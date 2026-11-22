/**
 * A CONVERSATION THAT WAS ONLY *INTERRUPTED* MUST NOT SEE THE "PENDING RESTART" PILL
 * (user report, 2026-11-22).
 *
 * `continuum_restart` marks every other running conversation `pendingResume` before
 * anything is killed (a6bcb35, 2026-11-13) so the boot can resume them. That write
 * is right and must stay.
 *
 * What went wrong is the READ side: the `?state=1` route built its `waiters` list
 * from BOTH the real requesters AND every session carrying `pendingResume`. The
 * composer pill shows itself when `waiters` contains the current session, so every
 * interrupted conversation displayed "待重启 · 等待 N 个…" — as if IT had asked for
 * the restart. The user saw exactly that in a session that never requested one,
 * and could not cancel it (it is not a requester), which made the pill look stuck.
 *
 * WHAT THESE TESTS ASSERT (both halves, so the fix cannot overshoot):
 *   1. the interrupted conversation is NOT in `waiters` (no pill for it), and
 *   2. it IS still `pendingResume` in the checkpoint (the resume still happens).
 */

import './_tmp-guard.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

/** A temporary state directory for one plugin instance. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-ar-waiters-${label}-`))
  const file = path.join(dir, 'state.json')
  const profile = path.join(dir, 'profile')
  fs.mkdirSync(profile, { recursive: true })
  return { dir, file, profile, backups: path.join(dir, 'backups') }
}

/** A fake Cordis context whose `agents.list()` is the whole input to `busyAgents()`. */
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

/** Apply the plugin against a fresh state file and return the restart tool. */
async function bootPlugin(label, agents) {
  const setup = tempStateFile(label)
  const harness = createContext({ agents, stateFile: setup.file, ...setup })
  apply(harness.ctx, {
    stateFile: setup.file,
    backupDir: setup.backups,
    restartCommand: 'restart-the-host',
    resumeOnBoot: true,
    // The restart genuinely interrupts the other conversation — this is the case
    // where the "mark everybody" write is correct and must keep working.
    forceRestartWhenBusy: true,
  })
  const tool = harness.tools.find((entry) => entry.name === 'continuum_restart')
  assert.ok(tool, 'the restart tool is registered')
  const restart = (args, callerId) => tool.execute(args, { agent: { id: callerId } })
  return { setup, tools: harness.tools, tool, restart, harness, restore: harness.restore }
}

/** Read the persisted checkpoint the plugin writes. */
function readState(stateFile) {
  if (!fs.existsSync(stateFile)) return undefined
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
}

/** Find a session entry however the checkpoint nests it. */
function sessionEntry(state, sessionId) {
  const sessions = state && state.sessions
  if (!sessions || typeof sessions !== 'object') return undefined
  if (sessions[sessionId] && typeof sessions[sessionId] === 'object') return sessions[sessionId]
  for (const value of Object.values(sessions)) {
    if (value && typeof value === 'object' && value.sessionId === sessionId) return value
  }
  return undefined
}

/**
 * Ask the plugin's own `?state=1` route what it reports to the client UI, and
 * return the parsed body. The route is the ONLY source the composer pill reads,
 * so this is the closest a unit test gets to "what does the pill see".
 */
function readReportedState(routes) {
  assert.ok(Array.isArray(routes) && routes.length > 0, 'the plugin registered a route')
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value
      },
      getHeader(name) {
        return this.headers[name]
      },
      writeHead(code) {
        this.statusCode = code
        return this
      },
      write() {},
      end(chunk) {
        try {
          finish(JSON.parse(String(chunk == null ? '' : chunk)))
        } catch (error) {
          reject(new Error(`the state route did not answer JSON: ${String(chunk)}`))
        }
      },
    }
    try {
      routes[0].handler(
        { url: '/__dsh_autorestart/health?state=1', socket: { remoteAddress: '127.0.0.1' } },
        res,
      )
    } catch (error) {
      reject(error)
    }
  })
}

test('an interrupted conversation is NOT a waiter, but is still resumed (2026-11-22)', async () => {
  // `sess-caller` asks for the restart. `sess-other` is a conversation that is
  // running for an unrelated reason — it never asked for anything.
  const { setup, restart, harness, restore } = await bootPlugin('interrupted', [
    agent('sess-caller'),
    agent('sess-other'),
  ])

  let body
  try {
    const result = await restart({ reason: 'interrupt everybody', resume: true }, 'sess-caller')
    assert.ok(result, 'the tool answered')
    body = await readReportedState(harness.routes)
  } finally {
    restore()
  }

  const waiters = Array.isArray(body.waiters) ? body.waiters : []
  assert.ok(
    waiters.includes('sess-caller'),
    'the session that ASKED for the restart is a waiter — it is the one that gets the pill',
  )
  assert.ok(
    !waiters.includes('sess-other'),
    'THE INTERRUPTED CONVERSATION IS NOT A WAITER: it never asked for this restart, ' +
      'so the pill would tell it (and its user) the restart is waiting for them — the 2026-11-22 report',
  )

  // The other half of the contract: removing it from `waiters` must NOT stop the
  // boot from resuming it. Two different things, and the fix may only change one.
  const state = readState(setup.file)
  const other = sessionEntry(state, 'sess-other')
  assert.ok(other, 'the interrupted conversation is still written down in the checkpoint')
  assert.equal(
    other.pendingResume,
    true,
    'and it is STILL pendingResume, so the boot recovery resumes it (a6bcb35 must keep working)',
  )
})
