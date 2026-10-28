/**
 * Tests for the one-time announcement of a new feature.
 *
 * The install prompt only ever reaches a FRESH installation, so an
 * installation that already existed would never hear of the new graceful
 * shutdown. This file proves the missing half:
 *
 *   1. the Host reports the announcement of an upgrade (and remembers it);
 *   2. the client shows it once, in the composer dock, and it quotes the
 *      countdown length that is really in effect;
 *   3. the install prompt marks it as seen, so a fresh installation never
 *      gets an announcement on top of its two questions.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { apply, featureAnnouncements, pluginVersion } from '../index.js'

const ANNOUNCEMENTS_PATH = '/__dsh_autorestart/announcements'
const CHOICE_PATH = '/__dsh_autorestart/choice'

/* ------------------------------------------------------------------ *
 * The Host half.
 * ------------------------------------------------------------------ */

/** Create a temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-announce-${label}-`))
  return path.join(dir, 'state.json')
}

/**
 * A fake Cordis context: it collects the routes and the warnings the plugin
 * logs.
 */
function createContext({ services = {} } = {}) {
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
      warn: (...parts) => {
        warnings.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
      },
      error: () => undefined,
    },
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    effect: (fn) => {
      fn()
      return () => {}
    },
    interval: () => () => {},
    timeout: () => () => {},
    get: (name) => (name === 'webServer' ? webServer : services[name]),
  }
  return { ctx, routes, warnings }
}

/** A minimal Node response stand-in. */
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

/** A request with a JSON body, good enough for `readJsonBody`. */
function fakeRequest(method, body, url) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: url || ANNOUNCEMENTS_PATH,
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

/** The announcements route of a freshly applied plugin. */
function announcementsRoute(routes) {
  const route = routes.find((entry) => entry.path === ANNOUNCEMENTS_PATH)
  assert.ok(route, `the announcements route ${ANNOUNCEMENTS_PATH} must be registered`)
  return route
}

/** The choice route of a freshly applied plugin. */
function choiceRoute(routes) {
  const route = routes.find((entry) => entry.path === CHOICE_PATH)
  assert.ok(route, `the choice route ${CHOICE_PATH} must be registered`)
  return route
}

/** Call the announcements route and return the parsed answer. */
async function callAnnouncements(routes, method, body) {
  const res = fakeResponse()
  announcementsRoute(routes).handler(fakeRequest(method, body), res)
  await settle()
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

/** Call the choice route and return the parsed answer. */
async function callChoice(routes, body) {
  const res = fakeResponse()
  choiceRoute(routes).handler(fakeRequest('POST', body, CHOICE_PATH), res)
  await settle()
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

test('the announcement of an upgrade is reported by the Host', async () => {
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: tempStateFile('pending'), recoveryDelayMs: 0, enabled: true })

  const answer = await callAnnouncements(routes, 'GET')
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true)
  assert.deepEqual(answer.body.pending, [{ feature: 'sleep', version: pluginVersion() }])
})

test('the version of the announcement is the version of the package', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pluginVersion(), pkg.version, 'the announcement must carry the version of the package')
  // The release number lives in package.json only: pinning a literal here made every
  // version bump fail this test, which taught nobody anything about the announcement.
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'the package version must be a semver triple')
  assert.deepEqual(featureAnnouncements(), [{ feature: 'sleep', version: pkg.version }])
})

test('the announcement is recorded once and never comes back', async () => {
  const file = tempStateFile('seen')
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const recorded = await callAnnouncements(routes, 'POST', { feature: 'sleep' })
  assert.equal(recorded.status, 200)
  assert.equal(recorded.body.ok, true)
  assert.deepEqual(recorded.body.seen, ['sleep'])

  const after = await callAnnouncements(routes, 'GET')
  assert.deepEqual(after.body.pending, [], 'a recorded announcement must not come back')

  // The record lives in the state file, so it survives a restart of the Host.
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.seenFeatureVersions.sleep, pluginVersion())
})

test('the answer of the install question marks the announcement as seen', async () => {
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: tempStateFile('install'), recoveryDelayMs: 0, enabled: true })

  const before = await callAnnouncements(routes, 'GET')
  assert.equal(before.body.pending.length, 1, 'the announcement must be pending before the question')

  const answer = await callChoice(routes, { includePlugins: true })
  assert.equal(answer.status, 200)

  const after = await callAnnouncements(routes, 'GET')
  assert.deepEqual(after.body.pending, [], 'a fresh installation must not get an announcement')
})

