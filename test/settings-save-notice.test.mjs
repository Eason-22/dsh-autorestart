/**
 * The settings page writes a change the moment the user picks it ("change it
 * and it is in effect") — which left the user unable to tell whether it was
 * really stored.
 *
 * So the plugin got ONE receipt line: 「已生效 21:40:12」 / 「Saved 21:40:12」
 * once the HOST answered `ok: true`, and 「没保存成功 — <reason>」 /
 * 「Not saved — <reason>」 in red when it refused.
 *
 * WHERE it lives is a rule of its own, and this file pins it: the line is a
 * `sticky` strip AT THE TOP OF THE SETTINGS PANEL — a child of the panel's own
 * tree. It used to be a window overlay (`shell.overlay`), and the user saw it
 * floating over the conversation area: outside the dialog it belonged to. The
 * first two tests below assert the DOM ancestry and the absence of that
 * registration, because "inside the panel" is exactly what went wrong.
 *
 * What is pinned here (all with an injected fake Host answer — no real Host is
 * contacted, and the clock is fake, so "3 seconds" is not waited for):
 *
 *   1. the receipt is drawn INSIDE the settings panel, and nothing registers it
 *      on `shell.overlay` any more;
 *   2. closing the panel drops it (reopening is clean);
 *   3. the strip is `sticky` at the top of the panel, 30px high, and it covers
 *      instead of pushing the form down;
 *   4. a save that came back `ok: true` shows 「已生效」 plus the local time;
 *   5. a refused save shows 「没保存成功」 plus the reason, and does not fade;
 *   6. the green line is gone after 3 seconds, and is still there before;
 *   7. two saves in a row keep ONE line and only update its time;
 *   8. the first render and every poll show NOTHING (no flash);
 *   9. nothing is announced before the Host's answer arrives;
 *  10. the copy follows the language and stays short.
 *
 * The client is a CLASSIC script (one IIFE, no ESM exports), so it is loaded
 * in a sandbox exactly the way the browser evaluates it.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

/* ------------------------------------------------------------------ *
 * A tiny React stand-in, a fake clock and the client harness.
 * ------------------------------------------------------------------ */

/** Whether two dependency lists are the same. */
function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/**
 * A tiny React stand-in with PER-COMPONENT hook storage, and a real UNMOUNT:
 * the settings page can be closed, and its cleanups must run then.
 */
function createReactHarness() {
  const components = new Map()
  let current = null
  let pendingEffects = []

  const stateOf = (Component) => {
    let state = components.get(Component)
    if (!state) {
      state = { hooks: [], cursor: 0 }
      components.set(Component, state)
    }
    return state
  }

  const slotAt = (state, index) => {
    while (state.hooks.length <= index) {
      state.hooks.push({ value: undefined, deps: undefined, cleanup: undefined, initialized: false, effectInit: false })
    }
    return state.hooks[index]
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
      const state = current
      const index = state.cursor
      state.cursor += 1
      const slot = slotAt(state, index)
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
      const state = current
      const index = state.cursor
      state.cursor += 1
      const slot = slotAt(state, index)
      if (!slot.initialized) {
        slot.initialized = true
        slot.value = { current: initial }
      }
      return slot.value
    },
    useEffect(fn, deps) {
      const state = current
      const index = state.cursor
      state.cursor += 1
      const slot = slotAt(state, index)
      const changed = !slot.effectInit || !sameDeps(slot.deps, deps)
      slot.deps = deps
      slot.effectInit = true
      if (changed) pendingEffects.push({ slot, fn })
    },
  }

  const render = (Component, props) => {
    current = stateOf(Component)
    current.cursor = 0
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

  /** Close the component: every cleanup it registered runs, its hooks are gone. */
  const unmount = (Component) => {
    const state = components.get(Component)
    if (!state) return
    for (const slot of state.hooks) {
      if (typeof slot.cleanup === 'function') {
        const cleanup = slot.cleanup
        slot.cleanup = undefined
        cleanup()
      }
    }
    components.delete(Component)
  }

  return { React, render, unmount }
}

/**
 * A clock the test drives by hand: `setTimeout` is recorded instead of waiting,
 * so "3 seconds later" costs nothing and is exact.
 */
