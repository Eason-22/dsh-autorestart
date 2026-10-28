/**
 * Tests for the shutdown window: the graceful shutdown has NO invisible
 * reserve any more.
 *
 * The user decided that the shutdown reserve was a duplicate: the graceful
 * shutdown already has a VISIBLE countdown (`sleepCountdownSeconds`), and
 * that countdown IS the wait before the machine goes off. A second, hidden
 * window next to it would only say the same thing twice — so it was removed.
 *
 * What is left:
 *
 *   - the RESTART reserve (`restartGraceMs`) — the restart has no countdown
 *     of its own, so it keeps the extra wait for the work this plugin
 *     cannot see;
 *   - the VISIBLE countdown of the shutdown — the wait before the machine
 *     goes off.
 *
 * These tests guard that the removed key is really gone (the whole
 * repository, the code included) and that the two windows do not influence
 * each other.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'

const HEALTH_PATH = '/__dsh_autorestart/health'
const CHOICE_PATH = '/__dsh_autorestart/choice'
const SLEEP_PATH = '/__dsh_autorestart/sleep'

/**
 * The key of the shutdown reserve that no longer exists.
 *
 * It is built from two parts on purpose: the whole plugin must not mention
 * the key any more — the tests included — so the needle itself may not
 * appear in any file of this repository.
 */
const REMOVED_SHUTDOWN_KEY = ['sleep', 'GraceMs'].join('')

