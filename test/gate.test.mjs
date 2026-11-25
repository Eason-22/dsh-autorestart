/**
 * The away gate ("关机时不再弹卡问人").
 *
 * The user pressed 「收工关机」 and left the desk: a question card would wait
 * for a human who is not there. While the shutdown is armed the gate holds
 * the "ask the user" tools back, and the refusal tells the model what to do
 * instead — put the question into the reply, keep doing the work that was
 * already approved, and stop with the list.
 *
 * The gate must be invisible in every other case:
 *   - the switch off ("gateOnSleep: false") → the question goes out as usual;
 *   - nobody armed the shutdown → the question goes out as usual;
 *   - a tool that is not a question → never touched.
 *
 * NOTHING IN THIS FILE CAN SWITCH THE MACHINE OFF: the sleep state is a fake
 * object (`{ controller: { status: () => ({ armed }) } }`), so the real
 * shutdown controller is never involved.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  apply,
  ASK_USER_TOOLS,
  detectAwayQuestion,
  featureAnnouncements,
  GATE_FEATURE_VERSION,
  normalizeConfig,
  PLUGIN_VERSION_FALLBACK,
  registerAskGate,
} from '../index.js'

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-gate-${label}-`))
  return path.join(dir, 'state.json')
}

/**
 * A fake Cordis context that records the tool guards and the prompt sections.
 *
 * @returns {{ ctx: object, guards: Function[], sections: object[], warnings: string[] }}
 */
function createContext() {
  const guards = []
  const sections = []
  const warnings = []
  const systemPrompt = {
    section: (section) => {
      sections.push(section)
      return () => {}
    },
    getSectionOrder: () => 100,
  }
  const ctx = {
    logger: {
      info: () => undefined,
      warn: (...parts) => { warnings.push(parts.map((part) => String(part)).join(' ')) },
      error: () => undefined,
    },
    tools: {
      register: () => () => {},
      guard: (callback) => {
        guards.push(callback)
        return () => {}
      },
    },
    effect: (fn) => { fn(); return () => {} },
    get: (name) => (name === 'systemPrompt' ? systemPrompt : undefined),
  }
  return { ctx, guards, sections, warnings }
}

/** A fake runtime: the gate only needs a log and a counter. */
function createRuntime() {
  return {
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    askGateBlocks: 0,
  }
}

/**
 * A fake sleep state.
 *
 * The real controller is never involved, so this file cannot switch the
 * machine off.
 *
 * @param {boolean} armed
 * @returns {{ controller: { status: () => object } }}
 */
function fakeSleep(armed) {
  return {
    controller: {
      status: () => ({ phase: armed ? 'waiting' : 'idle', armed, countdownSeconds: armed ? 20 : 0 }),
    },
  }
}

/* ------------------------------------------------------------------ *
 * The three cases the gate is judged by.
 * ------------------------------------------------------------------ */

test('the away gate holds a question back while the user is away', () => {
  // ARMED + THE SWITCH ON -> the question is held back.
  const { ctx, guards } = createContext()
  const runtime = createRuntime()
  registerAskGate(ctx, runtime, { gateOnSleep: true }, fakeSleep(true))

  assert.equal(guards.length, 1, 'the gate must register exactly one guard')
  const refusal = guards[0]({ name: 'ask_user_question', arguments: {} })
  assert.equal(typeof refusal, 'string', 'a question must be held back while the user is away')
  assert.equal(runtime.askGateBlocks, 1, 'the gate must count what it held back')
})

test('the away gate stays out of the way when the switch is off', () => {
  // ARMED + THE SWITCH OFF -> the question goes out as usual.
  const { ctx, guards } = createContext()
  const runtime = createRuntime()
  registerAskGate(ctx, runtime, { gateOnSleep: false }, fakeSleep(true))

  assert.equal(guards.length, 0, 'a disabled gate must not register a guard at all')
  assert.equal(
    detectAwayQuestion({ name: 'ask_user_question' }, { armed: true, enabled: false }),
    null,
    'and the decision itself must let the question through',
  )
  assert.equal(runtime.askGateBlocks, 0, 'a disabled gate must not count anything')
})

test('the away gate never touches a tool while the user is at the desk', () => {
  // NOT ARMED -> every tool goes out as usual.
  const { ctx, guards } = createContext()
  const runtime = createRuntime()
  registerAskGate(ctx, runtime, { gateOnSleep: true }, fakeSleep(false))

  assert.equal(guards.length, 1, 'the gate is registered, it just has nothing to do')
  assert.equal(
    guards[0]({ name: 'ask_user_question', arguments: {} }),
    undefined,
    'a question must go out as usual while nobody armed the shutdown',
  )
  assert.equal(guards[0]({ name: 'ops_bash', arguments: {} }), undefined)
  assert.equal(runtime.askGateBlocks, 0, 'the gate must not count anything')
})

/* ------------------------------------------------------------------ *
 * The refusal.
 * ------------------------------------------------------------------ */

test('the refusal teaches the model what to do instead of saying "no"', () => {
  const refusal = detectAwayQuestion({ name: 'ask_user_question' }, { armed: true })
  assert.equal(typeof refusal, 'string')

  // 1) the user is not at the desk.
  assert.match(refusal, /用户已离开电脑/, 'the refusal must say that the user is away')
  assert.match(refusal, /收工关机/, 'the refusal must name the reason')

  // 2) the question goes into the reply, not into a card.
  assert.match(refusal, /待你拍板/, 'the refusal must mark the list the user has to decide')
  assert.match(refusal, /正文/, 'the refusal must say that the list goes into the reply')

  // 3) keep going, and stop with the list.
  assert.match(refusal, /已经点头过的事/, 'the refusal must say what to do meanwhile')
  assert.match(refusal, /收尾停下/, 'the refusal must say how the work ends')

  // The refusal talks to the model, not to the plugin's internals.
  assert.doesNotMatch(refusal, /闸|卡点|管道/, 'the refusal must not use internal jargon')
})

