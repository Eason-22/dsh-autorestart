/**
 * THE WATCHDOG — one flow, three ways to trigger it.
 *
 * The flow is the same everywhere; only the way the watchdog is made to run
 * differs (see lib/watchdog-tier.js and lib/watchdog-schedule.js). This file
 * is that flow:
 *
 *   1. wait for the READY marker (the new host wrote it after its health
 *      check passed);
 *   2. no marker? Wait a bit and ASK AGAIN — a host that is slow to start is
 *      not a host that is dead (the misjudgement protection);
 *   3. still nothing? Is an instance ALIVE? If one is listening, the rollback
 *      is not needed: stand down (the no-double-start protection);
 *   3b. THE LAST QUESTION BEFORE A RESTORE: ask the health route ITSELF
 *      (HTTP to 127.0.0.1:<port>). Only a host that does not answer may be
 *      rolled back. This is what keeps a host that forgot to write the marker
 *      — or could not write it — from being restored out from under itself.
 *      When there is no port to ask at all (no instance record, no health
 *      URL), one more round is waited and the leftovers are looked at again;
 *   4. take the shared lock (`rollback.lock`) — exactly ONE of us restores;
 *   5. restore the snapshot, then START THE HOST AGAIN;
 *   6. wait for the ready marker once more: it came → `recovered`, it did not
 *      → `failed` — and then we STOP (at most one restore and one start).
 *
 * Whatever happens, the scheduling item and the pending marker go; the report
 * stays.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The marker that says "a restart is coming, a watchdog is watching". */
export const PENDING_NAME = 'watchdog-pending.json';
/** The marker that says "the new host is up and healthy". */
export const READY_NAME = 'watchdog-ready.json';
/** The report of the last watchdog run. */
export const REPORT_NAME = 'last-watchdog-report.json';
/** The lock that both the plugin and the watchdog take before a restore. */
export const LOCK_NAME = 'rollback.lock';

/** How long the watchdog waits for the new host. */
export const DEFAULT_TIMEOUT_MS = 180000;
/** How long it waits before it asks again (the misjudgement protection). */
export const DEFAULT_RECHECK_MS = 20000;
/** How often it looks at the ready marker. */
export const DEFAULT_POLL_MS = 2000;
/** How long it waits for the host after the restore. */
export const DEFAULT_READY_TIMEOUT_MS = 90000;

/**
 * Write a JSON file (no BOM, so every reader can parse it).
 *
 * @param {string} file
 * @param {object} value
 */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/**
 * Read a JSON file (a file that cannot be read is a file that is not there).
 *
 * @param {string} file
 * @returns {object|null}
 */
function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The pending marker: what the watchdog has to know.
 *
 * @param {{
 *   tier?: string,
 *   tierReason?: string,
 *   taskName?: string,
 *   unitId?: string,
 *   pidPath?: string,
 *   snapshotDir?: string,
 *   profileDir?: string,
 *   restoreCommand?: object|null,
 *   relaunchCommand?: object|null,
 *   healthUrl?: string,
 *   healthPath?: string,
 *   portFile?: string,
 *   expectedBootId?: string|null,
 *   timeoutMs?: number,
 *   recheckMs?: number,
 *   readyTimeoutMs?: number,
 *   hostKind?: string,
 *   attempts?: number,
 *   now?: number,
 * }} options
 * @returns {object}
 */
export function buildPending({
  tier = 'none',
  tierReason = '',
  arbiter = 'v2',
  taskName = '',
  unitId = '',
  pidPath = '',
  snapshotDir = '',
  profileDir = '',
  restoreCommand = null,
  relaunchCommand = null,
  healthUrl = '',
  healthPath = '/__dsh_autorestart/health',
  portFile = '',
  expectedBootId = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  recheckMs = DEFAULT_RECHECK_MS,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  hostKind = '',
  attempts = 1,
  now = Date.now(),
} = {}) {
  return {
    version: 1,
    at: new Date(now).toISOString(),
    tier,
    tierReason,
    arbiter,
    taskName,
    unitId,
    pidPath,
    snapshotDir,
    profileDir,
    restoreCommand,
    relaunchCommand,
    healthUrl,
    healthPath,
    portFile,
    expectedBootId,
    timeoutMs,
    recheckMs,
    readyTimeoutMs,
    hostKind,
    attempts,
  };
}