test('the settings page does NOT mark the announcement as seen', async () => {
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: tempStateFile('settings'), recoveryDelayMs: 0, enabled: true })

  // The settings page writes the countdown and the backup switches — not the
  // install question. An upgrade user who only touches the settings must
  // still see the announcement.
  const answer = await callChoice(routes, { sleepCountdownSeconds: 30 })
  assert.equal(answer.status, 200)

  const after = await callAnnouncements(routes, 'GET')
  assert.equal(after.body.pending.length, 1, 'the announcement must still be pending')
})

test('a broken record never hides the announcement', async () => {
  const file = tempStateFile('broken')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    bootId: null,
    bootPid: null,
    bootStartedAt: null,
    generation: 0,
    phase: 'idle',
    restart: null,
    sessions: {},
    seenFeatureVersions: { sleep: 42 },
    updatedAt: Date.now(),
  }), 'utf8')

  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const answer = await callAnnouncements(routes, 'GET')
  assert.equal(answer.body.pending.length, 1, 'an unreadable record must not swallow the announcement')
})

test('a malformed announcement request is refused and nothing is recorded', async () => {
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: tempStateFile('refused'), recoveryDelayMs: 0, enabled: true })

  const empty = await callAnnouncements(routes, 'POST', {})
  assert.equal(empty.status, 400)
  assert.equal(empty.body.ok, false)

  const unknown = await callAnnouncements(routes, 'POST', { feature: 'nope' })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.ok, false)

  const after = await callAnnouncements(routes, 'GET')
  assert.equal(after.body.pending.length, 1, 'a refused request must not record anything')
})

/* ------------------------------------------------------------------ *
 * The client half.
 * ------------------------------------------------------------------ */

/** A fake browser localStorage. */
function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value))
    },
    removeItem: (key) => {
      map.delete(key)
    },
    clear: () => {
      map.clear()
    },
    has: (key) => map.has(key),
  }
}

/** Compare two dependency lists the way React does. */
function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/**
 * A tiny React stand-in: enough for the classic client script.
 */
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

/** The keys the browser writes when the install questions were answered. */
const INSTALL_ANSWERED = {
  'dsh-autorestart:backup-choice-v1': 'plugins',
  'dsh-autorestart:sleep-button-v1': 'keep',
}

/**
 * Load the classic client script in a sandbox and mount the announcement.
 *
 * @param {{ storage: object, fetches: object[], pending?: object[], sleepStatus?: object }} options
 */
function mountAnnouncementPanel({
  storage,
  fetches,
  pending = [{ feature: 'sleep', version: '0.5.0' }],
  sleepStatus = { ok: true, phase: 'idle', countdownSeconds: 30, showSleepButton: true },
}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => {
          definition = value
        },
      },
      localStorage: storage,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    document: {
      getElementById: () => null,
      createElement: (tag) => ({ tag, id: '', textContent: '', parentNode: null, setAttribute: () => {}, appendChild: () => {} }),
      head: {
        appendChild: (node) => node,
        removeChild: () => {},
      },
    },
    fetch: (url, init) => {
      fetches.push({ url: String(url), init })
      const target = String(url)
      if (target.includes('/announcements')) {
        const isPost = init && init.method === 'POST'
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => (isPost ? { ok: true, seen: ['sleep'] } : { ok: true, pending }),
        })
      }
      if (target.includes('/sleep')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => sleepStatus })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
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
        const table = (dictionaries[namespace] || {}).zh || {}
        return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key
      },
    },
    slots: {
      inject: (name, thunk) => {
        // More than one component may live in the same slot.
        const list = slots.get(name) || []
        list.push(thunk)
        slots.set(name, list)
      },
      register: (registration, Component) => ({ registration, Component }),
    },
  }
  module.apply(ctx)

  const thunks = slots.get('conversation.input.dock') || []
  const thunk = thunks.find((entry) => {
    const { registration } = entry()
    return registration.id === 'autorestart-feature-announcement'
  })
  assert.ok(thunk, 'the announcement must be registered in the composer dock')
  const { Component } = thunk()
  return {
    render: () => harness.render(Component, {}),
    dictionaries,
  }
}

/** The requests the card sent to the announcements route. */
function announcementPosts(fetches) {
  return fetches.filter((call) => (
    call.url.includes('/announcements') && call.init && call.init.method === 'POST'
  ))
}

