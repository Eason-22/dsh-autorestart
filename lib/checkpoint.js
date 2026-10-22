/**
 * dsh-autorestart — durable checkpoint store.
 *
 * Keeps one small JSON document in the DSH home directory that describes what
 * the host was doing when it stopped: the current boot identity, the restart
 * generation, and one entry per agent session that may need to be resumed.
 *
 * Design rules:
 *  - never throw while *reading*: a missing, unreadable or corrupt state file
 *    is reported and replaced by `createEmptyState()`.
 *  - never leave a half-written file: writes go to `<file>.tmp-<rand>` in the
 *    same directory and are then atomically renamed over the target.
 *  - every mutating helper below mutates `state` in place **and** returns it,
 *    so callers may treat the helpers as expressions.
 *
 * ESM only, Node builtins only. No DSH / npm imports (profile-installed
 * bundles may not resolve them).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { PHASES, selectRecoverableSessions } from './lifecycle.js';

/** Current on-disk schema version. */
export const STATE_VERSION = 1;

/** Hard cap on `entry.reasons` so the checkpoint cannot grow without bound. */
export const ENTRY_REASONS_LIMIT = 16;

/** Hard cap on `restart.requesters` (one entry per requesting session). */
export const REQUESTERS_LIMIT = 16;

const RESTART_KEYS = new Set([
  'generation',
  'requestedAt',
  'reason',
  'bySessionId',
  'resume',
  'attempt',
  'softWarned',
  'failedAttempts',
  'notBefore',
  'requesters',
]);

const ENTRY_KEYS = new Set([
  'sessionId',
  'updatedAt',
  'running',
  'runningSince',
  'interrupted',
  'interruptedAt',
  'pendingResume',
  'pendingSince',
  'reasons',
  'goal',
  'resumeAttempts',
  'lastResumeAt',
  'lastResumeError',
]);

const GOAL_KEYS = new Set(['goalId', 'goalRevision', 'phase', 'updatedAt']);

const TOP_LEVEL_KEYS = new Set([
  'version',
  'bootId',
  'bootPid',
  'bootStartedAt',
  'generation',
  'phase',
  'restart',
  'sessions',
  'updatedAt',
]);

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {unknown} value @param {string} fallback */
function strOr(value, fallback = null) {
  return typeof value === 'string' ? value : fallback;
}

/** @param {unknown} value */
function nullableString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** @param {unknown} value */
function nullableNumber(value) {
  return isFiniteNumber(value) ? value : null;
}

/**
 * @param {string} sessionId
 * @param {number} now
 * @returns {object} a fresh entry with the documented default shape
 */
function defaultEntry(sessionId, now = Date.now()) {
  return {
    sessionId,
    updatedAt: now,
    running: false,
    runningSince: null,
    interrupted: false,
    interruptedAt: null,
    pendingResume: false,
    pendingSince: null,
    reasons: [],
    goal: null,
    resumeAttempts: 0,
    lastResumeAt: null,
    lastResumeError: null,
  };
}

/**
 * @param {number} [now]
 * @returns {object} an empty, valid state document
 */
export function createEmptyState(now = Date.now()) {
  return {
    version: STATE_VERSION,
    bootId: null,
    bootPid: null,
    bootStartedAt: null,
    generation: 0,
    phase: 'idle',
    restart: null,
    sessions: {},
    updatedAt: now,
  };
}

/**
 * Normalize one persisted goal record. Unknown or wrong-typed fields are
 * dropped; `{ goal: null }` means "no goal recorded".
 * @param {unknown} raw
 * @returns {{ goal: object|null, changed: boolean }}
 */
function normalizeGoal(raw) {
  if (!isObject(raw)) {
    return { goal: null, changed: raw !== null && raw !== undefined };
  }
  let changed = false;
  for (const key of Object.keys(raw)) if (!GOAL_KEYS.has(key)) changed = true;

  const goal = {
    goalId: nullableString(raw.goalId),
    goalRevision: nullableNumber(raw.goalRevision),
    phase: nullableString(raw.phase),
    updatedAt: nullableNumber(raw.updatedAt),
  };
  if (!isFiniteNumber(raw.goalRevision) && raw.goalRevision != null) changed = true;
  if (typeof raw.phase !== 'string' && raw.phase != null) changed = true;
  if (typeof raw.goalId !== 'string' && raw.goalId != null) changed = true;
  if (goal.goalId === null && goal.goalRevision === null && goal.phase === null) {
    return { goal: null, changed: true };
  }
  return { goal, changed };
}