/**
 * @param {string} stateDir
 * @returns {string}
 */
export function pendingPath(stateDir) {
  return path.join(stateDir, PENDING_NAME);
}

/**
 * @param {string} stateDir
 * @returns {string}
 */
export function readyPath(stateDir) {
  return path.join(stateDir, READY_NAME);
}

/**
 * @param {string} stateDir
 * @returns {string}
 */
export function reportPath(stateDir) {
  return path.join(stateDir, REPORT_NAME);
}

/**
 * Write the pending marker.
 *
 * @param {string} stateDir
 * @param {object} pending
 */
export function writePending(stateDir, pending) {
  writeJson(pendingPath(stateDir), pending);
}

/**
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readPending(stateDir) {
  return readJson(pendingPath(stateDir));
}

/**
 * Remove the pending marker (the watchdog is over).
 *
 * @param {string} stateDir
 */
export function clearPending(stateDir) {
  try {
    fs.rmSync(pendingPath(stateDir), { force: true });
  } catch {
    // It is gone either way.
  }
}

/**
 * Write the ready marker: "the new host is up".
 *
 * @param {string} stateDir
 * @param {{ bootId?: string, port?: number, at?: number }} [info]
 */
export function writeReady(stateDir, info = {}) {
  writeJson(readyPath(stateDir), {
    at: new Date(info.at ?? Date.now()).toISOString(),
    bootId: info.bootId ?? null,
    port: info.port ?? null,
  });
}

/**
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readReady(stateDir) {
  return readJson(readyPath(stateDir));
}

/**
 * Remove the ready marker (it belongs to one restart).
 *
 * @param {string} stateDir
 */
export function clearReady(stateDir) {
  try {
    fs.rmSync(readyPath(stateDir), { force: true });
  } catch {
    // It is gone either way.
  }
}

/**
 * Write the report of the last watchdog run.
 *
 * @param {string} stateDir
 * @param {object} report
 */
export function writeReport(stateDir, report) {
  writeJson(reportPath(stateDir), report);
}

/**
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readReport(stateDir) {
  return readJson(reportPath(stateDir));
}

/**
 * Take the lock (exactly one restore at a time).
 *
 * @param {string} lockFile
 * @param {{ now?: number, exists?: Function, mkdir?: Function, open?: Function }} [deps]
 * @returns {boolean}
 */
