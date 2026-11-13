/**
 * THE OWNERSHIP OF A DISARMED GOAL (bug, 2026-11-12).
 *
 * Two defects, one cause: the plugin decided WHO may be disarmed and WHO has
 * to be given back from PROCESS FACTS — a timestamp of the request that every
 * later requester rewrites, and the live state of a goal that says nothing
 * about who armed it.
 *
 *   A (the goal never comes back): the boot adopted a disarm only when its
 *     timestamp was not older than `restart.requestedAt`. The request field is
 *     rewritten by every requester that comes later (and pushed into the
 *     future by `defer_seconds`), so the disarm that happened FIRST looked
 *     like history: the boot had nothing to adopt and the goal stayed
 *     disarmed for ever.
 *
 *   B (the goal is taken away again and again): the poll disarmed the goals of
 *     the blocking sessions every three seconds. A goal the USER armed again
 *     in the meantime was taken away again on the next poll, and the disarm
 *     overwrote the record — so the reason was gone and the interface showed
 *     "paused" for ever.
 *
 * The fix: the record carries the OWNERSHIP of the disarm (why it happened,
 * which restart cycle, which revision of the goal) and the decisions are made
 * on that ownership. The timestamps stay as the fallback for the records of
 * the previous build, which have no ownership at all.
 *
 * These tests pin the behaviour, not the implementation.
 */

// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import {
  beginBoot,
  createEmptyState,
  normalizeState,
  recoverableSessions,
  requestRestart,
  setDisarmedGoal,
} from '../lib/checkpoint.js'

/** The state the selector reads. */
function stateWith(overrides = {}) {
  return { sessions: {}, ...overrides }
}