/**
 * Normalize one persisted session entry.
 * @param {unknown} raw
 * @param {string} sessionId
 * @param {number} now
 * @returns {{ entry: object, changed: boolean }}
 */
function normalizeEntry(raw, sessionId, now) {
  const entry = defaultEntry(sessionId, now);
  if (!isObject(raw)) return { entry, changed: raw !== undefined };
  let changed = false;
  for (const key of Object.keys(raw)) if (!ENTRY_KEYS.has(key)) changed = true;

  if (typeof raw.sessionId === 'string' && raw.sessionId) entry.sessionId = raw.sessionId;
  else if (raw.sessionId != null) changed = true;

  if (isFiniteNumber(raw.updatedAt)) entry.updatedAt = raw.updatedAt;
  else if (raw.updatedAt != null) changed = true;

  for (const key of ['running', 'interrupted', 'pendingResume']) {
    if (typeof raw[key] === 'boolean') entry[key] = raw[key];
    else if (raw[key] != null) changed = true;
  }

  for (const key of ['runningSince', 'interruptedAt', 'pendingSince', 'lastResumeAt']) {
    const value = nullableNumber(raw[key]);
    if (value !== null) entry[key] = value;
    else if (raw[key] != null) changed = true;
  }

  if (isFiniteNumber(raw.resumeAttempts) && raw.resumeAttempts >= 0) {
    entry.resumeAttempts = Math.trunc(raw.resumeAttempts);
  } else if (raw.resumeAttempts != null) {
    changed = true;
  }

  if (typeof raw.lastResumeError === 'string' && raw.lastResumeError.length > 0) {
    entry.lastResumeError = raw.lastResumeError;
  } else if (raw.lastResumeError != null) {
    changed = true;
  }

  if (Array.isArray(raw.reasons)) {
    const reasons = raw.reasons.filter((r) => typeof r === 'string' && r.length > 0);
    if (reasons.length !== raw.reasons.length) changed = true;
    entry.reasons = reasons.slice(-ENTRY_REASONS_LIMIT);
  } else if (raw.reasons != null) {
    changed = true;
  }

  const goal = normalizeGoal(raw.goal);
  entry.goal = goal.goal;
  if (goal.changed) changed = true;

  return { entry, changed };
}

/**
 * Normalize one restart requester record.
 *
 * @param {unknown} raw
 * @returns {{ sessionId: string, requestedAt: number, reason: string|null, resume: boolean }|null}
 *   `null` when the record is unusable (invalid entries are dropped).
 */
function normalizeRequester(raw) {
  if (!isObject(raw)) return null;
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId.length > 0 ? raw.sessionId : null;
  if (!sessionId) return null;
  return {
    sessionId,
    requestedAt: isFiniteNumber(raw.requestedAt) ? raw.requestedAt : 0,
    reason: nullableString(raw.reason),
    resume: raw.resume !== false,
  };
}

/**
 * Normalize the list of sessions that requested the current restart cycle.
 * Invalid and duplicate entries are dropped; the newest requester comes first.
 *
 * @param {unknown} raw
 * @returns {{ sessionId: string, requestedAt: number, reason: string|null, resume: boolean }[]}
 */
