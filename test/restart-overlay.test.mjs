/**
 * THE RESTART STAGE ON THE INTERFACE — the centred overlay, and the short line
 * the composer row keeps.
 *
 * THE REPORT (user, 2026-10-29): the stage of a restart lived in the composer
 * row — one clipped line inside a 22px toolbar. On a window that is not very
 * wide it read "正在等待所有会话空闲…" and the rest was CUT OFF, so the one
 * thing the user needed (how many conversations still hold the restart, how
 * much of the backup is written) was exactly what the ellipsis ate.
 *
 * THE FIX, as this file pins it down:
 *
 *   1. the DETAIL moved to a CENTRED OVERLAY (320px, one short line, a real
 *      progress bar): waiting = "等待会话空闲" + "还有 N 个会话",
 *      snapshotting = "DSH 重启前备份中" + the bar + "12.3 MB / 40 MB" + "31%",
 *      restarting = "正在重启…", back = "已回来" for 1.5s and then gone;
 *   2. the composer row got SHORT again: one line, never a sentence, and the
 *      long text of the Host never appears there any more;
 *   3. the overlay is PER PAGE: it reads what its host reports and remembers
 *      nothing, so an interface that is opened again shows the real stage.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// The client script publishes its pure helpers on the global namespace.
import '../client.js'

const api = globalThis.__dshAutorestartClient

/* ------------------------------------------------------------------ *
 * A tiny React stand-in (the client half is a classic script).
 * ------------------------------------------------------------------ */

function createStorage() {
  const values = new Map()
  return {
    getItem: (key) => (values.has(String(key)) ? values.get(String(key)) : null),
    setItem: (key, value) => { values.set(String(key), String(value)) },
    removeItem: (key) => { values.delete(String(key)) },
    clear: () => { values.clear() },
  }
}

function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

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

/** The node that carries `attribute` (undefined when absent). */
function findByAttribute(tree, attribute) {
  return walk(tree).find((node) => node.props && node.props[attribute] !== undefined)
}

/* ------------------------------------------------------------------ *
 * The Host payload: what `GET …/health?state=1` really answers.
 * ------------------------------------------------------------------ */

/** The long sentence the user could not read (kept as the tooltip only). */
const LONG_ZH = '正在等待所有会话空闲…（还有 2 个会话在忙）'
const LONG_EN = 'Waiting for every conversation to be idle… (2 conversations busy)'

/**
 * A pending restart this page waits for, with the stage the Host reports.
 *
 * @param {{ phase?: string, blocking?: number, progress?: object|null, blockedBy?: object[] }} [options]
 */
function statePayload({
  phase = 'waiting',
  pendingRestart = true,
  blocking = 2,
  progress = null,
  blockedBy = null,
  snapshotBytes = null,
} = {}) {
  return {
    ok: true,
    pendingRestart,
    waiters: ['sess-x'],
    blockedBy: blockedBy || [
      { sessionId: 'sess-y', kind: 'session', label: '写代码', name: '写代码', reason: 'running' },
      { sessionId: 'sess-z', kind: 'session', label: '调研', name: '调研', reason: 'running' },
    ],
    allowRestart: false,
    reason: 'blocked',
    restartPhase: {
      phase,
      at: Date.now(),
      elapsedMs: 3000,
      // The number the overlay prints: it travels as a NUMBER, not only inside
      // the sentence (a surface with room for two words must not parse a text).
      blocking,
      progress,
      // The size of the pre-restart snapshot, carried on EVERY stage (the Host
      // keeps it so a page that missed the copy can still report it).
      snapshotBytes,
      slow: null,
      cancellable: phase === 'waiting' || phase === 'snapshotting',
      cancelReason: null,
      text: { zh: LONG_ZH, en: LONG_EN },
    },
  }
}

/** Mount the client with a mutable Host state. */
function mountClient({ health = {}, language = 'zh' } = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
  const dictionaries = {}
  const slots = new Map()
  const pollers = []
  const state = { health: { ...health } }

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => { definition = value },
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
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => state.health }),
    console,
    setTimeout,
    clearTimeout,
    // The shared poll: its interval callback is kept, so a test can move the
    // Host on (a restart does not stand still while a page watches it).
    setInterval: (fn) => { pollers.push(fn); return pollers.length },
    clearInterval: () => {},
    AbortController,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.ok(definition, 'the client script must register itself with the module loader')

  const harness = createReactHarness()
  const module = definition.factory(() => harness.React)
  const ctx = {
    effect: (fn) => {
      fn()
      return () => {}
    },
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
    /** The state the Host reports. */
    setHealth: (next) => { state.health = { ...next } },
    /** The slot names the plugin registered (the overlay lives in shell.overlay). */
    slotNames: () => [...slots.keys()],
    /** Render once (and let a pending poll land), then render again. */
    settled: async (id, props) => {
      const Component = componentOf(id)
      harness.render(Component, props || {})
      await new Promise((resolve) => setTimeout(resolve, 5))
      return harness.render(Component, props || {})
    },
    /** ONE render, without a poll: this is what the FIRST frame shows. */
    firstFrame: (id) => harness.render(componentOf(id), {}),
    /** Let the shared poll land (one round), then render. */
    poll: async (id) => {
      for (const poller of pollers) poller()
      await new Promise((resolve) => setTimeout(resolve, 5))
      return harness.render(componentOf(id), {})
    },
    /** Render without waiting for the poll (the timer tests need the same tree). */
    render: (id, props) => harness.render(componentOf(id), props || {}),
  }
}