function createClock(start = Date.UTC(2026, 9, 29, 13, 40, 12)) {
  const clock = {
    now: start,
    timers: [],
    count: 0,
    setTimeout(fn, ms) {
      clock.count += 1
      const timer = { id: clock.count, fn, ms, due: clock.now + ms }
      clock.timers.push(timer)
      return timer
    },
    clearTimeout(handle) {
      const index = clock.timers.indexOf(handle)
      if (index !== -1) clock.timers.splice(index, 1)
    },
    /** Move the clock forward and run whatever became due. */
    advance(ms) {
      clock.now += ms
      const due = clock.timers.filter((timer) => timer.due <= clock.now).sort((a, b) => a.due - b.due)
      for (const timer of due) {
        const index = clock.timers.indexOf(timer)
        if (index === -1) continue
        clock.timers.splice(index, 1)
        timer.fn()
      }
    },
  }
  return clock
}

/** A localStorage stand-in. */
function createStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    clear: () => { map.clear() },
  }
}

/** Every node of a rendered tree. */
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

/** Let the pending promises settle (the fake fetch is still a promise). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

/**
 * Load the client script in a sandbox and mount the settings section.
 *
 * The fake Host is a QUEUE of answers: a test decides what the next save
 * answers, so a refusal, an accepted write and a request that never answers are
 * all one line of setup.
 */
function mountClient({ language = 'zh', info = {}, status = null } = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const clock = createClock()
  const FakeDate = class extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now)
      else super(...args)
    }

    static now() {
      return clock.now
    }
  }

  let definition = null
  const fetches = []
  const styles = []
  const polls = []
  // What the next POST /choice answers: `{ ok, status, body }` or a promise.
  const answers = []
  const host = {
    /** Answer the next save with a receipt (`ok: true`). */
    accept(body = { ok: true, applied: 'config' }) {
      answers.push({ ok: true, status: 200, body })
    },
    /** Answer the next save with a refusal. */
    refuse({ status = 400, body = { ok: false, error: 'config-write-failed' } } = {}) {
      answers.push({ ok: false, status, body })
    },
    /** Answer the next save with a promise the test resolves by hand. */
    hold() {
      let release
      const promise = new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, body: { ok: true, applied: 'config' } })
      })
      answers.push(promise)
      return release
    },
  }

  const sandbox = {
    window: {
      __ModuleLoader__: { load: (value) => { definition = value } },
      localStorage: createStorage(),
      sessionStorage: createStorage(),
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { reload: () => {}, replace: () => {}, href: 'http://127.0.0.1:58437/' },
    },
    document: {
      getElementById: () => null,
      createElement: (tag) => ({
        tag,
        id: '',
        textContent: '',
        parentNode: null,
        style: {},
        setAttribute: () => {},
        appendChild: () => {},
      }),
      head: {
        appendChild: (node) => {
          // The stylesheet the client injects is kept, so a test can read it.
          if (node && node.tag === 'style') styles.push({ id: node.id, text: node.textContent })
          node.parentNode = sandbox.document.head
          return node
        },
        removeChild: () => {},
      },
      querySelector: () => null,
      body: { appendChild: () => {}, removeChild: () => {} },
    },
    navigator: { language: language === 'en' ? 'en-US' : 'zh-CN' },
    fetch: (url, init) => {
      const target = String(url)
      fetches.push({ url: target, init })
      if (target.includes('/choice') && init && init.method === 'POST') {
        const answer = answers.length > 0 ? answers.shift() : { ok: true, status: 200, body: { ok: true } }
        const reply = (value) => Promise.resolve({
          ok: value.ok,
          status: value.status,
          json: async () => value.body,
        })
        return answer instanceof Promise ? answer.then(reply) : reply(answer)
      }
      if (target.includes('/sleep')) {
        // The GET poll: the panel re-reads the effective values here.
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => (status || { ok: true, phase: 'idle', countdownSeconds: 20, showSleepButton: true, blockers: [] }),
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, pendingRestart: false, ...info }),
      })
    },
    console,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (handle) => clock.clearTimeout(handle),
    // The shared polls: the callback is kept, so a test delivers a refresh
    // without waiting for the real 2s tick.
    setInterval: (fn) => { polls.push(fn); return polls.length },
    clearInterval: () => {},
    AbortController,
    Date: FakeDate,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.ok(definition, 'the client script must register itself with the module loader')

  const harness = createReactHarness()
  const module = definition.factory(() => harness.React)

  const dictionaries = {}
  const slots = new Map()
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: {
      register: (namespace, value) => { dictionaries[namespace] = value },
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

  /** Every component the plugin registered, with the slot it lives in. */
  const registered = () => {
    const entries = []
    for (const [slot, list] of slots) {
      for (const thunk of list) {
        const produced = thunk()
        const entry = (produced && typeof produced.next === 'function') ? produced.next().value : produced
        if (entry && entry.registration) entries.push({ slot, id: entry.registration.id, Component: entry.Component })
      }
    }
    return entries
  }

  const section = registered().find((entry) => entry.id === 'dsh-autorestart')
  assert.ok(section, 'the settings section must be registered')

  return {
    clock,
    fetches,
    styles,
    polls,
    host,
    dictionaries,
    registered,
    /** Mount the settings page, let its polls land, mount it again. */
    settledSection: async () => {
      harness.render(section.Component, {})
      await settle()
      return harness.render(section.Component, {})
    },
    /** One render of the settings page. */
    renderSection: () => harness.render(section.Component, {}),
    /** Close the settings page: the component unmounts and its cleanups run. */
    closeSection: () => harness.unmount(section.Component),
  }
}

