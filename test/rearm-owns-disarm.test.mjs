/**
 * THE RE-ARM OWNS THE DISARM (bug, 2026-11-25, session 534dee38).
 *
 * THE REAL MISS: session `534dee38` was disarmed by THIS plugin at 00:47
 * (`reason = 'restart-blocking'`, restart cycle 937). After the restart the
 * boot answered `lastRecoveryAction = 'prompt-continuation'` and the record's
 * `resumedAt` stayed empty — the goal was NEVER given back. It matched
 * neither of the two old branches, because at boot the goal's `activation`
 * was NOT `disarmed`: the host's own goal round driver had armed the goal
 * again after the restart. The work of that session was dropped.
 *
 * THE RULE THESE TESTS PIN:
 *   - The OWNERSHIP of the disarm decides, not the activation: a record that
 *     names a restart reason (`restart-queued` / `restart-blocking`) was taken
 *     by this plugin, so this plugin gives it back — whatever the activation
 *     says.
 *   - A record the USER stopped (`manual-park`) and a record of the previous
 *     build (no reason at all) are NOT ours: they are never given back.
 *   - When the goal CANNOT be given back, the failure leaves a trace
 *     (`goal-rearm-failed`); it never degrades into a bare continuation
 *     message, which would wake the session WITHOUT the goal and hide the
 *     fact that the goal was never given back.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

/** The actions that mean "the goal was given back". */
const RESUME_ACTIONS = new Set(['resume-disarmed-goal', 'resume-paused-goal', 'rearm-goal'])

