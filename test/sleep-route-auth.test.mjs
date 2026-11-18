/**
 * The gate of the sleep route's POST branch (收工关机).
 *
 * "The request came from 127.0.0.1" proves nothing: every process on this
 * machine can reach the loopback address, so the old rule let ANY local
 * program arm or cancel the shutdown without a single credential. The route
 * now asks the host's connection service whether the request is an
 * authenticated DSH interface request.
 *
 * The cases covered here:
 *   - the connection service refuses the request: the POST is refused with
 *     403 and the shutdown intent does NOT change (neither arming nor
 *     cancelling);
 *   - there is no connection service at all: the POST still works (the old
 *     loopback rule) and the log says in a warning that it fell back;
 *   - the GET branch is untouched: it still answers with the status even when
 *     the connection service refuses the request, and it never goes through
 *     the new gate.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

/** The route that serves the graceful sleep. */
const SLEEP_PATH = '/__dsh_autorestart/sleep'

/**
 * A fake Cordis context that records the routes, the warnings and the timers.
 *
 * `connection` is the host's connection service - it is undefined when this
 * host has none, which is the degraded case the route must report.
 */
function createContext({ connection } = {}) {
  const routes = []
  const warnings = []
  const timers = []
  const taps = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: (fn) => {
      taps.push(fn)
      return () => {}
    },
  }
  const ctx = {
    logger: {
      info: () => undefined,
      warn: (...parts) => { warnings.push(parts.join(' ')) },
      error: () => undefined,
    },
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
    get: (name) => {
      if (name === 'webServer') return webServer
      if (name === 'connection') return connection
      return undefined
    },
  }
  return { ctx, routes, warnings, timers, taps }
}

/**
 * A fake host connection service.
 *
 * `requestRejection` answers a refusal status when the service refuses the
 * request and nothing at all when it admits it - the same contract the real
 * host has.
 */
function fakeConnection() {
  const state = { admit: false, calls: 0 }
  return {
    state,
    requestRejection: () => {
      state.calls += 1
      return state.admit ? undefined : { statusCode: 403 }
    },
  }
}

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-sleep-auth-${label}-`))
  return { dir, file: path.join(dir, 'state.json') }
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

/** A request from the loopback address, good enough for `readJsonBody`. */
function fakeRequest(method, body, headers = { 'content-type': 'application/json' }) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: SLEEP_PATH,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      if (event === 'data') handler(payload)
      else if (event === 'end') handler()
      return this
    },
  }
}

/** Let the route's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

/** The sleep route of a freshly applied plugin. */
function sleepRoute(routes) {
  const route = routes.find((entry) => entry.path === SLEEP_PATH)
  assert.ok(route, `the sleep route ${SLEEP_PATH} must be registered`)
  return route
}

/** The status the route reports (the GET branch). */
function getStatus(routes) {
  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('GET'), res)
  assert.equal(res.statusCode, 200)
  return JSON.parse(res.body)
}

/** The shutdown intent as it is written on disk, when it is there at all. */
function storedIntent(file) {
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const state = raw.state && typeof raw.state === 'object' ? raw.state : raw
  const intent = state.sleep
  return intent && typeof intent === 'object' ? intent : null
}

test('a POST that arms the shutdown is refused when the connection service refuses it', async () => {
  const { file } = tempStateFile('refuse-arm')
  const connection = fakeConnection()
  connection.state.admit = false
  const { ctx, routes } = createContext({ connection })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'arm' }), res)
  await settle()

  assert.equal(res.statusCode, 403, 'a refused request must not arm the machine')
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'not-admitted' })
  assert.ok(connection.state.calls > 0, 'the connection service must have been asked')

  // THE INTENT DID NOT CHANGE.
  const status = getStatus(routes)
  assert.equal(status.armed, false, 'the machine must NOT be armed by a refused request')
  assert.equal(status.armedAt, null)
  assert.equal(storedIntent(file), null, 'no shutdown intent may be written')
})

test('a refused cancel does not take the shutdown back', async () => {
  const { file } = tempStateFile('refuse-cancel')
  const connection = fakeConnection()
  connection.state.admit = true
  const { ctx, routes } = createContext({ connection })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  // The interface arms the machine: the connection service admits it.
  const armed = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'arm' }), armed)
  await settle()
  assert.equal(armed.statusCode, 200)
  const before = getStatus(routes)
  assert.equal(before.armed, true, 'an admitted request still arms the machine')
  assert.ok(storedIntent(file), 'the intent is on disk (the control of this test)')

  // Now the service refuses: the cancel must NOT clear the standing intent.
  connection.state.admit = false
  const cancelled = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'cancel' }), cancelled)
  await settle()

  assert.equal(cancelled.statusCode, 403, 'a refused request must not cancel the machine')
  assert.deepEqual(JSON.parse(cancelled.body), { ok: false, error: 'not-admitted' })

  const after = getStatus(routes)
  assert.equal(after.armed, true, 'the standing shutdown intent must survive a refused cancel')
  assert.equal(after.armedAt, before.armedAt, 'the intent is the very same one')
  assert.ok(storedIntent(file), 'the intent is still on disk')
})

test('without a connection service the POST still works, and the log says it fell back', async () => {
  const { file } = tempStateFile('no-connection')
  const { ctx, routes, warnings } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const before = warnings.length

  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'arm' }), res)
  await settle()

  assert.equal(res.statusCode, 200, 'without a connection service the old rule is kept')
  assert.equal(JSON.parse(res.body).armed, true, 'the machine is armed as before')

  const newWarnings = warnings.slice(before)
  const fallback = newWarnings.find((line) => /connection/i.test(line))
  assert.ok(fallback, `a warning about the missing connection service is required, got: ${JSON.stringify(newWarnings)}`)
  assert.match(fallback, /loopback/i, 'the warning must say that the loopback rule was used instead')
})

test('the GET branch is unchanged: it answers with the status even when the connection service refuses', async () => {
  const { file } = tempStateFile('get-refused')
  const connection = fakeConnection()
  connection.state.admit = false
  const { ctx, routes, warnings } = createContext({ connection })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const before = warnings.length

  const status = getStatus(routes)

  assert.equal(status.ok, true)
  assert.equal(status.armed, false)
  assert.equal(status.phase, 'idle')
  assert.equal(typeof status.countdownSeconds, 'number')
  const newWarnings = warnings.slice(before)
  assert.equal(
    newWarnings.filter((line) => /connection/i.test(line)).length,
    0,
    'the GET branch must not go through the new gate',
  )
})
