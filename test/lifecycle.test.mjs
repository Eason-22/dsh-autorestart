import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PHASES,
  bootPlan,
  continuationPrompt,
  describeState,
  restartDecision,
  restartGate,
  resumeStep,
  selectRecoverableSessions,
} from '../lib/lifecycle.js';
import {
  createEmptyState,
  markPendingResume,
  markRunning,
  requestRestart,
} from '../lib/checkpoint.js';

const T = 1_700_000_000_000;
const SOFT = 300_000;
const HARD = 900_000;

/** A checkpoint with one deferred restart requested at T for session s1. */
function deferredState({ withGoal = false, now = T } = {}) {
  const state = createEmptyState(now);
  if (withGoal) markRunning(state, { sessionId: 's1', goalId: 'goal-1', goalRevision: 4, now });
  else markRunning(state, { sessionId: 's1', now });
  requestRestart(state, { reason: 'manual restart', bySessionId: 's1', now });
  return state;
}

test('PHASES is the frozen-by-convention phase list', () => {
  assert.deepEqual(PHASES, ['idle', 'deferred', 'restarting', 'recovering', 'running']);
  assert.equal(new Set(PHASES).size, PHASES.length);
});

test('bootPlan recovers pending sessions only when resumeOnBoot allows it', () => {
  const state = createEmptyState(T);
  markPendingResume(state, { sessionId: 'a', reason: 'interrupted', now: T + 20 });
  markPendingResume(state, { sessionId: 'b', reason: 'interrupted', now: T + 10 });
  markRunning(state, { sessionId: 'c', now: T + 30 });

  const plan = bootPlan(state, { limit: 2 });
  assert.equal(plan.recover, true);
  assert.equal(plan.phase, 'recovering');
  assert.equal(plan.restartWasPending, false);
  assert.deepEqual(plan.sessions.map((entry) => entry.sessionId), ['c', 'a']);

  const capped = bootPlan(state, { limit: 1 });
  assert.deepEqual(capped.sessions.map((entry) => entry.sessionId), ['c']);

  const disabled = bootPlan(state, { resumeOnBoot: false, limit: 2 });
  assert.equal(disabled.recover, false);
  assert.deepEqual(disabled.sessions, []);
  assert.equal(disabled.phase, 'idle');

  const idle = bootPlan(createEmptyState(T), {});
  assert.equal(idle.recover, false);
  assert.equal(idle.phase, 'idle');
});

test('bootPlan reports a pending restart without mutating the state', () => {
  const state = deferredState();
  const before = JSON.stringify(state);
  const plan = bootPlan(state, {});
  assert.equal(plan.restartWasPending, true);
  assert.equal(plan.recover, true);
  assert.equal(JSON.stringify(state), before);
});

test('restartDecision returns none when nothing is pending', () => {
  const decision = restartDecision(createEmptyState(T), { anyAgentRunning: false, now: T });
  assert.equal(decision.action, 'none');
  assert.equal(decision.reason, 'no-restart-pending');
});

test('restartDecision coalesces an in-progress restart', () => {
  const state = deferredState();
  state.phase = 'restarting';
  const busy = restartDecision(state, { anyAgentRunning: true, now: T + HARD * 10 });
  assert.equal(busy.action, 'none');
  assert.equal(busy.reason, 'restart-already-in-progress');
  const idle = restartDecision(state, { anyAgentRunning: false, now: T + 1 });
  assert.equal(idle.action, 'none');
});

test('restartDecision restarts immediately when no agent is running', () => {
  const decision = restartDecision(deferredState(), { anyAgentRunning: false, now: T + 1 });
  assert.equal(decision.action, 'restart');
  assert.equal(decision.reason, 'no-agent-running');
});

test('restartDecision waits inside the soft window', () => {
  const state = deferredState();
  const decision = restartDecision(state, { anyAgentRunning: true, now: T + 100 });
  assert.equal(decision.action, 'wait');
  assert.equal(decision.reason, 'agents-busy-within-soft-window');
  assert.equal(decision.log, undefined);
});

