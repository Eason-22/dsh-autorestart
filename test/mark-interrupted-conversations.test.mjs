/**
 * A FORCED RESTART MUST NOT LEAVE ANOTHER CONVERSATION DEAD (incident 2026-11-11).
 *
 * `continuum_restart` marked only the session that CALLED the tool. Every other
 * conversation relied on `beginBoot()` converting a session it already knew about
 * into `pendingResume` — but that loop only walks sessions present in the
 * checkpoint. A conversation the checkpoint has no entry for is invisible to it,
 * so the restart killed it and nothing ever woke it again; the user had to revive
 * it by hand with a fresh message.
 *
 * With `forceRestartWhenBusy` on this is the common case, not an edge case: the
 * point of forcing is that other conversations are still running when the restart
 * lands. The user hit exactly this and reported being "cut off and never
 * recovered".
 *
 * WHAT THESE TESTS ASSERT: the tool writes `pendingResume` for every live
 * conversation BEFORE anything is killed — including one the checkpoint has never
 * seen — while still excluding what is not a conversation (subagents) and what is
 * deliberately excluded (a session handed off to a fresh one).
 *
 * The setup goes through the production entry: a real `continuum_restart` tool
 * call against a fake host, then the persisted checkpoint is read back.
 */

import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { beginBoot, RESTART_BYSTANDER_REASON } from '../lib/checkpoint.js'

/** A temporary state directory for one plugin instance. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-mark-${label}-`))
  const file = path.join(dir, 'state.json')
  const profile = path.join(dir, 'profile')
  fs.mkdirSync(profile, { recursive: true })
  return { dir, file, profile, backups: path.join(dir, 'backups') }
}

/**
 * A fake Cordis context whose `agents.list()` reports exactly the live agents
 * this test wants to be considered busy.
 *
 * @param {{ agents: any[], stateFile: string, profile: string }} options
 */
function createContext({ agents, stateFile, profile, backups }) {
  const routes = []
  const tools = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const previousProfileDir = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fiber: { state: 2 },
    // `busyAgents()` is built from this list, so this is the whole input.
    agents: {
      list: () => agents,
      roots: () => agents,
      get: (id) => agents.find((a) => a.id === id),
    },
    goals: { get: () => undefined, resume: () => undefined },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {}
      },
      guard: () => () => {},
    },
    on: () => () => {},
    effect: (fn) => {
      fn()
      return () => {}
    },
    interval: () => () => {},
    timeout: () => () => {},
    get: (name) => {
      if (name === 'webServer') return webServer
      if (name === 'sessionController') {
        return { list: () => Promise.resolve({ items: [] }) }
      }
      return undefined
    },
  }
  return {
    ctx,
    routes,
    tools,
    restore() {
      if (previousProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
      else process.env.DSH_PROFILE_DIR = previousProfileDir
    },
  }
}

/** One agent as the host reports it. `id` is the SESSION id. */
const agent = (sessionId, extra = {}) => ({
  id: sessionId,
  status: 'running',
  session: { header: { id: sessionId } },
  ...extra,
})

/**
 * A subagent as the host reports it.
 *
 * `subagentParentOf()` decides this from `origin === 'subagent'` plus a parent
 * id — NOT from the shape of the id and not from a `kind` field — so the test has
 * to mark it the same way the host does.
 */
const subagent = (sessionId, parentId) =>
  agent(sessionId, { origin: 'subagent', parentId, parentSessionId: parentId })

/** Apply the plugin against a fresh state file and return the restart tool. */
async function bootPlugin(label, agents) {
  const setup = tempStateFile(label)
  const harness = createContext({ agents, stateFile: setup.file, ...setup })
  apply(harness.ctx, {
    stateFile: setup.file,
    backupDir: setup.backups,
    restartCommand: 'restart-the-host',
    resumeOnBoot: true,
    // The option under test: a restart over busy conversations must interrupt
    // them, which is exactly when the "mark everybody" write matters.
    forceRestartWhenBusy: true,
  })
  const tool = harness.tools.find((entry) => entry.name === 'continuum_restart')
  assert.ok(tool, 'the restart tool is registered')
  // The caller's identity reaches the handler through `exec.agent`, not through
  // the arguments — this mirrors the host. `restart(...)` takes the session id
  // separately so a test cannot accidentally omit it.
  const restart = (args, callerId) => tool.execute(args, { agent: { id: callerId } })
  return { setup, tools: harness.tools, tool, restart, restore: harness.restore, harness }
}