/** The pill's visible capsule (not the tooltip, not the panel). */
function capsuleOf(pill) {
  return walk(pill).find((node) => node.props && node.props['aria-haspopup'] === 'dialog')
}

/** The one visible line of the composer row. */
function capsuleCopy(pill) {
  const capsule = capsuleOf(pill)
  assert.ok(capsule, 'the pill must be on screen')
  return textOf(capsule)
}

/** The CJK characters of a text (what a reader counts as 字). */
function cjkCount(text) {
  return [...String(text)].filter((character) => /[\u3400-\u9fff]/.test(character)).length
}

/* ------------------------------------------------------------------ *
 * 1. WHILE THE GATE WAITS THERE IS NO CARD AT ALL (the user's second report).
 * ------------------------------------------------------------------ */

test('phase=waiting (pending): the overlay is NOT drawn — the pill carries the count', async () => {
  const mounted = mountClient({ health: statePayload({ phase: 'waiting', pendingRestart: true, blocking: 2 }) })
  const overlay = await mounted.settled('autorestart-restart-overlay')
  assert.equal(
    overlay,
    null,
    'nothing is in progress yet, so no card: "不是应该触发备份才触发吗？"',
  )

  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const copy = capsuleCopy(pill)
  assert.match(copy, /^待重启 · 等待 2 个/, `the pill still says how many conversations hold it: ${copy}`)
})

test('the FIRST frame of a page never flashes a card', async () => {
  const mounted = mountClient({
    health: statePayload({ phase: 'snapshotting', progress: { bytes: 1024 * 1024, total: 2 * 1024 * 1024, percent: 50 } }),
  })
  // Before the first poll there is no state at all: the first frame is empty.
  assert.equal(mounted.firstFrame('autorestart-restart-overlay'), null, 'no card on the very first frame')
})

test('no restart at all: an idle host draws nothing, ever', async () => {
  const mounted = mountClient({ health: { ok: true, pendingRestart: false } })
  assert.equal(mounted.firstFrame('autorestart-restart-overlay'), null)
  assert.equal(await mounted.settled('autorestart-restart-overlay'), null)
})

/* ------------------------------------------------------------------ *
 * 2. The centred overlay: the backup, with the real numbers.
 * ------------------------------------------------------------------ */

test('phase=snapshotting: the overlay shows the megabytes, the percentage and a real bar', async () => {
  const progress = {
    bytes: Math.round(12.3 * 1024 * 1024),
    total: 40 * 1024 * 1024,
    percent: 31,
    files: 120,
    filesTotal: 400,
  }
  const mounted = mountClient({ health: statePayload({ phase: 'snapshotting', progress }) })
  const overlay = await mounted.settled('autorestart-restart-overlay')

  assert.ok(overlay, 'the overlay shows the backup')
  assert.equal(overlay.props['data-dsh-autorestart-restart-overlay-phase'], 'snapshotting')
  const copy = textOf(overlay)
  // THE OWNER'S SECOND REPORT: "正在备份" did not say WHAT was being backed up.
  assert.match(copy, /重启前备份中/, `the card says what the backup is for: ${copy}`)
  assert.doesNotMatch(copy, /正在备份/, `no bare "正在备份" on the card any more: ${copy}`)
  // The unit travels with the number (see formatOverlaySize): a real backup
  // must never be rounded down to "0 MB".
  assert.match(copy, /12\.3 MB \/ 40 MB/, `the measured size is on the card: ${copy}`)
  assert.match(copy, /31%/, `the percentage is on the card: ${copy}`)

  const bar = findByAttribute(overlay, 'data-dsh-autorestart-restart-overlay-bar')
  assert.ok(bar, 'the progress bar is drawn')
  assert.equal(bar.props.style.width, '31%', 'the bar is as wide as the real progress')
  const size = findByAttribute(overlay, 'data-dsh-autorestart-restart-overlay-size')
  assert.equal(textOf(size), '12.3 MB / 40 MB', 'each number carries its own unit, both are exact')
  const percent = findByAttribute(overlay, 'data-dsh-autorestart-restart-overlay-percent')
  assert.equal(textOf(percent), '31%')
})

test('phase=snapshotting: before the first measurement no number is invented', async () => {
  const mounted = mountClient({ health: statePayload({ phase: 'snapshotting', progress: null }) })
  const overlay = await mounted.settled('autorestart-restart-overlay')
  assert.ok(overlay)
  assert.match(textOf(overlay), /重启前备份中/)
  assert.doesNotMatch(textOf(overlay), /MB/, 'nothing is measured yet, so nothing is claimed')
  assert.equal(findByAttribute(overlay, 'data-dsh-autorestart-restart-overlay-size'), undefined)
})

/* ------------------------------------------------------------------ *
 * 3. restarting: the card stays.
 * ------------------------------------------------------------------ */