function normalizeRequesters(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const requester = normalizeRequester(item);
    if (!requester || seen.has(requester.sessionId)) continue;
    seen.add(requester.sessionId);
    out.push(requester);
    if (out.length >= REQUESTERS_LIMIT) break;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {{ restart: object|null, changed: boolean }}
 */
function normalizeRestart(raw) {
  if (!isObject(raw)) return { restart: null, changed: raw !== null && raw !== undefined };
  let changed = false;
  for (const key of Object.keys(raw)) if (!RESTART_KEYS.has(key)) changed = true;

  const requesters = normalizeRequesters(raw.requesters);
  const restart = {
    generation: isFiniteNumber(raw.generation) && raw.generation >= 0 ? Math.trunc(raw.generation) : 0,
    requestedAt: isFiniteNumber(raw.requestedAt) ? raw.requestedAt : 0,
    reason: nullableString(raw.reason),
    bySessionId: nullableString(raw.bySessionId),
    resume: typeof raw.resume === 'boolean' ? raw.resume : true,
    attempt: isFiniteNumber(raw.attempt) && raw.attempt >= 0 ? Math.trunc(raw.attempt) : 0,
    softWarned: raw.softWarned === true,
    failedAttempts: isFiniteNumber(raw.failedAttempts) && raw.failedAttempts >= 0 ? Math.trunc(raw.failedAttempts) : 0,
    notBefore: isFiniteNumber(raw.notBefore) && raw.notBefore >= 0 ? raw.notBefore : 0,
    requesters,
  };
  if (!isFiniteNumber(raw.generation) || raw.generation < 0) changed = true;
  if (!isFiniteNumber(raw.requestedAt)) changed = true;
  if (!isFiniteNumber(raw.attempt) || raw.attempt < 0) changed = true;
  if (raw.failedAttempts != null && (!isFiniteNumber(raw.failedAttempts) || raw.failedAttempts < 0)) changed = true;
  if (raw.notBefore != null && !isFiniteNumber(raw.notBefore)) changed = true;
  if (typeof raw.resume !== 'boolean' && raw.resume != null) changed = true;
  if (raw.requesters != null && !Array.isArray(raw.requesters)) changed = true;
  if (Array.isArray(raw.requesters) && requesters.length !== raw.requesters.length) changed = true;
  return { restart, changed };
}

/**
 * Coerce arbitrary JSON into a valid state document without ever throwing.
 *
 * @param {unknown} raw parsed JSON (or anything else)
 * @param {number} [now]
 * @returns {{ state: object, repaired: boolean }} `repaired` is true when any
 *   field was dropped, defaulted or retyped (the caller may want to rewrite).
 */
export function normalizeState(raw, now = Date.now()) {
  const state = createEmptyState(now);
  if (!isObject(raw)) {
    return { state, repaired: raw !== undefined };
  }
  let repaired = false;
  for (const key of Object.keys(raw)) if (!TOP_LEVEL_KEYS.has(key)) repaired = true;

  if (raw.version !== STATE_VERSION) repaired = true;

  if (typeof raw.bootId === 'string' && raw.bootId) state.bootId = raw.bootId;
  else if (raw.bootId != null) repaired = true;

  if (isFiniteNumber(raw.bootPid)) state.bootPid = Math.trunc(raw.bootPid);
  else if (raw.bootPid != null) repaired = true;

  if (isFiniteNumber(raw.bootStartedAt)) state.bootStartedAt = raw.bootStartedAt;
  else if (raw.bootStartedAt != null) repaired = true;

  if (isFiniteNumber(raw.generation) && raw.generation >= 0) state.generation = Math.trunc(raw.generation);
  else if (raw.generation != null) repaired = true;

  if (typeof raw.phase === 'string' && PHASES.includes(raw.phase)) state.phase = raw.phase;
  else if (raw.phase != null) repaired = true;

  if (isFiniteNumber(raw.updatedAt)) state.updatedAt = raw.updatedAt;
  else if (raw.updatedAt != null) repaired = true;

  if (raw.restart != null) {
    const restart = normalizeRestart(raw.restart);
    state.restart = restart.restart;
    if (restart.changed) repaired = true;
  }

  if (isObject(raw.sessions)) {
    for (const [sessionId, value] of Object.entries(raw.sessions)) {
      const normalized = normalizeEntry(value, sessionId, now);
      state.sessions[sessionId] = normalized.entry;
      if (normalized.changed) repaired = true;
    }
  } else if (raw.sessions != null) {
    repaired = true;
  }

  return { state, repaired };
}

/**
 * Read a checkpoint from disk. Never throws and never creates directories.
 *
 * @param {string} filePath
 * @param {number} [now]
 * @returns {{ state: object, existed: boolean, corrupt: boolean, error: string|null, repaired: boolean }}
 *   `corrupt` is true only when the file exists but cannot be parsed; a
 *   missing file returns a fresh state with `existed: false`.
 */
export function readState(filePath, now = Date.now()) {
  let existed = false;
  let corrupt = false;
  let error = null;
  let raw = null;
  let parsed = false;

  try {
    const text = fs.readFileSync(filePath, 'utf8');
    existed = true;
    try {
      raw = JSON.parse(text.replace(/^\uFEFF/, ''));
      parsed = true;
    } catch (parseError) {
      corrupt = true;
      error = String(parseError && parseError.message ? parseError.message : parseError);
    }
  } catch (readError) {
    error = String(readError && readError.message ? readError.message : readError);
    if (readError && readError.code !== 'ENOENT') corrupt = true;
    try {
      existed = fs.existsSync(filePath);
    } catch {
      existed = false;
    }
    if (!existed) error = null;
  }

  if (!parsed) {
    return { state: createEmptyState(now), existed, corrupt, error, repaired: corrupt };
  }

  const normalized = normalizeState(raw, now);
  return {
    state: normalized.state,
    existed,
    corrupt,
    error,
    repaired: normalized.repaired,
  };
}

/**
 * Atomically persist a checkpoint. Creates the parent directory recursively.
 * Throws only on real I/O errors, and cleans up its temporary file when the
 * write or rename fails.
 *
 * @param {string} filePath
 * @param {object} state
 * @param {number} [now]
 * @returns {object} the same `state` (with `updatedAt` refreshed)
 */
export function writeState(filePath, state, now = Date.now()) {
  if (!isObject(state)) throw new TypeError('writeState requires a state object');
  state.updatedAt = now;

  // Serialize before touching the filesystem: a JSON failure must not leave a
  // limbo temp file behind.
  const payload = `${JSON.stringify(state, null, 2)}\n`;

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, payload, 'utf8');
      try {
        fs.fsyncSync(fd);
      } catch {
        /* fsync is a durability nicety, not a correctness requirement */
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best effort cleanup */
    }
    throw error;
  }
  return state;
}

