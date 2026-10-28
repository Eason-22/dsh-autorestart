/**
 * The blocker lists of the pending-restart bubble.
 *
 * The defect the real machine showed: the "waiting for a long time" line of
 * the bubble named EVERY blocker — and every AgentTeams member is a
 * subagent, so the names of one team turned into a string of a dozen
 * "…的子智能体" phrases that did not fit into the 22px pill any more and
 * were clipped away:
 *
 *   ● 待重启 · 等待 … · 已等 25 分 4 秒：GitHub 连接不稳定解决方案的子智能体、
 *     保险库推送目录配置的子智能体、DSH 电脑控…
 *
 * The rule under test — ONE rule, three surfaces:
 *
 *   1. the subagents of ONE session are ONE item ("<that session>
 *      (N subagents)"); a plain session is an item of its own;
 *   2. a bubble names at most 2 items and says "…等 N 项" about the rest;
 *   3. a name that is too long for the bubble is shortened (the "…" counts
 *      towards the 12 characters, so a name is never longer than 12);
 *   4. the COMPLETE list goes into the tooltip (`title`).
 *
 * ---------------------------------------------------------------------------
 * THE REAL SHAPES (this is what the Host actually sends)
 * ---------------------------------------------------------------------------
 *
 * A. The gate, the long wait and the state route (`index.js`:
 *    `describeBlocker` + `busyAgents`, spread by `goalAwareBlockingDetails`):
 *
 *      {
 *        sessionId: 'sess-a',        // the blocking session
 *        reason: 'running' | 'queued' | 'goal-active' | 'goal-exhausted',
 *        busyReason: 'running',      // only when a goal reason replaced it
 *        kind: 'session' | 'subagent',         // WHAT it is
 *        label: '写代码' | null,     // the title of the session — for a
 *                                   // SUBAGENT: the title of the session
 *                                   // that created it
 *        name: '写代码' | '写代码的子智能体' | '子智能体',
 *        parentTitle: '写代码' | null,   // the title of the creating session
 *        parentSessionId: 'sess-a' | null, // WHICH session it belongs to
 *      }
 *
 * B. The shutdown card (`lib/sleep.js`, `blockerEntry`): the SAME
 *    information, but WITHOUT `parentSessionId`:
 *
 *      { sessionId, kind, label, name, parentTitle, title }
 *
 *    `title` is the old name of `label` and stays for an older client.
 *
 * A rule that only knows `parentSessionId` groups the card WRONG: every
 * member of a team becomes an item of its own — exactly the endless list
 * the rule is there to prevent. The grouping therefore falls back to the
 * parent's title, and an entry that names a parent is a subagent even when
 * the Host does not label the kind.
 * ---------------------------------------------------------------------------
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

// The client script is a CLASSIC script: it publishes its pure helpers on the
// global namespace as soon as it is evaluated.
import '../client.js'

const api = globalThis.__dshAutorestartClient
assert.ok(api, 'the client must publish its pure helpers on globalThis.__dshAutorestartClient')

/** A translator for one of the two dictionaries of the client. */
const zh = (key) => (api.dictionaries.zh[key] !== undefined ? api.dictionaries.zh[key] : key)
const en = (key) => (api.dictionaries.en[key] !== undefined ? api.dictionaries.en[key] : key)

/** A blocking session with a title — shape A (the gate). */
function session(sessionId, label) {
  return {
    sessionId,
    reason: 'running',
    kind: 'session',
    label,
    name: label,
    parentTitle: null,
    parentSessionId: null,
  }
}

/** A blocking subagent — shape A (the gate). */
function subagent(sessionId, parentSessionId, parentTitle) {
  return {
    sessionId,
    reason: 'running',
    kind: 'subagent',
    label: parentTitle,
    name: `${parentTitle}的子智能体`,
    parentTitle,
    parentSessionId,
  }
}

