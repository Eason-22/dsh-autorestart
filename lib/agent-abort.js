/**
 * dsh-autorestart — aborting a stuck session through the HOST's own API.
 *
 * WHY (user report, 2026-11-21 22:56): "你没办法停止子代理" — a subagent ran for
 * 3 hours 20 minutes and the only way out was the human clicking in the UI. The
 * host already ships the abort: `Agent.cancel(cause, options?)` clears the
 * queued and steering work (unless `keepInbox`) and aborts the active turn or
 * the between-turn task. This module is the thin, honest wrapper around it.
 *
 * WHAT THE HOST SAYS (verbatim, `@deepseek-ai/dsh-agent` runtime-types):
 *   "Clear queued and steering work — unless `keepInbox` — and abort the active
 *    turn or between-turn task. The first cause wins for that activity. With no
 *    active activity, cancellation is a no-op and does not arm later work."
 *
 *   cancel(cause: AgentCancelCause, options?: CancelOptions): void
 *   interface CancelOptions { keepInbox?: boolean | undefined }
 *
 * The cause is the host's own sum type (`@deepseek-ai/dsh-session`):
 *   AgentCancelCause = { kind: 'user' } | { kind: 'parent' }
 *                    | { kind: 'hook'; reason: string } | { kind: 'disposed' }
 * "a human asked for this" is `{ kind: 'user' }` — the same shape the host's own
 * archive-admission comment uses.
 *
 * HOW THE AGENT IS FOUND (two ways, in this order):
 *   1. `ctx.agents.get(sessionId)` — the live agent registry. This is the path
 *      that works for a SUBAGENT: `sessionController.resolveAgent` refuses
 *      subagent-owned sessions ("session identity whose lifecycle belongs to
 *      subagent routing"), and a stuck subagent is exactly what this has to
 *      reach.
 *   2. `ctx.sessionController.resolveAgent(sessionId)` — the host's own
 *      resolver, used when the session is not in the live registry (it may
 *      RESUME a cold session, so it is the fallback, not the first choice).
 *
 * NOTHING IS THROWN. Every failure comes back as a structured answer, because a
 * tool that throws leaves the caller guessing whether the session was aborted.
 *
 * ESM only, no DSH / npm imports (the plugin is deliberately dependency-free).
 *
 * @module lib/agent-abort
 */

/**
 * The host's cancel cause for "a human asked for this".
 *
 * @type {{ readonly kind: 'user' }}
 */
export const USER_CANCEL_CAUSE = Object.freeze({ kind: 'user' })

/**
 * Queued work SURVIVES by default.
 *
 * Aborting a turn is not a decision to throw the inbox away: the messages that
 * were already queued for the session are still wanted, they just do not run
 * inside the aborted turn. `keepInbox: false` opts into discarding them.
 *
 * @type {boolean}
 */
export const DEFAULT_KEEP_INBOX = true

/**
 * The machine-readable reasons this module can fail with.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const ABORT_ERRORS = Object.freeze({
  INVALID_SESSION_ID: 'invalid-session-id',
  AGENT_NOT_FOUND: 'agent-not-found',
  CONTROLLER_UNAVAILABLE: 'session-controller-unavailable',
  RESOLVE_FAILED: 'resolve-failed',
  CANCEL_UNAVAILABLE: 'cancel-unavailable',
  CANCEL_FAILED: 'cancel-failed',
})

/**
 * One error, as a readable line. The host reports a failure either as a thrown
 * error or as a returned `{ error }` (a stable session-domain failure), so both
 * shapes have to end up as text.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function describeHostError(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error !== 'object') return String(error)
  const code = typeof error.code === 'string' && error.code !== '' ? error.code : ''
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : ''
  if (code !== '' && message !== '') return `${code}: ${message}`
  if (message !== '') return message
  if (code !== '') return code
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * A session id this module is willing to hand to the host.
 *
 * @param {unknown} value
 * @returns {string} the trimmed id, or '' when it is not usable
 */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '') return ''
  // A session id like `__proto__` would land on the prototype of the session
  // map: it is refused, and NOTHING is cancelled.
  if (trimmed === '__proto__' || trimmed === 'constructor' || trimmed === 'prototype') return ''
  return trimmed
}

/**
 * The live agent of a session, or undefined when it is not attached.
 *
 * @param {object} ctx the host context.
 * @param {string} sessionId
 * @returns {object|undefined}
 */
function liveAgent(ctx, sessionId) {
  try {
    if (ctx && ctx.agents && typeof ctx.agents.get === 'function') {
      const agent = ctx.agents.get(sessionId)
      if (agent) return agent
    }
  } catch {}
  return undefined
}

