/**
 * LEGACY (pause-based) parked-goal records: the current build disarms goals
 * instead of pausing them, but it still reads and clears the records the
 * previous pause-based build wrote — that is the only way the goals that build
 * paused can be resumed after the next boot.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearParkedGoal,
  createEmptyState,
  parkedRecord,
  setParkedGoal,
} from '../lib/checkpoint.js'
import { selectGoalDisarms } from '../lib/lifecycle.js'

test('a legacy parked record round-trips and is cleared by a resume', () => {
  const state = createEmptyState(1000)
  setParkedGoal(state, 's1', { goalId: 'goal-1', parkedAt: 5 })
  assert.equal(parkedRecord(state, 's1').goalId, 'goal-1')
  assert.equal(parkedRecord(state, 's1').parkedAt, 5)
  assert.equal(parkedRecord(state, 's1').resumedAt, null)
  clearParkedGoal(state, 's1', { resumedAt: 9 })
  assert.equal(state.parkedGoals.s1.resumedAt, 9)
  assert.equal(parkedRecord(state, 's1'), null, 'a resumed record is no longer offered for a resume')
})

test('a legacy parked record never vetoes the disarm of a live armed goal', () => {
  const goals = { s1: { id: 'goal-1', revision: 3, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10 } }
  const parkedGoals = { s1: { goalId: 'goal-1', parkedAt: 1, resumedAt: null } }
  const { disarms, reported } = selectGoalDisarms([{ sessionId: 's1' }], {
    getGoal: (id) => goals[id],
    parkedGoals,
  })
  assert.equal(disarms.length, 1, 'the live goal state decides, not the leftover record')
  assert.deepEqual(reported, [], 'the record is reporting material only')
})
