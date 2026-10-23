/**
 * Decision rules for DISARMING goal-driven blockers, and the checkpoint record
 * shapes the plugin reads and writes.
 *
 * A goal may be disarmed only when it is `active` + `armed` with round budget
 * left — judged on the LIVE goal state. The checkpoint record is reporting
 * material only: it never vetoes a disarm.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearDisarmedGoal,
  clearParkedGoal,
  createEmptyState,
  disarmedRecord,
  parkedRecord,
  setDisarmedGoal,
  setParkedGoal,
  stampResumedGoal,
} from '../lib/checkpoint.js'
import { GOAL_BLOCK_REASONS, selectGoalDisarms } from '../lib/lifecycle.js'

/** An armed, disarmable goal. */
const armed = (over = {}) => ({
  id: 'goal-1',
  revision: 3,
  phase: 'active',
  activation: 'armed',
  roundsStarted: 0,
  maxGoalRounds: 10,
  ...over,
})

test('an armed goal with budget left is selected for disarming', () => {
  const goals = { s1: armed() }
  const { disarms, reported } = selectGoalDisarms([{ sessionId: 's1' }], { getGoal: (id) => goals[id] })
  assert.equal(disarms.length, 1)
  assert.equal(disarms[0].sessionId, 's1')
  assert.equal(disarms[0].goalId, 'goal-1')
  assert.equal(disarms[0].revision, 3)
  assert.equal(disarms[0].reason, 'goal-active')
  assert.equal(GOAL_BLOCK_REASONS.ACTIVE, 'goal-active')
  assert.deepEqual(reported, [])
})

test('a goal whose round budget is spent is reported, never disarmed', () => {
  const goals = { s1: armed({ roundsStarted: 10, maxGoalRounds: 10 }) }
  const { disarms, reported } = selectGoalDisarms([{ sessionId: 's1' }], { getGoal: (id) => goals[id] })
  assert.equal(disarms.length, 0)
  assert.equal(reported[0].reason, GOAL_BLOCK_REASONS.EXHAUSTED)
  assert.equal(reported[0].reason, 'goal-exhausted')
})

test('a goal somebody paused is never disarmed', () => {
  const goals = { s1: armed({ phase: 'paused', activation: 'disarmed' }) }
  const { disarms, reported } = selectGoalDisarms([{ sessionId: 's1' }], { getGoal: (id) => goals[id] })
  assert.equal(disarms.length, 0)
  assert.equal(reported[0].reason, GOAL_BLOCK_REASONS.PAUSED)
})

test('a blocked or complete goal is only reported', () => {
  const goals = {
    s1: armed({ phase: 'blocked' }),
    s2: armed({ id: 'goal-2', phase: 'complete' }),
  }
  const { disarms, reported } = selectGoalDisarms(
    [{ sessionId: 's1' }, { sessionId: 's2' }],
    { getGoal: (id) => goals[id] },
  )
  assert.equal(disarms.length, 0)
  assert.deepEqual(reported.map((entry) => entry.reason), ['goal-blocked', 'goal-complete'])
})

test('a goal that is already disarmed is not disarmed again', () => {
  const goals = { s1: armed({ activation: 'disarmed' }) }
  const { disarms, reported } = selectGoalDisarms([{ sessionId: 's1' }], { getGoal: (id) => goals[id] })
  assert.equal(disarms.length, 0)
  assert.equal(reported[0].reason, GOAL_BLOCK_REASONS.DISARMED)
})

test('a record from an earlier disarm never vetoes: an armed goal is disarmable again', () => {
  // REGRESSION: the record used to veto the disarm, so a goal that was resumed
  // (and is therefore armed again) could never be disarmed a second time — the
  // restart then waited for it forever, which is the deadlock this feature
  // exists to remove. The LIVE goal state decides.
  const goals = { s1: armed() }
  // A stale record: the goal was armed again, but the record was never stamped.
  const stale = { s1: { goalId: 'goal-1', disarmedAt: 1, resumedAt: null } }
  const first = selectGoalDisarms([{ sessionId: 's1' }], { getGoal: (id) => goals[id], disarmedGoals: stale })
  assert.equal(first.disarms.length, 1, 'the goal is armed, so it is disarmable again')
  assert.equal(first.disarms[0].sessionId, 's1')
  assert.equal(first.disarms[0].reason, GOAL_BLOCK_REASONS.ACTIVE)
  assert.deepEqual(first.reported, [], 'the record is reporting material only')
  // A record that was already stamped does not veto it either.
  const resumed = { s1: { goalId: 'goal-1', disarmedAt: 1, resumedAt: 2 } }
  const second = selectGoalDisarms([{ sessionId: 's1' }], { getGoal: (id) => goals[id], disarmedGoals: resumed })
  assert.equal(second.disarms.length, 1)
})