/** The nodes of a rendered tree that carry one `data-dsh-autorestart-*` key. */
function marked(node, key) {
  return walk(node).filter((entry) => entry.props && entry.props[key] !== undefined)
}

/** The receipt of a rendered tree, or `null`. */
function receiptOf(tree) {
  const found = marked(tree, 'data-dsh-autorestart-save-notice')
  assert.ok(found.length <= 1, 'there is never more than ONE receipt')
  return found.length === 0 ? null : found[0]
}

/** The panel node of the settings section (the dialog's own content root). */
function panelOf(tree) {
  return walk(tree).find((node) => node.props && node.props.className === 'dsh-autorestart-settings')
}

/** Whether `node` is a descendant of `root`. */
function isInside(root, node) {
  return walk(root).some((entry) => entry === node)
}

/** The countdown dropdown of the rendered settings page. */
function countdownSelect(panel) {
  const select = walk(panel).find(
    (node) => node.type === 'select'
      && node.props['data-dsh-autorestart-setting'] === 'sleepCountdownSeconds',
  )
  assert.ok(select, 'the countdown dropdown must be there')
  return select
}

/** The local HH:MM:SS of a moment (the client formats in local time too). */
function localClock(at) {
  const moment = new Date(at)
  const pad = (value) => (value < 10 ? '0' + value : String(value))
  return `${pad(moment.getHours())}:${pad(moment.getMinutes())}:${pad(moment.getSeconds())}`
}

/* ------------------------------------------------------------------ *
 * 1. The mount point: INSIDE the settings panel, not on the window.
 * ------------------------------------------------------------------ */

test('the receipt is drawn INSIDE the settings panel, not on the window', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  mounted.host.accept()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()

  const tree = mounted.renderSection()
  const panelNode = panelOf(tree)
  assert.ok(panelNode, 'the settings panel must be rendered')
  const receipt = receiptOf(tree)
  assert.ok(receipt, 'the receipt must be there after a save')
  assert.equal(
    isInside(panelNode, receipt),
    true,
    'the receipt must be a DESCENDANT of the settings panel (it used to float over the conversation area)',
  )
  assert.equal(receipt, panelNode.children[0], 'it is the FIRST thing in the panel (the top of the dialog)')

  // No window overlay carries it any more.
  const overlayIds = mounted.registered()
    .filter((entry) => entry.slot === 'shell.overlay')
    .map((entry) => entry.id)
  assert.equal(
    overlayIds.includes('autorestart-save-notice'),
    false,
    'nothing registers the receipt on shell.overlay: ' + overlayIds.join(', '),
  )

  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.equal(
    /ctx\.slots\.inject\('shell\.overlay'[\s\S]{0,220}autorestart-save-notice/.test(source),
    false,
    'the receipt must not be registered on shell.overlay',
  )
})