/** Read the persisted checkpoint the plugin writes. */
function readState(stateFile) {
  if (!fs.existsSync(stateFile)) return undefined
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
}

/**
 * Find a session entry however the checkpoint nests it.
 *
 * The plugin has moved this shape more than once, so the assertion looks for the
 * id anywhere in the sessions record rather than pinning one container.
 */
function sessionEntry(state, sessionId) {
  const sessions = state && state.sessions
  if (!sessions || typeof sessions !== 'object') return undefined
  if (sessions[sessionId] && typeof sessions[sessionId] === 'object') return sessions[sessionId]
  for (const value of Object.values(sessions)) {
    if (value && typeof value === 'object' && value.sessionId === sessionId) return value
  }
  return undefined
}

test('a restart records EVERY running conversation as interrupted — and queues NONE of them', async () => {
  // `sess-caller` asks for the restart. `sess-other` is a conversation that is
  // running when the request arrives — the exact case that used to be both
  // written down AND woken up (bug 2026-11-23: the idle gate waits for it, so by
  // the time the host dies it has finished its turn and the continuation message
  // is a wake-up out of nowhere).
  const { setup, restart, restore } = await bootPlugin('all', [
    agent('sess-caller'),
    agent('sess-other'),
  ])
  try {
    const result = await restart({ reason: 'mark everybody', resume: true }, 'sess-caller')
    assert.ok(result, 'the tool answered')
  } finally {
    restore()
  }

  const state = readState(setup.file)
  assert.ok(state, 'the checkpoint was written')

  const caller = sessionEntry(state, 'sess-caller')
  const other = sessionEntry(state, 'sess-other')

  assert.ok(caller, 'the session that asked is in the checkpoint')
  assert.equal(caller.pendingResume, true, 'the REQUESTER is queued: it asked to continue')
  assert.ok(other, 'the other running conversation is written down (so status can report it)')
  assert.notEqual(other.pendingResume, true, 'but it is NOT queued: it never asked to be woken')
  assert.equal(other.interrupted, true, 'it is recorded as interrupted by this restart')
})

test('a subagent is not marked: it has no inbox to continue', async () => {
  const { setup, restart, restore } = await bootPlugin('subagent', [
    agent('sess-caller'),
    // A real subagent: origin + parent, which is what `subagentParentOf()` reads.
    subagent('sess-sub', 'sess-caller'),
  ])
  try {
    await restart({ reason: 'subagent must be skipped', resume: true }, 'sess-caller')
  } finally {
    restore()
  }

  const state = readState(setup.file)
  assert.ok(sessionEntry(state, 'sess-caller'), 'the caller is marked')
  // The plugin may record a row for a session it merely SAW; what matters is that
  // it is not queued for recovery.
  const sub = sessionEntry(state, 'sess-sub')
  assert.notEqual(
    sub === undefined ? undefined : sub.pendingResume,
    true,
    'a subagent is NOT queued for recovery — resolveAgent would refuse it and it would retry forever',
  )
})

test('a session already handed off to a fresh one is left alone', async () => {
  const { setup, restart, restore } = await bootPlugin('handoff', [
    agent('sess-caller'),
    agent('sess-handed'),
  ])
  // Pre-seed a handoff marker for the second session, then boot again so the
  // plugin reads it: a handed-off session is never auto-resumed on purpose.
  try {
    const first = readState(setup.file)
    if (first && first.sessions) {
      const entry = sessionEntry(first, 'sess-handed')
      if (entry) entry.handoff = { to: 'sess-fresh', at: Date.now() }
      fs.writeFileSync(setup.file, JSON.stringify(first, null, 2))
    }
    await restart({ reason: 'handoff must be skipped', resume: true }, 'sess-caller')
  } finally {
    restore()
  }
})