test('restartDecision warns once after the soft deadline, then keeps waiting', () => {
  const state = deferredState();
  const first = restartDecision(state, {
    anyAgentRunning: true,
    now: T + SOFT + 1,
    softMs: SOFT,
    hardMs: HARD,
  });
  assert.equal(first.action, 'warn');
  assert.equal(first.reason, 'agents-busy-past-soft-deadline');
  assert.equal(typeof first.log, 'string');
  assert.equal(first.markSoftWarned, true);

  // index.js records the warning on the checkpoint; afterwards a plain wait.
  state.restart.softWarned = true;
  const second = restartDecision(state, {
    anyAgentRunning: true,
    now: T + SOFT + 2,
    softMs: SOFT,
    hardMs: HARD,
  });
  assert.equal(second.action, 'wait');
  assert.equal(second.reason, 'agents-busy-awaiting-hard-deadline');
  assert.equal(second.log, undefined);
});

test('restartDecision honours defer policy "wait" at the hard deadline', () => {
  const state = deferredState();
  const decision = restartDecision(state, {
    anyAgentRunning: true,
    now: T + HARD,
    softMs: SOFT,
    hardMs: HARD,
    policy: 'wait',
  });
  assert.equal(decision.action, 'warn');
  assert.equal(decision.reason, 'hard-deadline-policy-wait');
  assert.equal(decision.log, 'defer policy wait: still busy after hard deadline');
});

test('restartDecision waits at the hard deadline by default and never forces a busy conversation', () => {
  const state = deferredState();
  assert.equal(state.phase, 'deferred');
  const decision = restartDecision(state, {
    anyAgentRunning: true,
    now: T + HARD + 1,
    softMs: SOFT,
    hardMs: HARD,
    policy: 'auto',
  });
  assert.equal(decision.action, 'warn');
  assert.equal(decision.reason, 'hard-deadline-waiting-for-conversations');
  assert.equal(
    decision.log,
    'dsh-autorestart: hard deadline reached but conversations are still running; forceRestartWhenBusy is disabled, so the restart keeps waiting',
  );
});

test('restartDecision force-restarts at the hard deadline only when forceRestartWhenBusy is enabled', () => {
  const state = deferredState();
  const decision = restartDecision(state, {
    anyAgentRunning: true,
    now: T + HARD + 1,
    softMs: SOFT,
    hardMs: HARD,
    policy: 'auto',
    forceRestartWhenBusy: true,
  });
  assert.equal(decision.action, 'force-restart');
  assert.equal(decision.reason, 'hard-deadline-force-restart');
});

test('restartDecision gives up when a forced restart was already attempted', () => {
  const state = deferredState();
  state.restart.attempt = 1;
  const decision = restartDecision(state, {
    anyAgentRunning: true,
    now: T + HARD + 1,
    softMs: SOFT,
    hardMs: HARD,
    policy: 'auto',
    forceRestartWhenBusy: true,
  });
  assert.equal(decision.action, 'give-up');
  assert.equal(decision.reason, 'forced-restart-already-attempted');

  // Without the opt-in the pending restart keeps waiting instead of giving up.
  const waiting = restartDecision(state, {
    anyAgentRunning: true,
    now: T + HARD + 1,
    softMs: SOFT,
    hardMs: HARD,
    policy: 'auto',
  });
  assert.equal(waiting.action, 'warn');
  assert.equal(waiting.reason, 'hard-deadline-waiting-for-conversations');
});

test('restartDecision never forces a busy conversation from a non-deferred phase', () => {
  const state = deferredState();
  state.phase = 'running';
  const decision = restartDecision(state, {
    anyAgentRunning: true,
    now: T + HARD + 1,
    softMs: SOFT,
    hardMs: HARD,
    policy: 'auto',
  });
  assert.equal(decision.action, 'warn');
  assert.equal(decision.reason, 'hard-deadline-waiting-for-conversations');

  // Even with the opt-in the force path needs the deferred phase.
  const forced = restartDecision(state, {
    anyAgentRunning: true,
    now: T + HARD + 1,
    softMs: SOFT,
    hardMs: HARD,
    policy: 'auto',
    forceRestartWhenBusy: true,
  });
  assert.equal(forced.action, 'warn');
  assert.equal(forced.reason, 'hard-deadline-waiting-for-conversations');
});

