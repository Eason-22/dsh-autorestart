/**
 * Tests for the trace a disarmed shutdown intent leaves on disk.
 *
 * The report was: "I armed the shutdown last night, and this morning the
 * intent was gone." The only path that clears the intent is the disarm, and
 * the disarm used to leave nothing but one log line — the running Host does
 * not keep its logs, so "the intent was gone" could not be proven afterwards.
 *
 * The rule now: **every disarm writes a trace.** The file `last-sleep.json`
 * sits next to the other `last-*.json` records of the plugin and says WHEN the
 * intent was cleared (at), WHY it was cleared (reason) and what the intent
 * looked like before it went away (armedAt, countdownSeconds).
 *
 * A trace that cannot be written must never break the disarm: the intent is
 * cleared first, and the file is a side effect of that, not the other way
 * round.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, readSleepTraceRecord, SLEEP_TRACE_FILE } from '../index.js'

const SLEEP_PATH = '/__dsh_autorestart/sleep'

/* ------------------------------------------------------------------ *
 * The Host half.
 * ------------------------------------------------------------------ */

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-sleep-trace-${label}-`))
  return path.join(dir, 'state.json')
}

/**
 * A fake Cordis context: the routes, the timers, the tools — and a logger
 * that keeps what it was told, so the test can look at the warnings.
 */
function createContext({ agents = [], logs = [] } = {}) {
  const routes = []
  const timers = []
  const tools = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const record = (level) => (...parts) => {
    logs.push({
      level,
      message: parts
        .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
        .join(' '),
    })
  }
  const ctx = {
    logger: {
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    fiber: { state: 2 },
    agents: {
      list: () => agents,
      roots: () => agents,
      get: () => undefined,
    },
    goals: {
      get: () => undefined,
      resume: () => undefined,
    },
    tools: {
      register: (tool) => {
        tools.push(tool)
        return () => {}
      },
      guard: () => () => {},
    },
    on: () => () => {},
    effect: (fn) => {
      fn()
      return () => {}
    },
    interval: (fn, ms) => {
      const timer = { fn, ms, disposed: false }
      timers.push(timer)
      return () => {
        timer.disposed = true
      }
    },
    timeout: (fn) => {
      fn()
      return () => {}
    },
    get: (name) => (name === 'webServer' ? webServer : undefined),
  }
  return { ctx, routes, timers, tools, logs }
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

function fakeRequest(method, body, url) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {})
  return {
    method,
    url: url || SLEEP_PATH,
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      if (event === 'data') handler(payload)
      else if (event === 'end') handler()
      return this
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

async function callSleep(routes, method, body) {
  const entry = routes.find((route) => route.path === SLEEP_PATH)
  assert.ok(entry, 'the sleep route is registered')
  const response = fakeResponse()
  entry.handler(fakeRequest(method, body), response)
  await settle()
  return JSON.parse(response.body)
}

function readState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Mount the plugin on a temporary state file.
 *
 * `spawn` replaces the process spawner: the default one records the power off
 * and reports a child that is already running.
 */
function applyPlugin(ctx, file, overrides = {}, spawn) {
  const powerOffs = []
  apply(
    ctx,
    {
      stateFile: file,
      recoveryDelayMs: 0,
      enabled: true,
      restartGraceMs: 0,
      sleepCountdownSeconds: 20,
      ...overrides,
    },
    {
      sleepSpawn:
        spawn ||
        ((command, args) => {
          powerOffs.push({ command, args })
          return { pid: 4242, unref() {} }
        }),
    },
  )
  return { powerOffs }
}

/* ------------------------------------------------------------------ *
 * The helpers of the test itself.
 * ------------------------------------------------------------------ */

/** The trace file of a state directory, or null while it is not there. */
function traceOf(stateDir) {
  const target = path.join(stateDir, SLEEP_TRACE_FILE)
  if (!fs.existsSync(target)) return null
  if (!fs.statSync(target).isFile()) return null
  return readSleepTraceRecord(stateDir)
}

/** Wait for the disarm to leave its trace. */
async function waitForTrace(stateDir, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const trace = traceOf(stateDir)
    if (trace) return trace
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return null
}

/**
 * Arm the shutdown intent and let it end one way or another:
 * `cancel` clears it by hand, every other way ends with the machine going off
 * (or refusing to).
 */
async function disarmOnce({ label, countdownSeconds = 20, cancel = false, dryRun = false, spawn }) {
  const file = tempStateFile(label)
  const stateDir = path.dirname(file)
  const logs = []
  const { ctx, routes } = createContext({ logs })
  const previousDryRun = process.env.DSH_AUTORESTART_SLEEP_DRYRUN
  if (dryRun) process.env.DSH_AUTORESTART_SLEEP_DRYRUN = '1'
  try {
    applyPlugin(ctx, file, { sleepCountdownSeconds: countdownSeconds }, spawn)
    await callSleep(routes, 'POST', { action: 'arm' })
    if (cancel) await callSleep(routes, 'POST', { action: 'cancel' })
    const trace = await waitForTrace(stateDir)
    return { trace, logs, state: readState(file), stateDir }
  } finally {
    if (dryRun) {
      if (previousDryRun === undefined) delete process.env.DSH_AUTORESTART_SLEEP_DRYRUN
      else process.env.DSH_AUTORESTART_SLEEP_DRYRUN = previousDryRun
    }
  }
}

/** Every trace has to say the same four things. */
function assertCompleteTrace(trace, reason) {
  assert.ok(trace, `the disarm wrote ${SLEEP_TRACE_FILE}`)
  assert.equal(typeof trace.at, 'number', 'the trace says WHEN it was written')
  assert.ok(trace.at > 0, 'the moment in the trace is a real one')
  assert.equal(trace.reason, reason, 'the trace says WHY the intent was cleared')
  assert.equal(typeof trace.armedAt, 'number', 'the trace says WHEN the intent was armed')
  assert.ok(trace.armedAt > 0, 'the armed moment in the trace is a real one')
  assert.equal(typeof trace.countdownSeconds, 'number', 'the trace says how long the countdown was')
}

/* ------------------------------------------------------------------ *
 * The four reasons a shutdown intent can end.
 * ------------------------------------------------------------------ */

test('a cancelled shutdown intent leaves a trace behind', async () => {
  const { trace, state } = await disarmOnce({ label: 'cancelled', cancel: true })
  assertCompleteTrace(trace, 'cancelled')
  assert.equal(trace.countdownSeconds, 20, 'the trace remembers the countdown of the intent')
  assert.equal(state.sleep, null, 'the intent is cleared')
})

test('a dry run leaves a trace behind', async () => {
  const { trace, state } = await disarmOnce({ label: 'dry-run', countdownSeconds: 0, dryRun: true })
  assertCompleteTrace(trace, 'dry-run')
  assert.equal(trace.countdownSeconds, 0, 'the trace remembers the countdown of the intent')
  assert.equal(state.sleep, null, 'the intent is cleared')
})

test('a shutdown that went through leaves a trace behind', async () => {
  const { trace, state } = await disarmOnce({ label: 'shutdown-completed', countdownSeconds: 0 })
  assertCompleteTrace(trace, 'shutdown-completed')
  assert.equal(trace.countdownSeconds, 0, 'the trace remembers the countdown of the intent')
  assert.equal(state.sleep, null, 'the intent is cleared')
})

test('a shutdown that failed leaves a trace behind', async () => {
  const { trace, state } = await disarmOnce({
    label: 'shutdown-failed',
    countdownSeconds: 0,
    spawn: () => {
      throw new Error('the machine refused to go off')
    },
  })
  assertCompleteTrace(trace, 'shutdown-failed')
  assert.equal(trace.countdownSeconds, 0, 'the trace remembers the countdown of the intent')
  assert.equal(state.sleep, null, 'the intent is cleared')
})

/* ------------------------------------------------------------------ *
 * A trace that cannot be written must not break the disarm.
 * ------------------------------------------------------------------ */

test('a state directory that cannot hold the trace does not break the disarm', async () => {
  const file = tempStateFile('unwritable')
  const stateDir = path.dirname(file)
  // A DIRECTORY with the name of the trace file: the temporary file can be
  // written, but it cannot be renamed onto a directory — so the write fails
  // in a way that has nothing to do with the permissions of the machine.
  fs.mkdirSync(path.join(stateDir, SLEEP_TRACE_FILE))
  const logs = []
  const { ctx, routes } = createContext({ logs })

  applyPlugin(ctx, file, { sleepCountdownSeconds: 20 })
  await callSleep(routes, 'POST', { action: 'arm' })
  await callSleep(routes, 'POST', { action: 'cancel' })
  await settle()

  assert.equal(readState(file).sleep, null, 'the intent was cleared anyway')
  assert.equal(traceOf(stateDir), null, 'there is no trace to read')
  const warnings = logs.filter((entry) => entry.level === 'warn').map((entry) => entry.message)
  assert.ok(
    warnings.some((message) => message.includes('sleep trace')),
    `the failure is reported, got ${JSON.stringify(warnings)}`,
  )
})