test('phase=restarting: the overlay does not disappear (the host is on its way out)', async () => {
  const mounted = mountClient({ health: statePayload({ phase: 'restarting', blocking: 0, blockedBy: [] }) })
  let overlay = await mounted.settled('autorestart-restart-overlay')
  assert.ok(overlay, 'the card is there')
  assert.match(textOf(overlay), /正在重启/, `the card says the host is restarting: ${textOf(overlay)}`)
  // Long after a "back" card would have folded away, the restarting card is
  // still on screen: nothing times it out.
  await new Promise((resolve) => setTimeout(resolve, 1700))
  overlay = mounted.render('autorestart-restart-overlay')
  assert.ok(overlay, 'the card is still there 1.7s later')
  assert.equal(overlay.props['data-dsh-autorestart-restart-overlay-phase'], 'restarting')
})

/* ------------------------------------------------------------------ *
 * 4. back: 1.5s and gone — and ONLY for a restart this page watched.
 * ------------------------------------------------------------------ */

test('phase=back: a page that watched the restart says 已回来 for 1.5s and then folds away', async () => {
  // The page follows a restart that is really running…
  const mounted = mountClient({
    health: statePayload({ phase: 'restarting', pendingRestart: true, blocking: 0, blockedBy: [] }),
  })
  assert.ok(await mounted.settled('autorestart-restart-overlay'), 'the restarting card is there')

  // …then the new host is up: the Host reports `back` and no pending restart.
  mounted.setHealth(statePayload({ phase: 'back', pendingRestart: false, blocking: 0, blockedBy: [] }))
  const back = await mounted.poll('autorestart-restart-overlay')
  assert.ok(back, 'the card greets the user')
  assert.match(textOf(back), /已回来/, `the card says the user is back: ${textOf(back)}`)

  // Still there 1s later (the user has to be able to read it)…
  await new Promise((resolve) => setTimeout(resolve, 1000))
  assert.ok(mounted.render('autorestart-restart-overlay'), 'the card is still there after 1s')

  // …and gone after 1.5s.
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(
    mounted.render('autorestart-restart-overlay'),
    null,
    '"已回来" is a moment, not a state: the card is gone after 1.5s',
  )
})

test('phase=back left over in the state file: a fresh page draws NOTHING', async () => {
  // This is what a page finds when it is opened AFTER a restart: the old stage
  // is still in the state file and `pendingRestart` is false. A card that said
  // "已回来" now would be a lie about a restart from ten minutes ago.
  const mounted = mountClient({ health: statePayload({ phase: 'back', pendingRestart: false, blocking: 0, blockedBy: [] }) })
  assert.equal(mounted.firstFrame('autorestart-restart-overlay'), null, 'not on the first frame')
  assert.equal(
    await mounted.settled('autorestart-restart-overlay'),
    null,
    'a leftover stage is not a running restart: no card at all',
  )
})

test('a leftover stage with no pending restart draws nothing either', async () => {
  const mounted = mountClient({ health: statePayload({ phase: 'restarting', pendingRestart: false, blocking: 0, blockedBy: [] }) })
  assert.equal(await mounted.settled('autorestart-restart-overlay'), null, 'a stale stage is not an action')
})

/* ------------------------------------------------------------------ *
 * 5. Per page: the overlay shows what its host reports, and remembers nothing.
 * ------------------------------------------------------------------ */

test('the overlay is per page: a second page shows its own host state, not a remembered one', async () => {
  const first = mountClient({
    health: statePayload({ phase: 'snapshotting', progress: { bytes: 1024 * 1024, total: 4 * 1024 * 1024, percent: 25 } }),
  })
  const firstCard = await first.settled('autorestart-restart-overlay')
  assert.equal(firstCard.props['data-dsh-autorestart-restart-overlay-phase'], 'snapshotting')

  // Another page (a fresh mount) whose host has already finished, its state
  // file still holding the goodbye of that restart.
  const second = mountClient({ health: statePayload({ phase: 'back', pendingRestart: false, blocking: 0, blockedBy: [] }) })
  assert.equal(
    await second.settled('autorestart-restart-overlay'),
    null,
    'the new page follows its own polling: it never replays an earlier page state',
  )
})

/* ------------------------------------------------------------------ *
 * 6. The composer row: ONE short line, never the long sentence.
 * ------------------------------------------------------------------ */

/** The pill of this page, rendered with a state. */
async function pillCopyFor(payload) {
  const mounted = mountClient({ health: payload })
  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  return capsuleCopy(pill)
}

test('the composer row says it in a SHORT line while the gate waits', async () => {
  const busy = await pillCopyFor(statePayload({ phase: 'waiting', blocking: 2 }))
  // The WORDING of the count belongs to the pending-restart capsule itself (it
  // is the same sentence the pill always had, "任务" or "会话" depending on the
  // task that owns it); what THIS task guarantees is that it stays ONE SHORT
  // LINE and that the count is still in it.
  assert.match(busy, /^待重启 · 等待 2 个/, `the count is still there, in one short line: ${busy}`)
  assert.doesNotMatch(busy, /[（]/, `no parenthetical in the pill: ${busy}`)

  const idle = await pillCopyFor(statePayload({ phase: 'waiting', blocking: 0, blockedBy: [] }))
  assert.equal(idle, '待重启 · 空闲后自动重启', `the idle line is the pre-restart line: ${idle}`)
})