test('resumeStep skips unknown sessions', () => {
  const step = resumeStep(createEmptyState(T), 'missing', { maxResumeAttempts: 2 });
  assert.equal(step.action, 'skip');
  assert.equal(step.needAgent, false);
  assert.equal(step.reason, 'unknown-session');
});

test('resumeStep re-arms a recorded goal after an interrupted turn', () => {
  const state = deferredState({ withGoal: true });
  const step = resumeStep(state, 's1', { maxResumeAttempts: 2 });
  assert.equal(step.action, 'rearm-goal');
  assert.equal(step.needAgent, true);
  assert.equal(step.needsAgentResume, true);
  assert.equal(step.attempts, 0);
  assert.equal(step.maxAttempts, 2);
});

test('resumeStep prompts a continuation when no goal is recorded', () => {
  const state = deferredState({ withGoal: false });
  const step = resumeStep(state, 's1', { maxResumeAttempts: 2 });
  assert.equal(step.action, 'prompt-continuation');
  assert.equal(step.needAgent, true);
  assert.equal(step.needsAgentResume, true);
});

test('resumeStep on a live running session does not need a resume', () => {
  const state = createEmptyState(T);
  markRunning(state, { sessionId: 's1', goalId: 'g', now: T });
  const step = resumeStep(state, 's1', { maxResumeAttempts: 2 });
  assert.equal(step.action, 'rearm-goal');
  assert.equal(step.needsAgentResume, false);
});

test('resumeStep skips after the attempt cap', () => {
  const state = deferredState({ withGoal: true });
  state.sessions.s1.resumeAttempts = 2;
  const capped = resumeStep(state, 's1', { maxResumeAttempts: 2 });
  assert.equal(capped.action, 'skip');
  assert.equal(capped.needAgent, false);
  assert.equal(capped.reason, 'resume-attempts-exhausted');

  const raised = resumeStep(state, 's1', { maxResumeAttempts: 3 });
  assert.equal(raised.action, 'rearm-goal');
});

test('continuationPrompt uses an override verbatim', () => {
  const entry = deferredState().sessions.s1;
  const override = '  keep going exactly as instructed  ';
  assert.equal(continuationPrompt(entry, { override, now: T }), override);
  // A whitespace-only override is ignored in favour of the built-in text.
  const built = continuationPrompt(entry, { override: '   ', now: T });
  assert.match(built, /<continuum_resume>/);
});

test('continuationPrompt default text names the host, time and reason', () => {
  const entry = deferredState({ withGoal: true }).sessions.s1;
  const text = continuationPrompt(entry, { reason: 'manual restart', now: T });
  assert.match(text, /^<continuum_resume>\n/);
  assert.match(text, /<\/continuum_resume>$/);
  assert.equal(text.includes(new Date(T).toISOString()), true);
  assert.equal(text.includes('manual restart'), true);
  assert.equal(text.includes('DeepSeek Harness'), true);
  assert.equal(text.split('\n').length, 4);

  const custom = continuationPrompt(entry, { now: T, appName: 'MyHost', reason: 'r' });
  assert.equal(custom.includes('MyHost'), true);
});

test('continuationPrompt falls back to the last recorded reason', () => {
  const state = deferredState();
  const entry = state.sessions.s1;
  assert.deepEqual(entry.reasons, ['manual restart']);
  const text = continuationPrompt(entry, { now: T });
  assert.equal(text.includes('manual restart'), true);
});

test('describeState is a one-line summary with phase/generation/pending', () => {
  const state = deferredState();
  state.sessions.s2 = {
    ...state.sessions.s1,
    sessionId: 's2',
    pendingResume: true,
  };
  const summary = describeState(state);
  assert.equal(summary.includes('\n'), false);
  assert.match(summary, /phase=deferred/);
  assert.match(summary, /generation=1/);
  assert.match(summary, /pending=2/);
  assert.match(summary, /s1/);
  assert.match(summary, /restart=attempt:0/);
  assert.equal(describeState(null), 'phase=unknown generation=0 pending=0');
});

test('selectRecoverableSessions is the shared definition used by checkpoint', () => {
  const state = createEmptyState(T);
  markRunning(state, { sessionId: 'a', now: T + 1 });
  assert.deepEqual(selectRecoverableSessions(state, {}).map((entry) => entry.sessionId), ['a']);
  assert.deepEqual(selectRecoverableSessions(null, {}), []);
});


