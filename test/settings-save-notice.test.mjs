/**
 * The settings page writes a change the moment the user picks it ("change it
 * and it is in effect") — which left the user unable to tell whether it was
 * really stored.
 *
 * So the client got ONE receipt line: a fixed strip at the top of the WINDOW
 * that says "已生效 21:40:12" / "Saved 21:40:12" once the HOST answered
 * `ok: true`, and "没保存成功 — <reason>" / "Not saved — <reason>" in red when
 * it refused.
 *
 * What is pinned here (all with an injected fake Host answer — no real Host is
 * contacted, and the clock is fake, so "3 seconds" is not waited for):
 *
 *   1. a save that came back `ok: true` shows 「已生效」 plus the local time;
 *   2. a refused save shows 「没保存成功」 plus the reason the Host gave, and
 *      the line does NOT disappear by itself;
 *   3. the green line is gone after the 3 seconds, and is still there before;
 *   4. two saves in a row keep ONE line and only update its time;
 *   5. the first render and every poll show NOTHING (no flash);
 *   6. the generated stylesheet positions the line `fixed` at the top centre
 *      of the window (and the class says which kind it is);
 *   7. the copy follows the language (`Saved` / `Not saved` in English);
 *   8. nothing is announced before the Host's answer arrives.
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
 * A tiny React stand-in with PER-COMPONENT hook storage: the settings section
 * and the receipt line are two components of the same window, and they must
 * not share their hook slots.
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

  return { React, render }
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
 * Load the client script in a sandbox and mount both surfaces of this feature.
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
    /** Answer the next save with a promise the test resolves. */
    hold() {
      let release
      const promise = new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, body: { ok: true, applied: 'config' } })
      })
      answers.push(promise)
      return release
    },
    /** No answer was queued: an accepted write (the default of the panel). */
    acceptDefault() {
      answers.push({ ok: true, status: 200, body: { ok: true, applied: 'config' } })
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
      location: { reload: () => {}, replace: () => {}, href: 'http://127.0.0.1:62345/' },
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

  /** The component registered under one slot id. */
  const componentOf = (id) => {
    for (const list of slots.values()) {
      for (const thunk of list) {
        const produced = thunk()
        const entry = (produced && typeof produced.next === 'function') ? produced.next().value : produced
        if (entry && entry.registration && entry.registration.id === id) return entry.Component
      }
    }
    assert.fail(`the component ${id} must be registered`)
  }

  // The two surfaces this feature spans: the settings page (which writes) and
  // the frame-wide receipt (which says what happened).
  const SECTION = componentOf('dsh-autorestart')
  const RECEIPT = componentOf('autorestart-save-notice')

  return {
    clock,
    fetches,
    styles,
    polls,
    host,
    dictionaries,
    /** Mount the settings section, let its polls land, mount it again. */
    settledSection: async () => {
      harness.render(SECTION, {})
      await settle()
      return harness.render(SECTION, {})
    },
    /** One render of the settings section. */
    renderSection: () => harness.render(SECTION, {}),
    /** One render of the receipt line (null while there is no receipt). */
    renderReceipt: () => harness.render(RECEIPT, {}),
  }
}

/** The nodes of a rendered tree that carry one `data-dsh-autorestart-*` key. */
function marked(node, key) {
  return walk(node).filter((entry) => entry.props && entry.props[key] !== undefined)
}

/** The receipt line of a rendered tree, or `null`. */
function receiptOf(tree) {
  const found = marked(tree, 'data-dsh-autorestart-save-notice')
  assert.ok(found.length <= 1, 'there is never more than ONE receipt line')
  return found.length === 0 ? null : found[0]
}

/** The countdown dropdown of the rendered settings section. */
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
 * 5. No flash: the first render and every poll are silent.
 * ------------------------------------------------------------------ */

test('the first render shows no receipt at all', async () => {
  const mounted = mountClient()
  const section = await mounted.settledSection()
  assert.ok(section, 'the settings page must render')

  // The receipt is empty, and its stylesheet was never injected: nothing is on
  // the screen before the Host answered anything.
  assert.equal(mounted.renderReceipt(), null, 'no receipt on the first render')
  assert.equal(mounted.styles.filter((style) => style.id === 'dsh-autorestart-save-notice').length, 0)
})

test('a refresh of the page never raises a receipt', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', countdownSeconds: 20, showSleepButton: true, blockers: [], backupOnRestart: true },
  })
  await mounted.settledSection()
  // The shared poll lands a fresh status (the page reads its values again).
  for (const poll of mounted.polls) await poll()
  await settle()

  mounted.renderSection()
  assert.equal(mounted.renderReceipt(), null, 'a poll is not a save')
})

/* ------------------------------------------------------------------ *
 * 8 + 1. Nothing before the answer; then 「已生效」 with the time.
 * ------------------------------------------------------------------ */

test('the receipt waits for the Host: no answer, no line', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  const release = mounted.host.hold()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()

  // The request is out, the Host has not answered yet: still nothing.
  assert.equal(mounted.renderReceipt(), null, 'a click alone is not a saved setting')

  release()
  await settle()
  const receipt = receiptOf(mounted.renderReceipt())
  assert.ok(receipt, 'the answer of the Host raises the line')
})