/** The same subagent in shape B (the shutdown card): NO `parentSessionId`. */
function cardSubagent(sessionId, parentTitle) {
  return {
    sessionId,
    kind: 'subagent',
    label: parentTitle,
    name: `${parentTitle}的子智能体`,
    parentTitle,
    title: parentTitle,
  }
}

/**
 * The NAME part of every group of a summary.
 *
 * A group is written as "<name>" or as "<name>（N 个子智能体）": the name is
 * what has to fit into the pill, the count is not part of it.
 *
 * @param {string} summary
 * @returns {string[]}
 */
function nameParts(summary) {
  return String(summary)
    .split('、')
    .map((part) => part.split('…等 ')[0].replace(/（\d+ 个子智能体）$/, ''))
}

/* ------------------------------------------------------------------ *
 * The rule itself.
 * ------------------------------------------------------------------ */

test('one subagent is one item and keeps its own name', () => {
  const result = api.summarizeBlockers([subagent('child-1', 'sess-a', '写代码')], { t: zh })
  assert.equal(result.total, 1, 'one blocker is one item')
  assert.equal(result.summary, '写代码的子智能体')
  assert.equal(result.full, '写代码的子智能体')
})

test('three subagents of ONE session are ONE item', () => {
  const result = api.summarizeBlockers([
    subagent('child-1', 'sess-a', '写代码'),
    subagent('child-2', 'sess-a', '写代码'),
    subagent('child-3', 'sess-a', '写代码'),
  ], { t: zh })
  assert.equal(result.total, 1, 'the three subagents of one session are one item')
  assert.equal(result.summary, '写代码（3 个子智能体）')
  assert.equal(result.full, '写代码（3 个子智能体）')
})

test('two parents and a plain session are three items, and the bubble names two of them', () => {
  const result = api.summarizeBlockers([
    subagent('child-1', 'sess-a', '写代码'),
    subagent('child-2', 'sess-a', '写代码'),
    subagent('child-3', 'sess-b', '保险库'),
    session('sess-c', '调研'),
  ], { t: zh })
  assert.equal(result.total, 3, 'a plain session is an item of its own')
  assert.equal(result.summary, '写代码（2 个子智能体）、保险库的子智能体…等 1 项')
  assert.equal(result.full, '写代码（2 个子智能体）、保险库的子智能体、调研')
})

test('one plain session is one item with its own name', () => {
  const result = api.summarizeBlockers([session('sess-a', '调研')], { t: zh })
  assert.equal(result.total, 1)
  assert.equal(result.summary, '调研')
  assert.equal(result.full, '调研')
})

test('the bubble never names more than the cap', () => {
  const many = Array.from({ length: 8 }, (_, index) => session(`sess-${index}`, `会话${index}`))
  const result = api.summarizeBlockers(many, { t: zh })
  assert.equal(result.summary, '会话0、会话1…等 6 项', `the summary is capped: ${result.summary}`)
  assert.equal(result.full.split('、').length, 8, 'the complete list is not capped')
})

test('a name that is too long is shortened in the bubble but not in the tooltip', () => {
  const long = '这是一个非常非常长的会话标题名字'
  const result = api.summarizeBlockers([session('sess-a', long)], { t: zh })
  assert.equal(result.summary, '这是一个非常非常长的会…', `the name is shortened: ${result.summary}`)
  assert.equal(result.full, long, 'the complete list keeps the whole name')
})

test('the shortened name is counted in characters, not in code units', () => {
  assert.equal(api.truncateBlockerName('一二三四五六七八九十', 4), '一二三…')
  assert.equal(api.truncateBlockerName('一二三', 4), '一二三', 'a short name is untouched')
  assert.equal(api.truncateBlockerName('', 4), '', 'no name is no name')
})

test('the ellipsis counts towards the limit: a name is never longer than the limit', () => {
  const long = '这是一个非常非常长的会话标题名字'
  assert.equal(Array.from(api.truncateBlockerName(long)).length, 12, 'the name fits the budget')
  assert.equal(Array.from(api.truncateBlockerName(long, 12)).length, 12)
  assert.equal(Array.from(api.truncateBlockerName(long, 5)).length, 5)
})

