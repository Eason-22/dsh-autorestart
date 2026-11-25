/**
 * The away gate's settings switch: from the settings page to the profile row,
 * and from there back into the payload the page reads.
 *
 * The settings page shows the switch and posts `save({gateOnSleep: true})`.
 * Two seams had to exist for that to mean anything:
 *
 *   1. `POST /choice` has to KNOW the key — a body that carried only
 *      `gateOnSleep` used to fall through to `no-choice` (400), so the switch
 *      could never be saved;
 *   2. the sleep status payload has to REPORT the value — otherwise the page
 *      can only guess whether the gate is on.
 *
 * The value is a BOOLEAN and nothing else: a wrong value is refused in the
 * same shape as the other keys, never coerced ("no" is not "false").
 *
 * NOTHING IN THIS FILE CAN SWITCH THE MACHINE OFF: the sleep controller is
 * never armed here.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, resolveGateOnSleep } from '../index.js'

/** The route that persists the one-time choice and the settings choices. */
const CHOICE_PATH = '/__dsh_autorestart/choice'

/** The route that reports the state of the graceful sleep. */
const SLEEP_PATH = '/__dsh_autorestart/sleep'

/** A temporary state file (its directory is the plugin's state directory). */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-gate-choice-${label}-`))
  return path.join(dir, 'state.json')
}

/**
 * A fake Cordis context.
 *
 * @param {{ configEditor?: object|null }} options the `configEditor` service,
 *   or null for the degraded path (the choice is written to the fallback file)
 * @returns {{ ctx: object, routes: object[], warnings: string[] }}
 */
function createContext({ configEditor = null } = {}) {
  const routes = []
  const warnings = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const ctx = {
    logger: {
      info: () => undefined,
      warn: (...parts) => { warnings.push(parts.map((part) => String(part)).join(' ')) },
      error: () => undefined,
    },
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: () => () => {},
    timeout: () => () => {},
    get: (name) => {
      if (name === 'webServer') return webServer
      if (name === 'configEditor') return configEditor
      return undefined
    },
  }
  return { ctx, routes, warnings }
}

/**
 * A fake `configEditor` service: the loader's own row for this plugin.
 *
 * @returns {{ row: object, editor: object }}
 */
function createConfigEditor() {
  const row = { options: { id: 'dsh-autorestart' }, config: {} }
  const editor = {
    entries: () => [row],
    edit: async (entry, mutate) => {
      entry.config = mutate(entry.config)
    },
  }
  return { row, editor }
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

/** A request with a JSON body, good enough for `readJsonBody`. */
function fakeRequest(method, body, url) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: url || CHOICE_PATH,
    headers: { 'content-type': 'application/json; charset=utf-8' },
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

/** The route whose path ends with the given suffix. */
function routeOf(routes, suffix) {
  const route = routes.find((entry) => typeof entry.path === 'string' && entry.path.endsWith(suffix))
  assert.ok(route, `the route ${suffix} must be registered`)
  return route
}

/** POST a choice and return the parsed answer. */
async function postChoice(routes, body) {
  const res = fakeResponse()
  routeOf(routes, '/choice').handler(fakeRequest('POST', body), res)
  await settle()
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

/** GET the sleep status and return the parsed answer. */
async function getSleep(routes) {
  const res = fakeResponse()
  routeOf(routes, '/sleep').handler(fakeRequest('GET', undefined, SLEEP_PATH), res)
  await settle()
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

/* ------------------------------------------------------------------ *
 * The three states of the switch.
 * ------------------------------------------------------------------ */

test('the away gate switch can be switched ON and the payload follows', async () => {
  const { row, editor } = createConfigEditor()
  const { ctx, routes } = createContext({ configEditor: editor })
  apply(ctx, { stateFile: tempStateFile('on'), recoveryDelayMs: 0, enabled: true })

  const answer = await postChoice(routes, { gateOnSleep: true })
  assert.equal(answer.status, 200, 'the choice must be accepted')
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.gateOnSleep, true)
  assert.equal(row.config.gateOnSleep, true, 'the choice must reach the profile row')

  const sleep = await getSleep(routes)
  assert.equal(sleep.status, 200)
  assert.equal(sleep.body.gateOnSleep, true, 'the payload must report the value that was written')
})

test('the away gate switch can be switched OFF and the payload follows', async () => {
  // The default is ON, so switching it OFF is the case that has to work.
  const { row, editor } = createConfigEditor()
  const { ctx, routes } = createContext({ configEditor: editor })
  apply(ctx, { stateFile: tempStateFile('off'), recoveryDelayMs: 0, enabled: true })

  const before = await getSleep(routes)
  assert.equal(before.body.gateOnSleep, true, 'the gate starts switched on')

  const answer = await postChoice(routes, { gateOnSleep: false })
  assert.equal(answer.status, 200, 'the choice must be accepted')
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.gateOnSleep, false)
  assert.equal(row.config.gateOnSleep, false, 'the choice must reach the profile row')

  const sleep = await getSleep(routes)
  assert.equal(sleep.status, 200)
  assert.equal(sleep.body.gateOnSleep, false, 'the payload must report the value that was written')
})

test('a value that is not a boolean is refused and nothing is written', async () => {
  const { row, editor } = createConfigEditor()
  const { ctx, routes } = createContext({ configEditor: editor })
  apply(ctx, { stateFile: tempStateFile('bad'), recoveryDelayMs: 0, enabled: true })

  for (const value of ['no', 1, 0, null]) {
    const answer = await postChoice(routes, { gateOnSleep: value })
    assert.equal(answer.status, 400, `the value ${JSON.stringify(value)} must be refused`)
    assert.equal(answer.body.ok, false)
    assert.equal(answer.body.error, 'gateOnSleep-must-be-boolean')
  }
  assert.equal(
    row.config.gateOnSleep,
    undefined,
    'a refused choice must never be written',
  )

  const sleep = await getSleep(routes)
  assert.equal(sleep.body.gateOnSleep, true, 'the default survives a refused choice')
})

/* ------------------------------------------------------------------ *
 * The degraded path: the choice must survive a restart.
 * ------------------------------------------------------------------ */

test('a choice made without the config editor is read back on the next boot', async () => {
  const file = tempStateFile('fallback')
  const first = createContext({ configEditor: null })
  apply(first.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const answer = await postChoice(first.routes, { gateOnSleep: false })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.applied, 'fallback-file', 'without the editor the choice degrades to the file')

  const recorded = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'install-choice.json'), 'utf8'))
  assert.equal(recorded.gateOnSleep, false, 'the fallback file must carry the value')

  // The next boot reads the record back.
  assert.deepEqual(
    resolveGateOnSleep({}, path.dirname(file)),
    { gateOnSleep: false, source: 'fallback-file' },
    'the resolver must find the recorded value',
  )
  const second = createContext({ configEditor: null })
  apply(second.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const sleep = await getSleep(second.routes)
  assert.equal(sleep.body.gateOnSleep, false, 'the value must survive the restart')
})

test('the profile row wins over the fallback file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-gate-choice-row-'))
  fs.writeFileSync(
    path.join(dir, 'install-choice.json'),
    JSON.stringify({ gateOnSleep: false }),
    'utf8',
  )
  assert.deepEqual(
    resolveGateOnSleep({ gateOnSleep: true }, dir),
    { gateOnSleep: true, source: 'config' },
    'the profile row decides',
  )
  assert.deepEqual(
    resolveGateOnSleep({}, dir),
    { gateOnSleep: false, source: 'fallback-file' },
    'the fallback file fills the gap',
  )
  assert.deepEqual(
    resolveGateOnSleep({}, ''),
    { gateOnSleep: true, source: 'default' },
    'the built-in default applies when neither says anything',
  )
})