test('closing the settings page throws the receipt away', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  mounted.host.accept()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()
  assert.ok(receiptOf(mounted.renderSection()), 'the receipt is there while the page is open')

  // The user closes the settings: the component unmounts and its cleanups run.
  mounted.closeSection()
  const reopened = mounted.renderSection()
  assert.equal(receiptOf(reopened), null, 'a reopened settings page shows no receipt of the last visit')
})

/* ------------------------------------------------------------------ *
 * 2. The look: a sticky strip at the top of the panel.
 * ------------------------------------------------------------------ */

test('the strip is sticky at the top of the panel and does not push the form', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  mounted.host.accept()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()

  const receipt = receiptOf(mounted.renderSection())
  assert.equal(
    String(receipt.props.className).includes('dsh-autorestart-save-notice'),
    true,
    'the class of the strip',
  )

  const style = mounted.styles.find((entry) => entry.id === 'dsh-autorestart-save-notice')
  assert.ok(style, 'the stylesheet of the receipt must be injected')
  const css = style.text
  assert.equal(css.includes('position:sticky;'), true, 'it must stick to the top while the settings scroll')
  assert.equal(css.includes('top:0;'), true, 'stuck at the very top of the panel')
  assert.equal(css.includes('height:0;'), true, 'it covers the first line instead of pushing the form down')
  assert.equal(css.includes('position:fixed;'), false, 'it must not be a window overlay any more')
  // 28-32px high, as asked.
  assert.match(css, /height:30px/)
  // A light green ground and a light red one.
  assert.match(css, /--ok[\s\S]*?background:color-mix\(in srgb, var\(--dsw-alias-state-success/)
  assert.match(css, /--failed[\s\S]*?background:color-mix\(in srgb, var\(--dsw-alias-danger/)

  // LEFT = the copy, RIGHT = the small time, then the close button.
  const bar = receipt.children.find((child) => child && child.props
    && String(child.props.className).includes('__bar'))
  assert.ok(bar, 'the strip has one bar')
  const parts = bar.children.map((child) => String((child.props && child.props.className) || ''))
  assert.equal(parts[0].includes('__title'), true, 'the copy comes first')
  assert.equal(parts.includes('dsh-autorestart-save-notice__time'), true, 'the time follows')
  assert.equal(parts.some((part) => part.includes('__close')), true, 'and the close button after it')
  assert.equal(textOf(receipt).trim().endsWith('×'), true, 'the close button is the last thing')
})

/* ------------------------------------------------------------------ *
 * 3. No flash: the first render and every poll are silent.
 * ------------------------------------------------------------------ */

test('the first render shows no receipt at all', async () => {
  const mounted = mountClient()
  const section = await mounted.settledSection()
  assert.ok(section, 'the settings page must render')

  assert.ok(panelOf(section), 'the panel is there')
  assert.equal(receiptOf(section), null, 'no receipt on the first render')
  assert.equal(
    mounted.styles.filter((style) => style.id === 'dsh-autorestart-save-notice').length,
    0,
    'its stylesheet is not even injected',
  )
})

test('a refresh of the page never raises a receipt', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', countdownSeconds: 20, showSleepButton: true, blockers: [], backupOnRestart: true },
  })
  await mounted.settledSection()
  // The shared poll lands a fresh status (the page reads its values again).
  for (const poll of mounted.polls) await poll()
  await settle()

  assert.equal(receiptOf(mounted.renderSection()), null, 'a poll is not a save')
})

/* ------------------------------------------------------------------ *
 * 4. Nothing before the answer; then 「已生效」 with the time.
 * ------------------------------------------------------------------ */

test('the receipt waits for the Host: no answer, no line', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  const release = mounted.host.hold()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()

  // The request is out, the Host has not answered yet: still nothing.
  assert.equal(receiptOf(mounted.renderSection()), null, 'a click alone is not a saved setting')

  release()
  await settle()
  assert.ok(receiptOf(mounted.renderSection()), 'the answer of the Host raises the line')
})

