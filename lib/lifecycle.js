/**
 * dsh-autorestart — pure lifecycle decision logic.
 *
 * Nothing in this module touches the filesystem, timers, processes or the DSH
 * host: every function is a pure transformation of the checkpoint state plus
 * an options bag. That makes the "should we restart / what should we resume"
 * policy fully unit-testable, and keeps `index.js` thin.
 *
 * ESM only, Node builtins only. No imports from DSH or npm.
 */

/** Ordered lifecycle phases. `deferred` means a restart is waiting for idle. */
export const PHASES = ['idle', 'deferred', 'restarting', 'recovering', 'running'];

const DEFAULT_LIMIT = 4;

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {object} entry */
function isDoneEntry(entry) {
  if (!isObject(entry)) return true;
  if (entry.done === true) return true;
  const phase = isObject(entry.goal) && typeof entry.goal.phase === 'string' ? entry.goal.phase : null;
  return phase === 'done' || phase === 'complete' || phase === 'completed';
}

/**
 * Shared implementation of `checkpoint.recoverableSessions` (kept here so the
 * checkpoint module only depends on this module in one direction).
 *
 * @param {object} state
 * @param {{ limit?: number }} [options]
 * @returns {object[]} entries where running || pendingResume, not done, newest first
 */
export function selectRecoverableSessions(state, { limit } = {}) {
  const sessions = isObject(state) && isObject(state.sessions) ? state.sessions : {};
  const out = [];
  for (const entry of Object.values(sessions)) {
    if (!isObject(entry)) continue;
    if (entry.running !== true && entry.pendingResume !== true) continue;
    if (isDoneEntry(entry)) continue;
    out.push(entry);
  }
  out.sort((a, b) => (isFiniteNumber(b.updatedAt) ? b.updatedAt : 0) - (isFiniteNumber(a.updatedAt) ? a.updatedAt : 0));
  const cap = isFiniteNumber(limit) && limit >= 0 ? Math.trunc(limit) : out.length;
  return out.slice(0, cap);
}

/**
 * Decide what the boot sequence should do. Does not mutate `state`.
 *
 * @param {object} state
 * @param {{ resumeOnBoot?: boolean, limit?: number }} [options]
 * @returns {{ recover: boolean, sessions: object[], restartWasPending: boolean, phase: 'recovering'|'idle' }}
 */
export function bootPlan(state, { resumeOnBoot = true, limit = DEFAULT_LIMIT } = {}) {
  const restartWasPending = isObject(state) && isObject(state.restart);
  const sessions = resumeOnBoot === false ? [] : selectRecoverableSessions(state, { limit });
  const recover = sessions.length > 0;
  return {
    recover,
    sessions,
    restartWasPending,
    phase: recover ? 'recovering' : 'idle',
  };
}

/**
 * Backwards-compatible bridge: derive a busy list from the legacy boolean option.
 *
 * @param {unknown} anyAgentRunning
 * @returns {{ sessionId: string|null, reason: string }[]}
 */
function legacyBusyAgents(anyAgentRunning) {
  return anyAgentRunning === true ? [{ sessionId: null, reason: 'running' }] : [];
}

/**
 * The two-layer anti-collision gate every restart path must pass.
 *
 * Layer 1 (`busyAgents`) blocks while ANY conversation is still working: a running
 * turn, a queued inbox message, a subagent or a teammate session.
 * Layer 2 (`settleMs`) additionally requires a short quiet window after the last
 * observed activity, so a turn that ended microseconds ago (or a message queued just
 * now) cannot be interrupted by a kill that was decided a poll earlier.
 *
 * @param {object} state
 * @param {{
 *   busyAgents?: { sessionId: string|null, reason: string }[],
 *   lastActivityAt?: number,
 *   now?: number,
 *   settleMs?: number,
 * }} [options]
 * @returns {{
 *   allow: boolean,
 *   reason: 'quiet'|'conversation-active'|'settling',
 *   blockedBy: { sessionId: string|null, reason: string }[],
 *   quietForMs: number,
 * }}
 */
