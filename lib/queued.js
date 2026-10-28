/**
 * dsh-autorestart — the upper bound of a QUEUED inbox message.
 *
 * THE DEFECT THIS MODULE FIXES
 *
 * A queued message (an inbox entry that nobody has claimed yet) used to block
 * the restart FOR EVER. The idle gate counted "this session has a queued
 * message" as "this session is busy", and the hard deadline only WARNED, so a
 * session that never ran its turn (the real case: a fresh, empty conversation
 * in the UI with one unclaimed message in its inbox) kept the pending restart
 * pending until the user gave up.
 *
 * THE POLICY
 *
 *   - a message that is claimed inside the grace window keeps blocking the
 *     restart (that is the normal case: the agent picks it up in a second);
 *   - a message that is still unclaimed after the grace window is STUCK: it
 *     stops blocking the restart and is named in the log, so the user can see
 *     WHICH session holds the queue;
 *   - a message that is being worked on (the session is `running`) always
 *     blocks, under EVERY grace setting. This module only ever judges queued
 *     work — it never relaxes the rule that a live turn is never interrupted.
 *
 * The tracker knows nothing about the host: it is a map of session id to the
 * moment the session was FIRST seen with a queued message, so it can be unit
 * tested with a fake clock.
 *
 * ESM only, Node builtins only. No DSH / npm imports.
 */

/** The default upper bound of a queued message: one minute. */
export const DEFAULT_QUEUED_GRACE_MS = 60000

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Normalise a grace window.
 *
 * A negative or non-numeric value falls back to the default; `0` is a LEGAL
 * value — it switches the protection off and restores the old behaviour (a
 * queued message blocks the restart for ever).
 *
 * @param {unknown} value
 * @returns {number} milliseconds, never negative
 */
export function normalizeQueuedGraceMs(value) {
  if (!isFiniteNumber(value) || value < 0) return DEFAULT_QUEUED_GRACE_MS
  return Math.trunc(value)
}

/**
 * Create the tracker.
 *
 * @param {{ now?: () => number }} [options] the clock (injectable for tests)
 * @returns {{
 *   observe: (agentId: string, queued: boolean, graceMs?: number) => { blocking: boolean, firstSeenAt: number|null, ageMs: number, becameStale: boolean },
 *   forget: (agentId: string) => boolean,
 *   size: () => number,
 *   ids: () => string[],
 * }}
 */
export function createQueuedTracker({ now = () => Date.now() } = {}) {
  /** @type {Map<string, { firstSeenAt: number, stale: boolean }>} */
  const records = new Map()

  /** The current time of the injected clock (never throws). */
  const clock = () => {
    try {
      const value = now()
      return isFiniteNumber(value) ? value : 0
    } catch {
      return 0
    }
  }

  /**
   * Observe one session.
   *
   * @param {string} agentId the session id
   * @param {boolean} queued does the session have an unclaimed message?
   * @param {number} [graceMs] the upper bound (0 = no upper bound)
   * @returns {{ blocking: boolean, firstSeenAt: number|null, ageMs: number, becameStale: boolean }}
   */
  const observe = (agentId, queued, graceMs) => {
    const id = agentId == null ? '' : String(agentId)
    if (id === '') return { blocking: false, firstSeenAt: null, ageMs: 0, becameStale: false }

    // The session has no queued work any more: its record is dropped, so a
    // NEW queue starts counting from zero.
    if (queued !== true) {
      records.delete(id)
      return { blocking: false, firstSeenAt: null, ageMs: 0, becameStale: false }
    }

    const at = clock()
    let record = records.get(id)
    if (record === undefined) {
      record = { firstSeenAt: at, stale: false }
      records.set(id, record)
    }
    const ageMs = Math.max(0, at - record.firstSeenAt)
    const grace = normalizeQueuedGraceMs(graceMs)

    // The protection is off (grace 0): a queued message blocks the restart for
    // ever — exactly the behaviour before this module existed.
    if (grace === 0) {
      return { blocking: true, firstSeenAt: record.firstSeenAt, ageMs, becameStale: false }
    }

    // Still inside the grace window: the agent may claim the message any
    // moment, so the restart keeps waiting for it.
    if (ageMs < grace) {
      return { blocking: true, firstSeenAt: record.firstSeenAt, ageMs, becameStale: false }
    }

    // The message is STUCK: it stops blocking the restart. `becameStale` is
    // true only on the tick where it turned stale, so the caller can log it
    // exactly once.
    const becameStale = record.stale !== true
    record.stale = true
    return { blocking: false, firstSeenAt: record.firstSeenAt, ageMs, becameStale }
  }

  /**
   * Drop the record of one session (it is running, or it is gone).
   *
   * @param {string} agentId
   * @returns {boolean} whether a record was dropped
   */
  const forget = (agentId) => {
    const id = agentId == null ? '' : String(agentId)
    if (id === '') return false
    return records.delete(id)
  }

  /** How many sessions are tracked right now. */
  const size = () => records.size

  /** The ids of the tracked sessions. */
  const ids = () => Array.from(records.keys())

  return { observe, forget, size, ids }
}