test('a saved setting says 「已生效」 with the local time', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  mounted.host.accept()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()

  const receipt = receiptOf(mounted.renderSection())
  assert.ok(receipt, 'the Host said ok:true, so the line is there')
  assert.equal(receipt.props['data-dsh-autorestart-save-notice'], 'ok', 'it is the green one')
  assert.equal(String(receipt.props.className).includes('dsh-autorestart-save-notice--ok'), true)
  assert.equal(receipt.props.role, 'status')

  const text = textOf(receipt)
  assert.equal(text.includes('已生效'), true, `the copy must say it took effect: ${text}`)
  const expected = localClock(mounted.clock.now)
  assert.equal(text.includes(expected), true, `the time of the save must be there: ${text}`)
  assert.match(text, /\d{2}:\d{2}:\d{2}/, 'the short line carries the clock time')
  // The short line stays ONE line: the copy itself is short.
  assert.ok(text.replace('已生效', '').replace('×', '').trim().length <= 20)
})

test('the English interface says Saved', async () => {
  const mounted = mountClient({ language: 'en' })
  const panel = await mounted.settledSection()
  mounted.host.accept()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()

  const text = textOf(receiptOf(mounted.renderSection()))
  assert.equal(text.includes('Saved'), true, `the English copy: ${text}`)
  assert.match(text, /\d{2}:\d{2}:\d{2}/)
})

/* ------------------------------------------------------------------ *
 * 5. A refusal is red, carries the reason and does not go away.
 * ------------------------------------------------------------------ */

test('a refused save says 「没保存成功」 with the reason of the Host', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  mounted.host.refuse({ body: { ok: false, error: 'config-write-failed' } })
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()

  const receipt = receiptOf(mounted.renderSection())
  assert.ok(receipt, 'a refused save must be visible')
  assert.equal(receipt.props['data-dsh-autorestart-save-notice'], 'failed', 'it is the red one')
  assert.equal(String(receipt.props.className).includes('dsh-autorestart-save-notice--failed'), true)
  assert.equal(receipt.props.role, 'alert')

  const text = textOf(receipt)
  assert.equal(text.includes('没保存成功'), true, `the copy must say it did not save: ${text}`)
  assert.equal(text.includes('config-write-failed'), true, `the reason of the Host must be there: ${text}`)
})

test('the red line does not disappear on its own', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  mounted.host.refuse()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()
  assert.ok(receiptOf(mounted.renderSection()), 'the red line is there')

  // Well past the 3 seconds the green line gets: nothing scheduled a fade.
  mounted.clock.advance(60_000)
  const stillThere = receiptOf(mounted.renderSection())
  assert.ok(stillThere, 'a failure is never swallowed by a timer')
  assert.equal(textOf(stillThere).includes('没保存成功'), true)

  // A poll does not clear it either.
  for (const poll of mounted.polls) await poll()
  await settle()
  assert.ok(receiptOf(mounted.renderSection()), 'a refresh must not clear the failure')
})

test('the user can close the red line', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  mounted.host.refuse()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()

  const close = marked(mounted.renderSection(), 'data-dsh-autorestart-save-notice-close')[0]
  assert.ok(close, 'the red line has a close button')
  assert.equal(close.type, 'button')
  close.props.onClick()
  assert.equal(receiptOf(mounted.renderSection()), null, 'the user closed it')
})

test('a save that works clears the red line', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  mounted.host.refuse()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()
  assert.equal(receiptOf(mounted.renderSection()).props['data-dsh-autorestart-save-notice'], 'failed')

  mounted.host.accept()
  countdownSelect(mounted.renderSection()).props.onChange({ target: { value: '30' } })
  await settle()
  const receipt = receiptOf(mounted.renderSection())
  assert.equal(receipt.props['data-dsh-autorestart-save-notice'], 'ok', 'the red line gave way to the green one')
  assert.equal(textOf(receipt).includes('没保存成功'), false)
})

test('an HTTP 200 without the ok:true of the Host is not a save', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  // The route answered, but without the receipt the settings page is built on.
  mounted.host.accept({ applied: 'config' })
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()

  const receipt = receiptOf(mounted.renderSection())
  assert.ok(receipt, 'an unconfirmed write must not be announced as saved')
  assert.equal(receipt.props['data-dsh-autorestart-save-notice'], 'failed')
  assert.equal(textOf(receipt).includes('没保存成功'), true)
})