export function restartGate(state, { busyAgents = [], lastActivityAt = 0, now = Date.now(), settleMs = 4000 } = {}) {
  void state; // uniform (state, options) signature with the other lifecycle policies
  const nowMs = isFiniteNumber(now) ? now : 0;
  const lastAt = isFiniteNumber(lastActivityAt) ? lastActivityAt : 0;
  const quietForMs = Math.max(0, nowMs - lastAt);
  const busy = Array.isArray(busyAgents) ? busyAgents.filter((entry) => isObject(entry)) : [];
  if (busy.length > 0) {
    return { allow: false, reason: 'conversation-active', blockedBy: busy, quietForMs };
  }
  const settle = isFiniteNumber(settleMs) && settleMs >= 0 ? settleMs : 4000;
  if (quietForMs < settle) return { allow: false, reason: 'settling', blockedBy: [], quietForMs };
  return { allow: true, reason: 'quiet', blockedBy: [], quietForMs };
}

/**
 * The idle-aware restart policy. Call this on a poll timer (e.g. `deferPollMs`)
 * while `state.restart` exists.
 *
 * @param {object} state
 * @param {{
 *   anyAgentRunning?: boolean,
 *   busyAgents?: { sessionId: string|null, reason: string }[],
 *   lastActivityAt?: number,
 *   settleMs?: number,
 *   now?: number,
 *   softMs?: number,
 *   hardMs?: number,
 *   policy?: 'auto'|'wait'|string,
 *   forceRestartWhenBusy?: boolean,
 * }} [options]
 * @returns {{
 *   action: 'none'|'wait'|'warn'|'restart'|'force-restart'|'give-up',
 *   reason: string,
 *   log?: string,
 *   markSoftWarned?: boolean,
 * }}
 */
export function restartDecision(
  state,
  {
    anyAgentRunning = false,
    busyAgents,
    lastActivityAt = 0,
    settleMs = 4000,
    now = Date.now(),
    softMs = 300_000,
    hardMs = 900_000,
    policy = 'auto',
    forceRestartWhenBusy = false,
  } = {},
) {
  const restart = isObject(state) && isObject(state.restart) ? state.restart : null;
  if (!restart) return { action: 'none', reason: 'no-restart-pending' };

  // Coalesce: never schedule the same restart twice.
  if (state.phase === 'restarting') return { action: 'none', reason: 'restart-already-in-progress' };

  const requestedAt = isFiniteNumber(restart.requestedAt) ? restart.requestedAt : 0;
  const attempt = isFiniteNumber(restart.attempt) ? restart.attempt : 0;
  const notBefore = isFiniteNumber(restart.notBefore) ? restart.notBefore : 0;
  const softDeadline = requestedAt + (isFiniteNumber(softMs) ? softMs : 0);
  const hardDeadline = requestedAt + (isFiniteNumber(hardMs) ? hardMs : 0);

  // Backoff after a failed scheduling attempt: wait without re-planning.
  if (notBefore > 0 && now < notBefore) return { action: 'wait', reason: 'restart-backoff' };

  // `defer_seconds` / a future requestedAt delays even an idle restart.
  if (requestedAt > now) return { action: 'wait', reason: 'restart-scheduled-in-future' };

  // Nobody is running an agent turn. The settle window still applies: a turn that
  // ended a moment ago, or a message queued just now, must not be killed.
  const busy = Array.isArray(busyAgents) ? busyAgents.filter((entry) => isObject(entry)) : legacyBusyAgents(anyAgentRunning);
  if (busy.length === 0) {
    if (!restartGate(state, { busyAgents: busy, lastActivityAt, now, settleMs }).allow) {
      return { action: 'wait', reason: 'settling' };
    }
    return { action: 'restart', reason: 'no-agent-running' };
  }

  if (now < softDeadline) return { action: 'wait', reason: 'agents-busy-within-soft-window' };

  if (now < hardDeadline) {
    if (restart.softWarned === true) {
      return { action: 'wait', reason: 'agents-busy-awaiting-hard-deadline' };
    }
    return {
      action: 'warn',
      reason: 'agents-busy-past-soft-deadline',
      log: 'dsh-autorestart: agents are still running after the soft deadline; waiting for the hard deadline, where the restart is only forced if forceRestartWhenBusy is enabled',
      markSoftWarned: true,
    };
  }

  // Hard deadline reached while a conversation is still running.
  if (policy === 'wait') {
    return {
      action: 'warn',
      reason: 'hard-deadline-policy-wait',
      log: 'defer policy wait: still busy after hard deadline',
    };
  }
  // The hard deadline only forces a restart when the operator explicitly opted in
  // (forceRestartWhenBusy) AND the restart is actually deferred. Every other
  // combination keeps waiting: a running conversation is never killed.
  if (forceRestartWhenBusy === true && policy === 'auto' && state.phase === 'deferred') {
    if (attempt > 0) return { action: 'give-up', reason: 'forced-restart-already-attempted' };
    return { action: 'force-restart', reason: 'hard-deadline-force-restart' };
  }
  // forceRestartWhenBusy is disabled (the default): the restart keeps waiting
  // until the idle gate is quiet again, and it never gives up.
  return {
    action: 'warn',
    reason: 'hard-deadline-waiting-for-conversations',
    log: 'dsh-autorestart: hard deadline reached but conversations are still running; forceRestartWhenBusy is disabled, so the restart keeps waiting',
  };
}