test('the card is shown and quotes the countdown length that is in effect', async () => {
  const fetches = []
  const mounted = mountAnnouncementPanel({
    storage: createStorage({ ...INSTALL_ANSWERED }),
    fetches,
  })

  assert.equal(mounted.render(), null, 'the card waits for the Host')

  await settle()
  const tree = mounted.render()
  assert.ok(tree, 'the card must be shown when the Host reports a pending announcement')
  assert.equal(tree.props.role, 'status', 'the card must be a status block, not a modal')
  assert.equal(tree.props['data-dsh-autorestart-announcement-feature'], 'sleep')

  const text = textOf(tree)
  assert.match(text, /新功能：收工关机/, 'the card must carry its title')
  assert.match(text, /🌙/, 'the card must name the moon button')
  assert.match(text, /30/, 'the card must quote the countdown length of the configuration')
  assert.match(text, /设置/, 'the card must point at the settings')
  assert.match(text, /知道了/, 'the card must offer the "知道了" button')
})

test('the card does not show when the announcement was already recorded', async () => {
  const fetches = []
  const mounted = mountAnnouncementPanel({
    storage: createStorage({ ...INSTALL_ANSWERED }),
    fetches,
    pending: [],
  })

  assert.equal(mounted.render(), null)
  await settle()
  assert.equal(mounted.render(), null, 'a recorded announcement must not be shown')
})

test('the "知道了" button records the announcement and the card disappears', async () => {
  const fetches = []
  const mounted = mountAnnouncementPanel({
    storage: createStorage({ ...INSTALL_ANSWERED }),
    fetches,
  })

  mounted.render()
  await settle()
  const tree = mounted.render()
  assert.ok(tree, 'the card must be shown')

  const button = walk(tree).find(
    (node) => node.type === 'button' && node.props['data-dsh-autorestart-announcement-ack'],
  )
  assert.ok(button, 'the card must offer the "知道了" button')
  button.props.onClick()

  await settle()
  assert.equal(mounted.render(), null, 'the card must disappear once it was recorded')
  const posts = announcementPosts(fetches)
  assert.equal(posts.length, 1, 'the Host must be told exactly once')
  assert.deepEqual(JSON.parse(posts[0].init.body), { feature: 'sleep' })
})

test('the card stays until the user answered it', async () => {
  const fetches = []
  const mounted = mountAnnouncementPanel({
    storage: createStorage({ ...INSTALL_ANSWERED }),
    fetches,
  })

  mounted.render()
  await settle()
  assert.ok(mounted.render(), 'the card must be shown')
  await settle()
  assert.ok(mounted.render(), 'the card must not disappear on its own')
  assert.equal(announcementPosts(fetches).length, 0, 'an unanswered card must not record anything')
})

test('the install question owns the dock: no announcement while it is unanswered', async () => {
  const fetches = []
  const mounted = mountAnnouncementPanel({
    storage: createStorage(),
    fetches,
  })

  assert.equal(mounted.render(), null, 'a fresh installation must not get two prompts')
  await settle()
  assert.equal(mounted.render(), null, 'a fresh installation must not get two prompts')
  assert.equal(
    fetches.filter((call) => call.url.includes('/announcements')).length,
    0,
    'the card must not even ask the Host while the install question is unanswered',
  )
})

test('the card says that the button is switched off', async () => {
  const fetches = []
  const mounted = mountAnnouncementPanel({
    storage: createStorage({ ...INSTALL_ANSWERED }),
    fetches,
    sleepStatus: { ok: true, phase: 'idle', countdownSeconds: 10, showSleepButton: false },
  })

  mounted.render()
  await settle()
  const tree = mounted.render()
  assert.ok(tree, 'the card must be shown')
  assert.match(textOf(tree), /目前关闭/, 'the card must say that the button is switched off')
  assert.match(textOf(tree), /10/, 'the card must quote the countdown length of the configuration')
})

test('the copy of the card lives in the locale files', () => {
  const zh = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(fs.readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  const mapping = {
    'announcement.title': 'title',
    'announcement.line1': 'line1',
    'announcement.line2': 'line2',
    'announcement.line2.generic': 'line2Generic',
    'announcement.line3': 'line3',
    'announcement.disabled': 'disabled',
    'announcement.button': 'button',
    'announcement.error': 'error',
  }

  const fetches = []
  const mounted = mountAnnouncementPanel({
    storage: createStorage({ ...INSTALL_ANSWERED }),
    fetches,
  })
  const dictionaries = mounted.dictionaries.dshAutorestart
  for (const [clientKey, fileKey] of Object.entries(mapping)) {
    assert.equal(dictionaries.zh[clientKey], zh.announcement[fileKey], `zh.${fileKey} must match the client copy`)
    assert.equal(dictionaries.en[clientKey], en.announcement[fileKey], `en.${fileKey} must match the client copy`)
  }

  assert.match(zh.announcement.disabled, /目前关闭/, 'the zh copy must say that the button is off')
  assert.match(en.announcement.disabled, /switched off/, 'the en copy must say that the button is off')
  assert.match(zh.announcement.button, /知道了/)
  assert.match(en.announcement.button, /Got it/)
})