/**
 * Register the current boot. A different `pid` means DSH was restarted, so any
 * session that was still running is converted into a pending resume.
 * Mutates `state` in place and returns `{ state, isNewBoot }`.
 *
 * @param {object} state
 * @param {{ pid: number, now?: number }} options
 * @returns {{ state: object, isNewBoot: boolean }}
 */
export function beginBoot(state, { pid, now = Date.now() } = {}) {
  const samePid = state.bootPid != null && state.bootPid === pid;
  if (samePid) return { state, isNewBoot: false };

  state.bootId = randomUUID();
  state.bootPid = pid == null ? null : pid;
  state.bootStartedAt = now;
  state.updatedAt = now;

  if (isObject(state.sessions)) {
    for (const entry of Object.values(state.sessions)) {
      if (!isObject(entry) || entry.running !== true) continue;
      entry.running = false;
      entry.runningSince = null;
      entry.interrupted = true;
      entry.interruptedAt = now;
      entry.pendingResume = true;
      entry.pendingSince = now;
      entry.updatedAt = now;
    }
  }

  return { state, isNewBoot: true };
}

/**
 * Get (or lazily create) the checkpoint entry for a session.
 * Mutates `state` in place.
 *
 * @param {object} state
 * @param {string} sessionId
 * @returns {object} the entry
 */
export function entryFor(state, sessionId) {
  if (!isObject(state.sessions)) state.sessions = {};
  let entry = state.sessions[sessionId];
  if (!isObject(entry)) {
    entry = defaultEntry(sessionId, Date.now());
    state.sessions[sessionId] = entry;
  }
  return entry;
}

/** @param {object} entry @param {string} reason */
function pushReason(entry, reason) {
  if (!Array.isArray(entry.reasons)) entry.reasons = [];
  if (entry.reasons[entry.reasons.length - 1] === reason) return;
  entry.reasons.push(reason);
  if (entry.reasons.length > ENTRY_REASONS_LIMIT) {
    entry.reasons.splice(0, entry.reasons.length - ENTRY_REASONS_LIMIT);
  }
}

/**
 * Mark a session as actively running an agent turn.
 *
 * `pendingResume` / `pendingSince` are deliberately NOT cleared: a session that
 * asked for a restart and keeps working (or receives a new message) must still
 * be resumed once the host comes back.
 *
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {{ sessionId: string, goalId?: string|null, goalRevision?: number|null, reason?: string, now?: number }} options
 * @returns {object} state
 */