/**
 * Derive the continuation step for one recovered session.
 *
 * The returned `action` is the *continuation* mode. When `needAgent` is true the
 * caller must first make sure an agent session exists/resumes, then apply the
 * action. `needsAgentResume` is true when the checkpoint shows the session was
 * interrupted while running (so it must be resumed rather than just prompted).
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {{ maxResumeAttempts?: number }} [options]
 * @returns {{ action: 'rearm-goal'|'prompt-continuation'|'skip', needAgent: boolean, needsAgentResume: boolean, reason: string, attempts: number, maxAttempts: number }}
 */
export function resumeStep(state, sessionId, { maxResumeAttempts = 2 } = {}) {
  const sessions = isObject(state) && isObject(state.sessions) ? state.sessions : {};
  const entry = isObject(sessions[sessionId]) ? sessions[sessionId] : null;
  const max = isFiniteNumber(maxResumeAttempts) ? maxResumeAttempts : 0;

  if (!entry) {
    return {
      action: 'skip',
      needAgent: false,
      needsAgentResume: false,
      reason: 'unknown-session',
      attempts: 0,
      maxAttempts: max,
    };
  }

  const attempts = isFiniteNumber(entry.resumeAttempts) ? entry.resumeAttempts : 0;
  if (attempts >= max) {
    return {
      action: 'skip',
      needAgent: false,
      needsAgentResume: false,
      reason: 'resume-attempts-exhausted',
      attempts,
      maxAttempts: max,
    };
  }

  const hasGoal = isObject(entry.goal) && entry.goal.goalId != null;
  return {
    action: hasGoal ? 'rearm-goal' : 'prompt-continuation',
    needAgent: true,
    needsAgentResume: entry.running !== true,
    reason: hasGoal ? 'goal-recorded' : 'no-goal-recorded',
    attempts,
    maxAttempts: max,
  };
}

/**
 * Build the single user message that asks a recovered agent to continue.
 *
 * @param {object|null} entry
 * @param {{ reason?: string, appName?: string, now?: number, override?: string }} [options]
 * @returns {string} one user-message text
 */
export function continuationPrompt(
  entry,
  { reason, appName = 'DeepSeek Harness', now = Date.now(), override } = {},
) {
  if (typeof override === 'string' && override.trim().length > 0) return override;

  const recorded = isObject(entry) && Array.isArray(entry.reasons) ? entry.reasons : [];
  const fallbackReason = recorded.length > 0 ? recorded[recorded.length - 1] : 'unknown';
  const effectiveReason = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : fallbackReason;
  const iso = Number.isFinite(now) ? new Date(now).toISOString() : new Date().toISOString();

  return [
    '<continuum_resume>',
    `主机（${appName}）在 ${iso} 重启。你上一轮的会话被中断（原因：${effectiveReason}）。`,
    '请先检查当前工作区、未完成的 todo 列表与最近的工具结果，判断中断点，然后直接从中断处继续原任务：不要等待新的用户指令，不要重复已完成的工作，完成剩余步骤后再向用户说明结果。如果任务已经在中断前完成，请直接给出结论。',
    '</continuum_resume>',
  ].join('\n');
}

/**
 * One-line human-readable summary for logs and the health endpoint.
 *
 * @param {object} state
 * @returns {string}
 */
export function describeState(state) {
  const phase = isObject(state) && typeof state.phase === 'string' ? state.phase : 'unknown';
  const generation = isObject(state) && isFiniteNumber(state.generation) ? state.generation : 0;
  const pending = selectRecoverableSessions(state, {});
  const ids = pending.map((entry) => (typeof entry.sessionId === 'string' ? entry.sessionId : '?')).join(', ');
  const restart = isObject(state) && isObject(state.restart)
    ? ` restart=attempt:${isFiniteNumber(state.restart.attempt) ? state.restart.attempt : 0}`
    : '';
  return `phase=${phase} generation=${generation} pending=${pending.length}${ids ? ` [${ids}]` : ''}${restart}`;
}
