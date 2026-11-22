/**
 * THE STALLED MARKER OF A BLOCKING SESSION (2026-11-21).
 *
 * The report used to say only HOW LONG a blocking conversation had been
 * running, so "it has been running for three hours" and "it has been stuck for
 * three hours" read exactly the same. This file pins the three facts that tell
 * them apart — `lastEventAt`, `silentMs`, `stalled` — and it drives them
 * through the REAL tool (`continuum_status`, assembled by `apply()` on a fake
 * context), not through the pure helpers alone: what a user can see is the
 * tool's answer, so that is what is asserted.
 *
 * What the fake context supplies: one root agent that is RUNNING (that is what
 * makes it a blocker), and a `sessionController` whose list carries a title
 * (the blocker's label comes from it).
 */
// Every temporary directory this file creates is removed when the run ends.
import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import {
  STALLED_THRESHOLD_MS,
  markRunning,
  noteSessionEvent,
  setGoal,
  stalledInfo,
  stalledLabelSuffix,
} from '../lib/checkpoint.js'

const SESSION_ID = 'sess-ui'
const TITLE = 'a live conversation'
/** 3h 12m — the shape the human-readable suffix is written for. */
const THREE_HOURS_TWELVE = 3 * 60 * 60 * 1000 + 12 * 60 * 1000
const MINUTE = 60 * 1000

/** One conversation that is working right now (so it blocks the restart). */
function fakeAgent(id) {
  return {
    id,
    status: 'running',
    session: { id },
    inbox: { nextStep: [], nextTurn: [] },
    followups: [],
    followup(message) {
      this.followups.push(message)
    },
  }
}

/**
 * A fake host context.
 *
 * `emit` passes EVERY argument to the listener, because the host delivers
 * `session/event` as `(session, event)` — a one-argument emitter would hide
 * exactly the shape the plugin has to cope with.
 */
function createFakeContext({ agents = [], title = TITLE } = {}) {
  const tools = []
  const listeners = new Map()
  const services = {
    sessionController: {
      list: () => ({ items: [{ sessionId: SESSION_ID, title }] }),
      flush: () => undefined,
    },
  }
  const ctx = {
    logger: Object.assign(() => undefined, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    }),
    fiber: { state: 2 },
    agents: {
      list: () => agents,
      roots: () => agents,
      get: (id) => agents.find((agent) => String(agent.id) === String(id)),
    },
    goals: {
      get: () => undefined,
      resume: () => {
        throw new Error('goals.resume is not configured for this test')
      },
      pause: () => undefined,
      block: () => undefined,
    },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
      guard: () => () => {},
    },
    get: (name) => (name === 'sessionController' ? services.sessionController : undefined),
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect: (fn) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    interval: () => () => {},
    timeout: () => () => {},
    provide: () => undefined,
    emit: (event, ...args) => {
      const handler = listeners.get(event)
      if (handler) handler(...args)
    },
  }
  return { ctx, tools }
}