test('the composer row shows the stage alone once the backup runs (and after it)', async () => {
  const snapshotting = await pillCopyFor(statePayload({
    phase: 'snapshotting',
    progress: { bytes: Math.round(12.3 * 1024 * 1024), total: 40 * 1024 * 1024, percent: 31 },
  }))
  assert.equal(snapshotting, '重启前备份中', `the backup is one short phrase: ${snapshotting}`)
  assert.ok(snapshotting.length <= 12, `and it stays short (<= 12): ${snapshotting.length}`)

  const restarting = await pillCopyFor(statePayload({ phase: 'restarting', blocking: 0, blockedBy: [] }))
  assert.equal(restarting, '正在重启…', `restarting is one word: ${restarting}`)

  const back = await pillCopyFor(statePayload({ phase: 'back', blocking: 0, blockedBy: [] }))
  assert.equal(back, '已回来', `and so is the return: ${back}`)
})

test('the composer row NEVER carries the long sentence that was cut off', async () => {
  const cases = [
    ['waiting', await pillCopyFor(statePayload({ phase: 'waiting', blocking: 2 }))],
    ['waiting-idle', await pillCopyFor(statePayload({ phase: 'waiting', blocking: 0, blockedBy: [] }))],
    ['snapshotting', await pillCopyFor(statePayload({
      phase: 'snapshotting',
      progress: { bytes: Math.round(12.3 * 1024 * 1024), total: 40 * 1024 * 1024, percent: 31 },
    }))],
    ['restarting', await pillCopyFor(statePayload({ phase: 'restarting', blocking: 0, blockedBy: [] }))],
    ['back', await pillCopyFor(statePayload({ phase: 'back', blocking: 0, blockedBy: [] }))],
  ]
  for (const [label, copy] of cases) {
    // The fragments of the sentence the user could not read (the host still
    // sends it as `text`, and it must stay out of this row).
    assert.doesNotMatch(copy, /会话空闲/, `${label}: no long sentence piece in the pill — ${copy}`)
    assert.doesNotMatch(copy, /（/, `${label}: no parenthetical in the pill — ${copy}`)
    assert.doesNotMatch(copy, /正在等待/, `${label}: no "waiting for…" sentence — ${copy}`)
    assert.doesNotMatch(copy, /MB/, `${label}: the megabytes belong to the overlay — ${copy}`)
    // ONE line, and short: at most 12 字 (the spaces, the separator and the
    // digits are not 字), and 16 visible characters in total.
    assert.ok(cjkCount(copy) <= 12, `${label}: at most 12 字 — ${copy} (${cjkCount(copy)})`)
    assert.ok(copy.length <= 16, `${label}: at most 16 visible characters — ${copy} (${copy.length})`)
  }
})

test('the long sentence of the Host is now only the tooltip of the pill', async () => {
  const mounted = mountClient({ health: statePayload({ phase: 'waiting', blocking: 2 }) })
  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const capsule = capsuleOf(pill)
  assert.match(textOf(capsule), /^待重启 · 等待 2 个/, 'the pill says the count, in one short line')
  // The detail is not lost: the tooltip still carries it (a hover, a screen
  // reader), and the overlay carries it on the interface itself.
  const withTitle = walk(pill).filter((node) => node.props && typeof node.props.title === 'string')
  assert.ok(withTitle.length > 0, 'the pill keeps its tooltip')
})

/* ------------------------------------------------------------------ *
 * 7. The pure helpers behind the copy.
 * ------------------------------------------------------------------ */

test('the composer copy of every stage is short, in BOTH languages', () => {
  const stages = ['snapshotting', 'restarting', 'back']
  for (const language of ['zh', 'en']) {
    const t = (key) => (api.dictionaries[language][key] !== undefined ? api.dictionaries[language][key] : key)
    for (const phase of stages) {
      const text = api.restartPillStageText({ phase }, t)
      assert.ok(text !== '', `${phase} has a text in ${language}`)
      assert.ok(text.length <= 12, `${phase}/${language}: ${text} is at most 12 characters`)
      assert.ok(cjkCount(text) <= 12, `${phase}/${language}: ${text} is at most 12 字`)
    }
    // `waiting` DELIBERATELY has no word of its own: the pill already says
    // "待重启 · 等待 N 个会话" / "待重启 · 空闲后自动重启" there.
    assert.equal(api.restartPillStageText({ phase: 'waiting' }, t), '')
    assert.equal(api.restartPillStageText({ phase: 'idle' }, t), '')
    assert.equal(api.restartPillStageText(null, t), '')
  }
})

