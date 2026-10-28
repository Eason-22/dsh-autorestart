/**
 * dsh-autorestart — what counts as REAL activity for the quiet window.
 *
 * THE DEFECT THIS MODULE FIXES
 *
 * The settle window ("the host must stay quiet for N ms before a restart may
 * fire") used to be reset by EVERY session event. The host emits session
 * events continuously while the interface polls and synchronises (measured on
 * the real machine: one every 2-3 seconds), so a window longer than the event
 * interval could never fill: the restart never fired, no matter how long the
 * user waited.
 *
 * THE POLICY
 *
 * A session event counts as activity only when it says that WORK happened: a
 * message was written, a tool ran, a turn started or ended. Everything else
 * (a title, a projection update, a context request, a job that settled, a
 * permission preset) is routine and must NOT reset the window.
 *
 * The rule is deliberately one-sided: an event whose type cannot be read is
 * NOT activity. When in doubt the plugin would rather restart a little early
 * than never restart at all.
 *
 * The hard guarantee does not live here: a conversation that is really
 * running blocks the restart through `busyAgents()` (the `running` reason),
 * and that rule is never relaxed. This module only decides what the QUIET
 * window measures.
 *
 * ESM only, Node builtins only. No DSH / npm imports.
 */

/**
 * The session event types that mean "work happened".
 *
 * The vocabulary is the one of the DSH session service (its known event
 * types). Only the events that describe a message, a tool, a turn or a
 * command are listed; the rest (titles, projections, jobs, presets, modes,
 * schedules, telemetry) are routine.
 */
export const WORK_SESSION_EVENT_TYPES = Object.freeze([
  // A message was written into a conversation.
  'user/message',
  'developer/message',
  'system/message',
  'assistant/message',
  'assistant/attempt',
  // A tool ran.
  'tool/call',
  'tool/result',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  // A turn or a step started or ended.
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  // A command ran.
  'command/run',
  'command/done',
  // Work was handed around: an inbox splice, a team message, a workflow run.
  'agent/inbox/spliced',
  'team/message/queued',
  'team/message/delivered',
  'team/task',
  'team/member',
  'tool-workflow/run-start',
  'tool-workflow/run-end',
  'tool-workflow/agent-start',
  'tool-workflow/agent-end',
  // A hook ran, a compaction ran, the model retried, a goal changed.
  'hook/invoked',
  'hook/result',
  'compaction/start',
  'compaction/end',
  'compaction/prune',
  'compaction/summary',
  'llm/retry',
  'llm/retry-started',
  'goal/change',
  'approval/asked',
])

/** The work types as a Set, for a cheap lookup. */
const WORK_TYPES = new Set(WORK_SESSION_EVENT_TYPES)

/**
 * The type of one session event, or null when it cannot be read.
 *
 * The payload shape differs between the hosts that call this plugin, so the
 * type is looked for in the places it can be: the payload itself, the nested
 * event, or the data envelope.
 *
 * @param {any} payload the event payload the host delivered
 * @returns {string|null}
 */
export function sessionEventType(payload) {
  if (payload === null || typeof payload !== 'object') return null
  const candidates = [
    payload.type,
    payload.eventType,
    payload.event && typeof payload.event === 'object' ? payload.event.type : undefined,
    payload.data && typeof payload.data === 'object' ? payload.data.type : undefined,
    payload.data && typeof payload.data === 'object' && payload.data.event && typeof payload.data.event === 'object'
      ? payload.data.event.type
      : undefined,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return null
}

/**
 * Whether one session event means that real work happened.
 *
 * @param {any} payload the event payload the host delivered
 * @returns {boolean} false for a routine event AND for an event whose type
 *   cannot be read (the one-sided rule: when in doubt, do not wait)
 */
export function isWorkSessionEvent(payload) {
  const type = sessionEventType(payload)
  if (type === null) return false
  return WORK_TYPES.has(type)
}