/** The directory of the plugin (the parent of this test directory). */
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-shutdown-${label}-`))
  return path.join(dir, 'state.json')
}

/**
 * Every file of the plugin that may hold text.
 *
 * The `.git` directory and `node_modules` are skipped: they are not part of
 * the plugin.
 *
 * @returns {string[]} the paths, relative to the plugin directory
 */
function pluginFiles(dir = PLUGIN_DIR, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      pluginFiles(full, out)
      continue
    }
    out.push(path.relative(PLUGIN_DIR, full))
  }
  return out
}

/**
 * A fake Cordis context: the routes and the timers.
 */
function createContext({ services = {} } = {}) {
  const routes = []
  const timers = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: (fn, ms) => {
      const timer = { fn, ms, disposed: false }
      timers.push(timer)
      return () => { timer.disposed = true }
    },
    timeout: () => () => {},
    get: (name) => (name === 'webServer' ? webServer : services[name]),
  }
  return { ctx, routes, timers }
}

/** A minimal Node response stand-in. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk) },
  }
}

/** A request from the loopback. */
function fakeRequest(method, body, url) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: url || SLEEP_PATH,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      if (event === 'data') handler(payload)
      else if (event === 'end') handler()
      return this
    },
  }
}

/** The route of a freshly applied plugin. */
function routeOf(routes, routePath) {
  const route = routes.find((entry) => entry.path === routePath)
  assert.ok(route, `the route ${routePath} must be registered`)
  return route
}

/** Let the route's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

/** What the restart gate answers right now. */
function gateVerdictOf(routes) {
  const res = fakeResponse()
  routeOf(routes, HEALTH_PATH).handler(fakeRequest('GET', undefined, `${HEALTH_PATH}?gate=1`), res)
  return JSON.parse(res.body)
}

/** What the shutdown route answers right now. */
function sleepStatusOf(routes) {
  const res = fakeResponse()
  routeOf(routes, SLEEP_PATH).handler(fakeRequest('GET'), res)
  return JSON.parse(res.body)
}

/** Ask the choice route to write one value. */
async function choose(routes, body) {
  const res = fakeResponse()
  routeOf(routes, CHOICE_PATH).handler(fakeRequest('POST', body, CHOICE_PATH), res)
  await settle()
  return { statusCode: res.statusCode, body: JSON.parse(res.body) }
}

test('the whole plugin has no trace of the removed shutdown reserve', () => {
  const hits = []
  for (const relative of pluginFiles()) {
    const full = path.join(PLUGIN_DIR, relative)
    let text = ''
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      // A file that is not text (an image) cannot hold the key.
      continue
    }
    if (text.includes(REMOVED_SHUTDOWN_KEY)) hits.push(relative)
  }
  assert.deepEqual(
    hits,
    [],
    `the removed key must not appear anywhere in the plugin: ${hits.join(', ')}`,
  )
})

test('the sleep status reports the countdown, not a silent window', () => {
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('status'),
    recoveryDelayMs: 0,
    enabled: true,
    restartGraceMs: 10000,
    sleepCountdownSeconds: 20,
  })

  const status = sleepStatusOf(routes)
  assert.equal(status.countdownSeconds, 20, 'the countdown is reported')
  assert.equal(status.restartGraceMs, 10000, 'the restart reserve is reported next to it')
  assert.equal(
    Object.prototype.hasOwnProperty.call(status, 'graceMs'),
    false,
    'the shutdown has no invisible window any more',
  )
})

test('the choice route refuses the removed key', async () => {
  const edits = []
  const { ctx, routes } = createContext({
    services: {
      configEditor: {
        entries: () => [{ options: { id: 'dsh-autorestart', name: 'dsh-autorestart', config: {} } }],
        edit: async (entry, change) => { edits.push(change({})) },
      },
    },
  })
  apply(ctx, { stateFile: tempStateFile('choice'), recoveryDelayMs: 0, enabled: true })

  // The removed key is not a choice any more: the route knows nothing about
  // it and writes nothing.
  const refused = await choose(routes, { [REMOVED_SHUTDOWN_KEY]: 30000 })
  assert.equal(refused.statusCode, 400, 'the removed key must not be accepted')
  assert.equal(refused.body.error, 'no-choice')
  assert.equal(edits.length, 0, 'a refused answer must not write anything')

  // The instruction of the route lists the keys that DO exist.
  const empty = await choose(routes, {})
  assert.equal(empty.statusCode, 400)
  assert.match(empty.body.instruction, /"restartGraceMs": 0 \| 5000 \| 10000 \| 20000 \| 30000 \| 60000/)
  assert.match(empty.body.instruction, /"sleepCountdownSeconds": 0 \| 10 \| 20 \| 30 \| 60/)
  assert.equal(
    empty.body.instruction.includes(REMOVED_SHUTDOWN_KEY),
    false,
    'the instruction must not mention the removed key',
  )
})

test('the restart reserve is independent of the shutdown countdown', () => {
  // The default: the gate waits for the settle window alone.
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('default'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    sleepCountdownSeconds: 20,
  })
  const plain = gateVerdictOf(routes)
  assert.equal(plain.effectiveSettleMs, 2000, 'the settle window alone is enough')
  assert.equal(plain.graceMs, 0, 'the restart reserve defaults to none')

  // A reserve of twenty seconds: the gate waits for it. The window the gate
  // really uses is `max(settleMs, restartGraceMs)` — the reserve REPLACES the
  // settle window when it is the longer one, it is not added to it.
  const second = createContext()
  apply(second.ctx, {
    stateFile: tempStateFile('reserve'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    restartGraceMs: 20000,
    sleepCountdownSeconds: 20,
  })
  const reserved = gateVerdictOf(second.routes)
  assert.equal(reserved.graceMs, 20000, 'the restart reserve is reported')
  assert.equal(reserved.effectiveSettleMs, 20000, 'the gate waits for the longer window')

  // The countdown of the shutdown does not touch the restart window at all.
  const third = createContext()
  apply(third.ctx, {
    stateFile: tempStateFile('countdown'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    sleepCountdownSeconds: 60,
  })
  const counted = gateVerdictOf(third.routes)
  assert.equal(counted.effectiveSettleMs, 2000, 'the countdown does not change the restart window')
  assert.equal(counted.graceMs, 0, 'the countdown does not create a reserve')
})