test('a saved setting says 「已生效」 with the local time', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  mounted.host.accept()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()

  const receipt = receiptOf(mounted.renderReceipt())
  assert.ok(receipt, 'the Host said ok:true, so the line is there')
  assert.equal(receipt.props['data-dsh-autorestart-save-notice'], 'ok', 'it is the green one')
  assert.equal(receipt.props.className.includes('dsh-autorestart-save-notice--ok'), true)
  assert.equal(receipt.props.role, 'status')

  const text = textOf(receipt)
  assert.equal(text.includes('已生效'), true, `the copy must say it took effect: ${text}`)
  const expected = localClock(mounted.clock.now)
  assert.equal(text.includes(expected), true, `the time of the save must be there: ${text}`)
  assert.match(text, /\d{2}:\d{2}:\d{2}/, 'the short line carries the clock time')
  // The short line stays ONE line: the copy itself is short.
  assert.ok(text.replace('已生效', '').trim().length <= 20)
})

test('the English interface says Saved', async () => {
  const mounted = mountClient({ language: 'en' })
  const panel = await mounted.settledSection()
  mounted.host.accept()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()

  const text = textOf(receiptOf(mounted.renderReceipt()))
  assert.equal(text.includes('Saved'), true, `the English copy: ${text}`)
  assert.match(text, /\d{2}:\d{2}:\d{2}/)
})

/* ------------------------------------------------------------------ *
 * 2. A refusal is red, carries the reason and does not go away.
 * ------------------------------------------------------------------ */

test('a refused save says 「没保存成功」 with the reason of the Host', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  mounted.host.refuse({ body: { ok: false, error: 'config-write-failed' } })
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()

  const receipt = receiptOf(mounted.renderReceipt())
  assert.ok(receipt, 'a refused save must be visible')
  assert.equal(receipt.props['data-dsh-autorestart-save-notice'], 'failed', 'it is the red one')
  assert.equal(receipt.props.className.includes('dsh-autorestart-save-notice--failed'), true)
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
  assert.ok(receiptOf(mounted.renderReceipt()), 'the red line is there')

  // Well past the 3 seconds the green line gets: nothing scheduled a fade.
  mounted.clock.advance(60_000)
  const stillThere = receiptOf(mounted.renderReceipt())
  assert.ok(stillThere, 'a failure is never swallowed by a timer')
  assert.equal(textOf(stillThere).includes('没保存成功'), true)

  // A poll does not clear it either.
  for (const poll of mounted.polls) await poll()
  await settle()
  assert.ok(receiptOf(mounted.renderReceipt()), 'a refresh must not clear the failure')
})

test('the user can close the red line', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  mounted.host.refuse()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()

  const close = marked(mounted.renderReceipt(), 'data-dsh-autorestart-save-notice-close')[0]
  assert.ok(close, 'the red line has a close button')
  assert.equal(close.type, 'button')
  close.props.onClick()
  assert.equal(mounted.renderReceipt(), null, 'the user closed it')
})

test('a save that works clears the red line', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  mounted.host.refuse()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()
  assert.equal(receiptOf(mounted.renderReceipt()).props['data-dsh-autorestart-save-notice'], 'failed')

  mounted.host.accept()
  countdownSelect(mounted.renderSection()).props.onChange({ target: { value: '30' } })
  await settle()
  const receipt = receiptOf(mounted.renderReceipt())
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

  const receipt = receiptOf(mounted.renderReceipt())
  assert.ok(receipt, 'an unconfirmed write must not be announced as saved')
  assert.equal(receipt.props['data-dsh-autorestart-save-notice'], 'failed')
  assert.equal(textOf(receipt).includes('没保存成功'), true)
})

/* ------------------------------------------------------------------ *
 * 3. The green line fades after 3 seconds — not before.
 * ------------------------------------------------------------------ */test('the green line is gone after three seconds', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  mounted.host.accept()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()
  assert.ok(receiptOf(mounted.renderReceipt()), 'it is there right after the save')

  mounted.clock.advance(2999)
  assert.ok(receiptOf(mounted.renderReceipt()), 'a moment later it is still readable')

  mounted.clock.advance(1)
  assert.equal(mounted.renderReceipt(), null, 'after three seconds it is gone')
})

/* ------------------------------------------------------------------ *
 * 4. Two saves, ONE line: the time is updated, nothing is stacked.
 * ------------------------------------------------------------------ */