test('a blocker without a name falls back to the generic line', () => {
  const result = api.summarizeBlockers([{ sessionId: 'sess-a', kind: 'session', label: null, name: '' }], { t: zh })
  assert.equal(result.summary, '有会话', `no empty name reaches the interface: ${result.summary}`)
  assert.notEqual(result.summary, '', 'the generic line is never empty')
  assert.equal(result.named, 0, 'an unnamed blocker has nothing to show')
})

test('the English wording uses the same rule', () => {
  const result = api.summarizeBlockers([
    subagent('child-1', 'sess-a', 'Coding'),
    subagent('child-2', 'sess-a', 'Coding'),
    session('sess-b', 'Research'),
  ], { t: en })
  assert.equal(result.summary, 'Coding (2 subagents), Research')
  assert.equal(result.full, 'Coding (2 subagents), Research')
})

/* ------------------------------------------------------------------ *
 * The shapes the Host really sends.
 * ------------------------------------------------------------------ */

test('the shutdown card groups its subagents even without a parent id', () => {
  // Shape B: `parentSessionId` is missing, so the grouping has to fall back
  // to the parent's title. Without the fallback every member of the team
  // would be an item of its own — the endless list of the defect.
  const result = api.summarizeBlockers([
    cardSubagent('child-1', '写代码'),
    cardSubagent('child-2', '写代码'),
    cardSubagent('child-3', '写代码'),
  ], { t: zh })
  assert.equal(result.total, 1, `the three subagents of one session are one item: ${result.full}`)
  assert.equal(result.summary, '写代码（3 个子智能体）')
  assert.equal(result.full, '写代码（3 个子智能体）')
})

test('an entry that names a parent is a subagent, whatever the Host called it', () => {
  const result = api.summarizeBlockers([
    { sessionId: 'child-1', label: '写代码', name: '写代码的子智能体', parentTitle: '写代码', parentSessionId: 'sess-a' },
    { sessionId: 'child-2', label: '写代码', name: '写代码的子智能体', parentTitle: '写代码', parentSessionId: 'sess-a' },
  ], { t: zh })
  assert.equal(result.total, 1, 'the kind is not the only evidence of a subagent')
  assert.equal(result.summary, '写代码（2 个子智能体）')
})

test('a title under the old name is still a title', () => {
  const result = api.summarizeBlockers([
    { sessionId: 'sess-a', kind: 'session', title: '调研', label: null, name: '' },
  ], { t: zh })
  assert.equal(result.summary, '调研', `the old field is still read: ${result.summary}`)
})

test('a subagent whose parent is unknown is counted, not named', () => {
  const result = api.summarizeBlockers([
    { sessionId: 'child-1', kind: 'subagent', label: null, name: '', parentTitle: null, parentSessionId: null },
    { sessionId: 'child-2', kind: 'subagent', label: null, name: '', parentTitle: null, parentSessionId: null },
  ], { t: zh })
  assert.equal(result.summary, '2 个子智能体', `the group is still counted: ${result.summary}`)
  assert.notEqual(result.summary, '', 'no empty name reaches the interface')
})

/* ------------------------------------------------------------------ *
 * The shape of the user's screenshot: four subagents of two parents and
 * two plain conversations.
 * ------------------------------------------------------------------ */

/** The blockers of the screenshot: a team of subagents and two conversations. */
const LONG_WAIT_BLOCKERS = [
  subagent('child-1', 'sess-a', 'GitHub 连接不稳定解决方案'),
  subagent('child-2', 'sess-a', 'GitHub 连接不稳定解决方案'),
  subagent('child-3', 'sess-a', 'GitHub 连接不稳定解决方案'),
  subagent('child-4', 'sess-b', '保险库推送目录配置'),
  session('sess-c', 'DSH 电脑控制台'),
  session('sess-d', '另一个会话'),
]