/** A temporary checkpoint file that holds the state of the previous boot. */
function tempStateFile(label, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-rearm-${label}-`))
  const file = path.join(dir, 'state.json')
  fs.writeFileSync(file, JSON.stringify(state), 'utf8')
  return file
}

/**
 * A fake Cordis context that remembers the goals service: every disarm is
 * counted, every resume is recorded, and the live goal can be told apart from
 * the record of the disarm.
 *
 * `resumeError` makes the goals service refuse the resume (the way the host
 * does when the revision is stale or the round budget is used up).
 */
function createContext({ agent = null, goal = null, followups = null, resumeError = null } = {}) {
  const timers = []
  const timeouts = []
  const handlers = new Map()
  const routes = []
  const calls = { disarm: [], resume: [] }
  const webServer = {
    register: (route) => { routes.push(route); return () => {} },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const live = agent === null ? undefined : agent
  // The recovery injects the continuation message through the live agent's
  // `followup()` — that is where "the session was woken up" becomes visible.
  const agents = live === undefined
    ? []
    : [followups && typeof live.followup !== 'function'
      ? { ...live, followup: (message) => { followups.push(message); return undefined } }
      : live]
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fiber: { state: 2 },
    agents: {
      list: () => agents,
      roots: () => agents,
      get: (id) => agents.find((entry) => entry.id === id),
    },
    goals: {
      get: (target) => (target && goal ? goal : undefined),
      disarm: (target) => { calls.disarm.push(target && target.id); return undefined },
      resume: (target, revision) => {
        calls.resume.push({ id: target && target.id, revision })
        if (resumeError) throw resumeError
      },
    },
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
    timeout: (fn, ms) => {
      timeouts.push({ fn, ms })
      return () => {}
    },
    get: (name) => (name === 'webServer' ? webServer : undefined),
  }
  return { ctx, timers, timeouts, calls, routes, handlers, agents }
}

/**
 * The state of the previous boot: the host really restarted, a restart was
 * requested a minute ago, and the session holds the record of the disarm.
 *
 * @param {number} now
 * @param {string|null} reason the `reason` of the disarm record (null = the
 *   records of the previous build, which have no reason at all)
 */
function bootState(now, reason) {
  return {
    version: 1,
    // A DIFFERENT pid: the host really restarted.
    bootPid: 1,
    generation: 645,
    phase: 'running',
    restart: { generation: 645, requestedAt: now - 60_000, attempt: 0, notBefore: 0, parkGoals: true },
    restartCycleStartedAt: now - 60_000,
    sessions: {
      'session-a': { sessionId: 'session-a', running: false, updatedAt: now },
    },
    disarmedGoals: {
      'session-a': {
        goalId: 'goal-1',
        disarmedAt: now - 36 * 60 * 1000,
        resumedAt: null,
        ...(reason === null ? {} : { reason }),
      },
    },
  }
}

/** Run the boot recovery pass of the plugin and wait for it. */
async function runBoot(runtime, timeouts) {
  const boot = timeouts[0]
  assert.ok(boot, 'the boot recovery pass must be scheduled')
  boot.fn()
  await new Promise((resolve) => setTimeout(resolve, 50))
}

test('a goal the plugin disarmed for the restart is given back even when the host armed it again', async () => {
  // THE REAL MISS (session 534dee38): the record names the restart, the goal is
  // still `active` — but its activation is `armed`, because the host's round
  // driver armed it after the restart. The old branches needed
  // `activation === 'disarmed'`, so the goal was silently kept.
  const now = Date.now()
  const stateFile = tempStateFile('already-armed', bootState(now, 'restart-blocking'))
  const followups = []
  const { ctx, timeouts, calls } = createContext({
    agent: { id: 'session-a', status: 'idle' },
    // NOT `disarmed`: the host armed the goal again after the restart.
    goal: { id: 'goal-1', revision: 9, phase: 'active', activation: 'armed', roundsStarted: 176, maxGoalRounds: 200 },
    followups,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  await runBoot(runtime, timeouts)

  const entry = runtime.state.sessions['session-a']
  const record = runtime.state.disarmedGoals['session-a']
  assert.equal(calls.resume.length, 1, 'the goal really got its continuation authority back')
  assert.ok(
    RESUME_ACTIONS.has(entry && entry.lastRecoveryAction),
    `the recovery gives the goal back (${entry && entry.lastRecoveryAction})`,
  )
  assert.notEqual(entry && entry.lastRecoveryAction, 'prompt-continuation', 'and it is NOT a bare continuation message')
  assert.notEqual(record.resumedAt, null, 'the record says the goal is back')
})

test('a record the USER stopped (manual-park) is never given back', async () => {
  const now = Date.now()
  const stateFile = tempStateFile('manual-park', bootState(now, 'manual-park'))
  const followups = []
  const { ctx, timeouts, calls } = createContext({
    agent: { id: 'session-a', status: 'idle' },
    goal: { id: 'goal-1', revision: 9, phase: 'active', activation: 'armed', roundsStarted: 176, maxGoalRounds: 200 },
    followups,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  await runBoot(runtime, timeouts)

  const record = runtime.state.disarmedGoals['session-a']
  assert.equal(calls.resume.length, 0, 'the goal of a session the user stopped is not re-armed')
  assert.equal(record.resumedAt, null, 'and its record stays untouched')
})

test('a record of the previous build (no reason) is never given back', async () => {
  const now = Date.now()
  const stateFile = tempStateFile('no-reason', bootState(now, null))
  const followups = []
  const { ctx, timeouts, calls } = createContext({
    agent: { id: 'session-a', status: 'idle' },
    goal: { id: 'goal-1', revision: 9, phase: 'active', activation: 'armed', roundsStarted: 176, maxGoalRounds: 200 },
    followups,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  await runBoot(runtime, timeouts)

  const record = runtime.state.disarmedGoals['session-a']
  assert.equal(calls.resume.length, 0, 'a record that does not name an owner is not ours to give back')
  assert.equal(record.resumedAt, null, 'and its record stays untouched')
})

test('a goal that cannot be given back leaves a trace instead of a continuation message', async () => {
  // The goals service refuses the resume (a stale revision, an exhausted round
  // budget): the goal of this session was taken away by the plugin and stays
  // away. That has to be visible — a continuation message would wake the
  // session WITHOUT the goal and hide the fact that nothing was given back.
  const now = Date.now()
  const stateFile = tempStateFile('rearm-failed', bootState(now, 'restart-blocking'))
  const followups = []
  const { ctx, timeouts } = createContext({
    agent: { id: 'session-a', status: 'idle' },
    goal: { id: 'goal-1', revision: 9, phase: 'active', activation: 'disarmed', roundsStarted: 176, maxGoalRounds: 200 },
    followups,
    resumeError: new Error('the goal was changed by someone else'),
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  await runBoot(runtime, timeouts)

  const entry = runtime.state.sessions['session-a']
  assert.equal(entry && entry.lastRecoveryAction, 'goal-rearm-failed', 'the failure is recorded')
  assert.notEqual(entry && entry.lastRecoveryAction, 'prompt-continuation', 'and it is NOT a bare continuation message')
  assert.equal(followups.length, 0, 'the session is not woken up without its goal')
})

test('a goal that is ALREADY armed: the session is woken up, the record is not closed as stale', async () => {
  // THE HOST ALREADY ARMED THE GOAL (the round driver did it after the
  // restart), so the goals service refuses the resume: `goal "<id>" is already
  // active and armed`.
  //
  // THE WORK MUST NOT FALL ON THE FLOOR (bug, 2026-11-25): closing the record
  // as if the goal had been given back leaves the session asleep — the goal
  // runs, but nobody tells the session to go on. So the record stays open (this
  // plugin did NOT give the goal back) and the session goes on the ORDINARY
  // recovery path: it is woken up with the continuation message.
  const now = Date.now()
  const stateFile = tempStateFile('already-armed-refused', bootState(now, 'restart-blocking'))
  const followups = []
  const { ctx, timeouts } = createContext({
    agent: { id: 'session-a', status: 'idle' },
    goal: { id: 'goal-1', revision: 9, phase: 'active', activation: 'armed', roundsStarted: 176, maxGoalRounds: 200 },
    followups,
    // The host's own words, from `@deepseek-ai/dsh-goal`.
    resumeError: new Error('goal "goal-1" is already active and armed'),
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  await runBoot(runtime, timeouts)

  const record = runtime.state.disarmedGoals['session-a']
  assert.equal(followups.length, 1, 'the session is woken up: the work does not fall on the floor')
  assert.equal(record.resumedAt, null, 'the record is NOT closed as if the goal had been given back')
})