test('restartGate allows only when no conversation is busy and the host is quiet', () => {
  const busy = [{ sessionId: 'other', reason: 'running' }];
  const blocked = restartGate(createEmptyState(T), { busyAgents: busy, lastActivityAt: T, now: T + 1, settleMs: 4000 });
  assert.equal(blocked.allow, false);
  assert.equal(blocked.reason, 'conversation-active');
  assert.deepEqual(blocked.blockedBy, busy);
  assert.equal(blocked.quietForMs, 1);

  const settling = restartGate(createEmptyState(T), { busyAgents: [], lastActivityAt: T, now: T + 1500, settleMs: 4000 });
  assert.equal(settling.allow, false);
  assert.equal(settling.reason, 'settling');
  assert.deepEqual(settling.blockedBy, []);
  assert.equal(settling.quietForMs, 1500);

  const quiet = restartGate(createEmptyState(T), { busyAgents: [], lastActivityAt: T, now: T + 4000, settleMs: 4000 });
  assert.equal(quiet.allow, true);
  assert.equal(quiet.reason, 'quiet');
  assert.equal(quiet.quietForMs, 4000);

  // Queued inbox work blocks exactly like a running turn.
  const queued = restartGate(createEmptyState(T), {
    busyAgents: [{ sessionId: 'other', reason: 'queued' }],
    lastActivityAt: 0,
    now: T + 99999,
    settleMs: 0,
  });
  assert.equal(queued.allow, false);
  assert.equal(queued.reason, 'conversation-active');
});

test('restartDecision waits during the settle window and only force-restarts at the hard deadline when enabled', () => {
  const state = deferredState();
  const settling = restartDecision(state, {
    anyAgentRunning: false,
    lastActivityAt: T + 100,
    settleMs: 4000,
    now: T + 200,
    softMs: SOFT,
    hardMs: HARD,
  });
  assert.equal(settling.action, 'wait');
  assert.equal(settling.reason, 'settling');

  const quiet = restartDecision(state, {
    busyAgents: [],
    lastActivityAt: T,
    settleMs: 4000,
    now: T + 5000,
    softMs: SOFT,
    hardMs: HARD,
  });
  assert.equal(quiet.action, 'restart');
  assert.equal(quiet.reason, 'no-agent-running');

  // A queued conversation blocks the restart inside the soft window...
  const queuedBusy = restartDecision(state, {
    busyAgents: [{ sessionId: 'other', reason: 'queued' }],
    lastActivityAt: T,
    settleMs: 4000,
    now: T + 1000,
    softMs: SOFT,
    hardMs: HARD,
  });
  assert.equal(queuedBusy.action, 'wait');
  assert.equal(queuedBusy.reason, 'agents-busy-within-soft-window');

  // ...but the hard deadline only forces a restart when that is explicitly enabled.
  const forced = restartDecision(state, {
    busyAgents: [{ sessionId: 'other', reason: 'running' }],
    lastActivityAt: T + HARD,
    settleMs: 4000,
    now: T + HARD + 1,
    softMs: SOFT,
    hardMs: HARD,
    forceRestartWhenBusy: true,
  });
  assert.equal(forced.action, 'force-restart');
  assert.equal(forced.reason, 'hard-deadline-force-restart');

  // By default the same situation keeps waiting for the conversation to finish.
  const waiting = restartDecision(state, {
    busyAgents: [{ sessionId: 'other', reason: 'running' }],
    lastActivityAt: T + HARD,
    settleMs: 4000,
    now: T + HARD + 1,
    softMs: SOFT,
    hardMs: HARD,
  });
  assert.equal(waiting.action, 'warn');
  assert.equal(waiting.reason, 'hard-deadline-waiting-for-conversations');
});

test('restartDecision defaults keep the previous idle behaviour', () => {
  const idle = restartDecision(deferredState(), { anyAgentRunning: false, now: T + 1 });
  assert.equal(idle.action, 'restart');
  assert.equal(idle.reason, 'no-agent-running');
  const busy = restartDecision(deferredState(), { anyAgentRunning: true, now: T + 1 });
  assert.equal(busy.action, 'wait');
  assert.equal(busy.reason, 'agents-busy-within-soft-window');
});