/** A temporary checkpoint file that holds the state of the previous boot. */
function tempStateFile(label, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-own-${label}-`))
  const file = path.join(dir, 'state.json')
  fs.writeFileSync(file, JSON.stringify(state), 'utf8')
  return file
}

/** Replace `Date.now` with a clock the test drives (no real waiting). */
function patchNow(clock, t) {
  const real = Date.now
  Date.now = () => clock.value
  t.after(() => { Date.now = real })
  return clock
}

/**
 * A fake Cordis context that remembers the goals service: every disarm is
 * counted, every resume is recorded, and the live goal can be told apart from
 * the record of the disarm.
 */
function createContext({ agent = null, goal = null, followups = null, sessionController = null } = {}) {
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
      resume: (target, revision) => { calls.resume.push({ id: target && target.id, revision }) },
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
    get: (name) => (
      name === 'webServer' ? webServer
        : (name === 'sessionController' ? sessionController : undefined)
    ),
  }
  // The controller is OPTIONAL: the recovery reaches for it when the session is
  // not live, and a test may hand in one that records the injected message.
  if (sessionController) ctx.sessionController = sessionController
  // `handlers` and `agents` are handed out so that a test can fire an event
  // the way the host does — with the very agent object the host holds.
  return { ctx, timers, timeouts, calls, routes, handlers, agents }
}

/* ------------------------------------------------------------------ *
 * ① THE BOOT ADOPTS THE DISARM OF THE WHOLE CYCLE (root cause A).
 * ------------------------------------------------------------------ */

test('R1: a disarm that happened BEFORE the later requester is adopted all the same', () => {
  // The restart was asked for at 15:34:09 (the cycle started then), and a
  // second requester joined it at 15:40. The goal was disarmed at 15:35 —
  // BEFORE the second requester — so the old rule ("the disarm is not older
  // than the request") threw it away as history and the boot never gave the
  // goal back.
  const state = stateWith({
    restart: { requestedAt: 5000, requesters: [{ sessionId: 's2', requestedAt: 5000 }] },
    // The cycle start lives in the STATE — that is where `requestRestart` writes
    // it and where `adoptDisarmedGoals` reads it.
    restartCycleStartedAt: 1000,
    sessions: {
      'session-a': { sessionId: 'session-a', running: false, updatedAt: 2000 },
    },
    disarmedGoals: {
      'session-a': {
        goalId: 'goal-1',
        disarmedAt: 2000,
        resumedAt: null,
        reason: 'restart-blocking',
        cycle: 640,
        goalRevision: 5,
      },
    },
  })
  const pending = recoverableSessions(state, { now: 6000 })
  assert.equal(pending.length, 1, 'the disarm belongs to this restart cycle: it is adopted')
  assert.equal(pending[0].pendingResume, true)
  assert.equal(pending[0].goal.goalId, 'goal-1')
})

test('R2: a record of the previous build is only claimed by its timestamps', () => {
  // No reason, no cycle, no revision: the previous build wrote nothing but
  // the timestamp, so the timestamp is all there is.
  const state = stateWith({
    restart: { requestedAt: 1000 },
    sessions: {
      'session-old': { sessionId: 'session-old', running: false, updatedAt: 999 },
    },
    disarmedGoals: {
      'session-old': { goalId: 'goal-old', disarmedAt: 999, resumedAt: null },
    },
  })
  assert.deepEqual(recoverableSessions(state, { now: 2000 }), [], 'the disarm is older than the request: it is history')
  // The same record, read by a clock that is a day later: it is older than the
  // request AND older than the age bound — it is history either way.
  assert.deepEqual(recoverableSessions(state, { now: 1_700_000_000_000 }), [], 'a day later it is still history')
})

test('R2: a record of the previous build without a session is an orphan, not pending work', () => {
  const state = stateWith({
    restart: { requestedAt: 1000 },
    disarmedGoals: {
      'session-old': { goalId: 'goal-old', disarmedAt: 999, resumedAt: null },
    },
  })
  assert.deepEqual(recoverableSessions(state, { now: 2000 }), [], 'an orphan record must not create a ghost session')
})

test('R2 (the age bound): a record of the previous build that is older than a day is not claimed', () => {
  // A record that was never resumed is never pruned, so without an age bound
  // it would come back on every single boot. Here the record is NEWER than the
  // request (so the request moment does not reject it) but a day old.
  const now = 1_700_000_000_000
  const state = stateWith({
    restart: { requestedAt: 1000 },
    sessions: {
      'session-old': { sessionId: 'session-old', running: false, updatedAt: now },
    },
    disarmedGoals: {
      'session-old': { goalId: 'goal-old', disarmedAt: now - 25 * 60 * 60 * 1000, resumedAt: null },
    },
  })
  assert.deepEqual(recoverableSessions(state, { now }), [], 'a record of days ago is not pending work')
})

/* ------------------------------------------------------------------ *
 * ② THE GOAL OF THE USER IS NOT TAKEN AWAY AGAIN (root cause B).
 * ------------------------------------------------------------------ */

test('R3: a goal the user armed again is not taken away a second time', async (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const stateFile = tempStateFile('taken-back', {
    version: 1,
    // A DIFFERENT pid: the host really restarted.
    bootPid: 1,
    generation: 641,
    phase: 'running',
    restart: { generation: 641, requestedAt: 5000, attempt: 0, notBefore: 0, parkGoals: true },
    restartCycleStartedAt: 1000,
    sessions: {
      'session-a': { sessionId: 'session-a', running: false, updatedAt: 5000 },
    },
    disarmedGoals: {
      'session-a': {
        goalId: 'goal-1',
        disarmedAt: 1000,
        resumedAt: null,
        reason: 'restart-blocking',
        cycle: 640,
        goalRevision: 5,
      },
    },
  })
  const { ctx, calls } = createContext({
    agent: { id: 'session-a', status: 'running' },
    // The user armed the goal again: it is active, armed, and it is NEWER
    // than the revision the record was written at.
    goal: { id: 'goal-1', revision: 6, phase: 'active', activation: 'armed', roundsStarted: 3, maxGoalRounds: 10 },
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 10000,
    forceRestartWhenBusy: false,
  })

  runtime.tick()
  const record = runtime.state.disarmedGoals['session-a']
  assert.equal(calls.disarm.length, 0, 'the goal of the user is not taken away')
  assert.equal(record.disarmedAt, 1000, 'the record of the disarm is untouched')
  assert.notEqual(record.resumedAt, null, 'the record says the goal is the user\'s again')

  // The next poll must not take it away either.
  clock.value += 5000
  runtime.tick()
  assert.equal(calls.disarm.length, 0, 'and it is not taken away on the next poll either')
  assert.equal(runtime.state.disarmedGoals['session-a'].disarmedAt, 1000, 'the record still is the one of the disarm')

  // The gate keeps deciding: the restart is waiting for the goal, not stuck.
  const gate = runtime.restartGateInfo()
  assert.ok(gate && typeof gate.at === 'number', 'the gate records its decision')
  assert.ok(gate.at >= clock.value - 10000, 'and the decision is of this poll')
})

test('R4: a goal the PLUGIN gave back may be disarmed again', async (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const stateFile = tempStateFile('given-back', {
    version: 1,
    bootPid: 1,
    generation: 641,
    phase: 'running',
    restart: { generation: 641, requestedAt: 5000, attempt: 0, notBefore: 0, parkGoals: true },
    restartCycleStartedAt: 1000,
    sessions: {
      'session-a': { sessionId: 'session-a', running: false, updatedAt: 5000 },
    },
    disarmedGoals: {
      // The plugin gave this goal back itself (`resumedAt` is set): a goal the
      // plugin owns may be disarmed again — otherwise the restart waits for a
      // goal nobody can disarm any more (the deadlock of 2026-11-02).
      'session-a': {
        goalId: 'goal-1',
        disarmedAt: 1000,
        resumedAt: 2000,
        reason: 'restart-blocking',
        cycle: 640,
        goalRevision: 5,
      },
    },
  })
  const { ctx, calls } = createContext({
    agent: { id: 'session-a', status: 'running' },
    goal: { id: 'goal-1', revision: 6, phase: 'active', activation: 'armed', roundsStarted: 3, maxGoalRounds: 10 },
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 10000,
    forceRestartWhenBusy: false,
  })

  runtime.tick()
  assert.equal(calls.disarm.length, 1, 'the goal the plugin gave back is disarmable again')
})

/* ------------------------------------------------------------------ *
 * ③ THE CYCLE HAS AN IDENTITY OF ITS OWN.
 * ------------------------------------------------------------------ */

test('R7: the requester that comes second does not move the start of the cycle', () => {
  const state = createEmptyState(0)
  requestRestart(state, { reason: 'first', bySessionId: 's1', now: 1000 })
  requestRestart(state, { reason: 'second', bySessionId: 's2', now: 5000 })
  assert.equal(state.restartCycleStartedAt, 1000, 'the cycle started when the FIRST requester asked')
  assert.equal(state.restart.requestedAt, 5000, 'the request itself is the one of the last requester')
  assert.equal(state.restart.requesters.length, 2, 'both requesters are on the record')
})

test('R7: a deferred restart does not move the start of the cycle either', () => {
  const state = createEmptyState(0)
  requestRestart(state, { reason: 'first', bySessionId: 's1', now: 1000 })
  // What `defer_seconds` does: the request moment moves into the future.
  state.restart.requestedAt = 1000 + 60 * 1000
  requestRestart(state, { reason: 'second', bySessionId: 's2', now: 5000 })
  assert.equal(state.restartCycleStartedAt, 1000, 'the cycle still started at the first request')
})

/* ------------------------------------------------------------------ *
 * ⑤ THE RECORD CARRIES THE OWNERSHIP OF THE DISARM.
 * ------------------------------------------------------------------ */

test('R8: the record keeps the ownership of the disarm', () => {
  const state = createEmptyState(1000)
  setDisarmedGoal(state, 's1', { goalId: 'goal-1', disarmedAt: 5 })
  setDisarmedGoal(state, 's1', { disarmedAt: 17, reason: 'restart-blocking', cycle: 8, goalRevision: 3 })
  const record = state.disarmedGoals.s1
  assert.equal(record.reason, 'restart-blocking', 'WHY the goal was taken away')
  assert.equal(record.cycle, 8, 'WHICH restart cycle took it away')
  assert.equal(record.goalRevision, 3, 'WHICH revision of the goal it was at that moment')
  assert.equal(record.resumedAt, null, 'and it is not given back')
})

test('R8: a disarm that names no reason does not throw the reason away', () => {
  const state = createEmptyState(1000)
  setDisarmedGoal(state, 's1', { goalId: 'goal-1', disarmedAt: 5, reason: 'restart-queued' })
  setDisarmedGoal(state, 's1', { goalId: 'goal-1', disarmedAt: 17 })
  assert.equal(state.disarmedGoals.s1.reason, 'restart-queued', 'what is known about the disarm survives')
})

/* ------------------------------------------------------------------ *
 * ⑥ THE LEGACY FALLBACK, ON THE PRODUCTION PATH (review O1).
 *
 * A record of the previous build has no `reason`, so the boot decides about it
 * with the timestamps: the disarm has to be at least as new as the START of
 * the restart cycle, and it must not be older than a day (a record that was
 * never resumed is never pruned).
 *
 * The start of the cycle lives in the STATE (`state.restartCycleStartedAt`),
 * because that is where `requestRestart` writes it. These cases go through
 * that very field, so the fallback is covered where it actually runs.
 * ------------------------------------------------------------------ */

/** The state of a host that is waiting for a restart, with a legacy record. */
function legacyState({ disarmedAt = 2000, now = 6000 } = {}) {
  return stateWith({
    restart: { requestedAt: 5000 },
    restartCycleStartedAt: 1000,
    sessions: {
      'session-a': { sessionId: 'session-a', running: false, updatedAt: disarmedAt },
    },
    disarmedGoals: {
      'session-a': { goalId: 'goal-1', disarmedAt, resumedAt: null },
    },
  })
}

test('C1: a record of the previous build is claimed by the start of the cycle', () => {
  const pending = recoverableSessions(legacyState(), { now: 6000 })
  assert.equal(pending.length, 1, 'the record has no reason: the cycle start decides')
  assert.equal(pending[0].pendingResume, true)
  assert.equal(pending[0].goal.goalId, 'goal-1')
})

test('C2: a record of the previous build that is older than the cycle is history', () => {
  const state = legacyState({ disarmedAt: 999 })
  assert.deepEqual(recoverableSessions(state, { now: 6000 }), [], 'the disarm is older than the cycle start')
})

test('C3: a record of the previous build that is more than a day old is not claimed', () => {
  const now = 1_700_000_000_000
  const state = legacyState({ disarmedAt: now - 25 * 60 * 60 * 1000, now })
  assert.deepEqual(recoverableSessions(state, { now }), [], 'a record of days ago is not pending work')
})

test('C4: the cycle start lives in ONE place — the state, never in the request record', () => {
  // A file that carries `restart.cycleStartedAt` (hand-written, or from a build
  // that had the field) loses that key: the request record has no such field.
  const normalized = normalizeState({
    version: 1,
    restart: { requestedAt: 5000, cycleStartedAt: 1234 },
    restartCycleStartedAt: 1000,
  }, 6000)
  assert.equal(normalized.state.restart.cycleStartedAt, undefined, 'the dead field is gone')
  assert.equal('cycleStartedAt' in normalized.state.restart, false, 'and it is not even a key')
  assert.equal(normalized.state.restartCycleStartedAt, 1000, 'the state keeps the cycle start')

  // `requestRestart` writes the state field, and the requester that comes
  // second does not move it.
  const state = createEmptyState(0)
  requestRestart(state, { reason: 'first', bySessionId: 's1', now: 1000 })
  requestRestart(state, { reason: 'second', bySessionId: 's2', now: 5000 })
  assert.equal(state.restartCycleStartedAt, 1000, 'the cycle started with the first requester')
  assert.equal(state.restart.cycleStartedAt, undefined, 'the request record carries no cycle start')
})

/* ------------------------------------------------------------------ *
 * ⑦ THE AGE BOUND APPLIES TO EVERY RECORD (real incident, 2026-11-12).
 * ------------------------------------------------------------------ */

/** A state whose disarm record NAMES a restart — the shape the plugin writes now. */
function ownedState({ disarmedAt, now, reason = 'restart-queued' }) {
  return stateWith({
    restart: { requestedAt: now - 60_000 },
    restartCycleStartedAt: now - 60_000,
    sessions: {
      'session-a': { sessionId: 'session-a', running: false, updatedAt: disarmedAt },
    },
    disarmedGoals: {
      'session-a': { goalId: 'goal-1', disarmedAt, resumedAt: null, reason },
    },
  })
}

test('D1: a disarm of DAYS ago is history, even when it names a restart', () => {
  // THE INCIDENT (2026-11-12, the boot of generation 644): a session that was
  // disarmed on 11-03 — nine days earlier — was pulled into the recovery queue
  // and a resume message was queued for it, because its record named a restart
  // and the age bound only applied to the records of the previous build. A goal
  // that was taken away for good long ago must not be woken up by a boot.
  const now = 1_700_000_000_000
  const state = ownedState({ disarmedAt: now - 217 * 60 * 60 * 1000, now })
  assert.deepEqual(recoverableSessions(state, { now }), [], 'nine days old is history')
})

test('D2: a disarm of the last hours is still pending work', () => {
  // The age bound must not close the door the fix opened: a disarm that
  // happened two hours ago and names the pending restart is still that
  // restart's business (and the reason branch still does not look at the
  // timestamp of the record).
  const now = 1_700_000_000_000
  const state = ownedState({ disarmedAt: now - 2 * 60 * 60 * 1000, now })
  const pending = recoverableSessions(state, { now })
  assert.equal(pending.length, 1, 'the disarm belongs to the pending restart')
  assert.equal(pending[0].pendingResume, true)
  assert.equal(pending[0].goal.goalId, 'goal-1')
})

test('D3: a record of the previous build that is older than a day is not claimed', () => {
  // The same bound for the records without a reason (the shape of C3, pinned
  // here again so that moving the bound cannot break it unnoticed).
  const now = 1_700_000_000_000
  const state = legacyState({ disarmedAt: now - 25 * 60 * 60 * 1000, now })
  assert.deepEqual(recoverableSessions(state, { now }), [], 'a record of days ago is not pending work')
})

/* ------------------------------------------------------------------ *
 * ⑦ A GOAL THAT IS COMPLETE STAYS QUIET (bug, 2026-11-12).
 *
 * A goal that finished has no work left: there is nothing for a continuation
 * message to continue. The boot used to adopt such a session on every
 * restart (the record names the restart, so it was claimed) and to wake the
 * sessions that already carried `pendingResume` — the one in the field ran to
 * round 176, answering "there is nothing to do" every single time.
 * ------------------------------------------------------------------ */

/** A state whose disarm record belongs to the current restart (36 minutes old). */
function currentRestartState(now) {
  return stateWith({
    restart: { requestedAt: now - 60_000 },
    restartCycleStartedAt: now - 60_000,
    sessions: {
      'session-a': { sessionId: 'session-a', running: false, updatedAt: now },
    },
    disarmedGoals: {
      'session-a': {
        goalId: 'goal-1',
        disarmedAt: now - 36 * 60 * 1000,
        resumedAt: null,
        reason: 'restart-blocking',
      },
    },
  })
}

test('E1: a goal that is COMPLETE is not adopted — there is nothing to continue', () => {
  const now = 1_700_000_000_000
  const state = currentRestartState(now)
  const goal = { id: 'goal-1', revision: 9, phase: 'complete', activation: 'disarmed' }
  const pending = recoverableSessions(state, { now, getGoal: () => goal })
  assert.deepEqual(pending, [], 'a finished goal is not pending work')
  assert.notEqual(state.sessions['session-a'].pendingResume, true, 'and nothing queues it')
})

test('E2: a goal that is still ACTIVE is adopted — the fix must not close the positive case', () => {
  const now = 1_700_000_000_000
  const state = currentRestartState(now)
  const goal = { id: 'goal-1', revision: 9, phase: 'active', activation: 'disarmed' }
  const pending = recoverableSessions(state, { now, getGoal: () => goal })
  assert.equal(pending.length, 1, 'the disarmed goal still belongs to this restart')
  assert.equal(pending[0].pendingResume, true)
  assert.equal(pending[0].goal.goalId, 'goal-1')
})

test('E3: a session that already carries pendingResume and a COMPLETE goal is not woken up', async () => {
  // The second path of the bug: the record was already adopted by an older
  // build, so the `pendingResume` flag is on the session — and the pending work
  // is about the GOAL, not about an interrupted turn. The queue still carries
  // such a session (an existing test demands it: a COMPLETE goal does not make
  // the session "done" — see test/checkpoint.test.mjs), so it is the RECOVERY
  // that has to refuse it: it asks about the source of the pending work.
  const now = Date.now()
  const stateFile = tempStateFile('completed-goal', {
    version: 1,
    // A DIFFERENT pid: the host really restarted.
    bootPid: 1,
    generation: 645,
    phase: 'running',
    sessions: {
      'session-a': {
        sessionId: 'session-a',
        running: false,
        pendingResume: true,
        updatedAt: now,
        // The pending work is a GOAL that has to be given back.
        pendingSource: 'adoption',
        goal: { goalId: 'goal-1', goalRevision: 9, phase: 'complete', updatedAt: now },
      },
    },
  })
  const followups = []
  const { ctx, timeouts, calls } = createContext({
    agent: { id: 'session-a', status: 'idle' },
    // The goal is DONE: there is nothing left to continue.
    goal: { id: 'goal-1', revision: 9, phase: 'complete', activation: 'disarmed', roundsStarted: 176, maxGoalRounds: 200 },
    followups,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  const boot = timeouts[0]
  assert.ok(boot, 'the boot recovery pass must be scheduled')
  boot.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const entry = runtime.state.sessions['session-a']
  assert.equal(followups.length, 0, 'a finished goal that was ADOPTED is not woken up')
  assert.equal(calls.resume.length, 0, 'a finished goal is not re-armed')
  assert.equal(calls.disarm.length, 0, 'and it is not disarmed again')
  assert.equal(entry === undefined ? undefined : entry.pendingResume, false, 'the session stops being pending work')
  assert.equal(entry === undefined ? undefined : entry.lastRecoveryAction, 'goal-stopped', 'and the recovery says why it stayed quiet')
})

test('E4: a goal the user PAUSED or that is BLOCKED still stays quiet', () => {
  const now = 1_700_000_000_000
  for (const phase of ['paused', 'blocked']) {
    const state = currentRestartState(now)
    const goal = { id: 'goal-1', revision: 9, phase, activation: 'disarmed' }
    assert.deepEqual(
      recoverableSessions(state, { now, getGoal: () => goal }),
      [],
      `${phase} is not pending work`,
    )
  }
})

/* ------------------------------------------------------------------ *
 * ⑧ THE SOURCE OF THE PENDING WORK (bug, 2026-11-12).
 *
 * A goal that is COMPLETE has no work left — but that only means the GOAL is
 * over. When the pending work is an INTERRUPTED TURN of the user, the session
 * still deserves its continuation message: the goal having no work left does
 * not mean the user has an answer. The source marker says which of the two it
 * is.
 * ------------------------------------------------------------------ */

/** A state file whose session was RUNNING when the host went down. */
function interruptedState(now) {
  return {
    version: 1,
    // A DIFFERENT pid: the host really restarted.
    bootPid: 1,
    generation: 645,
    phase: 'running',
    sessions: {
      'session-a': { sessionId: 'session-a', running: true, updatedAt: now },
    },
  }
}

test('E5: a session interrupted by the boot is woken up even when its goal is COMPLETE', async () => {
  // THE CASE THE REVIEW FOUND: the host restarted while the session was
  // working, so the user's turn was cut in half. The goal has meanwhile been
  // finished — but the user still has an unanswered question, so the session
  // MUST get its continuation message.
  const now = Date.now()
  const stateFile = tempStateFile('interrupted', interruptedState(now))
  const followups = []
  const { ctx, timeouts } = createContext({
    agent: { id: 'session-a', status: 'idle' },
    // The goal is DONE — and that must NOT silence an interrupted turn.
    goal: { id: 'goal-1', revision: 9, phase: 'complete', activation: 'disarmed', roundsStarted: 176, maxGoalRounds: 200 },
    followups,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  const boot = timeouts[0]
  assert.ok(boot, 'the boot recovery pass must be scheduled')
  boot.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const entry = runtime.state.sessions['session-a']
  assert.equal(followups.length, 1, 'the interrupted turn of the user still gets its continuation message')
  assert.equal(entry === undefined ? undefined : entry.lastRecoveryAction, 'prompt-continuation', 'and the recovery says so')
  assert.equal(entry === undefined ? undefined : entry.pendingSource, 'boot-interrupted', 'the source of the pending work is recorded')
})

test('E6: a session of an older build that still holds a disarm record stays quiet', async () => {
  // NO marker in the state file (an older build) — but the session still holds
  // the record of the disarm, which is the evidence that the pending work is
  // about the GOAL. A goal that is finished has nothing to give back ⇒ quiet.
  const now = Date.now()
  const stateFile = tempStateFile('legacy-adopted', {
    version: 1,
    bootPid: 1,
    generation: 645,
    phase: 'running',
    sessions: {
      'session-a': { sessionId: 'session-a', running: false, pendingResume: true, updatedAt: now },
    },
    disarmedGoals: {
      'session-a': { goalId: 'goal-1', disarmedAt: now - 217 * 60 * 60 * 1000, resumedAt: null, reason: 'restart-queued' },
    },
  })
  const followups = []
  const { ctx, timeouts } = createContext({
    agent: { id: 'session-a', status: 'idle' },
    goal: { id: 'goal-1', revision: 9, phase: 'complete', activation: 'disarmed', roundsStarted: 176, maxGoalRounds: 200 },
    followups,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  const boot = timeouts[0]
  assert.ok(boot, 'the boot recovery pass must be scheduled')
  boot.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const entry = runtime.state.sessions['session-a']
  assert.equal(followups.length, 0, 'the nine-day-old record of the field is not woken up')
  assert.equal(entry === undefined ? undefined : entry.lastRecoveryAction, 'goal-stopped', 'and the recovery says why it stayed quiet')
})

test('E7: a session of an older build that was interrupted mid-turn still gets its answer', async () => {
  // NO marker and NO disarm record: the only thing the state says is that the
  // session was interrupted. That is a turn of the user ⇒ it is woken up, so
  // the question is not silently dropped.
  const now = Date.now()
  const stateFile = tempStateFile('legacy-interrupted', {
    version: 1,
    bootPid: 1,
    generation: 645,
    phase: 'running',
    sessions: {
      'session-a': { sessionId: 'session-a', running: false, pendingResume: true, interrupted: true, updatedAt: now },
    },
  })
  const followups = []
  const { ctx, timeouts } = createContext({
    agent: { id: 'session-a', status: 'idle' },
    goal: { id: 'goal-1', revision: 9, phase: 'complete', activation: 'disarmed', roundsStarted: 3, maxGoalRounds: 200 },
    followups,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  const boot = timeouts[0]
  assert.ok(boot, 'the boot recovery pass must be scheduled')
  boot.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(followups.length, 1, 'an interrupted turn of the user is not silently dropped')
})

test('E8: the source of the pending work survives a write and a read', () => {
  // The marker lives in the state file: without it in the whitelist of the
  // session shape it would be dropped on the next boot.
  const normalized = normalizeState({
    version: 1,
    sessions: {
      'session-a': {
        sessionId: 'session-a',
        running: false,
        pendingResume: true,
        pendingSource: 'boot-interrupted',
        updatedAt: 1000,
      },
    },
  }, 2000)
  assert.equal(normalized.state.sessions['session-a'].pendingSource, 'boot-interrupted', 'the marker survives the read')
})

/* ------------------------------------------------------------------ *
 * ⑨ THE HOLES OF THE PHASE × SOURCE TABLE (bug, 2026-11-12).
 *
 * The table has five phases and five sources, and E1~E8 pin most of it.
 * Three cells were still empty — and all three could reproduce the defect
 * this file is about: the message of a user is silently dropped.
 *
 *   U2  `complete` × `disposed` — the agent of the session disappeared while
 *       its turn was running. The goal may be finished by now, but the turn
 *       of the USER was cut short ⇒ the session still gets its answer.
 *   U4  the source of a state file of the previous build (no marker) is
 *       DERIVED — and the question is not "is there a record?" but "WHICH
 *       event is the NEWER one?": a record that is older than the
 *       interruption cannot be the cause of it.
 *   U3  the phase of the checkpoint is a SNAPSHOT; when the live goal cannot
 *       be read the snapshot is trusted — a deliberate choice, pinned here.
 *
 * Every case below is a BEHAVIOUR: it asserts that a continuation message
 * really went out (or really did not), not merely that a session is listed.
 * ------------------------------------------------------------------ */

test('U2: a session whose agent was DISPOSED still gets its continuation message, even when the goal is COMPLETE', async () => {
  // The agent of the session disappeared while its turn was running, so the
  // turn of the USER was cut in half. The goal happens to be finished by now —
  // but that says only that the GOAL has no work left, not that the user has
  // an answer. The session must get its continuation message.
  const now = Date.now()
  const stateFile = tempStateFile('disposed', {
    version: 1,
    bootPid: 1,
    generation: 645,
    phase: 'running',
    sessions: {
      // NOT running: the mount marks the LIVE agent as running, and the
      // `agent/disposed` event is what turns that into pending work.
      'session-a': { sessionId: 'session-a', running: false, updatedAt: now },
    },
  })
  const followups = []
  const { ctx, timeouts, calls, handlers, agents } = createContext({
    agent: { id: 'session-a', status: 'running' },
    // The goal is DONE — and that must NOT silence an interrupted turn.
    goal: { id: 'goal-1', revision: 9, phase: 'complete', activation: 'disarmed', roundsStarted: 176, maxGoalRounds: 200 },
    followups,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  // The agent disappears while its turn is running.
  const disposed = handlers.get('agent/disposed')
  assert.ok(disposed && disposed.length, 'the plugin listens for agent/disposed')
  for (const handler of disposed) handler({ agent: agents[0] })

  const pending = runtime.state.sessions['session-a']
  assert.equal(pending.pendingSource, 'disposed', 'the pending work is marked as an interrupted turn')
  assert.equal(pending.pendingResume, true, 'and the session is pending work')

  const boot = timeouts[0]
  assert.ok(boot, 'the boot recovery pass must be scheduled')
  boot.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const entry = runtime.state.sessions['session-a']
  assert.equal(followups.length, 1, 'the half-asked question of the user still gets an answer')
  assert.equal(entry === undefined ? undefined : entry.lastRecoveryAction, 'prompt-continuation', 'and the recovery says so')
  assert.equal(calls.resume.length, 0, 'a finished goal is not re-armed')
  assert.equal(calls.disarm.length, 0, 'and it is not disarmed again')
})

test('U4: a session of an older build that was interrupted AFTER an old disarm record still gets its answer', async () => {
  // NO marker in the state file (an older build), but the state says TWO
  // things: the session was interrupted one minute ago, and a goal of it was
  // disarmed ten minutes ago. The record is OLDER than the interruption, so it
  // cannot be the cause of it — this pending work is an interrupted turn, so
  // the session still gets its answer, even though the goal is finished.
  const now = Date.now()
  const stateFile = tempStateFile('legacy-interrupted-after-record', {
    version: 1,
    bootPid: 1,
    generation: 645,
    phase: 'running',
    sessions: {
      'session-a': {
        sessionId: 'session-a',
        running: false,
        pendingResume: true,
        interrupted: true,
        // The pending work was made pending ONE minute ago…
        pendingSince: now - 60_000,
        updatedAt: now,
      },
    },
    disarmedGoals: {
      // …while the record of the disarm is TEN minutes old.
      'session-a': { goalId: 'goal-1', disarmedAt: now - 10 * 60 * 1000, resumedAt: null, reason: 'restart-queued' },
    },
  })
  const followups = []
  const { ctx, timeouts } = createContext({
    agent: { id: 'session-a', status: 'idle' },
    goal: { id: 'goal-1', revision: 9, phase: 'complete', activation: 'disarmed', roundsStarted: 176, maxGoalRounds: 200 },
    followups,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  const boot = timeouts[0]
  assert.ok(boot, 'the boot recovery pass must be scheduled')
  boot.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const entry = runtime.state.sessions['session-a']
  assert.equal(followups.length, 1, 'the interrupted turn of the user is not silently dropped')
  assert.equal(entry === undefined ? undefined : entry.lastRecoveryAction, 'prompt-continuation', 'and the recovery says so')
})

test('U4: a session of an older build whose disarm record is NEWER than the interruption stays quiet', async () => {
  // The other way round: the record is NEWER than the interruption, so the
  // pending work is about the GOAL (the plugin took it away) ⇒ a finished
  // goal has nothing to give back ⇒ the session stays quiet.
  const now = Date.now()
  const stateFile = tempStateFile('legacy-record-after-interruption', {
    version: 1,
    bootPid: 1,
    generation: 645,
    phase: 'running',
    sessions: {
      'session-a': {
        sessionId: 'session-a',
        running: false,
        pendingResume: true,
        interrupted: true,
        // The pending work was made pending TEN minutes ago…
        pendingSince: now - 10 * 60 * 1000,
        updatedAt: now,
      },
    },
    disarmedGoals: {
      // …while the record of the disarm is ONE minute old.
      'session-a': { goalId: 'goal-1', disarmedAt: now - 60_000, resumedAt: null, reason: 'restart-queued' },
    },
  })
  const followups = []
  const { ctx, timeouts } = createContext({
    agent: { id: 'session-a', status: 'idle' },
    goal: { id: 'goal-1', revision: 9, phase: 'complete', activation: 'disarmed', roundsStarted: 176, maxGoalRounds: 200 },
    followups,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  const boot = timeouts[0]
  assert.ok(boot, 'the boot recovery pass must be scheduled')
  boot.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const entry = runtime.state.sessions['session-a']
  assert.equal(followups.length, 0, 'a goal that has to be given back is not woken up by a finished goal')
  assert.equal(entry === undefined ? undefined : entry.lastRecoveryAction, 'goal-stopped', 'and the recovery says why it stayed quiet')
})

test('U3: when the live goal cannot be read, the phase snapshot of the checkpoint is trusted', async () => {
  // The session is not live, so the live goal cannot be read and the recovery
  // falls back to the phase the checkpoint recorded on the last `goal/changed`.
  // That snapshot may be STALE — it can still say `active` while the goal is
  // `complete` by now.
  //
  // THE SNAPSHOT IS TRUSTED ON PURPOSE: the two errors do not cost the same.
  // A stale snapshot wakes a session that has nothing to do — one visible,
  // retryable round. The other side would drop the message of a user whose
  // turn was cut short, and that is gone for good. There is no field evidence
  // for which way to lean, so the cost is paid on the visible side.
  //
  // The pending work here is about the GOAL (`pendingSource: 'adoption'`), so
  // the phase of the snapshot is the ONLY thing that can keep this session
  // quiet — which is exactly what this test measures.
  const now = Date.now()
  for (const phase of ['active', 'complete']) {
    const prompts = []
    const sessionController = {
      prompt: (request) => { prompts.push(request); return undefined },
    }
    const stateFile = tempStateFile(`legacy-snapshot-${phase}`, {
      version: 1,
      bootPid: 1,
      generation: 645,
      phase: 'running',
      sessions: {
        'session-a': {
          sessionId: 'session-a',
          running: false,
          pendingResume: true,
          pendingSource: 'adoption',
          // THE SNAPSHOT — it may be stale.
          goal: { goalId: 'goal-1', goalRevision: 9, phase, updatedAt: now },
          updatedAt: now,
        },
      },
    })
    const { ctx, timeouts } = createContext({
      // The session is NOT live: the live goal cannot be read.
      agent: null,
      goal: { id: 'goal-1', revision: 9, phase: 'complete', activation: 'disarmed', roundsStarted: 176, maxGoalRounds: 200 },
      sessionController,
    })
    const runtime = apply(ctx, {
      stateFile,
      recoveryDelayMs: 0,
      enabled: true,
      resumeOnBoot: true,
      maxSessions: 4,
    })

    const boot = timeouts[0]
    assert.ok(boot, 'the boot recovery pass must be scheduled')
    boot.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const entry = runtime.state.sessions['session-a']
    const expected = phase === 'active' ? 1 : 0
    assert.equal(prompts.length, expected, `the snapshot says ${phase}: the continuation message ${expected === 1 ? 'is queued' : 'is not queued'}`)
    assert.equal(
      entry === undefined ? undefined : entry.lastRecoveryAction,
      expected === 1 ? 'resume-via-prompt' : 'goal-stopped',
      `and the recovery says which way it went (${phase})`,
    )
  }
})

/* ------------------------------------------------------------------ *
 * ⑩ THE LAST TWO HOLES OF THE TABLE (bug, 2026-11-13).
 *
 *   U1  `complete` × `restart-requested` — the session asked for the restart
 *       itself. `restart-requested` is a turn-side source, so a finished goal
 *       does NOT silence it: it still gets its continuation message.
 *   U5  `blocked` at the RECOVERY layer, and a goal whose phase cannot be
 *       read at all.
 *
 * Both are BEHAVIOUR: a continuation message really went out (or really did
 * not), not "the session is on the list".
 * ------------------------------------------------------------------ */

test('U1: a session that asked for the RESTART itself still gets its continuation message when its goal is COMPLETE (the current rule, pinned)', async () => {
  // THE CURRENT RULE, PINNED — this case is not a fix, it is the agreed
  // wording: `restart-requested` is a turn-side source. The session asked for
  // the restart because it had work to do, and the goal being finished by now
  // says only that the GOAL has no work left — not that the user has an
  // answer. The cost is ONE extra round (the pending mark is cleared right
  // after), never a loop.
  const now = Date.now()
  const state = stateWith({
    version: 1,
    // A DIFFERENT pid: the host really restarted.
    bootPid: 1,
    generation: 645,
    phase: 'running',
    sessions: {
      'session-a': { sessionId: 'session-a', running: false, updatedAt: now },
    },
  })
  // THE REAL WRITE PATH: the session asks for the restart itself.
  requestRestart(state, { reason: 'manual', bySessionId: 'session-a', now })
  assert.equal(state.sessions['session-a'].pendingSource, 'restart-requested', 'the requester is a turn-side source')
  const stateFile = tempStateFile('restart-requested', state)

  const followups = []
  const { ctx, timeouts } = createContext({
    agent: { id: 'session-a', status: 'idle' },
    // The goal is DONE — and that must NOT silence the requester.
    goal: { id: 'goal-1', revision: 9, phase: 'complete', activation: 'disarmed', roundsStarted: 176, maxGoalRounds: 200 },
    followups,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  const boot = timeouts[0]
  assert.ok(boot, 'the boot recovery pass must be scheduled')
  boot.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const entry = runtime.state.sessions['session-a']
  assert.equal(followups.length, 1, 'the session that asked for the restart still gets its continuation message')
  assert.equal(entry === undefined ? undefined : entry.lastRecoveryAction, 'prompt-continuation', 'and the recovery says so')
  assert.equal(entry === undefined ? undefined : entry.pendingResume, false, 'and it does not repeat: the pending mark is cleared')
})

test('U5: a BLOCKED goal stays quiet at the recovery layer, and a goal whose phase cannot be read is still recovered (fail-closed)', async () => {
  const now = Date.now()

  // ── ① A BLOCKED GOAL STAYS QUIET ──────────────────────────────────
  // The pending work is an INTERRUPTED TURN (the boot cut the session short),
  // and the goal is BLOCKED. A goal nobody can move on is a goal somebody
  // stopped: the recovery must keep quiet — and it must keep quiet at the
  // RECOVERY layer, where the decision is really made (the queue above it
  // never looks at the phase at all).
  {
    const stateFile = tempStateFile('blocked-goal', {
      version: 1,
      bootPid: 1,
      generation: 645,
      phase: 'running',
      sessions: {
        'session-a': {
          sessionId: 'session-a',
          running: false,
          pendingResume: true,
          interrupted: true,
          pendingSource: 'boot-interrupted',
          goal: { goalId: 'goal-1', goalRevision: 9, phase: 'blocked', updatedAt: now },
          updatedAt: now,
        },
      },
    })
    const followups = []
    const { ctx, timeouts } = createContext({
      agent: { id: 'session-a', status: 'idle' },
      goal: { id: 'goal-1', revision: 9, phase: 'blocked', activation: 'disarmed', roundsStarted: 3, maxGoalRounds: 200 },
      followups,
    })
    const runtime = apply(ctx, {
      stateFile,
      recoveryDelayMs: 0,
      enabled: true,
      resumeOnBoot: true,
      maxSessions: 4,
    })

    const boot = timeouts[0]
    assert.ok(boot, 'the boot recovery pass must be scheduled')
    boot.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const entry = runtime.state.sessions['session-a']
    assert.equal(followups.length, 0, 'a BLOCKED goal is not woken up, not even by an interrupted turn')
    assert.equal(entry === undefined ? undefined : entry.lastRecoveryAction, 'goal-stopped', 'and the recovery says why it stayed quiet')
  }

  // ── ② A PHASE THAT CANNOT BE READ IS STILL RECOVERED (fail-closed) ─
  // The host does not always report a phase. A goal whose phase is missing is
  // NOT a finished goal and NOT a stopped goal — and the pending work here is
  // about the GOAL (`adoption`), so "the goal is over" is the ONLY thing that
  // could silence this session. Without a phase there is no such answer ⇒ the
  // session is recovered. The whole chain is walked: from the pending mark to
  // the message that really goes out.
  for (const [label, phase] of [['missing', undefined], ['an empty string', ''], ['not a string', 42]]) {
    const liveGoal = { id: 'goal-1', revision: 9, activation: 'disarmed', roundsStarted: 3, maxGoalRounds: 200 }
    if (phase !== undefined) liveGoal.phase = phase
    const stateFile = tempStateFile(`unreadable-phase-${label.replace(/\s+/g, '-')}`, {
      version: 1,
      bootPid: 1,
      generation: 645,
      phase: 'running',
      sessions: {
        'session-a': {
          sessionId: 'session-a',
          running: false,
          pendingResume: true,
          interrupted: true,
          // The pending work is about the GOAL: only the phase could silence it.
          pendingSource: 'adoption',
          // The snapshot does not know a phase either.
          goal: { goalId: 'goal-1', goalRevision: 9, updatedAt: now },
          updatedAt: now,
        },
      },
    })
    const followups = []
    const { ctx, timeouts } = createContext({
      agent: { id: 'session-a', status: 'idle' },
      goal: liveGoal,
      followups,
    })
    const runtime = apply(ctx, {
      stateFile,
      recoveryDelayMs: 0,
      enabled: true,
      resumeOnBoot: true,
      maxSessions: 4,
    })

    const boot = timeouts[0]
    assert.ok(boot, 'the boot recovery pass must be scheduled')
    boot.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const entry = runtime.state.sessions['session-a']
    assert.equal(followups.length, 1, `the phase is ${label}: the session is still recovered (fail-closed)`)
    assert.equal(entry === undefined ? undefined : entry.lastRecoveryAction, 'prompt-continuation', `and the recovery says so (${label})`)
  }
})

/* ------------------------------------------------------------------ *
 * ⑪ THE RETRY BUDGET BELONGS TO THE BOOT (bug, 2026-11-13).
 *
 * The counter was reset in `markPendingResume` and in an explicit
 * `continuum_recover_now(force: true)` only — so a session that was NOT
 * running at the boot and got no new pending work never got a new budget.
 * One transient failure (another plugin was broken for a minute) disabled the
 * recovery of that session FOR EVER: the counter stayed at the cap, every
 * later boot refused the session with `resume-attempts-exhausted`, and the
 * user could not recover it by hand. (Field report 2026-11-13:
 * session-9fef9189, two days of "nothing".)
 *
 * A boot is a new cycle, and a new cycle brings a new budget. The cap still
 * bites INSIDE one cycle — that is what stops a broken session from being
 * retried for ever.
 * ------------------------------------------------------------------ */

test('B1: a new boot gives every session a fresh resume budget — and the failure stays visible', async () => {
  const now = Date.now()
  // THE STATE OF THE FIELD: two attempts failed in the PREVIOUS cycle, the
  // session is not pending any more, and the reason is on record.
  const exhausted = {
    version: 1,
    // A DIFFERENT pid: the host really restarted.
    bootPid: 1,
    generation: 645,
    phase: 'running',
    sessions: {
      'session-a': {
        sessionId: 'session-a',
        running: false,
        pendingResume: false,
        resumeAttempts: 2,
        lastResumeError: 'read_image is registered twice',
        updatedAt: now - 60_000,
      },
    },
  }

  // ① THE CONTRACT ITSELF: one `beginBoot` of a new cycle.
  const direct = JSON.parse(JSON.stringify(exhausted))
  const boot = beginBoot(direct, { pid: 4242, now })
  assert.equal(boot.isNewBoot, true, 'a different pid is a new boot')
  const directEntry = direct.sessions['session-a']
  assert.equal(directEntry.resumeAttempts, 0, 'the new cycle brings a new budget')
  assert.equal(directEntry.lastResumeError, 'read_image is registered twice', 'the reason of the last failure stays visible')
  assert.equal(directEntry.pendingResume, false, 'and no pending work is invented out of thin air')

  // ② THE SAME THROUGH A REAL BOOT of the plugin.
  const stateFile = tempStateFile('fresh-budget', exhausted)
  const { ctx, timeouts } = createContext({ agent: null })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  const bootPass = timeouts[0]
  assert.ok(bootPass, 'the boot recovery pass must be scheduled')
  bootPass.fn()
  await new Promise((resolve) => setTimeout(resolve, 50))

  const entry = runtime.state.sessions['session-a']
  assert.equal(entry === undefined ? undefined : entry.resumeAttempts, 0, 'the real boot gives the session a full budget too')
  assert.equal(entry === undefined ? undefined : entry.lastResumeError, 'read_image is registered twice', 'and the failure stays visible')
  assert.equal(entry === undefined ? undefined : entry.pendingResume, false, 'a session without pending work stays without pending work')
})

test('B2: inside ONE boot the cap still stops the retry loop — the budget is per boot, not per attempt', async () => {
  const now = Date.now()
  const stateFile = tempStateFile('attempts-cap', {
    version: 1,
    bootPid: 1,
    generation: 645,
    phase: 'running',
    sessions: {
      'session-a': {
        sessionId: 'session-a',
        running: false,
        pendingResume: true,
        interrupted: true,
        pendingSource: 'boot-interrupted',
        updatedAt: now,
      },
    },
  })
  const followups = []
  const { ctx, timeouts } = createContext({
    // The session is NOT live and the controller cannot resolve it: every
    // attempt fails, exactly like the temporary failure of another plugin.
    agent: null,
    goal: { id: 'goal-1', revision: 9, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 200 },
    followups,
    sessionController: {
      resolveAgent: async () => { throw new Error('boom') },
    },
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    resumeRetryDelayMs: 0,
    maxResumeAttempts: 2,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  // THREE recovery passes, all inside the SAME boot: no new cycle in between,
  // so the budget of this boot must run out — and stop the loop.
  const bootPass = timeouts[0]
  assert.ok(bootPass, 'the boot recovery pass must be scheduled')
  for (let pass = 1; pass <= 3; pass += 1) {
    bootPass.fn()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  const entry = runtime.state.sessions['session-a']
  assert.equal(entry === undefined ? undefined : entry.resumeAttempts, 2, 'the third attempt never happened: the cap of this boot stopped it')
  assert.equal(entry === undefined ? undefined : entry.pendingResume, true, 'and the session stays pending: the next boot brings a new budget')
  assert.equal(entry === undefined ? undefined : entry.lastRecoveryAction, 'nothing', 'the recovery says it did nothing')
  assert.equal(entry === undefined ? undefined : entry.lastRecoveryDetail, 'resume-attempts-exhausted', 'and why')
  assert.equal(followups.length, 0, 'and the session was never woken up')
})

/* ------------------------------------------------------------------ *
 * ⑫ THE GOAL THE USER GAVE BACK IS NOT TAKEN AWAY AGAIN (bug, 2026-11-13).
 *
 * The plugin may not restore a goal by itself, but the USER may — and that
 * restoration is final for this cycle (user decision: "插件不能主动去恢复被
 * 缴械的目标，但是人类可以，并且人类的恢复是不会触发二次缴械的").
 *
 * The BOOT recovery keeps writing `resumedAt` only: a goal the PLUGIN gave
 * back may be disarmed again in the next cycle, or the restart would wait for a
 * goal nobody can take away any more (the deadlock of 2026-11-02). The two
 * paths are therefore NOT the same.
 * ------------------------------------------------------------------ */

test('R9: a goal the USER restored by hand is not taken away again in the same cycle', async (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const stateFile = tempStateFile('manual-restore', {
    version: 1,
    // A DIFFERENT pid: the host really restarted.
    bootPid: 1,
    generation: 641,
    phase: 'running',
    restart: { generation: 641, requestedAt: 5000, attempt: 0, notBefore: 0, parkGoals: true },
    restartCycleStartedAt: 1000,
    sessions: {
      // The session is pending work: it can be restored.
      'session-a': { sessionId: 'session-a', running: false, pendingResume: true, updatedAt: 5000 },
    },
  })
  const goal = { id: 'goal-1', revision: 6, phase: 'active', activation: 'armed', roundsStarted: 3, maxGoalRounds: 10 }
  const { ctx, calls } = createContext({
    // The session is busy: the queued restart waits for it.
    agent: { id: 'session-a', status: 'running' },
    goal,
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 10000,
    forceRestartWhenBusy: false,
  })

  // ① THE PLUGIN TAKES THE GOAL AWAY (the queued restart waits for it).
  runtime.tick()
  assert.equal(calls.disarm.length, 1, 'the plugin took the goal away')
  // The host shows the goal as taken away.
  goal.activation = 'disarmed'

  // ② THE USER RESTORES IT BY HAND (`continuum_recover_now`).
  const outcome = await runtime.recoverNow('session-a')
  assert.equal(outcome[0].action, 'resume-disarmed-goal', 'the user restored the goal')
  assert.equal(calls.resume.length, 1, 'and the goal was armed again')
  const record = runtime.state.disarmedGoals['session-a']
  assert.notEqual(record.resumedAt, null, 'the record says the goal is back')
  assert.notEqual(record.tookBackAt, null, 'and that the USER gave it back')
  // The host shows the goal as armed again.
  goal.activation = 'armed'

  // ③ THE THREE-SECOND POLL MUST NOT TAKE IT AWAY AGAIN.
  runtime.tick()
  assert.equal(calls.disarm.length, 1, 'the goal of the user is not taken away a second time')
  assert.equal(runtime.state.disarmedGoals['session-a'].disarmedAt, record.disarmedAt, 'the record of the disarm is untouched')
})

test('R10: the boot recovery gives the goal back but does NOT claim it for the user', async () => {
  // THE OTHER HALF OF THE RULE: a goal the PLUGIN gave back may be taken away
  // again in the next cycle — otherwise the restart would wait for a goal
  // nobody can take away any more (the deadlock of 2026-11-02).
  const now = Date.now()
  const stateFile = tempStateFile('boot-gave-back', {
    version: 1,
    bootPid: 1,
    generation: 645,
    phase: 'running',
    restart: { generation: 645, requestedAt: now - 60_000, attempt: 0, notBefore: 0, parkGoals: true },
    restartCycleStartedAt: now - 60_000,
    sessions: {
      'session-a': { sessionId: 'session-a', running: false, updatedAt: now },
    },
    disarmedGoals: {
      'session-a': { goalId: 'goal-1', disarmedAt: now - 36 * 60 * 1000, resumedAt: null, reason: 'restart-blocking' },
    },
  })
  const agent = { id: 'session-a', status: 'idle' }
  const goal = { id: 'goal-1', revision: 9, phase: 'active', activation: 'disarmed', roundsStarted: 176, maxGoalRounds: 200 }
  const { ctx, timeouts, calls } = createContext({ agent, goal })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  const boot = timeouts[0]
  assert.ok(boot, 'the boot recovery pass must be scheduled')
  boot.fn()
  await new Promise((resolve) => setTimeout(resolve, 50))

  const record = runtime.state.disarmedGoals['session-a']
  assert.equal(calls.resume.length, 1, 'the boot gave the goal back')
  assert.notEqual(record.resumedAt, null, 'the record says the goal is back')
  assert.equal(record.tookBackAt, null, 'but it was the PLUGIN that gave it back, not the user')

  // THE NEXT CYCLE MAY TAKE THE GOAL AWAY AGAIN.
  agent.status = 'running'
  goal.activation = 'armed'
  runtime.tick()
  assert.equal(calls.disarm.length, 1, 'the goal may be taken away in the next cycle')
})

/* ------------------------------------------------------------------ *
 * ⑬ THE GOALS OF OTHERS ARE LEFT ALONE WHILE THE REQUESTERS RUN
 *    (bug, 2026-11-13).
 *
 * While a session that ASKED for the restart is still running, the restart
 * cannot happen at all. Disarming the goals of the sessions that did NOT ask
 * for it does not bring the restart any closer — it only makes THOSE sessions
 * wait for nothing (field report: 28 minutes of waiting).
 *
 * The requesters are the OWNERS of the cycle (`restart.requesters`), not a
 * timestamp: a requester that is not here any more counts as stopped.
 * ------------------------------------------------------------------ */

/** A state file with ONE session that asked for the restart. */
function queuedRestartState() {
  return {
    version: 1,
    // A DIFFERENT pid: the host really restarted.
    bootPid: 1,
    generation: 641,
    phase: 'running',
    restart: {
      generation: 641,
      requestedAt: 5000,
      reason: 'user asked for restart',
      bySessionId: 'session-requester',
      resume: true,
      attempt: 0,
      softWarned: false,
      failedAttempts: 0,
      notBefore: 0,
      requesters: [{ sessionId: 'session-requester', requestedAt: 5000, reason: 'user asked for restart', resume: true }],
      parkGoals: true,
      skipBackup: false,
    },
    restartCycleStartedAt: 1000,
    sessions: {
      'session-requester': { sessionId: 'session-requester', running: false, updatedAt: 5000 },
      'session-other': { sessionId: 'session-other', running: false, updatedAt: 5000 },
    },
  }
}

test('R11: while the sessions that asked for the restart are still running, the goals of the others are left alone', async (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const stateFile = tempStateFile('requesters-running', queuedRestartState())
  const { ctx, calls } = createContext({
    // THE REQUESTER IS STILL RUNNING: the restart cannot happen yet.
    agent: { id: 'session-requester', status: 'running' },
    goal: { id: 'goal-1', revision: 6, phase: 'active', activation: 'armed', roundsStarted: 3, maxGoalRounds: 10 },
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 10000,
    forceRestartWhenBusy: false,
  })

  const outcome = runtime.tick()
  assert.equal(calls.disarm.length, 0, 'no goal is taken away while the requesters are still running')
  assert.equal(outcome && outcome.skipped, 'requesters-still-running', 'and the tick says why it did nothing')
})

test('R12: once the requesters have stopped, the goals of the sessions that did NOT ask are taken away', async (t) => {
  const clock = patchNow({ value: 1_700_000_000_000 }, t)
  const stateFile = tempStateFile('requesters-stopped', queuedRestartState())
  const { ctx, calls } = createContext({
    // THE REQUESTER IS GONE (it stopped); another session is the busy one.
    agent: { id: 'session-other', status: 'running' },
    goal: { id: 'goal-1', revision: 6, phase: 'active', activation: 'armed', roundsStarted: 3, maxGoalRounds: 10 },
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    settleMs: 10000,
    forceRestartWhenBusy: false,
  })

  runtime.tick()
  assert.equal(calls.disarm.length, 1, 'the goal of the session that did NOT ask is taken away')
  assert.equal(calls.disarm[0], 'session-other', 'and it is that session — not one of the requesters')
})

/* ------------------------------------------------------------------ *
 * ⑭ A GOAL THE PLUGIN LOCKED UP CAN BE UNLOCKED BY HAND (bug, 2026-11-13).
 *
 * The plugin took some goals away before a restart that never happened (or
 * happened long ago). The BOOT does not take them back once the record is
 * older than a day — that is right. But the USER must still be able to say
 * "give that goal back": a manual recovery of an explicit session.
 *
 * The plugin never does this by itself. Only the named session, only while it
 * is not running, and only when the record says the PLUGIN took the goal.
 * ------------------------------------------------------------------ */

/** A state with a goal the plugin took away nine days ago and never gave back. */
function lockedGoalState(now) {
  const nineDays = 9 * 24 * 60 * 60 * 1000
  return {
    version: 1,
    // A DIFFERENT pid: the host really restarted.
    bootPid: 1,
    generation: 645,
    phase: 'running',
    restart: {
      generation: 645,
      requestedAt: now - nineDays,
      reason: 'user asked for restart',
      bySessionId: 'session-a',
      resume: true,
      attempt: 0,
      softWarned: false,
      failedAttempts: 0,
      notBefore: 0,
      requesters: [{ sessionId: 'session-a', requestedAt: now - nineDays, reason: 'user asked for restart', resume: true }],
      parkGoals: true,
      skipBackup: false,
    },
    restartCycleStartedAt: now - nineDays,
    sessions: {
      // NOT pending any more: the pending work is long gone. The session itself
      // is still around (only the RECORD is old — that is what the age bound
      // is about).
      'session-a': { sessionId: 'session-a', running: false, pendingResume: false, updatedAt: now },
    },
    disarmedGoals: {
      // THE PLUGIN TOOK THE GOAL AWAY — and never gave it back.
      'session-a': { goalId: 'goal-1', disarmedAt: now - nineDays, resumedAt: null, reason: 'restart-blocking' },
    },
  }
}

test('R13: a goal the PLUGIN locked up can be unlocked by hand: the manual recovery gives it back', async (t) => {
  const now = 1_700_000_000_000
  patchNow({ value: now }, t)
  const stateFile = tempStateFile('locked-goal', lockedGoalState(now))
  const { ctx, calls } = createContext({
    agent: { id: 'session-a', status: 'idle' },
    goal: { id: 'goal-1', revision: 9, phase: 'active', activation: 'disarmed', roundsStarted: 3, maxGoalRounds: 200 },
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  const outcome = await runtime.recoverNow('session-a')
  assert.equal(outcome[0].action, 'resume-disarmed-goal', 'the manual recovery gives the locked goal back')
  assert.notEqual(outcome[0].detail, 'no-pending-recovery', 'and it is not refused any more')
  assert.equal(calls.resume.length, 1, 'the continuation authority really went back to the goal')
  assert.equal(runtime.state.sessions['session-a'].pendingResume, false, 'and the session is not pending any more')
})

test('R14: the boot does NOT take a locked goal back — only the user can unlock it', async (t) => {
  const now = 1_700_000_000_000
  patchNow({ value: now }, t)
  const stateFile = tempStateFile('locked-goal-boot', lockedGoalState(now))
  const { ctx, timeouts, calls } = createContext({
    agent: { id: 'session-a', status: 'idle' },
    goal: { id: 'goal-1', revision: 9, phase: 'active', activation: 'disarmed', roundsStarted: 3, maxGoalRounds: 200 },
  })
  const runtime = apply(ctx, {
    stateFile,
    recoveryDelayMs: 0,
    enabled: true,
    resumeOnBoot: true,
    maxSessions: 4,
  })

  assert.ok(runtime.state.sessions['session-a'], 'the session is in the state before the boot pass')

  // THE BOOT RECOVERY PASS (beginBoot → adoptDisarmedGoals): the record is
  // nine days old, so the automatic path must NOT take it back.
  const boot = timeouts[0]
  assert.ok(boot, 'the boot recovery pass must be scheduled')
  boot.fn()
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(calls.resume.length, 0, 'the boot does not take the locked goal back')
  const entry = runtime.state.sessions['session-a']
  assert.notEqual(entry && entry.pendingResume, true, 'and the session stays out of the recovery')
})