export function acquireLock(lockFile, { now = Date.now(), exists = fs.existsSync, mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }), open = null } = {}) {
  try {
    mkdir(path.dirname(lockFile));
    if (exists(lockFile)) {
      // A lock that is older than 10 minutes belongs to a process that died
      // in the middle of its restore: it must not block the rollback for ever.
      let age = 0;
      try {
        age = now - fs.statSync(lockFile).mtimeMs;
      } catch {
        age = 0;
      }
      if (age > 10 * 60 * 1000) fs.rmSync(lockFile, { force: true });
      else return false;
    }
    const handle = open === null
      ? fs.openSync(lockFile, 'wx')
      : open(lockFile);
    if (handle !== null && handle !== undefined && typeof handle.close === 'function') handle.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Give the lock back.
 *
 * @param {string} lockFile
 */
export function releaseLock(lockFile) {
  try {
    fs.rmSync(lockFile, { force: true });
  } catch {
    // It is gone either way.
  }
}

/**
 * Put the snapshot back.
 *
 * The same for every platform: the configuration files and the plugin tree
 * are copied out of the snapshot into the profile. (The profile is NOT
 * deleted first — the broken files are overwritten, so a half-restored
 * profile is never worse than the broken one.)
 *
 * @param {{ snapshotDir?: string, profileDir?: string, copy?: Function }} options
 * @returns {{ ok: boolean, error: string|null, copied: string[] }}
 */
export function restoreFromSnapshot({ snapshotDir = '', profileDir = '', copy = null } = {}) {
  const from = String(snapshotDir ?? '');
  const into = String(profileDir ?? '');
  if (from === '' || into === '') {
    return { ok: false, error: 'the snapshot or the profile directory is unknown', copied: [] };
  }
  const copied = [];
  const copyInto = copy === null
    ? (source, target) => { fs.cpSync(source, target, { recursive: true, force: true }); }
    : copy;
  try {
    for (const [part, target] of [['config', into], ['node_modules', path.join(into, 'node_modules')]]) {
      const source = path.join(from, part);
      if (!fs.existsSync(source)) continue;
      copyInto(source, target);
      copied.push(part);
    }
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
      copied,
    };
  }
  return { ok: copied.length > 0, error: copied.length > 0 ? null : 'the snapshot carries nothing to restore', copied };
}

/**
 * Wait for the ready marker.
 *
 * @param {object} deps
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForReady(deps, timeoutMs) {
  const deadline = deps.now() + Math.max(0, timeoutMs);
  while (deps.now() < deadline) {
    if (deps.readReady()) return true;
    // The plugin may have decided on its own (the restart failed): stand down.
    if (deps.isWithdrawn && deps.isWithdrawn()) return false;
    await deps.sleep(Math.min(deps.pollMs, Math.max(0, deadline - deps.now())));
  }
  return deps.readReady() === true;
}

/**
 * Normalize the answer of the health question.
 *
 * The dependency may answer with a plain string ('healthy' | 'unhealthy' |
 * 'unknown') or with `{ state, detail }` — the CLI uses the second form, so the
 * report can say WHY the host was believed to be up (a health route answered, or
 * an instance of the new boot is clearly running).
 *
 * @param {unknown} value
 * @returns {{ state: string, detail: string|null }}
 */
function healthAnswer(value) {
  if (value && typeof value === 'object') {
    const state = typeof value.state === 'string' ? value.state : 'unknown';
    const detail = typeof value.detail === 'string' && value.detail !== '' ? value.detail : null;
    return { state, detail };
  }
  return { state: typeof value === 'string' ? value : 'unknown', detail: null };
}

/**
 * THE FLOW.
 *
 * @param {{
 *   pending: object,
 *   stateDir?: string,
 *   deps?: object,
 * }} options
 * @returns {Promise<object>} the report
 */
export async function runWatchdogFlow({ pending, stateDir = '', deps = {} }) {
  const d = {
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    pollMs: DEFAULT_POLL_MS,
    readReady: () => readReady(stateDir),
    isWithdrawn: () => readPending(stateDir) === null,
    probeAlive: () => false,
    // THE HEALTH QUESTION (see step 3b): 'healthy' | 'unhealthy' | 'unknown'.
    // The CLI answers it with a real HTTP request; a flow test injects it.
    askHealth: () => 'unknown',
    runRestore: () => ({ ok: false, error: 'no restore command' }),
    runRelaunch: () => ({ ok: false, error: 'no relaunch command' }),
    acquireLock: () => true,
    releaseLock: () => {},
    removeSchedule: () => {},
    writeReport: (report) => writeReport(stateDir, report),
    ...deps,
  };
  const startedAt = d.now();
  const report = {
    at: new Date(startedAt).toISOString(),
    result: 'unknown',
    tier: pending && pending.tier ? pending.tier : 'none',
    tierReason: pending && pending.tierReason ? pending.tierReason : '',
    // WHO watched this restart. There is only ever one watchdog at a time
    // (see lib/watchdog-arbiter.js), and the report says which one it was.
    arbiter: pending && pending.arbiter ? pending.arbiter : 'v2',
    waitedMs: 0,
    rechecked: false,
    // What the health route of the host itself said before anything was
    // restored: 'healthy' (stood down), 'unhealthy' (really down) or
    // 'unknown' (there was no port to ask).
    healthCheck: 'unknown',
    healthDetail: null,
    health: null,
    extraRound: false,
    restored: false,
    relaunched: false,
    ready: false,
    error: null,
  };
  try {
    // (1) The new host writes the ready marker after its health check.
    const ready = await waitForReady(d, pending.timeoutMs);
    if (ready) {
      report.result = 'not-needed';
      report.ready = true;
      return report;
    }
    if (d.isWithdrawn()) {
      report.result = 'decided';
      report.error = 'the plugin decided on its own: the watchdog stood down';
      return report;
    }

    // (2) ASK AGAIN. A host that is slow to start is not a host that is dead.
    report.rechecked = true;
    await d.sleep(Math.max(0, pending.recheckMs));
    if (d.readReady()) {
      report.result = 'not-needed';
      report.ready = true;
      return report;
    }
    if (d.isWithdrawn()) {
      report.result = 'decided';
      report.error = 'the plugin decided on its own: the watchdog stood down';
      return report;
    }

    // (3) Is an instance ALIVE? Then there is nothing to restore.
    if (await d.probeAlive()) {
      report.result = 'abandoned';
      report.error = 'an instance is alive: the snapshot was not restored';
      return report;
    }

    // (3b) THE LAST QUESTION BEFORE A RESTORE: ask the health route itself.
    //
    // The marker is written by the plugin, so it can be missing while the host
    // is perfectly healthy (0.8.1: the write threw and the error was
    // swallowed). A restore of a live host is the worst thing this file can
    // do, so the host gets asked directly — and only a host that does not
    // answer may be rolled back.
    const health = healthAnswer(await d.askHealth());
    report.healthCheck = health.state;
    report.healthDetail = health.detail;
    if (health.state === 'healthy') {
      report.result = 'not-needed';
      report.health = 'healthy';
      report.error = 'the host answered: it is up, the snapshot was NOT restored'
        + (health.detail === null ? '' : ' (' + health.detail + ')');
      return report;
    }
    if (health.state === 'unknown') {
      // There was no port to ask (no instance record, no health URL). One more
      // round is waited, and the leftovers are looked at again: a host that is
      // still starting gets this last chance before anything is restored.
      report.extraRound = true;
      await d.sleep(Math.max(0, pending.recheckMs));
      if (d.readReady()) {
        report.result = 'not-needed';
        report.ready = true;
        return report;
      }
      if (d.isWithdrawn()) {
        report.result = 'decided';
        report.error = 'the plugin decided on its own: the watchdog stood down';
        return report;
      }
      if (await d.probeAlive()) {
        report.result = 'abandoned';
        report.error = 'an instance is alive: the snapshot was not restored';
        return report;
      }
      const lateHealth = healthAnswer(await d.askHealth());
      report.healthCheck = lateHealth.state;
      report.healthDetail = lateHealth.detail;
      if (lateHealth.state === 'healthy') {
        report.result = 'not-needed';
        report.health = 'healthy';
        report.error = 'the host answered: it is up, the snapshot was NOT restored'
          + (lateHealth.detail === null ? '' : ' (' + lateHealth.detail + ')');
        return report;
      }
    }

    // (4) The lock: exactly ONE of us restores.
    if (!d.acquireLock()) {
      report.result = 'abandoned';
      report.error = 'another rollback is already running';
      return report;
    }
    try {
      // (5) Restore the snapshot.
      const restored = d.runRestore();
      report.restored = restored !== null && restored !== undefined && restored.ok === true;
      if (!report.restored) {
        report.result = 'failed';
        report.error = restored && restored.error ? restored.error : 'the restore failed';
        return report;
      }
      // (6) Start the host again.
      const relaunched = d.runRelaunch();
      report.relaunched = relaunched !== null && relaunched !== undefined && relaunched.ok === true;
      if (!report.relaunched) {
        report.result = 'failed';
        report.error = relaunched && relaunched.error ? relaunched.error : 'the host could not be started again';
        return report;
      }
      // (7) Did it come up this time?
      const readyAgain = await waitForReady(d, pending.readyTimeoutMs);
      report.ready = readyAgain;
      report.result = readyAgain ? 'recovered' : 'failed';
      if (!readyAgain) report.error = 'the host did not come up after the restore';
    } finally {
      d.releaseLock();
    }
  } catch (error) {
    report.result = 'failed';
    report.error = error && error.message ? error.message : String(error);
  } finally {
    report.waitedMs = d.now() - startedAt;
    // The scheduling item and the pending marker go; the report stays.
    try {
      d.removeSchedule();
    } catch {
      // The scheduling item is cleaned up by the next run if this fails.
    }
    try {
      if (stateDir !== '') clearPending(stateDir);
    } catch {
      // It is gone either way.
    }
    d.writeReport(report);
  }
  return report;
}