/* ------------------------------------------------------------------ *
 * 6. The green line fades after 3 seconds — not before.
 * ------------------------------------------------------------------ */

test('the green line is gone after three seconds', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  mounted.host.accept()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()
  assert.ok(receiptOf(mounted.renderSection()), 'it is there right after the save')

  mounted.clock.advance(2999)
  assert.ok(receiptOf(mounted.renderSection()), 'a moment later it is still readable')

  mounted.clock.advance(1)
  assert.equal(receiptOf(mounted.renderSection()), null, 'after three seconds it is gone')
})

/* ------------------------------------------------------------------ *
 * 7. Two saves, ONE line: the time is updated, nothing is stacked.
 * ------------------------------------------------------------------ */

test('two saves in a row keep one line and update its time', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()

  mounted.host.accept()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()
  const first = receiptOf(mounted.renderSection())
  assert.ok(first, 'the first save is announced')
  const firstTime = first.props['data-dsh-autorestart-save-notice-at']
  assert.equal(firstTime, localClock(mounted.clock.now))

  // Five seconds later (the first line would long be gone) a second change.
  mounted.clock.advance(5000)
  mounted.host.accept()
  countdownSelect(mounted.renderSection()).props.onChange({ target: { value: '30' } })
  await settle()

  const tree = mounted.renderSection()
  assert.equal(marked(tree, 'data-dsh-autorestart-save-notice').length, 1, 'still exactly ONE line')
  const second = receiptOf(tree)
  const secondTime = second.props['data-dsh-autorestart-save-notice-at']
  assert.notEqual(secondTime, firstTime, 'the time of the line was updated')
  assert.equal(secondTime, localClock(mounted.clock.now))
  assert.equal(textOf(second).includes('已生效'), true)

  // And the fade of the SECOND line starts its own three seconds.
  mounted.clock.advance(2999)
  assert.ok(receiptOf(mounted.renderSection()), 'the new line gets its own three seconds')
  mounted.clock.advance(1)
  assert.equal(receiptOf(mounted.renderSection()), null)
})

/* ------------------------------------------------------------------ *
 * The copy: short, bilingual, in both dictionaries and both locale files.
 * ------------------------------------------------------------------ */

test('the copy is short and exists in both languages and both locale files', () => {
  const mounted = mountClient()
  const both = { zh: mounted.dictionaries.dshAutorestart.zh, en: mounted.dictionaries.dshAutorestart.en }
  const keys = ['settings.saveNotice.saved', 'settings.saveNotice.failed', 'settings.saveNotice.dismiss']
  for (const key of keys) {
    assert.equal(typeof both.zh[key], 'string', `zh.${key} is missing`)
    assert.equal(typeof both.en[key], 'string', `en.${key} is missing`)
    // "extremely short": the longest of the two copies stays tiny.
    assert.ok(both.zh[key].length <= 10, `zh.${key} is too long: ${both.zh[key]}`)
    assert.ok(both.en[key].length <= 10, `en.${key} is too long: ${both.en[key]}`)
  }
  assert.equal(both.zh['settings.saveNotice.saved'], '已生效')
  assert.equal(both.en['settings.saveNotice.saved'], 'Saved')
  assert.equal(both.zh['settings.saveNotice.failed'], '没保存成功')
  assert.equal(both.en['settings.saveNotice.failed'], 'Not saved')

  // The locale files are the MIRROR of the dictionaries.
  for (const language of ['zh', 'en']) {
    const file = JSON.parse(fs.readFileSync(new URL(`../locale/${language}.json`, import.meta.url), 'utf8'))
    const mirror = mounted.dictionaries.dshAutorestart[language]
    assert.equal(file.settings.saveNotice.saved, mirror['settings.saveNotice.saved'])
    assert.equal(file.settings.saveNotice.failed, mirror['settings.saveNotice.failed'])
    assert.equal(file.settings.saveNotice.dismiss, mirror['settings.saveNotice.dismiss'])
  }
})
