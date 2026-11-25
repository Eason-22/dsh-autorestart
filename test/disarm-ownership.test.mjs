/**
 * WHO DISARMED A GOAL DECIDES WHO GIVES IT BACK (user decision, 2026-11-25).
 *
 * "Whoever disarmed it gives it back": a goal the PLUGIN disarmed for a
 * restart is given back after the restart; a goal the USER stopped is not; and
 * a record whose origin was never written down is not either.
 *
 * THE OLD RULE GUESSED THE OWNER FROM THE TIMESTAMPS: "no reason, but it
 * happened after the cycle started, so it must be ours" — and that guess
 * handed back the goals the user had stopped on purpose. These tests pin the
 * ownership to the `reason` of the record and to nothing else, so the guess
 * cannot come back.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { adoptDisarmedGoals } from '../lib/checkpoint.js'

/** The smallest state the adoption reads. */
function stateWith(overrides = {}) {
  return {
    sessions: {},
    ...overrides,
  }
}

/**
 * A state in which the goal of `session-a` was disarmed with the given reason.
 *
 * The disarm happens AFTER the restart request (`disarmedAt` 1500 > the request
 * at 1000), so the old timestamp guess would have claimed the record: the tests
 * are about the ownership, not about the clock.
 *
 * @param {string|null} reason the reason the record carries
 * @param {{ at?: number, requestedAt?: number, now?: number }} [options]
 * @returns {object} the state
 */
function disarmedWithReason(reason, { at = 1500, requestedAt = 1000, now = 2000 } = {}) {
  return stateWith({
    restart: { requestedAt },
    sessions: {
      'session-a': { sessionId: 'session-a', running: false, updatedAt: at },
    },
    disarmedGoals: {
      'session-a': { goalId: 'goal-1', disarmedAt: at, resumedAt: null, reason },
    },
  })
}

/**
 * Has the session been queued for recovery by the adoption?
 *
 * @param {object} state the state the adoption ran on
 * @returns {boolean} true when the session was given back
 */
function wasGivenBack(state) {
  return state.sessions['session-a'].pendingResume === true
}

test('a goal the PLUGIN disarmed for the restart is given back (reason restart-blocking)', () => {
  const state = disarmedWithReason('restart-blocking')
  adoptDisarmedGoals(state, { now: 2000 })
  assert.equal(wasGivenBack(state), true, 'the plugin disarmed it, so the plugin gives it back')
  assert.equal(state.sessions['session-a'].goal.goalId, 'goal-1')
})

test('a goal the PLUGIN disarmed for the queued restart is given back (reason restart-queued)', () => {
  const state = disarmedWithReason('restart-queued')
  adoptDisarmedGoals(state, { now: 2000 })
  assert.equal(wasGivenBack(state), true, 'the queued restart took it away, so it is given back')
})

test('a goal the USER stopped is NOT given back (reason manual-park)', () => {
  const state = disarmedWithReason('manual-park')
  adoptDisarmedGoals(state, { now: 2000 })
  assert.equal(wasGivenBack(state), false, 'the user stopped it, so the plugin does not touch it')
  assert.equal(state.disarmedGoals['session-a'].resumedAt, null, 'the record is left exactly as it was')
})

test('a record whose origin is not written down is NOT given back (reason null, even when it is newer than the request)', () => {
  // The record of the previous build: no reason at all. It happened AFTER the
  // request, so the old timestamp guess claimed it — and the boot woke a goal
  // nobody had taken away. An origin that is not written down is not ours.
  const state = disarmedWithReason(null)
  adoptDisarmedGoals(state, { now: 2000 })
  assert.equal(wasGivenBack(state), false, 'a record of unknown origin is not given back')
  assert.equal(state.disarmedGoals['session-a'].resumedAt, null, 'the record is left exactly as it was')
})

test('a record whose session is gone is DROPPED, whoever disarmed it', () => {
  // The orphan cleanup is garbage collection, not a judgement about the goal:
  // the session is gone, so this record can never be given back to anybody, and
  // keeping it only makes the state file grow. It is therefore cleaned up
  // BEFORE the ownership is looked at — an orphan of unknown origin is deleted
  // exactly like an orphan the plugin disarmed.
  const state = stateWith({
    restart: { requestedAt: 1000 },
    // No session entry at all: the session is gone.
    sessions: {},
    disarmedGoals: {
      'session-gone': { goalId: 'goal-1', disarmedAt: 1500, resumedAt: null, reason: null },
    },
  })
  adoptDisarmedGoals(state, { now: 2000 })
  assert.equal(state.disarmedGoals['session-gone'], undefined, 'the orphan record is dropped with the session')
  assert.equal(state.sessions['session-gone'], undefined, 'and no ghost session is created')
})