export function markRunning(state, { sessionId, goalId, goalRevision, reason, now = Date.now() } = {}) {
  if (!sessionId) return state;
  const entry = entryFor(state, sessionId);
  entry.running = true;
  entry.runningSince = now;
  entry.interrupted = false;
  entry.interruptedAt = null;
  entry.updatedAt = now;
  entry.lastResumeAt = entry.lastResumeAt ?? null;

  if (goalId != null || goalRevision != null) {
    entry.goal = {
      goalId: goalId == null ? entry.goal?.goalId ?? null : String(goalId),
      goalRevision: isFiniteNumber(goalRevision) ? goalRevision : entry.goal?.goalRevision ?? null,
      phase: entry.goal?.phase ?? null,
      updatedAt: now,
    };
  }
  if (typeof reason === 'string' && reason.trim()) pushReason(entry, reason.trim());

  state.updatedAt = now;
  return state;
}

/**
 * Mark a session as finished/idle. Entries with no goal and no pending resume
 * are removed to keep the checkpoint small.
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {{ now?: number }} [options]
 * @returns {object} state
 */
export function markIdle(state, sessionId, { now = Date.now() } = {}) {
  if (!sessionId || !isObject(state.sessions)) return state;
  const entry = state.sessions[sessionId];
  if (!isObject(entry)) return state;
  entry.running = false;
  entry.runningSince = null;
  entry.updatedAt = now;
  state.updatedAt = now;
  if (!entry.pendingResume && !entry.goal) delete state.sessions[sessionId];
  return state;
}

/**
 * Mark a session as needing a resume after a restart/interruption.
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {{ sessionId: string, reason?: string, goalId?: string|null, goalRevision?: number|null, now?: number }} options
 * @returns {object} state
 */
export function markPendingResume(state, { sessionId, reason, goalId, goalRevision, now = Date.now() } = {}) {
  if (!sessionId) return state;
  const entry = entryFor(state, sessionId);
  const wasPending = entry.pendingResume === true;
  entry.running = false;
  entry.runningSince = null;
  entry.pendingResume = true;
  entry.resumeAttempts = 0;
  entry.lastResumeError = null;
  entry.pendingSince = now;
  entry.updatedAt = now;

  if (typeof reason === 'string' && reason.trim()) {
    pushReason(entry, reason.trim());
    entry.interrupted = true;
    if (!wasPending || entry.interruptedAt == null) entry.interruptedAt = now;
  }
  if (goalId != null || goalRevision != null) {
    entry.goal = {
      goalId: goalId == null ? entry.goal?.goalId ?? null : String(goalId),
      goalRevision: isFiniteNumber(goalRevision) ? goalRevision : entry.goal?.goalRevision ?? null,
      phase: entry.goal?.phase ?? null,
      updatedAt: now,
    };
  }

  state.updatedAt = now;
  return state;
}

/**
 * Forget a session entirely.
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} sessionId
 * @returns {object} state
 */
export function clearSession(state, sessionId) {
  if (!sessionId || !isObject(state.sessions)) return state;
  if (Object.prototype.hasOwnProperty.call(state.sessions, sessionId)) {
    delete state.sessions[sessionId];
    state.updatedAt = Date.now();
  }
  return state;
}

/**
 * Record (or clear, with `goalId: null`) the goal attached to a session.
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {{ goalId?: string|null, goalRevision?: number|null, phase?: string|null, now?: number }} options
 * @returns {object} state
 */
export function setGoal(state, sessionId, { goalId, goalRevision = null, phase = null, now = Date.now() } = {}) {
  if (!sessionId) return state;
  const entry = entryFor(state, sessionId);
  if (goalId == null) {
    entry.goal = null;
  } else {
    entry.goal = {
      goalId: String(goalId),
      goalRevision: isFiniteNumber(goalRevision) ? goalRevision : null,
      phase: typeof phase === 'string' ? phase : null,
      updatedAt: now,
    };
  }
  entry.updatedAt = now;
  state.updatedAt = now;
  return state;
}

/**
 * Open a deferred restart cycle (bumps `generation` exactly once per request).
 *
 * Several sessions may ask for a restart at the same time. The requests are
 * COALESCED into one restart cycle: `generation` is bumped and `restart` is
 * replaced, but every requester is kept in `restart.requesters` (newest first,
 * one entry per distinct session id, capped at {@link REQUESTERS_LIMIT}) and
 * marked as pending resume, so the boot recovery wakes ALL of them.
 *
 * `restart.bySessionId` still holds the last requester for compatibility.
 *
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {{ reason?: string, bySessionId?: string|null, resume?: boolean, now?: number }} options
 * @returns {object} state
 */