test('the overlay has a title for the stages it draws, and the megabytes read like numbers', () => {
  for (const language of ['zh', 'en']) {
    const t = (key) => (api.dictionaries[language][key] !== undefined ? api.dictionaries[language][key] : key)
    for (const phase of ['snapshotting', 'restarting', 'back']) {
      assert.equal(api.isRestartOverlayPhase(phase), true)
      const title = api.restartOverlayTitle({ phase }, t)
      assert.ok(title !== '', `${phase} has an overlay title in ${language}`)
      // Not a paragraph: the card is 320px wide and shrinks its font, so a
      // short phrase fits — but nothing long enough to be cut may get in.
      assert.ok(title.length <= 40, `${phase}/${language}: ${title} is a short phrase`)
    }
    // No card is drawn while the gate merely waits, so there is no copy for it.
    assert.equal(api.isRestartOverlayPhase('waiting'), false)
    assert.equal(api.restartOverlayTitle({ phase: 'waiting' }, t), '')
    assert.equal(api.isRestartOverlayPhase('idle'), false)
    assert.equal(api.restartOverlayTitle({ phase: 'idle' }, t), '')
  }
  // THE UNIT FITS THE SIZE: a 92 KB profile is not "0 MB".
  assert.equal(api.formatOverlaySize(92 * 1024), '92 KB')
  assert.equal(api.formatOverlaySize(156 * 1024 * 1024), '156 MB')
  assert.equal(api.formatOverlaySize(Math.round(12.3 * 1024 * 1024)), '12.3 MB')
  assert.equal(api.formatOverlaySize(40 * 1024 * 1024), '40 MB')
  assert.equal(api.formatOverlaySize(0), '0 B')
  assert.equal(api.formatOverlaySize(512), '512 B')
  assert.equal(api.formatOverlaySize(null), '')
  assert.equal(api.formatOverlaySize(-1), '')
})

/* ------------------------------------------------------------------ *
 * 8. Where it is mounted: the shell overlay layer, never the composer.
 * ------------------------------------------------------------------ */

test('the overlay is registered in the shell overlay layer', () => {
  const mounted = mountClient({ health: statePayload({ phase: 'waiting', blocking: 1 }) })
  assert.deepEqual(
    mounted.slotNames().sort(),
    [
      'conversation.input.dock',
      'conversation.input.left',
      'settings.section',
      'shell.overlay',
      'sidebar.footer.action',
      'sidebar.session.row.leading',
    ].sort(),
    'the surfaces of the plugin did not change: the overlay joins shell.overlay',
  )
})

/* ------------------------------------------------------------------ *
 * 9. The Host side: the count of blocking tasks really travels as a number.
 *
 * The overlay prints "还有 N 个会话" from `restartPhase.blocking`. If the Host
 * only put that number into its long sentence, the overlay would have to parse
 * a text — so this is checked on the payload the routes really answer with.
 * ------------------------------------------------------------------ */

test('the stage carried by the routes has the number of blocking tasks on it', async (t) => {
  const { apply } = await import('../index.js')
  const { describeRestartPhase } = await import('../lib/restart-phase.js')
  const os = await import('node:os')
  const path = await import('node:path')

  // (a) The pure description: the number is a field of its own.
  const waiting = describeRestartPhase({ phase: 'waiting', blocking: 3, now: 1_700_000_000_000 })
  assert.equal(waiting.blocking, 3, 'the count is reported as a number')
  assert.match(waiting.text.zh, /还有 3 个会话在忙/, 'the long sentence keeps it too')
  assert.equal(
    describeRestartPhase({ phase: 'restarting' }).blocking,
    null,
    'a stage that was given no count reports null, not a fake zero',
  )

  // (b) The state route (the surface the overlay polls): `?state=1` answers
  // with the stage, and the stage carries the number.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-overlay-route-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows may still hold a handle; the temp dir is not the assertion.
    }
  })
  const routes = []
  const tools = []
  const ctx = {
    logger: Object.assign(() => undefined, { info: () => {}, warn: () => {}, error: () => {} }),
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => {}, pause: () => {}, block: () => {} },
    tools: {
      register: (definition) => { tools.push(definition); return () => {} },
      guard: () => () => {},
    },
    get: (name) => (name === 'webServer'
      ? { register: (route) => { routes.push(route); return () => {} }, tapIndex: () => () => {} }
      : undefined),
    on: () => () => {},
    effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    interval: () => () => {},
    timeout: () => () => {},
    provide: () => {},
    emit: () => {},
  }
  apply(ctx, { stateFile: path.join(dir, 'state.json'), enabled: true, recoveryDelayMs: 0 })

  const restartTool = tools.find((definition) => (definition.name || '').includes('restart'))
  assert.ok(restartTool, 'the restart tool is registered')
  restartTool.execute({ reason: 'overlay test', resume: true }, { agent: { id: 'sess-overlay' } })

  const health = routes.find((route) => route.path === '/__dsh_autorestart/health')
  assert.ok(health, 'the health route is registered')
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(body) { this.body = String(body ?? '') },
  }
  health.handler({ url: '/__dsh_autorestart/health?state=1', socket: { remoteAddress: '127.0.0.1' } }, response)
  const payload = JSON.parse(response.body)
  assert.equal(payload.restartPhase.phase, 'waiting')
  assert.equal(
    typeof payload.restartPhase.blocking,
    'number',
    'the number of blocking tasks is a field of the stage, not only a sentence',
  )
  assert.equal(payload.restartPhase.blocking, 0, 'no conversation is running in this test')
})

