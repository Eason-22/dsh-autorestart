/**
 * d1 — THE COUNT OF THE PARKED GOALS COUNTS ONLY THE ONES THE PLUGIN PARKED.
 *
 * THE DEFECT
 *
 * The capsule of the restart bubble says "· 已停泊 {n} 个 goal，重启后自动继续".
 * The number counted EVERY goal that was parked: the ones the plugin parked
 * for the restart ('restart-queued' / 'restart-blocking') AND the ones the
 * USER stopped by hand ('manual-park'), AND the records of the old builds that
 * carry no reason at all (null).
 *
 * So the sentence promised something the plugin does not do: the goals the
 * user stopped by hand are not continued after the restart — the user stopped
 * them on purpose. Counting them made the capsule lie.
 *
 * THE RULE THIS FILE PINS DOWN
 *
 *   1. the count is the number of the goals THE PLUGIN parked for the restart:
 *      'restart-queued' and 'restart-blocking';
 *   2. 'manual-park' is NOT counted — the user stopped it, the plugin does not
 *      continue it;
 *   3. a record with no reason (null — the legacy `kind === 'parked'` records
 *      of the old builds) is NOT counted either: nobody knows who parked it,
 *      so it is not "a goal this plugin parked";
 *   4. when nothing of the plugin's own is left, the sentence is NOT shown at
 *      all — the capsule says something else. That is a smaller number, not a
 *      broken feature: the other sentences of the capsule are still there.
 *
 * The client is the REAL `client.js`: the file is evaluated in a sandbox and
 * the component is rendered, so the number below is the number the user sees.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

/* ------------------------------------------------------------------ *
 * The shapes the Host really sends.
 * ------------------------------------------------------------------ */

/**
 * ONE record of `info.parkedGoals`, as `index.js` publishes it.
 *
 * The Host publishes `thisBoot` (the record is from this run), `resumedAt`
 * (the goal is back), `tookBackAt` (the USER gave it back) and `reason` (who
 * parked it: the plugin for the restart, or the user by hand).
 */
function parkedRecord(overrides = {}) {
  return {
    sessionId: 'sess-me',
    kind: 'disarmed',
    goalId: 'goal-1',
    disarmedAt: 1,
    parkedAt: null,
    resumedAt: null,
    resumed: false,
    tookBackAt: null,
    reason: null,
    thisBoot: true,
    ...overrides,
  }
}

/** A legacy record: the old builds parked a goal and wrote no reason at all. */
function legacyParkedRecord(overrides = {}) {
  return parkedRecord({
    kind: 'parked',
    goalId: 'goal-legacy',
    disarmedAt: null,
    parkedAt: 1,
    reason: null,
    ...overrides,
  })
}

/**
 * The state of every case below: THIS session asked for the restart and
 * nothing else is in the way.
 */
function pendingState(parkedGoals) {
  return {
    ok: true,
    pendingRestart: true,
    allowRestart: false,
    reason: 'conversation-active',
    waiters: ['sess-me'],
    blockedBy: [],
    busyCount: 0,
    parkedGoals,
    cancelUrl: '/__dsh_autorestart/cancel',
  }
}

/* ------------------------------------------------------------------ *
 * The client, mounted the way the browser mounts it.
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
      return [slot.value, setState]
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

/** The text leaves of a subtree, in order. */
function textLeaves(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { node.forEach((child) => textLeaves(child, out)); return out }
  for (const child of node.children || []) textLeaves(child, out)
  return out
}

/** The CAPSULE of the composer row (not the panel that floats above it). */
function capsuleOf(pill) {
  return walk(pill).find((node) => node.props && node.props['aria-haspopup'] === 'dialog')
}

/** The copy of the capsule itself. */
function capsuleCopy(pill) {
  const capsule = capsuleOf(pill)
  return capsule ? textLeaves(capsule).join('') : ''
}