test('two saves in a row keep one line and update its time', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()

  mounted.host.accept()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()
  const first = receiptOf(mounted.renderReceipt())
  assert.ok(first, 'the first save is announced')
  const firstTime = first.props['data-dsh-autorestart-save-notice-at']
  assert.equal(firstTime, localClock(mounted.clock.now))

  // Five seconds later (the first line would long be gone) a second change.
  mounted.clock.advance(5000)
  mounted.host.accept()
  countdownSelect(mounted.renderSection()).props.onChange({ target: { value: '30' } })
  await settle()

  const tree = mounted.renderReceipt()
  assert.equal(marked(tree, 'data-dsh-autorestart-save-notice').length, 1, 'still exactly ONE line')
  const second = receiptOf(tree)
  const secondTime = second.props['data-dsh-autorestart-save-notice-at']
  assert.notEqual(secondTime, firstTime, 'the time of the line was updated')
  assert.equal(secondTime, localClock(mounted.clock.now))
  assert.equal(textOf(second).includes('已生效'), true)

  // And the fade of the SECOND line starts its own three seconds.
  mounted.clock.advance(2999)
  assert.ok(receiptOf(mounted.renderReceipt()), 'the new line gets its own three seconds')
  mounted.clock.advance(1)
  assert.equal(mounted.renderReceipt(), null)
})

/* ------------------------------------------------------------------ *
 * 6. The look: fixed, at the top centre of the window.
 * ------------------------------------------------------------------ */

test('the line is a fixed strip at the top centre of the window', async () => {
  const mounted = mountClient()
  const panel = await mounted.settledSection()
  mounted.host.accept()
  countdownSelect(panel).props.onChange({ target: { value: '60' } })
  await settle()

  const receipt = receiptOf(mounted.renderReceipt())
  assert.equal(receipt.props.className.includes('dsh-autorestart-save-notice'), true, 'the class of the line')

  const style = mounted.styles.find((entry) => entry.id === 'dsh-autorestart-save-notice')
  assert.ok(style, 'the stylesheet of the line must be injected')
  const css = style.text
  assert.equal(css.includes('position:fixed;'), true, 'the line must not scroll away')
  assert.equal(css.includes('left:50%;'), true, 'it hangs in the middle')
  assert.equal(css.includes('transform:translateX(-50%);'), true, 'centred on that middle')
  assert.match(css, /top:calc\(var\(--dsh-frame-chrome-top,0px\) \+ 8px\)/, 'below the top bar buttons')
  assert.match(css, /z-index:9\d{3}/, 'above the content')
  assert.equal(css.includes('pointer-events:none;'), true, 'it never eats a click of the top bar')
  assert.equal(css.includes('.dsh-autorestart-save-notice__close'), true, 'the close button takes one')

  // The strip itself lets clicks through, and it says which kind it is.
  assert.equal(receipt.props.style.pointerEvents, 'none')
  const close = marked(receipt, 'data-dsh-autorestart-save-notice-close')[0]
  assert.equal(close.props.style.pointerEvents, 'auto', 'only the close button takes a click')
})

/* ------------------------------------------------------------------ *
 * The copy: short, bilingual, in both dictionaries and both locale files.
 * ------------------------------------------------------------------ */

test('the copy is short and exists in both languages and both locale files', () => {
  const mounted = mountClient()
  const arabic = { zh: mounted.dictionaries.dshAutorestart.zh, en: mounted.dictionaries.dshAutorestart.en }
  const keys = ['settings.saveNotice.saved', 'settings.saveNotice.failed', 'settings.saveNotice.dismiss']
  for (const key of keys) {
    assert.equal(typeof arabic.zh[key], 'string', `zh.${key} is missing`)
    assert.equal(typeof arabic.en[key], 'string', `en.${key} is missing`)
    // "extremely short": the longest of the two copies stays tiny.
    assert.ok(arabic.zh[key].length <= 10, `zh.${key} is too long: ${arabic.zh[key]}`)
    assert.ok(arabic.en[key].length <= 10, `en.${key} is too long: ${arabic.en[key]}`)
  }
  assert.equal(arabic.zh['settings.saveNotice.saved'], '已生效')
  assert.equal(arabic.en['settings.saveNotice.saved'], 'Saved')
  assert.equal(arabic.zh['settings.saveNotice.failed'], '没保存成功')
  assert.equal(arabic.en['settings.saveNotice.failed'], 'Not saved')

  // The locale files are the MIRROR of the dictionaries.
  for (const language of ['zh', 'en']) {
    const file = JSON.parse(fs.readFileSync(new URL(`../locale/${language}.json`, import.meta.url), 'utf8'))
    const mirror = mounted.dictionaries.dshAutorestart[language]
    assert.equal(file.settings.saveNotice.saved, mirror['settings.saveNotice.saved'])
    assert.equal(file.settings.saveNotice.failed, mirror['settings.saveNotice.failed'])
    assert.equal(file.settings.saveNotice.dismiss, mirror['settings.saveNotice.dismiss'])
  }
})

/* ------------------------------------------------------------------ *
 * The registration: the receipt lives on the frame-wide overlay slot.
 * ------------------------------------------------------------------ */

test('the receipt is registered on the frame-wide overlay slot', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // The line must be a SHELL overlay: inside the settings column it would be
  // clipped by the column that scrolls.
  assert.equal(
    /ctx\.slots\.inject\('shell\.overlay'[\s\S]{0,200}id: 'autorestart-save-notice'/.test(source),
    true,
    'the receipt must be registered on shell.overlay',
  )
})