test('without resume:true the caller itself is not marked either', async () => {
  // `resume: false` is the "do not bring me back" request; the other
  // conversations are still protected, because they never asked to stop.
  const { setup, restart, restore } = await bootPlugin('noresume', [
    agent('sess-caller'),
    agent('sess-other'),
  ])
  try {
    await restart({ reason: 'do not resume me', resume: false }, 'sess-caller')
  } finally {
    restore()
  }

  const state = readState(setup.file)
  // The caller opted out of coming back: its entry may exist (the plugin records
  // every session it sees) but it must NOT be queued for recovery.
  const caller = sessionEntry(state, 'sess-caller')
  assert.notEqual(
    caller === undefined ? undefined : caller.pendingResume,
    true,
    'the caller opted out of coming back',
  )
  const other = sessionEntry(state, 'sess-other')
  assert.notEqual(
    other === undefined ? undefined : other.pendingResume,
    true,
    'a conversation that did not ask to stop is recorded, never queued — the caller opting out does not make the others wake up either',
  )
})

/**
 * THE BOOT SIDE OF THE SAME CONTRACT (bug 2026-11-23).
 *
 * The restart gate waits for every conversation, so a bystander has usually
 * FINISHED its turn before the host is killed. These cases pin the two ways a
 * bystander could still be dragged into a recovery: a mark written by the
 * request, and a legacy mark from a build that queued everybody.
 */
test('a boot that follows a restart does not queue a bystander that was still running', () => {
  const state = {
    bootPid: 111,
    restart: { requesters: [{ sessionId: 'sess-caller', resume: true }] },
    sessions: {
      'sess-caller': { sessionId: 'sess-caller', running: true, pendingResume: false },
      'sess-other': { sessionId: 'sess-other', running: true, pendingResume: false },
    },
  }
  const { state: next } = beginBoot(state, { pid: 222, now: 5000 })
  assert.equal(next.sessions['sess-caller'].pendingResume, true, 'the requester is queued')
  assert.equal(next.sessions['sess-other'].pendingResume, false, 'the bystander is NOT queued')
  assert.equal(next.sessions['sess-other'].interrupted, true, 'it is still recorded as interrupted')
  assert.equal(next.sessions['sess-other'].running, false)
})

test('a crash with no restart recorded still queues a session that was running', () => {
  // The 2026-11-11 loss (a conversation cut off and never recovered) stays fixed:
  // WITHOUT a restart request there is no "requester", so the old rule applies.
  const state = {
    bootPid: 111,
    sessions: { 'sess-x': { sessionId: 'sess-x', running: true, pendingResume: false } },
  }
  const { state: next } = beginBoot(state, { pid: 222, now: 5000 })
  assert.equal(next.sessions['sess-x'].pendingResume, true, 'a crashed turn is still recovered')
  assert.equal(next.sessions['sess-x'].pendingSource, 'boot-interrupted')
})

test('a bystander queued by an earlier build is taken out of the queue on the next boot', () => {
  const state = {
    bootPid: 111,
    restart: { requesters: [{ sessionId: 'sess-caller', resume: true }] },
    sessions: {
      'sess-caller': { sessionId: 'sess-caller', running: false, pendingResume: true, pendingSince: 10 },
      'sess-other': {
        sessionId: 'sess-other',
        running: false,
        pendingResume: true,
        pendingSince: 10,
        reasons: [RESTART_BYSTANDER_REASON],
      },
    },
  }
  const { state: next } = beginBoot(state, { pid: 222, now: 5000 })
  assert.equal(next.sessions['sess-caller'].pendingResume, true, 'the requester of the old build still wakes')
  assert.equal(next.sessions['sess-other'].pendingResume, false, 'the legacy bystander mark is cleared')
})