export function requestRestart(state, { reason, bySessionId = null, resume = true, now = Date.now() } = {}) {
  const generation = (isFiniteNumber(state.generation) && state.generation >= 0 ? state.generation : 0) + 1;
  state.generation = generation;
  state.phase = 'deferred';

  const previous = isObject(state.restart) ? state.restart : null;
  const requesters = [];
  if (previous && Array.isArray(previous.requesters)) {
    for (const item of previous.requesters) {
      const requester = normalizeRequester(item);
      if (requester && !requesters.some((entry) => entry.sessionId === requester.sessionId)) {
        requesters.push(requester);
      }
    }
  }
  const sessionId = bySessionId == null ? null : String(bySessionId);
  const reasonText = typeof reason === 'string' && reason.length > 0 ? reason : null;
  if (sessionId) {
    const kept = requesters.filter((entry) => entry.sessionId !== sessionId);
    kept.unshift({ sessionId, requestedAt: now, reason: reasonText, resume: resume !== false });
    requesters.length = 0;
    requesters.push(...kept.slice(0, REQUESTERS_LIMIT));
  }

  state.restart = {
    generation,
    requestedAt: now,
    reason: reasonText,
    bySessionId: sessionId,
    resume: resume !== false,
    attempt: 0,
    softWarned: false,
    failedAttempts: 0,
    notBefore: 0,
    requesters,
  };
  for (const requester of requesters) {
    if (requester.resume === false) continue;
    markPendingResume(state, {
      sessionId: requester.sessionId,
      reason: requester.reason ?? 'restart-requested',
      now,
    });
  }
  state.updatedAt = now;
  return state;
}

/**
 * Abandon a deferred restart.
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {{ now?: number }} [options]
 * @returns {object} state
 */
export function cancelRestart(state, { now = Date.now() } = {}) {
  state.restart = null;
  state.phase = 'idle';
  state.updatedAt = now;
  return state;
}

/**
 * Set the lifecycle phase, ignoring unknown values.
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {string} phase
 * @returns {object} state
 */
export function setPhase(state, phase) {
  if (typeof phase === 'string' && PHASES.includes(phase)) {
    state.phase = phase;
    state.updatedAt = Date.now();
  }
  return state;
}

/**
 * Sessions that still need work after a boot, newest first.
 * Delegates to `lifecycle.selectRecoverableSessions` so there is one definition
 * of "recoverable" in the plugin.
 *
 * @param {object} state
 * @param {{ limit?: number }} [options]
 * @returns {object[]} entries (live references into `state.sessions`)
 */
export function recoverableSessions(state, { limit } = {}) {
  return selectRecoverableSessions(state, { limit });
}

/**
 * Keep the checkpoint small: cap the session map by `updatedAt` (newest wins)
 * and optionally drop finished entries older than `maxAgeMs`. Running and
 * pending-resume sessions are never dropped by age.
 * Mutates `state` in place and returns it.
 *
 * @param {object} state
 * @param {{ maxSessions?: number, now?: number, maxAgeMs?: number }} [options]
 * @returns {object} state
 */
export function pruneSessions(state, { maxSessions, now = Date.now(), maxAgeMs } = {}) {
  if (!isObject(state.sessions)) return state;
  const sessions = state.sessions;
  const ids = Object.keys(sessions);
  if (ids.length === 0) return state;

  const updatedAt = (id) => {
    const entry = sessions[id];
    return entry && isFiniteNumber(entry.updatedAt) ? entry.updatedAt : 0;
  };
  ids.sort((a, b) => updatedAt(b) - updatedAt(a));

  const cap = isFiniteNumber(maxSessions) && maxSessions >= 1 ? Math.trunc(maxSessions) : Infinity;
  const remove = new Set(ids.slice(cap));

  if (isFiniteNumber(maxAgeMs) && maxAgeMs > 0) {
    const cutoff = now - maxAgeMs;
    for (const id of ids) {
      const entry = sessions[id];
      if (!isObject(entry)) continue;
      if (entry.running === true || entry.pendingResume === true) continue;
      if (entry.goal) continue;
      if (isFiniteNumber(entry.updatedAt) && entry.updatedAt < cutoff) remove.add(id);
    }
  }

  for (const id of remove) delete sessions[id];
  if (remove.size > 0) state.updatedAt = now;
  return state;
}