/** Mount the client with a state the Host reported. */
function mountClient(health) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
  const dictionaries = {}
  const slots = new Map()
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
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => health }),
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
    /** Render, let the shared poll deliver the payload, render again. */
    settled: async (id, props) => {
      const Component = componentOf(id)
      harness.render(Component, props || {})
      await new Promise((resolve) => setTimeout(resolve, 5))
      return harness.render(Component, props || {})
    },
  }
}

/* ------------------------------------------------------------------ *
 * The helpers of this file.
 * ------------------------------------------------------------------ */

/** Render the capsule and return its copy. */
async function capsuleFor(parkedGoals) {
  const mounted = mountClient(pendingState(parkedGoals))
  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-me' })
  assert.ok(pill, 'the capsule must be shown while the restart waits')
  return capsuleCopy(pill)
}

/** The number the capsule claims ("已停泊 N 个 goal"), or null. */
function claimedCount(copy) {
  const match = /已停泊 (\d+) 个 goal/.exec(copy)
  return match ? Number(match[1]) : null
}

/* ------------------------------------------------------------------ *
 * The rules.
 * ------------------------------------------------------------------ */

test('the goals the plugin parked for the restart ARE counted', async () => {
  const queued = await capsuleFor([parkedRecord({ reason: 'restart-queued' })])
  assert.equal(claimedCount(queued), 1, `one queued goal is counted: ${queued}`)

  const blocking = await capsuleFor([parkedRecord({ reason: 'restart-blocking' })])
  assert.equal(claimedCount(blocking), 1, `one blocking goal is counted: ${blocking}`)

  const both = await capsuleFor([
    parkedRecord({ sessionId: 'a', reason: 'restart-queued' }),
    parkedRecord({ sessionId: 'b', reason: 'restart-blocking' }),
  ])
  assert.equal(claimedCount(both), 2, `both of the plugin's own goals are counted: ${both}`)
})

test('the goals the USER parked by hand are NOT counted', async () => {
  const manual = await capsuleFor([parkedRecord({ reason: 'manual-park' })])
  assert.equal(claimedCount(manual), null, `a hand-parked goal is not counted: ${manual}`)

  // The capsule is not broken: it says something else.
  assert.ok(manual.length > 0, 'the capsule still says something')
  assert.doesNotMatch(manual, /已停泊/, 'the parked sentence is not shown at all')
})

test('a record with no reason (the legacy kind=parked ones) is NOT counted', async () => {
  const legacy = await capsuleFor([legacyParkedRecord()])
  assert.equal(claimedCount(legacy), null, `a record without a reason is not counted: ${legacy}`)
  assert.doesNotMatch(legacy, /已停泊/, 'the parked sentence is not shown at all')
})

test('only the goals of the plugin are counted when the list mixes all kinds', async () => {
  const copy = await capsuleFor([
    parkedRecord({ sessionId: 'a', reason: 'restart-queued' }),
    parkedRecord({ sessionId: 'b', reason: 'restart-blocking' }),
    parkedRecord({ sessionId: 'c', reason: 'manual-park' }),
    legacyParkedRecord({ sessionId: 'd' }),
  ])
  assert.equal(claimedCount(copy), 2, `only the plugin's own two goals are counted: ${copy}`)
})

test('a goal that is already back or was taken back is not counted', async () => {
  const resumed = await capsuleFor([parkedRecord({ reason: 'restart-queued', resumedAt: 5 })])
  assert.equal(claimedCount(resumed), null, `a resumed goal is not counted: ${resumed}`)

  const tookBack = await capsuleFor([parkedRecord({ reason: 'restart-queued', tookBackAt: 5 })])
  assert.equal(claimedCount(tookBack), null, `a goal the user took back is not counted: ${tookBack}`)
})

test('a goal of an earlier run is not counted', async () => {
  const copy = await capsuleFor([parkedRecord({ reason: 'restart-queued', thisBoot: false })])
  assert.equal(claimedCount(copy), null, `a goal of an earlier run is not counted: ${copy}`)
})
