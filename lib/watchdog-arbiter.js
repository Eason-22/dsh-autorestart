/**
 * ONE watchdog at a time.
 *
 * This plugin knows two watchdogs:
 *
 *   - **v1** (`lib/restart.js`): a detached PowerShell script. It puts the
 *     snapshot back when the host does not come up — and it does **not** start
 *     the host again.
 *   - **v2** (`lib/watchdog.js` + the three tiers): it puts the snapshot back
 *     **and** starts the host again, and it writes a report.
 *
 * Both take the SAME lock (`rollback.lock`). Two of them at once is worse than
 * one: the one that loses the lock gives up, and if the loser is v2 the user
 * gets a restored profile **and nothing running** — the rescue becomes the
 * hole.
 *
 * So the rule is simple and it is decided in ONE place:
 *
 *   - v2 is armed → v2 is the arbiter, the old watcher is **not** started;
 *   - v2 could not be armed (no tier, the watchdog is off, the registration
 *     failed) → v1 is the arbiter, so the old machines still have a safety net.
 *
 * The v1 code stays (a way back, and the old tests still use it); it is just
 * no longer started next to v2.
 */

/** Who is watching this restart. */
export const ARBITERS = Object.freeze({
  /** The new watchdog: restore + start the host again + a report. */
  V2: 'v2',
  /** The old watcher: restore only. */
  V1: 'v1',
  /** Nobody: the supervisor of the plugin restores the snapshot itself. */
  NONE: 'none',
});

/**
 * Decide who is the arbiter of this restart.
 *
 * @param {{
 *   v2Armed?: boolean,
 *   supervised?: boolean,
 * }} [options]
 * @returns {{ arbiter: string, startV1: boolean, reason: string }}
 */
export function planWatchdogArbiter({ v2Armed = false, supervised = false } = {}) {
  if (supervised === true) {
    return {
      arbiter: ARBITERS.NONE,
      startV1: false,
      reason: 'the supervisor of the plugin restores the snapshot itself',
    };
  }
  if (v2Armed === true) {
    return {
      arbiter: ARBITERS.V2,
      startV1: false,
      reason: 'the watchdog v2 is armed: it restores the snapshot AND starts the host again',
    };
  }
  return {
    arbiter: ARBITERS.V1,
    startV1: true,
    reason: 'the watchdog v2 is not available: the old watcher takes over',
  };
}

/**
 * Arm the watchdog — and only ONE of them.
 *
 * Both arms are injected, so a test can count them: when v2 is armed, the v1
 * arm is never called, and the other way round.
 *
 * @param {{
 *   v2Arm?: Function|null,
 *   v1Arm?: Function|null,
 *   supervised?: boolean,
 *   log?: { warn?: Function, info?: Function }|null,
 * }} [options]
 * @returns {{
 *   arbiter: string,
 *   reason: string,
 *   v2: object,
 *   v1: object|null,
 *   v1Started: boolean,
 * }}
 */
export function armTheOneArbiter({
  v2Arm = null,
  v1Arm = null,
  supervised = false,
  log = null,
} = {}) {
  const v2 = typeof v2Arm === 'function'
    ? v2Arm()
    : { ok: false, tier: 'none', reason: 'the watchdog v2 was not armed' };
  const plan = planWatchdogArbiter({ v2Armed: v2 !== null && v2.ok === true, supervised });
  let v1 = null;
  if (plan.startV1 === true && typeof v1Arm === 'function') {
    v1 = v1Arm();
  }
  if (log !== null && typeof log === 'object' && typeof log.warn === 'function') {
    log.warn('the watchdog arbiter is decided', {
      arbiter: plan.arbiter,
      reason: plan.reason,
      v2Tier: v2 && typeof v2.tier === 'string' ? v2.tier : 'none',
      v1Started: v1 !== null,
    });
  }
  return {
    arbiter: plan.arbiter,
    reason: plan.reason,
    v2: v2 === null ? { ok: false, tier: 'none', reason: 'the watchdog v2 was not armed' } : v2,
    v1,
    v1Started: v1 !== null,
  };
}