test('the summary of the screenshot names the parents, not the subagents', () => {
  const result = api.summarizeBlockers(LONG_WAIT_BLOCKERS, { t: zh })
  assert.equal(result.total, 4, 'two parents and two conversations are four items')
  assert.match(result.summary, /GitHub 连接不稳…（3 个子智能体）/, `the parent is named once: ${result.summary}`)
  assert.doesNotMatch(result.summary, /的子智能体、/, `no subagent is named one by one: ${result.summary}`)
  assert.match(result.summary, /…等 2 项/, `the rest is counted, not listed: ${result.summary}`)
})

test('the summary of the screenshot names at most two groups, each at most 12 characters', () => {
  const result = api.summarizeBlockers(LONG_WAIT_BLOCKERS, { t: zh })
  const names = nameParts(result.summary)
  assert.equal(names.length, 2, `the bubble names two items at most: ${result.summary}`)
  for (const name of names) {
    assert.ok(
      Array.from(name).length <= 12,
      `the name fits the bubble: "${name}" is ${Array.from(name).length} characters`,
    )
  }
})

test('the complete list of the screenshot shows every group', () => {
  const result = api.summarizeBlockers(LONG_WAIT_BLOCKERS, { t: zh })
  assert.equal(
    result.full,
    'GitHub 连接不稳定解决方案（3 个子智能体）、保险库推送目录配置的子智能体、DSH 电脑控制台、另一个会话',
  )
})

/* ------------------------------------------------------------------ *
 * The surfaces that use the rule.
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
 * Load the classic client script in a sandbox and mount one surface.
 *
 * @param {{ health?: object, status?: object, language?: string }} options
 */
function mountClient({ health = {}, status = {}, language = 'zh' } = {}) {
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
    },
    fetch: (url) => {
      const target = String(url)
      const body = target.includes('/sleep') ? status : health
      return Promise.resolve({ ok: true, status: 200, json: async () => body })
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
    settled: async (id, props) => {
      const Component = componentOf(id)
      harness.render(Component, props || {})
      await new Promise((resolve) => setTimeout(resolve, 5))
      return harness.render(Component, props || {})
    },
  }
}

/* ------------------------------------------------------------------ *
 * The capsule: NUMBERS ONLY. Every name lives in the tooltip.
 *
 * The real machine showed why: the capsule is 22px high and ONE line wide,
 * so every name in it is a name that gets clipped away. It says HOW LONG
 * and HOW MANY — never WHO.
 * ------------------------------------------------------------------ */

/** How many characters the copy of the capsule may have. */
const CAPSULE_COPY_LIMIT = 30

/**
 * The copy of the capsule: every text leaf that is NOT a button.
 *
 * A button is a control (the park button), not copy: the capsule copy is
 * what the user reads.
 *
 * @param {any} node
 * @param {string[]} [out]
 * @returns {string[]}
 */
function capsuleCopy(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.type === 'button') return out
  for (const child of node.children || []) {
    if (typeof child === 'string') out.push(child)
    else capsuleCopy(child, out)
  }
  return out
}

/** The copy of the capsule as one string. */
function copyOf(pill) {
  return capsuleCopy(pill).join('')
}

/** The tooltip of the capsule (the capsule's own `title`). */
function tooltipOf(pill) {
  const node = walk(pill).find(
    (entry) => entry.props && typeof entry.props.title === 'string' && entry.type !== 'button',
  )
  return node ? node.props.title : ''
}

/**
 * Mount the capsule with a long wait that is held by these blockers.
 *
 * @param {any[]} blockedBy
 * @param {number} [waitedMs]
 * @returns {Promise<any>}
 */