test('the list of question tools is the one truth', () => {
  assert.deepEqual(ASK_USER_TOOLS, ['ask_user_question', 'intake_ask', 'intake_elicit'])
  for (const name of ASK_USER_TOOLS) {
    assert.equal(
      typeof detectAwayQuestion({ name }, { armed: true }),
      'string',
      `${name} must be held back while the user is away`,
    )
  }
  for (const name of ['ops_bash', 'read', 'todo_write', 'continuum_status']) {
    assert.equal(
      detectAwayQuestion({ name }, { armed: true }),
      null,
      `${name} is not a question and must never be held back`,
    )
  }
})

test('a broken tool call never blocks anything', () => {
  assert.equal(detectAwayQuestion(null, { armed: true }), null)
  assert.equal(detectAwayQuestion(undefined, { armed: true }), null)
  assert.equal(detectAwayQuestion({}, { armed: true }), null)
  assert.equal(detectAwayQuestion({ name: 42 }, { armed: true }), null)
})

test('a sleep state that cannot be read is not "the user is away"', () => {
  const { ctx, guards } = createContext()
  const runtime = createRuntime()
  registerAskGate(ctx, runtime, { gateOnSleep: true }, {
    controller: {
      status: () => { throw new Error('the state cannot be read') },
    },
  })
  assert.equal(guards.length, 1)
  assert.equal(
    guards[0]({ name: 'ask_user_question' }),
    undefined,
    'a broken reader must not hold a question back',
  )
  assert.equal(runtime.askGateBlocks, 0)
})

/* ------------------------------------------------------------------ *
 * The injection that is NOT there.
 *
 * The gate speaks to the model ONLY when it holds a question back: the
 * refusal is the tool's answer. There is no system-prompt section for it —
 * a section is global, so it would reach every session and make OTHER
 * conversations stop early.
 * ------------------------------------------------------------------ */

test('the away gate adds no system-prompt section at all', () => {
  // The source must not mention the section or the text it used to carry.
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(
    source,
    /away-gate/,
    'the away gate must not register a system-prompt section: it is global',
  )
  assert.doesNotMatch(
    source,
    /AWAY_GATE_PROMPT/,
    'the away gate must not carry an injected text',
  )
  // The refusal is what remains: it is the answer the gate gives the model.
  assert.match(source, /AWAY_GATE_DENIAL/, 'the refusal text must stay')
})

/* ------------------------------------------------------------------ *
 * The configuration.
 * ------------------------------------------------------------------ */
test('the switch is on unless it is explicitly turned off', () => {
  assert.equal(normalizeConfig({}).gateOnSleep, true, 'the gate is on by default')
  assert.equal(normalizeConfig({ gateOnSleep: true }).gateOnSleep, true)
  assert.equal(normalizeConfig({ gateOnSleep: false }).gateOnSleep, false)
  assert.equal(
    normalizeConfig({ gateOnSleep: 'no' }).gateOnSleep,
    true,
    'a wrong value must never open the gate',
  )
})

/* ------------------------------------------------------------------ *
 * The announcement and the version.
 * ------------------------------------------------------------------ */

test('the gate is announced once, as a feature of its own', () => {
  assert.equal(GATE_FEATURE_VERSION, '1.0.0')
  const entry = featureAnnouncements().find((one) => one.feature === 'gate')
  assert.deepEqual(entry, { feature: 'gate', version: '1.0.0' })
  // The shape of the list must not change: every entry is {feature, version}.
  for (const one of featureAnnouncements()) {
    assert.deepEqual(Object.keys(one).sort(), ['feature', 'version'])
  }
})

test('the package version and its fallback agree', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.version, '1.0.0')
  assert.equal(PLUGIN_VERSION_FALLBACK, '1.0.0')
})

/* ------------------------------------------------------------------ *
 * The boot: the gate and the reminder are really wired up.
 * ------------------------------------------------------------------ */

/**
 * A fake Cordis context good enough for `apply()`.
 *
 * @returns {{ ctx: object, guards: Function[], sections: object[], file: string }}
 */
function createBootContext() {
  const guards = []
  const sections = []
  const warnings = []
  const webServer = {
    register: () => () => {},
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const systemPrompt = {
    section: (section) => {
      sections.push(section)
      return () => {}
    },
    getSectionOrder: () => 100,
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
    tools: {
      register: () => () => {},
      guard: (callback) => {
        guards.push(callback)
        return () => {}
      },
    },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: () => () => {},
    timeout: () => () => {},
    get: (name) => {
      if (name === 'webServer') return webServer
      if (name === 'systemPrompt') return systemPrompt
      return undefined
    },
  }
  return { ctx, guards, sections, warnings, file: tempStateFile('boot') }
}

test('the plugin registers no away-gate section at boot', () => {
  const { ctx, guards, sections, file } = createBootContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  assert.equal(
    sections.filter((one) => one.name === 'dsh-autorestart:away-gate').length,
    0,
    'no away-gate section may be registered',
  )

  // The gate itself still works: nothing is held back while nobody armed
  // the shutdown.
  assert.ok(guards.length >= 1, 'the tool guards must be registered')
  for (const guard of guards) {
    assert.equal(
      guard({ name: 'ask_user_question', arguments: {} }),
      undefined,
      'no guard may hold a question back while nobody armed the shutdown',
    )
  }
})