/* ------------------------------------------------------------------ *
 * 11. The Host's side of the gate: a REAL restart stays pending.
 *
 * The card needs `pendingRestart === true` AND a running stage. That is only
 * safe if the Host keeps the request pending for the whole restart — this pins
 * it down, so a later refactor cannot quietly hide a live card (or let a stale
 * stage draw one).
 * ------------------------------------------------------------------ */

test('a real restart keeps pendingRestart true while it snapshots and while it restarts', async (t) => {
  const { createRuntime, normalizeConfig } = await import('../index.js')
  const { requestRestart } = await import('../lib/checkpoint.js')
  const os = await import('node:os')
  const path = await import('node:path')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-overlay-gate-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows may still hold a handle; the temp dir is not the assertion.
    }
  })

  const samples = []
  const ctx = {
    logger: Object.assign(() => undefined, { info: () => {}, warn: () => {}, error: () => {} }),
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => {}, pause: () => {}, block: () => {} },
    tools: { register: () => () => {}, guard: () => () => {} },
    get: (name) => (name === 'webServer'
      ? { register: () => () => {}, tapIndex: () => () => {} }
      : undefined),
    on: () => () => {},
    effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    interval: () => () => {},
    timeout: () => () => {},
    provide: () => {},
    emit: () => {},
  }
  const config = normalizeConfig({
    stateFile: path.join(dir, 'state.json'),
    restartMode: 'command',
    restartCommand: 'restart-the-host',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: true,
  })
  const runtime = createRuntime(ctx, config, {
    env: { isDesktopApp: false, appExePath: null },
    // THE SNAPSHOT: while it runs, the payload a page would receive is
    // `{ phase: 'snapshotting', pendingRestart: true }` — the card's gate.
    snapshot: () => {
      samples.push({
        at: 'snapshot',
        phase: runtime.restartStageInfo().phase,
        pending: runtime.state.restart !== null,
      })
      // Call the copy off: this test only wants the sample, not a real restart.
      return { ok: true, cancelled: true, dir: null, backup: null, profileDir: null }
    },
    runCommand: async ({ command }) => ({ ok: true, command, exitCode: 0, timedOut: false }),
    launchWatcher: () => ({ ok: true, method: 'test', error: null }),
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test arms nothing' }),
    probeInstance: async () => ({ ok: true, reason: 'unused' }),
  })

  requestRestart(runtime.state, { reason: 'the overlay gate', bySessionId: 'sess-gate' })
  await runtime.executeRestart()

  assert.equal(samples.length, 1, 'the snapshot ran once')
  assert.equal(samples[0].phase, 'snapshotting', 'the card is @snapshotting while the copy runs')
  assert.equal(samples[0].pending, true, 'and the request is still PENDING: the card must be drawn')

  // The stage of the shutdown does NOT clear the request either: only a cancel
  // (or the next boot) does, so `{ phase: 'restarting', pendingRestart: true }`
  // is what the page sees while the host goes down.
  requestRestart(runtime.state, { reason: 'the overlay gate 2', bySessionId: 'sess-gate' })
  runtime.markRestartStage('restarting')
  assert.equal(runtime.state.restart !== null, true, 'the request survives the "restarting" stage')
  const stage = runtime.restartStageInfo()
  assert.equal(stage.phase, 'restarting')
  assert.equal(stage.cancellable, false)
})

test('the card names WHAT is being backed up, in BOTH languages', async () => {
  const progress = { bytes: 1024 * 1024, total: 2 * 1024 * 1024, percent: 50 }

  // Chinese: the user's own words ("看不出是什么备份").
  const zh = mountClient({ health: statePayload({ phase: 'snapshotting', progress }) })
  const zhCard = await zh.settled('autorestart-restart-overlay')
  const zhCopy = textOf(zhCard)
  assert.match(zhCopy, /DSH 重启前备份中/, `the card says it is the pre-restart backup: ${zhCopy}`)
  assert.doesNotMatch(zhCopy, /正在备份/, `and never the bare "正在备份": ${zhCopy}`)

  // English: the same sentence.
  const en = mountClient({ health: statePayload({ phase: 'snapshotting', progress }), language: 'en' })
  const enCard = await en.settled('autorestart-restart-overlay')
  const enCopy = textOf(enCard)
  assert.match(enCopy, /before DSH restart/i, `the English card says it too: ${enCopy}`)
  // The numbers are untouched: the bar, the size and the percentage are all there.
  assert.match(enCopy, /1 MB \/ 2 MB/, `the sizes survive the copy change: ${enCopy}`)
  assert.equal(findByAttribute(enCard, 'data-dsh-autorestart-restart-overlay-bar').props.style.width, '50%')

  // The composer row stays a WORD in both languages (never the sentence).
  const enPill = await mountClient({ health: statePayload({ phase: 'snapshotting', progress }), language: 'en' })
    .settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const enPillCopy = capsuleCopy(enPill)
  assert.equal(enPillCopy, 'Backing up…', `the English pill is a word: ${enPillCopy}`)
  assert.ok(enPillCopy.length <= 12, `and short: ${enPillCopy.length}`)
})