/**
 * The session controller, reached the way the rest of this plugin reaches it:
 * the declared injection first, the optional lookup second.
 *
 * @param {object} ctx the host context.
 * @returns {object|null}
 */
function sessionController(ctx) {
  try {
    if (ctx && ctx.sessionController && typeof ctx.sessionController === 'object') {
      return ctx.sessionController
    }
  } catch {}
  try {
    if (ctx && typeof ctx.get === 'function') {
      const viaGet = ctx.get('sessionController')
      if (viaGet && typeof viaGet === 'object') return viaGet
    }
  } catch {}
  return null
}

/**
 * The agent's lifecycle status, read defensively.
 *
 * @param {object} agent
 * @returns {'idle'|'running'|null}
 */
function agentStatus(agent) {
  try {
    const status = agent && agent.status
    if (status === 'idle' || status === 'running') return status
  } catch {}
  return null
}

/**
 * Abort the current turn of one session through the host's own cancel API.
 *
 * @param {object} options
 * @param {object} options.ctx the host context (needs `agents`, optionally `sessionController`).
 * @param {string} options.sessionId the session whose turn is aborted.
 * @param {boolean} [options.keepInbox=true] keep the queued and steering work.
 * @param {() => number} [options.now] the clock, injected for tests.
 * @returns {Promise<object>} the structured answer — never a thrown error.
 */
export async function abortAgentSession({ ctx, sessionId, keepInbox = DEFAULT_KEEP_INBOX, now = () => Date.now() } = {}) {
  const id = normalizeSessionId(sessionId)
  if (id === '') {
    return {
      ok: false,
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      keepInbox: keepInbox !== false,
      error: ABORT_ERRORS.INVALID_SESSION_ID,
      detail: 'The session id is missing or unusable, so nothing was aborted.',
    }
  }
  const keep = keepInbox !== false
  const resolvedAt = typeof now === 'function' ? now() : Date.now()

  // 1. The live agent — the only path that reaches a subagent-owned session.
  let agent = liveAgent(ctx, id)
  let resolvedVia = 'agents-registry'

  // 2. The host's own resolver, for a session that is not live right now.
  if (!agent) {
    const controller = sessionController(ctx)
    if (!controller || typeof controller.resolveAgent !== 'function') {
      return {
        ok: false,
        sessionId: id,
        keepInbox: keep,
        error: ABORT_ERRORS.CONTROLLER_UNAVAILABLE,
        detail: 'Neither the live agent registry nor the session controller could resolve this session, so nothing was aborted.',
      }
    }
    resolvedVia = 'session-controller'
    let result = null
    try {
      result = await controller.resolveAgent(id)
    } catch (error) {
      return {
        ok: false,
        sessionId: id,
        keepInbox: keep,
        resolvedVia,
        error: ABORT_ERRORS.RESOLVE_FAILED,
        detail: `The session controller could not resolve this session: ${describeHostError(error)}`,
      }
    }
    if (result && result.error) {
      return {
        ok: false,
        sessionId: id,
        keepInbox: keep,
        resolvedVia,
        error: ABORT_ERRORS.AGENT_NOT_FOUND,
        detail: `The session controller refused this session: ${describeHostError(result.error)}`,
      }
    }
    agent = result && result.agent ? result.agent : undefined
    if (!agent) {
      return {
        ok: false,
        sessionId: id,
        keepInbox: keep,
        resolvedVia,
        error: ABORT_ERRORS.AGENT_NOT_FOUND,
        detail: 'The session controller returned no agent for this session, so nothing was aborted.',
      }
    }
  }

  // 3. The abort itself. The host decides what it means: with an active turn it
  // aborts it, without one it is a no-op.
  if (typeof agent.cancel !== 'function') {
    return {
      ok: false,
      sessionId: id,
      keepInbox: keep,
      resolvedVia,
      error: ABORT_ERRORS.CANCEL_UNAVAILABLE,
      detail: 'The resolved agent exposes no cancel(), so nothing was aborted.',
    }
  }
  const status = agentStatus(agent)
  try {
    agent.cancel(USER_CANCEL_CAUSE, { keepInbox: keep })
  } catch (error) {
    return {
      ok: false,
      sessionId: id,
      keepInbox: keep,
      resolvedVia,
      agentStatus: status,
      error: ABORT_ERRORS.CANCEL_FAILED,
      detail: `The host refused the cancellation: ${describeHostError(error)}`,
    }
  }

  return {
    ok: true,
    sessionId: id,
    cancelledAt: resolvedAt,
    keepInbox: keep,
    active: status === 'running',
    agentStatus: status,
    resolvedVia,
  }
}