async function mountLongWait(blockedBy, waitedMs = 1_504_000) {
  const mounted = mountClient({
    health: {
      ok: true,
      pendingRestart: true,
      waiters: ['sess-x'],
      blockedBy: [],
      allowRestart: false,
      longWait: {
        since: 1_700_000_000_000,
        reason: 'hard-deadline-waiting-for-conversations',
        waitedMs,
        blockedBy,
      },
    },
  })
  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  assert.ok(pill, 'the capsule must be rendered')
  return pill
}

/** The blocker lists the capsule has to survive. */
const CAPSULE_SCENARIOS = [
  {
    label: 'three plain conversations',
    blockers: [session('sess-a', '会话一'), session('sess-b', '会话二'), session('sess-c', '会话三')],
  },
  {
    label: 'ten subagents of three parents',
    blockers: [
      subagent('child-1', 'sess-a', '写代码'),
      subagent('child-2', 'sess-a', '写代码'),
      subagent('child-3', 'sess-a', '写代码'),
      subagent('child-4', 'sess-b', '调研'),
      subagent('child-5', 'sess-b', '调研'),
      subagent('child-6', 'sess-b', '调研'),
      subagent('child-7', 'sess-c', '发版'),
      subagent('child-8', 'sess-c', '发版'),
      subagent('child-9', 'sess-c', '发版'),
      subagent('child-10', 'sess-c', '发版'),
    ],
  },
  {
    label: 'a name of fifty characters',
    blockers: [session('sess-a', '会'.repeat(50))],
  },
  {
    label: 'everything mixed',
    blockers: [
      subagent('child-1', 'sess-a', '写代码'),
      subagent('child-2', 'sess-a', '写代码'),
      session('sess-b', '会'.repeat(50)),
      session('sess-c', '会话三'),
      subagent('child-3', 'sess-d', '发版'),
    ],
  },
]

test('the capsule of a long wait carries numbers only', async () => {
  const pill = await mountLongWait(LONG_WAIT_BLOCKERS)
  const copy = copyOf(pill)
  // FOUR tasks: the two parents of the subagents and the two plain
  // conversations. The ten blockers are four tasks.
  assert.equal(copy, '待重启 · 已等 25 分钟 · 4 项任务在跑', `the capsule says the numbers: ${copy}`)
  assert.ok(
    Array.from(copy).length <= CAPSULE_COPY_LIMIT,
    `the capsule stays short: ${Array.from(copy).length} characters — ${copy}`,
  )
})

test('the capsule stays short for every kind of blocker list', async () => {
  for (const scenario of CAPSULE_SCENARIOS) {
    const pill = await mountLongWait(scenario.blockers)
    const copy = copyOf(pill)
    assert.ok(
      Array.from(copy).length <= CAPSULE_COPY_LIMIT,
      `${scenario.label}: the capsule stays short: ${Array.from(copy).length} characters — ${copy}`,
    )
  }
})

test('the capsule names no blocker at all', async () => {
  for (const scenario of CAPSULE_SCENARIOS) {
    const pill = await mountLongWait(scenario.blockers)
    const copy = copyOf(pill)
    for (const entry of scenario.blockers) {
      const title = entry.label || entry.name || ''
      assert.ok(
        !copy.includes(title),
        `${scenario.label}: the capsule names no blocker: "${title}" — ${copy}`,
      )
    }
  }
})

test('the tooltip of the capsule carries every blocker, nothing cut', async () => {
  for (const scenario of CAPSULE_SCENARIOS) {
    const pill = await mountLongWait(scenario.blockers)
    const tooltip = tooltipOf(pill)
    for (const entry of scenario.blockers) {
      const title = entry.label || entry.name || ''
      assert.ok(
        tooltip.includes(title),
        `${scenario.label}: the tooltip names it: "${title}" — ${tooltip}`,
      )
    }
    assert.ok(!tooltip.includes('…'), `${scenario.label}: the tooltip is not cut: ${tooltip}`)
  }
})