/* ------------------------------------------------------------------ *
 * 12. THE CARD HAS A CLOCK (user report: "I never saw the backup").
 *
 * A hosted profile is 92 KB and is copied in ~5 ms, while the page polls every
 * 2 s. The backup really happened; the card was simply never seen. The rule is
 * a DISPLAY rule (the copy itself is untouched), and it is proved here with a
 * fake clock first and with real timers afterwards.
 * ------------------------------------------------------------------ */

/** The Host report the clock reads (what the state route answers with). */
function report(phase, { pending = true, bytes = null, total = null, percent = null, snapshotBytes = null } = {}) {
  return {
    phase,
    pending,
    progress: bytes === null && total === null && percent === null
      ? null
      : { bytes, total, percent },
    snapshotBytes,
  }
}

test('the clock keeps a 5 ms backup on screen for the minimum, then shows the receipt', () => {
  const api = globalThis.__dshAutorestartClient
  const min = api.SNAPSHOT_MIN_VISIBLE_MS
  const doneMs = api.SNAPSHOT_DONE_MS
  assert.equal(min, 800, 'the minimum shown time is 800 ms')
  assert.equal(doneMs, 1200, 'the receipt stays 1.2 s')

  // t=0: the copy starts (a 92 KB profile: it is dumped in about 5 ms).
  let state = api.emptyOverlayClock()
  let view = api.advanceOverlayClock(state, report('snapshotting', { bytes: 92 * 1024, total: 92 * 1024, percent: 100 }), 0)
  assert.equal(view.card.kind, 'snapshot', 'the card counts the copy')
  assert.equal(view.card.bytes, 92 * 1024)
  state = view.state

  // t=5 ms: the copy is over and the host is going down. A page that polls
  // every 2 s would show NOTHING here — the clock does not let go.
  view = api.advanceOverlayClock(state, report('restarting', { snapshotBytes: 92 * 1024 }), 5)
  assert.equal(view.card.kind, 'snapshot', 'the card is still the copy at 5 ms')
  state = view.state
  assert.equal(state.stage, 'snapshot')

  view = api.advanceOverlayClock(state, report('restarting', { snapshotBytes: 92 * 1024 }), min - 1)
  assert.equal(view.card.kind, 'snapshot', 'still the copy just before 800 ms')
  state = view.state

  // t=800 ms: the minimum is over — the receipt takes over.
  view = api.advanceOverlayClock(state, report('restarting', { snapshotBytes: 92 * 1024 }), min)
  assert.equal(view.card.kind, 'done', 'the receipt appears at 800 ms')
  assert.equal(view.card.bytes, 92 * 1024, 'with the real size of the copy')
  state = view.state

  view = api.advanceOverlayClock(state, report('restarting', { snapshotBytes: 92 * 1024 }), min + doneMs - 1)
  assert.equal(view.card.kind, 'done', 'the receipt is still there just before 1.2 s')
  state = view.state

  // t=800+1200: the receipt is over; the ordinary card of the stage takes over.
  view = api.advanceOverlayClock(state, report('restarting', { snapshotBytes: 92 * 1024 }), min + doneMs)
  assert.equal(view.card, null, 'after the receipt the ordinary restart card is the component\'s business')
  assert.equal(api.overlayClockDeadline(view.state), null, 'and no timer is left behind')
})

test('a copy this page NEVER saw still gets its receipt (the WSL case)', () => {
  const api = globalThis.__dshAutorestartClient
  // First observation: the host is already restating, but it carries the size.
  const first = api.advanceOverlayClock(api.emptyOverlayClock(), report('restarting', { snapshotBytes: 92 * 1024 }), 1000)
  assert.equal(first.card.kind, 'done', 'the receipt appears even though no progress was ever seen')
  assert.equal(first.card.bytes, 92 * 1024)
  assert.equal(
    globalThis.__dshAutorestartClient.formatOverlaySize(first.card.bytes),
    '92 KB',
    'and it says 92 KB, never 0 MB',
  )
  // It lasts 1.2 s, and it is given ONCE per restart.
  const later = api.advanceOverlayClock(first.state, report('restarting', { snapshotBytes: 92 * 1024 }), 1000 + 1199)
  assert.equal(later.card.kind, 'done')
  const over = api.advanceOverlayClock(later.state, report('restarting', { snapshotBytes: 92 * 1024 }), 1000 + 1200)
  assert.equal(over.card, null, 'the receipt is over')
  const again = api.advanceOverlayClock(over.state, report('restarting', { snapshotBytes: 92 * 1024 }), 1000 + 5000)
  assert.equal(again.card, null, 'the receipt is not shown a second time for the same restart')
})

test('a 156 MB backup is quoted as 156 MB, a 92 KB one as 92 KB', () => {
  const api = globalThis.__dshAutorestartClient
  const big = api.advanceOverlayClock(api.emptyOverlayClock(), report('restarting', { snapshotBytes: 156 * 1024 * 1024 }), 0)
  assert.equal(api.formatOverlaySize(big.card.bytes), '156 MB')
  const small = api.advanceOverlayClock(api.emptyOverlayClock(), report('restarting', { snapshotBytes: 92 * 1024 }), 0)
  assert.equal(api.formatOverlaySize(small.card.bytes), '92 KB')
})