/** Boot the real plugin on a fake context and hand back what the tests drive. */
function boot({ agents = [fakeAgent(SESSION_ID)] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-stalled-'))
  const file = path.join(dir, 'state.json')
  const { ctx, tools } = createFakeContext({ agents })
  const runtime = apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const statusTool = tools.find((tool) => tool.name === 'continuum_status')
  assert.ok(statusTool, 'continuum_status must be registered by the plugin')
  return { ctx, tools, runtime, statusTool, file, dir, agent: agents[0] }
}

/**
 * Make the blocking session look SILENT for a while.
 *
 * The value is written straight onto the checkpoint entry: `markRunning` only
 * stamps the activity on the TRANSITION into "running", and the agent has been
 * running since the boot seeded it — so an old event is what this simulates.
 */
function seedSilence(fake, silentMs) {
  const entry = fake.runtime.state.sessions[SESSION_ID]
  assert.ok(entry, 'the boot must seed the running agent into the checkpoint')
  entry.lastEventAt = Date.now() - silentMs
  return entry
}

/** The blocker the report names (there is exactly one in this file). */
function theBlocker(out) {
  assert.ok(Array.isArray(out.blockedBy), 'the answer carries blockedBy')
  assert.equal(out.blockedBy.length, 1, 'the running conversation must be the one blocker')
  return out.blockedBy[0]
}

test('the work event of a session is recorded, and it reaches the state file', () => {
  const fake = boot()
  // The turn starts: that is what creates the checkpoint entry.
  fake.ctx.emit('agent/status', { agent: fake.agent, status: 'running' })
  const entry = fake.runtime.state.sessions[SESSION_ID]
  assert.ok(entry, 'a running agent must have a checkpoint entry')

  // A SENTINEL, so the assertion can tell WHICH event wrote the field: only the
  // session event below may move it.
  entry.lastEventAt = 1
  const before = Date.now()
  fake.ctx.emit('session/event', { session: { id: SESSION_ID } }, { type: 'tool/call' })

  const stamped = fake.runtime.state.sessions[SESSION_ID].lastEventAt
  assert.ok(
    typeof stamped === 'number' && stamped >= before,
    'the work event must stamp the last activity (got ' + String(stamped) + ')',
  )

  // AND IT SURVIVES THE PROCESS: `lastEventAt` is a checkpoint field, not a
  // memory-only value — that is what lets the report answer after a restart.
  const onDisk = JSON.parse(fs.readFileSync(fake.file, 'utf8'))
  assert.equal(
    onDisk.sessions[SESSION_ID].lastEventAt,
    stamped,
    'the recorded activity must be on disk, not only in memory',
  )
})

test('the agent/status heartbeat does not refresh the last activity', () => {
  const fake = boot()
  fake.ctx.emit('agent/status', { agent: fake.agent, status: 'running' })
  // A goal keeps the entry alive through the idle transition (an entry with no
  // goal and no pending resume is dropped, which is correct and unrelated).
  setGoal(fake.runtime.state, SESSION_ID, { goalId: 'g1', goalRevision: 1, phase: 'active' })

  const T0 = Date.now() - MINUTE
  fake.runtime.state.sessions[SESSION_ID].lastEventAt = T0

  // THE HEARTBEAT: the host pulses `agent/status` every few seconds per session.
  fake.ctx.emit('agent/status', { agent: fake.agent, status: 'running' })
  assert.equal(
    fake.runtime.state.sessions[SESSION_ID].lastEventAt,
    T0,
    'a repeated "running" pulse is not activity: a stuck session would look fresh for ever',
  )

  // THE END OF THE TURN is activity, and it is recorded.
  fake.ctx.emit('agent/status', { agent: fake.agent, status: 'idle' })
  const endedAt = fake.runtime.state.sessions[SESSION_ID].lastEventAt
  assert.ok(endedAt > T0, 'the end of a turn must be recorded as activity')

  // THE HEARTBEAT OF AN IDLE SESSION is not activity either.
  fake.ctx.emit('agent/status', { agent: fake.agent, status: 'idle' })
  assert.equal(
    fake.runtime.state.sessions[SESSION_ID].lastEventAt,
    endedAt,
    'an idle heartbeat must not refresh the activity',
  )

  // AND THE CONSEQUENCE A USER SEES: the silence keeps growing under the pulse.
  // A FRESH boot, because here the session must ALREADY be running: going idle
  // and then running again is a NEW TURN (that IS activity), while the pulse of
  // a session that is already running is only a heartbeat.
  const fresh = boot()
  seedSilence(fresh, 20 * MINUTE)
  fresh.ctx.emit('agent/status', { agent: fresh.agent, status: 'running' })
  const blocker = theBlocker(fresh.statusTool.execute({}))
  assert.ok(blocker.silentMs >= 20 * MINUTE, 'the heartbeat must not shorten the reported silence')
  assert.equal(blocker.stalled, true, 'a session silent for 20 minutes is stalled')
})

test('a blocking session silent for over fifteen minutes reports the three facts', () => {
  const fake = boot()
  seedSilence(fake, THREE_HOURS_TWELVE)

  const blocker = theBlocker(fake.statusTool.execute({}))

  assert.equal(blocker.sessionId, SESSION_ID, 'the blocker names the session')
  assert.equal(typeof blocker.lastEventAt, 'number', 'lastEventAt is a real timestamp, not a guess')
  assert.equal(typeof blocker.silentMs, 'number', 'silentMs is reported')
  assert.ok(
    blocker.silentMs >= STALLED_THRESHOLD_MS,
    'the silence must be over the threshold (got ' + blocker.silentMs + ')',
  )
  assert.equal(blocker.stalled, true, 'a session silent for over 15 minutes is STALLED')
  // The reading is honest: silentMs really is "now minus when it was last seen".
  assert.ok(
    Math.abs(blocker.silentMs - (Date.now() - blocker.lastEventAt)) < 1000,
    'silentMs must be the distance from lastEventAt to now',
  )
})

test('the top level summary counts the stalled blocker', () => {
  const fake = boot()
  seedSilence(fake, THREE_HOURS_TWELVE)

  const out = fake.statusTool.execute({})

  assert.ok(out.stalled && typeof out.stalled === 'object', 'the answer carries a top level stalled summary')
  assert.equal(out.stalled.total, 1, 'one blocker was counted')
  assert.equal(out.stalled.stalledCount, 1, 'and it is stalled')
  assert.deepEqual(out.stalled.stalledSessionIds, [SESSION_ID], 'the stalled sessions are named')
  assert.equal(out.stalled.stalled, true, 'the summary itself is stalled')
  assert.equal(out.stalled.lastEventAt, theBlocker(out).lastEventAt, 'the summary copies the oldest blocker')
  assert.equal(out.stalled.silentMs, theBlocker(out).silentMs, 'the summary copies the longest silence')
})

test('a blocker that is not stalled keeps every field it had', () => {
  const fake = boot()

  // The SAME blocker, read twice: only the recorded activity differs.
  seedSilence(fake, MINUTE)
  const fresh = theBlocker(fake.statusTool.execute({}))
  seedSilence(fake, THREE_HOURS_TWELVE)
  const quiet = theBlocker(fake.statusTool.execute({}))

  const addedByThisFeature = ['lastEventAt', 'silentMs', 'stalled']
  assert.deepEqual(
    Object.keys(fresh).sort(),
    Object.keys(quiet).sort(),
    'the two readings must have the same shape',
  )
  for (const key of Object.keys(fresh)) {
    if (addedByThisFeature.includes(key) || key === 'label') continue
    assert.deepEqual(quiet[key], fresh[key], 'field "' + key + '" must be byte-identical between the two readings')
  }

  // NOT STALLED means NOT STALLED, and its label is exactly the title: no suffix.
  assert.equal(fresh.stalled, false, 'a minute of silence is not a stall')
  assert.equal(fresh.label, TITLE, 'the label of a working session is unchanged')
})

test('a stalled blocker carries the readable suffix on its label', () => {
  const fake = boot()
  seedSilence(fake, THREE_HOURS_TWELVE)

  const blocker = theBlocker(fake.statusTool.execute({}))

  assert.equal(
    blocker.label,
    TITLE + ' (silent 3h 12m)',
    'the label of a stalled session says HOW silent it has been',
  )
  // The title itself is untouched: the suffix is appended, not a replacement.
  assert.ok(blocker.label.startsWith(TITLE), 'the readable name is kept')
})

test('the threshold is the exported constant, and an unknown time is null', () => {
  assert.equal(STALLED_THRESHOLD_MS, 15 * MINUTE, 'the threshold is fifteen minutes')

  // NOTHING TO MEASURE FROM: null, never 0 and never "now".
  assert.deepEqual(
    stalledInfo(null),
    { lastEventAt: null, silentMs: null, stalled: false },
    'an unknown last event is reported as unknown',
  )
  assert.equal(stalledInfo(1000, 1000 + STALLED_THRESHOLD_MS - 1).stalled, false, 'one millisecond short is not stalled')
  assert.equal(stalledInfo(1000, 1000 + STALLED_THRESHOLD_MS).stalled, true, 'at the threshold it IS stalled')

  // The suffix in both shapes.
  assert.equal(stalledLabelSuffix(THREE_HOURS_TWELVE), ' (silent 3h 12m)')
  assert.equal(stalledLabelSuffix(15 * MINUTE), ' (silent 15m)')
})

test('a session that is not in the checkpoint gets no activity record', () => {
  const fake = boot()

  noteSessionEvent(fake.runtime.state, 'never-seen', { now: Date.now() })

  assert.equal(
    fake.runtime.state.sessions['never-seen'],
    undefined,
    'a ghost entry would let a session that never worked look like it did',
  )
  // The entry shape of a real session is untouched by the attempt.
  const entry = fake.runtime.state.sessions[SESSION_ID]
  assert.ok(entry, 'the real session is still there')
  assert.equal(entry.sessionId, SESSION_ID)
})