test('the tooltip of the capsule groups the subagents of one session', async () => {
  const pill = await mountLongWait(LONG_WAIT_BLOCKERS)
  const tooltip = tooltipOf(pill)
  assert.match(tooltip, /GitHub 连接不稳定解决方案（3 个子智能体）/, `the group is in the tooltip: ${tooltip}`)
  assert.match(tooltip, /保险库推送目录配置/, `every group is in the tooltip: ${tooltip}`)
  assert.match(tooltip, /DSH 电脑控制台/, `every group is in the tooltip: ${tooltip}`)
  assert.match(tooltip, /另一个会话/, `every group is in the tooltip: ${tooltip}`)
  assert.doesNotMatch(tooltip, /…等 \d+ 项/, `the tooltip is the whole list: ${tooltip}`)
})

test('a long wait does not say the waiting sentence twice', async () => {
  const mounted = mountClient({
    health: {
      ok: true,
      pendingRestart: true,
      waiters: ['sess-x'],
      allowRestart: false,
      // The ordinary list AND the long wait are both there: the capsule must
      // say it ONCE.
      blockedBy: [session('sess-a', '写代码'), session('sess-b', '调研')],
      longWait: {
        since: 1_700_000_000_000,
        reason: 'hard-deadline-waiting-for-conversations',
        waitedMs: 1_504_000,
        blockedBy: LONG_WAIT_BLOCKERS,
      },
    },
  })

  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const copy = copyOf(pill)
  assert.match(copy, /已等/, `the capsule says the long wait: ${copy}`)
  assert.doesNotMatch(copy, /等待 \d+ 个任务结束/, `the waiting sentence is not said twice: ${copy}`)
  assert.ok(
    Array.from(copy).length <= CAPSULE_COPY_LIMIT,
    `the capsule stays short: ${Array.from(copy).length} characters — ${copy}`,
  )
})

test('the waiting sentence of the capsule counts the tasks and names none of them', async () => {
  const mounted = mountClient({
    health: {
      ok: true,
      pendingRestart: true,
      waiters: ['sess-x'],
      allowRestart: false,
      blockedBy: [
        subagent('child-1', 'sess-a', '写代码'),
        subagent('child-2', 'sess-a', '写代码'),
        session('sess-b', '调研'),
        session('sess-c', '另一个会话'),
      ],
    },
  })

  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const copy = copyOf(pill)
  // THREE tasks: the two subagents belong to the session "写代码" (one task),
  // plus "调研" and "另一个会话".
  assert.equal(copy, '待重启 · 等待 3 个任务结束', `the capsule counts the tasks: ${copy}`)
  for (const title of ['写代码', '调研', '另一个会话']) {
    assert.ok(!copy.includes(title), `the capsule names no blocker: ${title} — ${copy}`)
  }
  // The names are in the tooltip, where there is room for them.
  const tooltip = tooltipOf(pill)
  assert.match(tooltip, /写代码（2 个子智能体）/, `the tooltip groups the subagents: ${tooltip}`)
  assert.match(tooltip, /调研/, `the tooltip names every group: ${tooltip}`)
  assert.match(tooltip, /另一个会话/, `the tooltip names every group: ${tooltip}`)
})

test('a blocker without a name adds no clause to the waiting sentence', async () => {
  const mounted = mountClient({
    health: {
      ok: true,
      pendingRestart: true,
      waiters: ['sess-x'],
      allowRestart: false,
      blockedBy: [{ sessionId: 'sess-a', kind: 'session', label: null, name: '' }],
    },
  })

  const pill = await mounted.settled('autorestart-restart-pill', { sessionId: 'sess-x' })
  const text = textOf(pill)
  assert.match(text, /等待 1 个任务结束/, `the tasks are still counted: ${text}`)
  assert.doesNotMatch(text, /有会话/, `a blocker without a name has nothing to show: ${text}`)
})