test('a cancelled copy gets NO receipt (it did not finish)', () => {
  const api = globalThis.__dshAutorestartClient
  let view = api.advanceOverlayClock(api.emptyOverlayClock(), report('snapshotting', { bytes: 4096, total: 92 * 1024, percent: 4 }), 0)
  assert.equal(view.card.kind, 'snapshot')
  // The user calls it off: the stage is gone and nothing is pending.
  view = api.advanceOverlayClock(view.state, report('', { pending: false }), 10)
  assert.equal(view.card, null, 'no card for a cancelled copy')
  assert.equal(view.state.stage, '', 'and the clock is empty again')
})

test('while the gate merely waits nothing is owed', () => {
  const api = globalThis.__dshAutorestartClient
  const view = api.advanceOverlayClock(api.emptyOverlayClock(), report('waiting', { snapshotBytes: 92 * 1024 }), 0)
  assert.equal(view.card, null)
})

test('the card is held in the real component too: 5 ms copy, then the receipt, then 正在重启', async () => {
  // The same walk, driven through the component with real timers.
  const mounted = mountClient({
    health: statePayload({ phase: 'snapshotting', progress: { bytes: 92 * 1024, total: 92 * 1024, percent: 100 } }),
  })
  let card = await mounted.settled('autorestart-restart-overlay')
  assert.equal(card.props['data-dsh-autorestart-restart-overlay-card'], 'snapshot', 'the copy is on screen')
  assert.match(textOf(card), /92 KB/, `with the real size: ${textOf(card)}`)

  // The copy ends and the host goes down, well inside the minimum.
  mounted.setHealth(statePayload({ phase: 'restarting', progress: null, snapshotBytes: 92 * 1024 }))
  card = await mounted.poll('autorestart-restart-overlay')
  assert.equal(card.props['data-dsh-autorestart-restart-overlay-card'], 'snapshot', 'the card is still held')

  // …until the minimum is over: then the receipt.
  await new Promise((resolve) => setTimeout(resolve, 850))
  card = mounted.render('autorestart-restart-overlay')
  assert.equal(card.props['data-dsh-autorestart-restart-overlay-card'], 'done', 'the receipt appears')
  assert.match(textOf(card), /重启前备份完成（92 KB）/, `the receipt quotes the real size: ${textOf(card)}`)

  // …and 1.2 s later the ordinary restart card is back.
  await new Promise((resolve) => setTimeout(resolve, 1300))
  card = mounted.render('autorestart-restart-overlay')
  assert.equal(card.props['data-dsh-autorestart-restart-overlay-card'], 'restarting')
  assert.match(textOf(card), /正在重启/, `and it hands over to the restart card: ${textOf(card)}`)
})

test('the hold never delays the copy itself', async (t) => {
  // The clock lives in the browser: the Host must not know about it at all, and
  // a real 92 KB backup must stay a few milliseconds.
  const api = globalThis.__dshAutorestartClient
  assert.equal(typeof api.SNAPSHOT_MIN_VISIBLE_MS, 'number')

  const { createBackup } = await import('../lib/backup.js')
  const os = await import('node:os')
  const path = await import('node:path')
  const fsmod = await import('node:fs')

  const root = fsmod.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-hold-'))
  t.after(() => {
    try {
      fsmod.rmSync(root, { recursive: true, force: true })
    } catch {
      // Windows may still hold a handle; the temp dir is not the assertion.
    }
  })
  const profile = path.join(root, 'profile')
  const modules = path.join(profile, 'node_modules')
  fsmod.mkdirSync(modules, { recursive: true })
  fsmod.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'plugins: []\n', 'utf8')
  // ~92 KB of plugin files: exactly the profile from the report.
  for (let index = 0; index < 23; index += 1) {
    fsmod.writeFileSync(path.join(modules, 'plugin-' + index + '.js'), 'x'.repeat(4096), 'utf8')
  }

  const started = Date.now()
  const result = await createBackup({
    profileDir: profile,
    backupsDir: path.join(root, 'backups'),
    includePlugins: true,
    now: 1_700_000_000_000,
  })
  const elapsed = Date.now() - started
  assert.equal(result.ok, true)
  assert.ok(result.bytes > 90 * 1024, `the copy really wrote ~92 KB: ${result.bytes}`)
  assert.ok(
    elapsed < api.SNAPSHOT_MIN_VISIBLE_MS,
    `the copy of 92 KB finished in ${elapsed} ms — the 800 ms hold is display only`,
  )

  // And the Host does not even know the constant: the hold is client-side.
  const indexSource = fsmod.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const backupSource = fsmod.readFileSync(new URL('../lib/backup.js', import.meta.url), 'utf8')
  assert.equal(indexSource.includes('SNAPSHOT_MIN_VISIBLE_MS'), false, 'no hold in the host')
  assert.equal(backupSource.includes('SNAPSHOT_MIN_VISIBLE_MS'), false, 'no hold in the copy loop')
})
