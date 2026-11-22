/**
 * Tests for `lib/agent-abort.js` — the abort path of the `continuum_abort_agent` tool.
 *
 * WHY THIS FILE EXISTS (M8-2, second review): the output-schema test proves that
 * the ANSWER of the tool fits its schema. It does NOT prove that a session is
 * actually aborted, nor that the queued work of the session survives. This file
 * drives the abort and looks at what the HOST received.
 *
 * The contract under test:
 *   - the cause is the host's own `AgentCancelCause` for "a human asked for this":
 *     `{ kind: 'user' }` (`@deepseek-ai/dsh-session` — `AgentCancelCause` is
 *     `{kind:'user'} | {kind:'parent'} | {kind:'hook';reason} | {kind:'disposed'}`);
 *   - the options are `{ keepInbox }` — the queued and steering work SURVIVES
 *     unless the caller asks for it to be dropped;
 *   - every failure is a structured answer, never a thrown error.
 *
 * ESM only, Node builtins only.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ABORT_ERRORS,
  DEFAULT_KEEP_INBOX,
  USER_CANCEL_CAUSE,
  abortAgentSession,
} from '../lib/agent-abort.js'

/** A fixed moment, so `cancelledAt` is the same in every run. */
const NOW = 1_700_000_000_000

/**
 * An agent that records what the host was asked to do.
 *
 * @param {{ status?: 'idle'|'running' }} [options]
 * @returns {{ calls: object[], agent: object }}
 */
function recordingAgent({ status = 'running' } = {}) {
  const calls = []
  return {
    calls,
    agent: {
      id: 'sess-1',
      status,
      cancel(cause, options) {
        calls.push({ cause, options })
      },
    },
  }
}

test('the live agent is aborted with the user cause and the inbox is kept', async () => {
  const { calls, agent } = recordingAgent()
  const ctx = { agents: { get: (id) => (id === 'sess-1' ? agent : undefined) } }

  const answer = await abortAgentSession({ ctx, sessionId: 'sess-1', now: () => NOW })

  assert.equal(calls.length, 1, 'the host was asked exactly once')
  assert.deepEqual(
    calls[0],
    { cause: { kind: 'user' }, options: { keepInbox: true } },
    'the host received the user cause and the inbox was kept',
  )
  assert.equal(answer.ok, true)
  assert.equal(answer.sessionId, 'sess-1')
  assert.equal(answer.cancelledAt, NOW)
  assert.equal(answer.keepInbox, true)
  assert.equal(answer.active, true)
  assert.equal(answer.agentStatus, 'running')
  assert.equal(answer.resolvedVia, 'agents-registry')
})

test('keepInbox:false is handed to the host as it is', async () => {
  const { calls, agent } = recordingAgent()
  const ctx = { agents: { get: () => agent } }

  const answer = await abortAgentSession({ ctx, sessionId: 'sess-1', keepInbox: false, now: () => NOW })

  assert.deepEqual(
    calls[0],
    { cause: { kind: 'user' }, options: { keepInbox: false } },
    'the host was told to drop the queued work too',
  )
  assert.equal(answer.ok, true)
  assert.equal(answer.keepInbox, false)
})

test('an unusable session id is refused and NOTHING is aborted', async () => {
  const { calls, agent } = recordingAgent()
  const ctx = { agents: { get: () => agent } }

  const answer = await abortAgentSession({ ctx, sessionId: '  __proto__  ', now: () => NOW })

  assert.equal(calls.length, 0, 'no session was aborted')
  assert.equal(answer.ok, false)
  assert.equal(answer.error, ABORT_ERRORS.INVALID_SESSION_ID)
  assert.equal(typeof answer.detail, 'string')
})

test('the session controller refusing the session is reported as agent-not-found', async () => {
  const ctx = {
    agents: { get: () => undefined },
    sessionController: {
      resolveAgent: async () => ({ error: { code: 'session/not-found', message: 'gone' } }),
    },
  }

  const answer = await abortAgentSession({ ctx, sessionId: 'sess-2', now: () => NOW })

  assert.equal(answer.ok, false)
  assert.equal(answer.error, ABORT_ERRORS.AGENT_NOT_FOUND)
  assert.equal(answer.resolvedVia, 'session-controller')
  assert.match(answer.detail, /session\/not-found/)
})

test('the session controller resolving the agent aborts it', async () => {
  const { calls, agent } = recordingAgent()
  const ctx = {
    agents: { get: () => undefined },
    sessionController: { resolveAgent: async () => ({ agent }) },
  }

  const answer = await abortAgentSession({ ctx, sessionId: 'sess-3', now: () => NOW })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { cause: { kind: 'user' }, options: { keepInbox: true } })
  assert.equal(answer.ok, true)
  assert.equal(answer.resolvedVia, 'session-controller')
})

test('without a session controller nothing is aborted and the reason is reported', async () => {
  const answer = await abortAgentSession({ ctx: { agents: { get: () => undefined } }, sessionId: 'sess-4', now: () => NOW })

  assert.equal(answer.ok, false)
  assert.equal(answer.error, ABORT_ERRORS.CONTROLLER_UNAVAILABLE)
  assert.equal(typeof answer.detail, 'string')
})

test('the host refusing the cancellation is reported as cancel-failed', async () => {
  const ctx = {
    agents: {
      get: () => ({
        id: 'sess-5',
        status: 'running',
        cancel() {
          throw new Error('the host refused')
        },
      }),
    },
  }

  const answer = await abortAgentSession({ ctx, sessionId: 'sess-5', now: () => NOW })

  assert.equal(answer.ok, false)
  assert.equal(answer.error, ABORT_ERRORS.CANCEL_FAILED)
  assert.match(answer.detail, /the host refused/)
})

test('an agent without a cancel() is refused, not called', async () => {
  const answer = await abortAgentSession({
    ctx: { agents: { get: () => ({ id: 'sess-6', status: 'idle' }) } },
    sessionId: 'sess-6',
    now: () => NOW,
  })

  assert.equal(answer.ok, false)
  assert.equal(answer.error, ABORT_ERRORS.CANCEL_UNAVAILABLE)
})

test('the cause and the default are the host\'s own shapes', () => {
  assert.deepEqual(USER_CANCEL_CAUSE, { kind: 'user' })
  assert.equal(DEFAULT_KEEP_INBOX, true, 'the queued work of a session survives by default')
})