test('the list of the shutdown card groups the subagents and stays short', async () => {
  const mounted = mountClient({
    status: {
      ok: true,
      phase: 'waiting',
      showSleepButton: true,
      blockers: LONG_WAIT_BLOCKERS,
    },
  })

  const card = await mounted.settled('autorestart-sleep-overlay')
  assert.ok(card, 'the waiting card must be shown')
  const list = walk(card).find(
    (node) => node.props && node.props.className === 'dsh-autorestart-sleep-waiting__list',
  )
  assert.ok(list, 'the card must have its list')
  const items = list.children
  assert.equal(items.length, 3, `two items and the "and N more" line: ${textOf(list)}`)
  assert.match(textOf(list), /GitHub 连接不稳定解决方案的 3 个子智能体正在运行|会话「GitHub 连接不稳定解决方案」的 3 个子智能体正在运行/, `the group has its own line: ${textOf(list)}`)
  assert.match(textOf(list), /…等 \d+ 项/, `the rest is counted, not listed: ${textOf(list)}`)
  assert.doesNotMatch(textOf(list), /另一个会话/, `the card names at most a couple of items: ${textOf(list)}`)

  // The COMPLETE list is in the tooltip of the list.
  const title = list.props.title
  assert.match(title, /GitHub 连接不稳定解决方案/, `the group is in the tooltip: ${title}`)
  assert.match(title, /保险库推送目录配置/, `every group is in the tooltip: ${title}`)
  assert.match(title, /DSH 电脑控制台/, `every group is in the tooltip: ${title}`)
  assert.match(title, /另一个会话/, `every group is in the tooltip: ${title}`)
  assert.doesNotMatch(title, /…等 \d+ 项/, `the tooltip is the whole list: ${title}`)
})

test('the list of the shutdown card groups the subagents of the shape it really gets', async () => {
  // The card gets shape B: no `parentSessionId`, only the parent's title.
  const mounted = mountClient({
    status: {
      ok: true,
      phase: 'waiting',
      showSleepButton: true,
      blockers: [
        cardSubagent('child-1', 'GitHub 连接不稳定解决方案'),
        cardSubagent('child-2', 'GitHub 连接不稳定解决方案'),
        cardSubagent('child-3', 'GitHub 连接不稳定解决方案'),
        cardSubagent('child-4', '保险库推送目录配置'),
        { sessionId: 'sess-c', kind: 'session', label: 'DSH 电脑控制台', name: 'DSH 电脑控制台', parentTitle: null, title: 'DSH 电脑控制台' },
        { sessionId: 'sess-d', kind: 'session', label: '另一个会话', name: '另一个会话', parentTitle: null, title: '另一个会话' },
      ],
    },
  })

  const card = await mounted.settled('autorestart-sleep-overlay')
  const list = walk(card).find(
    (node) => node.props && node.props.className === 'dsh-autorestart-sleep-waiting__list',
  )
  assert.ok(list, 'the card must have its list')
  assert.equal(list.children.length, 3, `two items and the "and N more" line: ${textOf(list)}`)
  assert.match(textOf(list), /会话「GitHub 连接不稳定解决方案」的 3 个子智能体正在运行/, `the group has its own line: ${textOf(list)}`)
  assert.match(textOf(list), /…等 \d+ 项/, `the rest is counted, not listed: ${textOf(list)}`)
  assert.doesNotMatch(textOf(list), /另一个会话/, `the card names at most a couple of items: ${textOf(list)}`)
})

test('the count of the shutdown card is still about tasks', async () => {
  const mounted = mountClient({
    status: {
      ok: true,
      phase: 'waiting',
      showSleepButton: true,
      blockers: LONG_WAIT_BLOCKERS,
    },
  })

  const card = await mounted.settled('autorestart-sleep-overlay')
  const text = textOf(card)
  // FOUR tasks: the two parents of the subagents and the two plain
  // conversations. TWO of them are carried by subagents alone (their session
  // is idle).
  assert.match(text, /还有 4 个任务在干活/, `the count is about tasks: ${text}`)
  assert.match(text, /其中 2 个是子智能体/, `the subagent tasks are counted: ${text}`)
})