test('a live goal that is disarmed is not disarmable, even when a record exists', () => {
  const goals = { s1: armed({ activation: 'disarmed' }) }
  const disarmedGoals = { s1: { goalId: 'goal-1', disarmedAt: 1, resumedAt: null } }
  const { disarms, reported } = selectGoalDisarms([{ sessionId: 's1' }], { getGoal: (id) => goals[id], disarmedGoals })
  assert.equal(disarms.length, 0)
  assert.equal(reported[0].reason, GOAL_BLOCK_REASONS.DISARMED)
})

test('a legacy parked record never vetoes a disarm either', () => {
  const goals = { s1: armed() }
  const parkedGoals = { s1: { goalId: 'goal-1', parkedAt: 1, resumedAt: null } }
  const { disarms, reported } = selectGoalDisarms([{ sessionId: 's1' }], { getGoal: (id) => goals[id], parkedGoals })
  assert.equal(disarms.length, 1, 'the live goal state decides, not the leftover record')
  assert.deepEqual(reported, [])
})

test('a session without a live goal is skipped', () => {
  const { disarms, reported } = selectGoalDisarms([{ sessionId: 's1' }], { getGoal: () => undefined })
  assert.deepEqual(disarms, [])
  assert.deepEqual(reported, [])
  // A getGoal that throws must never break the gate either.
  const throwing = selectGoalDisarms([{ sessionId: 's1' }], {
    getGoal: () => {
      throw new Error('goals service exploded')
    },
  })
  assert.deepEqual(throwing.disarms, [])
})

test('the checkpoint records both the disarmed and the legacy parked shape', () => {
  const state = createEmptyState(1000)
  setDisarmedGoal(state, 's1', { goalId: 'goal-1', disarmedAt: 5 })
  assert.equal(state.disarmedGoals.s1.goalId, 'goal-1')
  assert.equal(state.disarmedGoals.s1.disarmedAt, 5)
  assert.equal(state.disarmedGoals.s1.resumedAt, null)
  assert.equal(disarmedRecord(state, 's1').goalId, 'goal-1')
  assert.equal(disarmedRecord(state, 'missing'), null)

  setParkedGoal(state, 's1', { goalId: 'goal-0', parkedAt: 7 })
  assert.equal(state.parkedGoals.s1.goalId, 'goal-0')
  assert.equal(state.parkedGoals.s1.parkedAt, 7)
  assert.equal(state.parkedGoals.s1.resumedAt, null)
  assert.equal(parkedRecord(state, 's1').goalId, 'goal-0')
  assert.equal(parkedRecord(state, 'missing'), null)

  clearDisarmedGoal(state, 's1', { resumedAt: 9 })
  assert.equal(state.disarmedGoals.s1.resumedAt, 9)
  clearParkedGoal(state, 's1', { resumedAt: 9 })
  assert.equal(state.parkedGoals.s1.resumedAt, 9)
})

test('a new disarm overwrites the record of the session, the legacy record included', () => {
  const state = createEmptyState(1000)
  // A leftover record of the previous pause-based build ...
  setParkedGoal(state, 's1', { goalId: 'goal-0', parkedAt: 7 })
  // ... is replaced by the current one: one session has ONE goal record.
  setDisarmedGoal(state, 's1', { goalId: 'goal-1', disarmedAt: 11 })
  assert.equal(state.parkedGoals.s1, undefined, 'the legacy record cannot linger next to the current one')
  assert.equal(state.disarmedGoals.s1.goalId, 'goal-1')
  assert.equal(state.disarmedGoals.s1.disarmedAt, 11)
  assert.equal(state.disarmedGoals.s1.resumedAt, null)
})

test('a disarm after a resume resets the record of the session', () => {
  const state = createEmptyState(1000)
  setDisarmedGoal(state, 's1', { goalId: 'goal-1', disarmedAt: 5 })
  clearDisarmedGoal(state, 's1', { resumedAt: 9 })
  assert.equal(state.disarmedGoals.s1.resumedAt, 9)
  // The goal is armed again and blocks the next restart: the record is
  // overwritten, so it reports the NEW disarm and not the old one.
  setDisarmedGoal(state, 's1', { goalId: 'goal-1', disarmedAt: 17 })
  assert.equal(state.disarmedGoals.s1.disarmedAt, 17)
  assert.equal(state.disarmedGoals.s1.resumedAt, null)
})

test('a resume stamps the record of the session so the status shows it as resumed', () => {
  const state = createEmptyState(1000)
  setDisarmedGoal(state, 's1', { goalId: 'goal-1', disarmedAt: 5 })
  stampResumedGoal(state, 's1', { resumedAt: 21 })
  assert.equal(state.disarmedGoals.s1.resumedAt, 21)

  setParkedGoal(state, 's2', { goalId: 'goal-2', parkedAt: 6 })
  stampResumedGoal(state, 's2', { resumedAt: 22 })
  assert.equal(state.parkedGoals.s2.resumedAt, 22)

  // A session without a record has nothing to stamp, and that is not an error.
  assert.doesNotThrow(() => stampResumedGoal(state, 'missing', { resumedAt: 23 }))
  assert.equal(state.disarmedGoals.missing, undefined)
})
