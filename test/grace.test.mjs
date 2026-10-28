/**
 * Tests for the grace window: the extra wait after the last conversation
 * finished.
 *
 * The plugin can only see the DSH agents. Other plugins (a memory plugin
 * that writes its notes a few seconds after the conversation ended, a
 * summary, an MCP callback) queue their work with a timer of their own —
 * work that is invisible here. Without a grace window the host may restart
 * or switch off right in the middle of that write.
 *
 * The grace window is therefore:
 *
 *   - a CONFIG value (`restartGraceMs`, default 10 seconds, offered as
 *     0 / 3 / 5 / 10 / 20 / 30 seconds);
 *   - honoured by BOTH paths (the restart gate and the graceful shutdown);
 *   - anchored at the last observed conversation activity, so new activity
 *     during the wait starts the timer over;
 *   - reported by the status interfaces (`graceMs` + `quietForMs`).
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { apply, DEFAULTS, normalizeConfig } from '../index.js'

const HEALTH_PATH = '/__dsh_autorestart/health'
const SLEEP_PATH = '/__dsh_autorestart/sleep'

/* ------------------------------------------------------------------ *
 * The Host half.
 * ------------------------------------------------------------------ */

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-grace-${label}-`))
  return path.join(dir, 'state.json')
}

/**
 * Replace `Date.now` with a clock the test drives.
 *
 * The gate, the quiet window and the grace all measure time with
 * `Date.now()`, so the test has to own the clock.
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
 * A fake Cordis context: the live agents, the timers, the event handlers and
 * the routes.
 */
function createContext({ agents = [], services = {} } = {}) {
  const routes = []
  const timers = []
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
    agents: { list: () => agents, roots: () => agents, get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
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
  return {
    ctx,
    routes,
    timers,
    /** Fire every event handler of one event (the plugin's activity signal). */
    fire: (event, payload) => {
      for (const handler of handlers.get(event) || []) handler(payload)
    },
  }
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
    url: url || SLEEP_PATH,
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

/** The route of a freshly applied plugin. */
function routeOf(routes, routePath) {
  const route = routes.find((entry) => entry.path === routePath)
  assert.ok(route, `the route ${routePath} must be registered`)
  return route
}

/** What the restart gate answers right now. */
function gateVerdictOf(routes) {
  const res = fakeResponse()
  routeOf(routes, HEALTH_PATH).handler(
    fakeRequest('GET', undefined, `${HEALTH_PATH}?gate=1`),
    res,
  )
  return JSON.parse(res.body)
}

/** What the state route answers right now. */
function stateOf(routes) {
  const res = fakeResponse()
  routeOf(routes, HEALTH_PATH).handler(
    fakeRequest('GET', undefined, `${HEALTH_PATH}?state=1`),
    res,
  )
  return JSON.parse(res.body)
}

/** What the sleep route answers right now. */
function sleepStatusOf(routes) {
  const res = fakeResponse()
  routeOf(routes, SLEEP_PATH).handler(fakeRequest('GET'), res)
  return JSON.parse(res.body)
}

/** Arm the graceful shutdown. */
async function armSleep(routes) {
  const res = fakeResponse()
  routeOf(routes, SLEEP_PATH).handler(fakeRequest('POST', { action: 'arm' }), res)
  await settle()
  return JSON.parse(res.body)
}

/** Fire every 1s timer of the plugin (the sleep controller ticks on them). */
function fireTicks(timers) {
  for (const timer of timers) {
    if (!timer.disposed && timer.ms === 1000) timer.fn()
  }
}

test('the two reserve windows have their own defaults', () => {
  // The restart reserve: a restart is a daily operation, so no extra wait.
  assert.equal(DEFAULTS.restartGraceMs, 0, 'the restart reserve defaults to none')
  assert.equal(normalizeConfig({}).restartGraceMs, 0)
  // The shutdown reserve: the machine goes off for good, so the delayed work
  // of the other plugins must get its chance.
  assert.equal(DEFAULTS.sleepGraceMs, 30000, 'the shutdown reserve defaults to thirty seconds')
  assert.equal(normalizeConfig({}).sleepGraceMs, 30000)
  assert.notEqual(
    normalizeConfig({}).restartGraceMs,
    normalizeConfig({}).sleepGraceMs,
    'the two windows must not share one default',
  )
  // A hand-edited profile value is snapped onto the nearest offered choice.
  assert.equal(normalizeConfig({ restartGraceMs: 7000 }).restartGraceMs, 5000)
  assert.equal(normalizeConfig({ restartGraceMs: 20000 }).restartGraceMs, 20000)
  assert.equal(normalizeConfig({ restartGraceMs: 15000 }).restartGraceMs, 10000)
  assert.equal(normalizeConfig({ sleepGraceMs: 3000 }).sleepGraceMs, 5000)
  assert.equal(normalizeConfig({ sleepGraceMs: 15000 }).sleepGraceMs, 10000)
  assert.equal(normalizeConfig({ restartGraceMs: 0 }).restartGraceMs, 0)
  assert.equal(normalizeConfig({ sleepGraceMs: 0 }).sleepGraceMs, 0)
  // A wrong value falls back to the default OF THAT WINDOW.
  assert.equal(normalizeConfig({ restartGraceMs: -1 }).restartGraceMs, 0)
  assert.equal(normalizeConfig({ restartGraceMs: 'nonsense' }).restartGraceMs, 0)
  assert.equal(normalizeConfig({ sleepGraceMs: -1 }).sleepGraceMs, 30000)
  assert.equal(normalizeConfig({ sleepGraceMs: 'nonsense' }).sleepGraceMs, 30000)
})

test('the two reserve windows do not inherit each other', () => {
  // A profile that only knows the OLD key gets the new defaults — the old
  // value must not bleed into the other window.
  assert.equal(normalizeConfig({ restartGraceMs: 60000 }).sleepGraceMs, 30000)
  assert.equal(normalizeConfig({ sleepGraceMs: 60000 }).restartGraceMs, 0)
  // Both present: each one keeps its own value.
  const both = normalizeConfig({ restartGraceMs: 10000, sleepGraceMs: 60000 })
  assert.equal(both.restartGraceMs, 10000)
  assert.equal(both.sleepGraceMs, 60000)
})

test('without a grace the restart behaves exactly as before', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('no-grace'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 0,
    restartGraceMs: 0,
  })

  const verdict = gateVerdictOf(routes)
  assert.equal(verdict.allowRestart, true, 'no extra wait')
  assert.equal(verdict.gate.reason, 'quiet')
  assert.equal(verdict.graceMs, 0)
})

test('with a grace of ten seconds the restart waits for it', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('grace'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 0,
    restartGraceMs: 10000,
  })

  // 9.9 seconds after the last conversation finished: too early.
  clock.value += 9900
  const early = gateVerdictOf(routes)
  assert.equal(early.allowRestart, false, 'the grace must hold the restart back')
  assert.equal(early.gate.reason, 'settling')
  assert.equal(early.gate.quietForMs, 9900)
  assert.equal(early.graceMs, 10000, 'the grace window is reported')
  assert.equal(early.effectiveSettleMs, 10000, 'the gate uses the longer window')

  // 10.1 seconds: the grace is over, the restart may go.
  clock.value += 200
  const late = gateVerdictOf(routes)
  assert.equal(late.allowRestart, true, 'the restart may fire once the grace is over')
  assert.equal(late.gate.reason, 'quiet')
  assert.equal(late.gate.quietForMs, 10100)
})

test('new activity during the wait starts the timer over', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes, fire } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('reset'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 0,
    restartGraceMs: 10000,
  })

  // Five seconds in, a conversation starts working again.
  clock.value += 5000
  fire('agent/status', { agent: { id: 'sess-a' }, status: 'running' })

  // Ten seconds after the START would be five seconds after the new
  // activity: the grace is not over yet.
  clock.value += 5000
  const early = gateVerdictOf(routes)
  assert.equal(early.allowRestart, false, 'the new activity must start the timer over')
  assert.equal(early.gate.quietForMs, 5000)

  // Ten seconds after the new activity: the grace is over.
  clock.value += 5000
  const late = gateVerdictOf(routes)
  assert.equal(late.allowRestart, true)
  assert.equal(late.gate.quietForMs, 10000)
})

test('the graceful shutdown waits for the SHUTDOWN reserve', async (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes, timers } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('sleep-grace'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 0,
    // The restart reserve is not the one the shutdown waits for.
    restartGraceMs: 0,
    sleepGraceMs: 10000,
    sleepCountdownSeconds: 20,
  })

  const armed = await armSleep(routes)
  assert.equal(armed.phase, 'waiting', 'the countdown must not start during the grace')
  assert.deepEqual(armed.blockers, [], 'nobody is busy — the grace is the reason')
  assert.match(armed.message, /再等/, 'the machine says why it waits')
  assert.equal(armed.graceMs, 10000, 'the shutdown reserve is reported')
  assert.equal(typeof armed.quietForMs, 'number')

  // Still inside the grace: the countdown does not start.
  clock.value += 9000
  fireTicks(timers)
  assert.equal(sleepStatusOf(routes).phase, 'waiting')

  // The grace is over: the countdown starts.
  clock.value += 2000
  fireTicks(timers)
  const counting = sleepStatusOf(routes)
  assert.equal(counting.phase, 'countdown', 'the countdown starts once the grace is over')
  assert.equal(counting.remainingMs, 20000)
})

test('the state route reports the grace and the quiet window', (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const { ctx, routes } = createContext()
  apply(ctx, {
    stateFile: tempStateFile('state'),
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 2000,
    restartGraceMs: 10000,
  })

  clock.value += 3000
  const state = stateOf(routes)
  assert.equal(state.graceMs, 10000)
  assert.equal(state.quietForMs, 3000)
  assert.equal(state.effectiveSettleMs, 10000, 'the grace is longer than the settle window')
  assert.equal(state.settleMs, 2000, 'the settle window is still reported')
})

test('the choice route takes the grace and refuses a value that is not offered', async () => {
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

  const res = fakeResponse()
  routeOf(routes, '/__dsh_autorestart/choice').handler(
    fakeRequest('POST', { restartGraceMs: 20000 }, '/__dsh_autorestart/choice'),
    res,
  )
  await settle()
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, applied: 'config', restartGraceMs: 20000 })
  assert.equal(edits.length, 1, 'the profile row must be edited exactly once')
  assert.equal(edits[0].restartGraceMs, 20000)

  // A value that is not offered is refused, and nothing is written.
  const refused = fakeResponse()
  routeOf(routes, '/__dsh_autorestart/choice').handler(
    fakeRequest('POST', { restartGraceMs: 7000 }, '/__dsh_autorestart/choice'),
    refused,
  )
  await settle()
  assert.equal(refused.statusCode, 400)
  assert.equal(JSON.parse(refused.body).ok, false)
  assert.equal(edits.length, 1, 'a refused answer must not write anything')
})

/* ------------------------------------------------------------------ *
 * The client half.
 * ------------------------------------------------------------------ */

/** A fake browser localStorage. */
function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    clear: () => { map.clear() },
    has: (key) => map.has(key),
  }
}

/** Compare two dependency lists the way React does. */
function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/** A tiny React stand-in: enough for the classic client script. */
function createReactHarness() {
  const hooks = []
  let cursor = 0
  let pendingEffects = []

  const slotAt = (index) => {
    while (hooks.length <= index) {
      hooks.push({ value: undefined, deps: undefined, cleanup: undefined, initialized: false, effectInit: false })
    }
    return hooks[index]
  }

  const React = {
    createElement(type, props, ...children) {
      const flat = []
      const push = (child) => {
        if (Array.isArray(child)) child.forEach(push)
        else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child)
      }
      children.forEach(push)
      return { type, props: props || {}, children: flat }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index)
      if (!slot.initialized) {
        slot.initialized = true
        slot.value = typeof initial === 'function' ? initial() : initial
      }
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
      }
      return [slot.value, setState]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index)
      if (!slot.initialized) {
        slot.initialized = true
        slot.value = { current: initial }
      }
      return slot.value
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index)
      const changed = !slot.effectInit || !sameDeps(slot.deps, deps)
      slot.deps = deps
      slot.effectInit = true
      if (changed) pendingEffects.push({ slot, fn })
    },
  }

  const render = (Component, props) => {
    cursor = 0
    pendingEffects = []
    const tree = Component(props)
    const effects = pendingEffects
    pendingEffects = []
    for (const { slot, fn } of effects) {
      if (typeof slot.cleanup === 'function') slot.cleanup()
      slot.cleanup = fn()
    }
    return tree
  }

  return { React, render }
}

/** Every node of a rendered tree, depth first. */
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children || []) walk(child, out)
  return out
}

/** The concatenated text of a rendered subtree. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}

/**
 * Load the classic client script in a sandbox and mount the settings section.
 *
 * @param {{ status?: object, language?: string }} options
 */
function mountSettings({ status = {}, language = 'zh' } = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
  const fetches = []
  const state = { status }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => {
          definition = value
        },
      },
      localStorage: createStorage(),
      sessionStorage: createStorage(),
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { reload: () => {} },
    },
    document: {
      getElementById: () => null,
      createElement: (tag) => ({ tag, id: '', textContent: '', parentNode: null, setAttribute: () => {}, appendChild: () => {} }),
      head: { appendChild: (node) => node, removeChild: () => {} },
      querySelector: () => null,
    },
    fetch: (url, init) => {
      fetches.push({ url: String(url), init })
      const target = String(url)
      if (target.includes('/choice') && init && init.body) {
        // The Host takes the answer and reports it back on the next poll —
        // under the names the status route uses (`restartGraceMs` and
        // `sleepGraceMs`, not the write key of the shutdown reserve).
        const written = JSON.parse(init.body)
        const next = { ...(state.status || {}) }
        if (typeof written.restartGraceMs === 'number') next.restartGraceMs = written.restartGraceMs
        if (typeof written.sleepGraceMs === 'number') next.sleepGraceMs = written.sleepGraceMs
        if (typeof written.sleepCountdownSeconds === 'number') next.countdownSeconds = written.sleepCountdownSeconds
        state.status = next
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, applied: 'config', ...written }),
        })
      }
      if (target.includes('/sleep')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => state.status || {} })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, pendingRestart: false, choiceUrl: '/__dsh_autorestart/choice' }),
      })
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    AbortController,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.ok(definition, 'the client script must register itself with the module loader')

  const harness = createReactHarness()
  const module = definition.factory(() => harness.React)

  const dictionaries = {}
  const slots = new Map()
  const ctx = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    locale: {
      register: (namespace, value) => {
        dictionaries[namespace] = value
      },
      bind: (namespace) => (key) => {
        const table = (dictionaries[namespace] || {})[language] || {}
        return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key
      },
    },
    slots: {
      inject: (name, thunk) => {
        const list = slots.get(name) || []
        list.push(thunk)
        slots.set(name, list)
      },
      entries: () => [],
      register: (registration, Component) => ({ registration, Component }),
    },
  }
  module.apply(ctx)

  const componentOf = (id) => {
    for (const list of slots.values()) {
      for (const thunk of list) {
        const produced = thunk()
        const entry = (produced && typeof produced.next === 'function')
          ? produced.next().value
          : produced
        if (entry && entry.registration && entry.registration.id === id) return entry.Component
      }
    }
    assert.fail(`the component ${id} must be registered`)
  }

  return {
    dictionaries,
    fetches,
    settled: async (id, props) => {
      const Component = componentOf(id)
      harness.render(Component, props || {})
      await new Promise((resolve) => setTimeout(resolve, 5))
      return harness.render(Component, props || {})
    },
    render: (id, props) => harness.render(componentOf(id), props || {}),
  }
}

test('the settings section offers the two reserve windows and saves them', async () => {
  const mounted = mountSettings({
    status: {
      ok: true,
      phase: 'idle',
      showSleepButton: true,
      blockers: [],
      countdownSeconds: 20,
      graceMs: 30000,
      sleepGraceMs: 30000,
      restartGraceMs: 0,
    },
  })

  const panel = await mounted.settled('dsh-autorestart')
  assert.ok(panel, 'the settings section must be rendered')

  const selects = walk(panel).filter((node) => node.type === 'select')
  const restart = selects.find((node) => node.props['data-dsh-autorestart-setting'] === 'restartGraceMs')
  const shutdown = selects.find((node) => node.props['data-dsh-autorestart-setting'] === 'sleepGraceMs')
  assert.ok(restart, 'the restart reserve must have a dropdown')
  assert.ok(shutdown, 'the shutdown reserve must have a dropdown')
  assert.equal(restart.props.value, '0', 'the restart reserve of the Host is shown')
  assert.equal(shutdown.props.value, '30', 'the shutdown reserve of the Host is shown')
  const options = walk(restart).filter((node) => node.type === 'option').map((node) => node.props.value)
  assert.deepEqual(options, ['0', '5', '10', '20', '30', '60'], 'the six offered windows')
  assert.deepEqual(
    walk(shutdown).filter((node) => node.type === 'option').map((node) => node.props.value),
    ['0', '5', '10', '20', '30', '60'],
    'both dropdowns offer the same six windows',
  )

  // The two labels tell the two situations apart.
  const shown = textOf(panel)
  assert.match(shown, /重启前再等几秒/, `the restart label must be there: ${shown}`)
  assert.match(shown, /关机前再等几秒/, `the shutdown label must be there: ${shown}`)
  assert.match(shown, /日常操作/, `the restart hint must explain the restart: ${shown}`)
  assert.match(shown, /机器就关了/, `the shutdown hint must explain the shutdown: ${shown}`)

  // Choosing another value writes it into the profile configuration.
  restart.props.onChange({ target: { value: '20' } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const posts = mounted.fetches.filter(
    (call) => String(call.url).includes('/choice') && call.init && call.init.body,
  )
  assert.equal(posts.length, 1, 'the choice must be written once')
  assert.deepEqual(JSON.parse(posts[0].init.body), { restartGraceMs: 20000 })

  // And it is read back from the Host.
  const again = mounted.render('dsh-autorestart')
  const selectsAgain = walk(again).filter((node) => node.type === 'select')
  const restartAgain = selectsAgain.find((node) => node.props['data-dsh-autorestart-setting'] === 'restartGraceMs')
  assert.equal(restartAgain.props.value, '20', 'the new value is read back')
})

test('the copy of the two reserve windows lives in the locale files', () => {
  const zh = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  assert.ok(zh.settings.restartGrace, 'the zh locale must carry the restart texts')
  assert.ok(zh.settings.sleepGrace, 'the zh locale must carry the shutdown texts')
  assert.ok(en.settings.restartGrace, 'the en locale must carry the restart texts')
  assert.ok(en.settings.sleepGrace, 'the en locale must carry the shutdown texts')
  assert.equal(zh.settings.restartGrace.label, '重启前再等几秒')
  assert.equal(zh.settings.sleepGrace.label, '关机前再等几秒')
  assert.match(zh.settings.restartGrace.hint, /日常操作/, 'the zh restart copy must explain the restart')
  assert.match(zh.settings.sleepGrace.hint, /机器就关了/, 'the zh shutdown copy must explain the shutdown')
  assert.match(en.settings.restartGrace.hint, /daily operation/, 'the en restart copy must explain the restart')
  assert.match(en.settings.sleepGrace.hint, /goes off for good/, 'the en shutdown copy must explain the shutdown')
})
