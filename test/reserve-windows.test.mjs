/**
 * Tests for the TWO reserve windows.
 *
 * The user decided that the one window that served both paths was wrong:
 *
 *   - `restartGraceMs` — the RESTART reserve. A restart is a daily operation:
 *     it should happen as soon as the conversations are done. Default: none.
 *   - `sleepGraceMs` — the SHUTDOWN reserve. The machine goes off for good,
 *     so the delayed work of the other plugins (memory notes, a summary, an
 *     MCP callback) must get its chance. Default: thirty seconds.
 *
 * The windows are independent: changing one must not change the other.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

const HEALTH_PATH = '/__dsh_autorestart/health'
const CHOICE_PATH = '/__dsh_autorestart/choice'
const SLEEP_PATH = '/__dsh_autorestart/sleep'

/** The six windows the settings page offers (in milliseconds). */
const OFFERED = [0, 5000, 10000, 20000, 30000, 60000]

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-reserve-${label}-`))
  return path.join(dir, 'state.json')
}

/**
 * Replace `Date.now` with a clock the test drives.
 *
 * @param {{ value: number }} clock
 * @param {object} t the test context
 */
function patchNow(clock, t) {
  const real = Date.now
  Date.now = () => clock.value
  t.after(() => { Date.now = real })
  return clock
}

/**
 * A fake Cordis context: the routes, the timers and the tools.
 */
function createContext({ services = {} } = {}) {
  const routes = []
  const timers = []
  const tools = []
  const handlers = new Map()
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
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
      guard: () => () => {},
    },
    on: (event, handler) => {
      const list = handlers.get(event) || []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect: (fn) => { fn(); return () => {} },
    interval: (fn, ms) => {
      const timer = { fn, ms, disposed: false }
      timers.push(timer)
      return () => { timer.disposed = true }
    },
    timeout: () => () => {},
    get: (name) => (name === 'webServer' ? webServer : services[name]),
  }
  return { ctx, routes, timers, tools }
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

/** What the state route answers right now. */
function stateOf(routes) {
  const res = fakeResponse()
  routeOf(routes, HEALTH_PATH).handler(fakeRequest('GET', undefined, `${HEALTH_PATH}?state=1`), res)
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

test('the restart gate only listens to the restart reserve', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('gate'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    restartGraceMs: 0,
    // A big SHUTDOWN reserve must not slow the restart down.
    sleepGraceMs: 60000,
  })

  // Three quiet seconds: the settle window (2s) is full.
  clock.value += 3000
  const verdict = gateVerdictOf(routes)
  assert.equal(verdict.effectiveSettleMs, 2000, 'the restart gate waits for the settle window only')
  assert.equal(verdict.graceMs, 0, 'the restart reserve is reported')
  assert.equal(verdict.sleepGraceMs, 60000, 'the shutdown reserve is reported next to it')
  assert.equal(verdict.allowRestart, true, 'the restart is not held back by the shutdown reserve')
})

test('the shutdown only listens to the shutdown reserve', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('sleep'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    // A big RESTART reserve must not slow the shutdown down.
    restartGraceMs: 60000,
    sleepGraceMs: 0,
  })

  const status = sleepStatusOf(routes)
  assert.equal(status.graceMs, 0, 'the shutdown waits for the shutdown reserve')
  assert.equal(status.restartGraceMs, 60000, 'the restart reserve is reported next to it')
})

test('the restart reserve makes the gate wait, the shutdown reserve does not', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('gate-restart'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    restartGraceMs: 10000,
    sleepGraceMs: 0,
  })

  clock.value += 3000
  const verdict = gateVerdictOf(routes)
  assert.equal(verdict.allowRestart, false, 'the restart reserve holds the restart back')
  assert.equal(verdict.gate.reason, 'settling')
  assert.equal(verdict.effectiveSettleMs, 10000, 'the gate uses the restart reserve')
  assert.equal(verdict.sleepGraceMs, 0, 'the shutdown reserve is a different knob')
})

test('the state route reports both reserves', (t) => {
  patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('state'),
    recoveryDelayMs: 0,
    enabled: true,
    restartGraceMs: 10000,
    sleepGraceMs: 30000,
  })

  const state = stateOf(routes)
  assert.equal(state.graceMs, 10000, 'the restart reserve is reported')
  assert.equal(state.sleepGraceMs, 30000, 'the shutdown reserve is reported')
})

test('the choice route takes both reserves and refuses a value that is not offered', async () => {
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

  // Every offered window is accepted — for both keys.
  for (const value of OFFERED) {
    const restart = await choose(routes, { restartGraceMs: value })
    assert.equal(restart.statusCode, 200, `restartGraceMs ${value} must be accepted`)
    assert.equal(restart.body.restartGraceMs, value)

    const shutdown = await choose(routes, { sleepGraceMs: value })
    assert.equal(shutdown.statusCode, 200, `sleepGraceMs ${value} must be accepted`)
    assert.equal(shutdown.body.sleepGraceMs, value)
  }

  // A value that is not offered is refused — for both keys — and nothing is
  // written.
  const editsBefore = edits.length
  for (const value of [3000, 15000, 45000]) {
    const refusedRestart = await choose(routes, { restartGraceMs: value })
    assert.equal(refusedRestart.statusCode, 400, `restartGraceMs ${value} must be refused`)
    assert.equal(refusedRestart.body.error, 'restartGraceMs-must-be-offered')

    const refusedShutdown = await choose(routes, { sleepGraceMs: value })
    assert.equal(refusedShutdown.statusCode, 400, `sleepGraceMs ${value} must be refused`)
    assert.equal(refusedShutdown.body.error, 'sleepGraceMs-must-be-offered')
  }
  assert.equal(edits.length, editsBefore, 'a refused answer must not write anything')

  // The instruction of the route lists the six offered windows.
  const empty = await choose(routes, {})
  assert.equal(empty.statusCode, 400)
  assert.match(empty.body.instruction, /"restartGraceMs": 0 \| 5000 \| 10000 \| 20000 \| 30000 \| 60000/)
  assert.match(empty.body.instruction, /"sleepGraceMs": 0 \| 5000 \| 10000 \| 20000 \| 30000 \| 60000/)
})
