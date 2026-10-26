/**
 * Integration tests for the plugin entry point (`index.js`).
 *
 * These tests drive `apply()` with a fake Cordis context that mirrors the real
 * service surface the plugin touches (agents, goals, sessionController, tools,
 * timer, webServer). They assert the recovery decisions and the checkpoint side
 * effects, and that the three model-facing tools are registered with valid
 * schemas that the real registry would accept.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, detectManualRestart, normalizeConfig, resolveStateFile } from '../index.js'
import { DEFAULTS } from '../index.js'
import { writeState, createEmptyState, entryFor, markPendingResume, markRunning, requestRestart, setDisarmedGoal, setGoal, setParkedGoal } from '../lib/checkpoint.js'

/** Create a temporary state-file path per test. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-it-${label}-`))
  return { dir, file: path.join(dir, 'state.json') }
}

/**
 * Build a fake Cordis context. `services` are resolved through `ctx.get(name)`, so
 * the test can omit the optional web server or session controller.
 */
function createFakeContext({ services = {}, runningAgents = [] } = {}) {
  const tools = []
  const guards = []
  const listeners = new Map()
  const intervals = []
  const timeouts = []
  const effects = []
  const provided = new Map()

  const ctx = {
    logger: Object.assign((..._args) => undefined, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
    fiber: { state: 2 },
    agents: {
      list: () => runningAgents,
      roots: () => runningAgents,
      get: (id) => runningAgents.find((agent) => String(agent.id) === String(id)),
    },
    goals: {
      get: () => undefined,
      resume: () => {
        throw new Error('goals.resume not configured for this test')
      },
      pause: () => undefined,
      block: () => undefined,
    },
    tools: {
      register: (definition) => {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
      guard: (guard) => {
        guards.push(guard)
        return () => {
          const index = guards.indexOf(guard)
          if (index >= 0) guards.splice(index, 1)
        }
      },
    },
    get: (name) => services[name],
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect: (fn, _label) => {
      const disposer = fn()
      effects.push(disposer)
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    interval: (fn, ms) => {
      intervals.push({ fn, ms })
      return () => {
        const index = intervals.findIndex((entry) => entry.fn === fn)
        if (index >= 0) intervals.splice(index, 1)
      }
    },
    timeout: (fn, ms) => {
      timeouts.push({ fn, ms })
      return () => {
        const index = timeouts.findIndex((entry) => entry.fn === fn)
        if (index >= 0) timeouts.splice(index, 1)
      }
    },
    provide: (name, value) => {
      provided.set(name, value)
    },
    emit: (event, payload) => {
      const handler = listeners.get(event)
      if (handler) handler(payload)
    },
  }
  return { ctx, tools, guards, listeners, intervals, timeouts, effects, provided }
}

/** Seed a checkpoint that looks like it came from a previous host process. */
function seedPreviousBoot(file, build) {
  const state = createEmptyState(Date.now() - 60_000)
  state.bootPid = 999_999
  state.bootId = 'previous-boot'
  state.phase = 'idle'
  build(state)
  writeState(file, state)
}

/** A fake live Agent good enough for goal lookups, ids, and followup capture. */
function fakeAgent(id) {
  const followups = []
  return {
    id,
    status: 'idle',
    session: { id },
    inbox: { nextStep: [], nextTurn: [] },
    followups,
    followup(message) {
      followups.push(message)
    },
  }
}

/** Run one recovery pass by invoking the scheduled timeout callback. */
async function runBootRecovery(fake) {
  const pending = fake.timeouts.shift()
  assert.ok(pending, 'apply() must schedule a boot-recovery timer')
  pending.fn()
  // The recovery callback is async; give its microtasks a chance to settle.
  await new Promise((resolve) => setTimeout(resolve, 20))
}

test('normalizeConfig merges defaults and rejects wrong types', () => {
  const config = normalizeConfig({ recoveryDelayMs: 10, deferPolicy: 'bogus', enabled: 'no' })
  assert.equal(config.recoveryDelayMs, 10)
  assert.equal(config.deferPolicy, 'auto')
  assert.equal(config.enabled, true)
  assert.equal(config.maxSessions, 4)
  // A running conversation is never force-restarted unless this is explicitly enabled.
  assert.equal(normalizeConfig({}).forceRestartWhenBusy, false)
  assert.equal(DEFAULTS.forceRestartWhenBusy, false)
  assert.equal(normalizeConfig({ forceRestartWhenBusy: true }).forceRestartWhenBusy, true)
  assert.equal(normalizeConfig({ forceRestartWhenBusy: 'yes' }).forceRestartWhenBusy, false)
})

test('the countdown length is one of the offered choices', () => {
  // The settings page offers a dropdown, so only these five values exist.
  assert.deepEqual(DEFAULTS.sleepCountdownSeconds, 20)
  assert.equal(normalizeConfig({}).sleepCountdownSeconds, 20)
  for (const choice of [0, 10, 20, 30, 60]) {
    assert.equal(normalizeConfig({ sleepCountdownSeconds: choice }).sleepCountdownSeconds, choice)
  }
  // A profile that still carries an old value is snapped onto the nearest
  // offered one instead of breaking.
  assert.equal(normalizeConfig({ sleepCountdownSeconds: 15 }).sleepCountdownSeconds, 20)
  assert.equal(normalizeConfig({ sleepCountdownSeconds: 45 }).sleepCountdownSeconds, 60)
  assert.equal(normalizeConfig({ sleepCountdownSeconds: '20' }).sleepCountdownSeconds, 20)
  assert.equal(normalizeConfig({ sleepCountdownSeconds: null }).sleepCountdownSeconds, 20)
})

test('resolveStateFile honours config and DSH_HOME', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-home-test')
  try {
    assert.equal(
      resolveStateFile({ stateFile: '' }),
      path.join(process.env.DSH_HOME, 'storages', 'dsh-autorestart', 'state.json'),
    )
    const explicit = path.join(os.tmpdir(), 'explicit-state.json')
    assert.equal(resolveStateFile({ stateFile: explicit }), path.resolve(explicit))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('boot recovery re-arms a disarmed active goal instead of prompting', async () => {
  const { file } = tempStateFile('goal')
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' })
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' })
    setGoal(state, 'sess-goal', { goalId: 'goal-1', goalRevision: 3, phase: 'active' })
  })

  const agent = fakeAgent('sess-goal')
  const resumeCalls = []
  const fake = createFakeContext({
    services: {
      sessionController: {
        resolveAgent: async (sessionId) => ({ agent }),
      },
    },
  })
  fake.ctx.goals.get = () => ({
    id: 'goal-1',
    revision: 3,
    phase: 'active',
    activation: 'disarmed',
    roundsStarted: 0,
    maxGoalRounds: 256,
  })
  fake.ctx.goals.resume = (target, ref) => {
    resumeCalls.push({ target, ref })
    return { id: 'goal-1', revision: 4, phase: 'active', activation: 'armed' }
  }

  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  await runBootRecovery(fake)

  assert.equal(resumeCalls.length, 1, 'the goal must be re-armed exactly once')
  assert.deepEqual(resumeCalls[0].ref, { id: 'goal-1', revision: 3 })
  assert.equal(agent.followups.length, 0, 'a re-armed goal must not also receive a continuation message')

  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.sessions['sess-goal'].pendingResume, false)
  assert.equal(state.sessions['sess-goal'].resumeAttempts, 1)
  assert.equal(state.phase, 'running')
})

test('boot recovery injects one continuation message when there is no goal', async () => {
  const { file } = tempStateFile('prompt')
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-prompt', reason: 'app closed mid-turn' })
  })

  const agent = fakeAgent('sess-prompt')
  const fake = createFakeContext({
    services: {
      sessionController: {
        resolveAgent: async () => ({ agent }),
      },
    },
  })

  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  await runBootRecovery(fake)

  assert.equal(agent.followups.length, 1, 'exactly one continuation message is queued')
  const message = agent.followups[0]
  assert.equal(message.role, 'user')
  assert.equal(message.content.length, 1)
  assert.equal(message.content[0].type, 'text')
  assert.match(message.content[0].text, /continuum_resume/)
  assert.match(message.content[0].text, /app closed mid-turn/)
  assert.equal(message.source.kind, 'continuum')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
  assert.ok(Object.isFrozen(message), 'the queued message must be immutable')

  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.sessions['sess-prompt'].pendingResume, false)
})

test('a resolveAgent failure is counted and queues no continuation', async () => {
  const { file } = tempStateFile('resolve-error')
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-err', reason: 'host restart' })
  })
  const fake = createFakeContext({
    services: {
      sessionController: {
        resolveAgent: async () => ({ error: { code: 'session/not-found' } }),
      },
    },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  await runBootRecovery(fake)
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.sessions['sess-err'].resumeAttempts, 1, 'a failed resume must still consume budget')
  assert.equal(state.sessions['sess-err'].pendingResume, true, 'it stays recoverable for the next boot')
})

test('boot recovery does nothing when the checkpoint has no interrupted session', async () => {
  const { file } = tempStateFile('empty')
  seedPreviousBoot(file, () => {})
  const resolved = []
  const fake = createFakeContext({
    services: {
      sessionController: {
        resolveAgent: async (id) => {
          resolved.push(id)
          return { agent: fakeAgent(id) }
        },
        prompt: async () => {
          throw new Error('must not prompt')
        },
      },
    },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  await runBootRecovery(fake)
  assert.deepEqual(resolved, [])
})

test('a session at its resume-attempt cap is skipped', async () => {
  const { file } = tempStateFile('cap')
  seedPreviousBoot(file, (state) => {
    const entry = entryFor(state, 'sess-cap')
    entry.pendingResume = true
    entry.resumeAttempts = 2
  })
  const resolved = []
  const fake = createFakeContext({
    services: {
      sessionController: {
        resolveAgent: async (id) => {
          resolved.push(id)
          return { agent: fakeAgent(id) }
        },
        prompt: async () => {
          throw new Error('must not prompt')
        },
      },
    },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, maxResumeAttempts: 2, enabled: true })
  await runBootRecovery(fake)
  assert.deepEqual(resolved, [])
})

test('completion of a second boot does not re-run recovery in the same process', async () => {
  const { file } = tempStateFile('same-boot')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  const pid = state.bootPid
  assert.equal(typeof pid, 'number')
  assert.equal(fake.timeouts.length, 1, 'a fresh boot schedules one recovery pass')
  // Re-applying in the same process (hot reload) must not schedule another recovery.
  const second = createFakeContext()
  apply(second.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  assert.equal(second.timeouts.length, 0, 'a same-process reload must not recover again')
  const reloaded = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(reloaded.bootId, state.bootId)
  assert.equal(reloaded.bootPid, pid)
})

test('six lifecycle tools register with registry-acceptable definitions', () => {
  const { file } = tempStateFile('tools')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const names = fake.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'continuum_cancel_restart',
    'continuum_handoff',
    'continuum_park_goal',
    'continuum_recover_now',
    'continuum_restart',
    'continuum_status',
  ])
  for (const tool of fake.tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 20, `${tool.name} needs a real description`)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(tool.parameters.type, 'object')
  }
})

test('continuum_restart checkpoints the requesting session for continuation', () => {
  const { file } = tempStateFile('restart-tool')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart')
  const result = restart.execute(
    { reason: 'load the installed plugin update' },
    { agent: { id: 'sess-restart', status: 'running' } },
  )
  assert.equal(result.accepted, true)
  assert.equal(result.willResume, true)
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.phase, 'deferred')
  assert.equal(state.restart.bySessionId, 'sess-restart')
  assert.equal(state.sessions['sess-restart'].pendingResume, true)
  assert.ok(fake.intervals.length >= 1, 'the defer poller must start')
})

test('continuum_cancel_restart releases the pending continuation', () => {
  const { file } = tempStateFile('cancel-tool')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart')
  const cancel = fake.tools.find((tool) => tool.name === 'continuum_cancel_restart')
  restart.execute({ reason: 'test' }, { agent: { id: 'sess-cancel' } })
  const result = cancel.execute({ reason: 'changed my mind' })
  assert.equal(result.cancelled, true)
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.restart, null)
  assert.equal(state.phase, 'idle')
  assert.equal(state.sessions['sess-cancel'], undefined)
})

test('continuum_status reports environment and checkpoint paths', () => {
  const { file } = tempStateFile('status-tool')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  const status = fake.tools.find((tool) => tool.name === 'continuum_status')
  const result = status.execute({})
  assert.equal(result.ok, true)
  assert.equal(result.stateFile, file)
  assert.equal(typeof result.summary, 'string')
  assert.equal(result.pendingRestart, false)
  assert.equal(result.environment.platform, process.platform)
})

test('agent status changes are checkpointed and idle clears them', () => {
  const { file } = tempStateFile('status-events')
  const agent = fakeAgent('sess-live')
  agent.status = 'running'
  const fake = createFakeContext({ runningAgents: [agent] })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  // Activation seeds already-running agents.
  let state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.sessions['sess-live'].running, true)

  agent.status = 'idle'
  fake.ctx.emit('agent/status', { agent, status: 'idle' })
  state = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(state.sessions['sess-live'], undefined)
})

test('the restart policy is registered as a global system-prompt section', () => {
  const { file } = tempStateFile('system-prompt')
  const sections = []
  const fake = createFakeContext({
    services: {
      systemPrompt: {
        section: (section) => {
          sections.push(section)
          return () => {}
        },
        getSectionOrder: (name) => {
          assert.equal(name, 'HARNESS_IDENTITY')
          return 10
        },
      },
    },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  assert.equal(sections.length, 1)
  const [section] = sections
  assert.equal(section.name, 'dsh-autorestart:restart-policy')
  assert.equal(section.order, 11)
  assert.equal(section.interpolate, false)
  assert.match(section.text, /continuum_restart/)
  assert.match(section.text, /do NOT kill|do not kill/i)
  assert.match(section.text, /continuum_status/)
  // Discoverability must not depend on an AGENTS.md edit.
  assert.doesNotMatch(section.text, /AGENTS\.md/)
})

test('the served index gets a boot-token heartbeat for dsh web pages', () => {
  const { file } = tempStateFile('heartbeat')
  const taps = []
  const routes = []
  const fake = createFakeContext({
    services: {
      webServer: {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
        tapIndex: (transform) => {
          taps.push(transform)
          return () => {}
        },
      },
    },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  assert.equal(routes.length, 6)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, '/__dsh_autorestart/health')
  assert.equal(routes[1].kind, 'exact')
  assert.equal(routes[1].path, '/__dsh_autorestart/park')
  assert.equal(routes[4].kind, 'exact')
  assert.equal(routes[4].path, '/__dsh_autorestart/choice')
  assert.equal(routes[5].kind, 'exact')
  assert.equal(routes[5].path, '/__dsh_autorestart/sleep')
  assert.equal(taps.length, 1)
  const html = taps[0]('<html><head></head><body>app</body></html>')
  assert.match(html, /data-dsh-autorestart-heartbeat/)
  assert.match(html, /__DSH_AUTORESTART_BOOT__/)
  assert.match(html, /\/__dsh_autorestart\/health/)
  assert.ok(html.indexOf('data-dsh-autorestart-heartbeat') < html.indexOf('</head>'))
  // Idempotent: tapping the same document twice must not duplicate the script.
  assert.equal(taps[0](html), html)
})

test('autoReloadPage: false suppresses the heartbeat but keeps the health route', () => {
  const { file } = tempStateFile('no-heartbeat')
  const taps = []
  const routes = []
  const fake = createFakeContext({
    services: {
      webServer: {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
        tapIndex: (transform) => {
          taps.push(transform)
          return () => {}
        },
      },
    },
  })
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, autoReloadPage: false })
  assert.equal(routes.length, 6)
  assert.equal(taps.length, 0)
})

test('every exported default key is present in cordis.patch.yml (no dead knobs)', () => {
  const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const configBlock = patch.slice(patch.indexOf('config:'))
  for (const key of Object.keys(DEFAULTS)) {
    assert.match(configBlock, new RegExp(`\\b${key}:`), `cordis.patch.yml must document ${key}`)
  }
})

test('detectManualRestart blocks real restart attempts', () => {
  const blocked = [
    { name: 'pwsh', arguments: { command: 'taskkill /IM "DeepSeek Harness.exe" /T /F' } },
    { name: 'pwsh', arguments: { command: 'Get-Process -Name "DeepSeek Harness" | Stop-Process -Force' } },
    { name: 'pwsh', arguments: { command: 'Stop-Process -Name "DeepSeek*" -Force' } },
    { name: 'bash', arguments: { command: 'pkill -f "DeepSeek Harness"' } },
    { name: 'pwsh', arguments: { command: 'schtasks /Run /TN dsh-web' } },
    { name: 'pwsh', arguments: { command: 'Get-CimInstance Win32_Process -Filter "name=\'DeepSeek Harness.exe\'" | Invoke-CimMethod -MethodName Terminate' } },
    { name: 'run_code', arguments: { code: 'await import("node:child_process").then(m => m.execSync("taskkill /IM \\"DeepSeek Harness.exe\\" /F"))' } },
    { name: 'pwsh', arguments: { command: "Get-Process | ? {$_.ProcessName -like 'Deep*Harness*'} | Stop-Process" } },
    { name: 'bash', arguments: { command: 'pkill -f DeepSeek' } },
    { name: 'pwsh', arguments: { command: 'wmic process where name="DeepSeek Harness.exe" call terminate' } },
    { name: 'pwsh', arguments: { command: 'shutdown /r /t 0' } },
    { name: 'pwsh', arguments: { command: 'Restart-Computer -Force' } },
  ]
  for (const exec of blocked) {
    assert.ok(detectManualRestart(exec, { pid: 4242, ppid: 999 }), `must block ${exec.name}: ${JSON.stringify(exec.arguments)}`)
  }
  // Pid-targeted kills only match the live host pid / parent pid.
  assert.ok(detectManualRestart({ name: 'pwsh', arguments: { command: 'Stop-Process -Id 12345 -Force' } }, { pid: 12345, ppid: 999 }))
  assert.ok(detectManualRestart({ name: 'pwsh', arguments: { command: 'taskkill /PID 999 /F' } }, { pid: 12345, ppid: 999 }))
  // Port-targeted kills only match the port this Host actually serves.
  assert.ok(detectManualRestart({ name: 'bash', arguments: { command: 'npx kill-port 60909' } }, { pid: 4242, ppid: 999, webPort: 60909 }))
})

test('detectManualRestart leaves ordinary commands and other tools alone', () => {
  const allowed = [
    { name: 'pwsh', arguments: { command: 'echo hello' } },
    { name: 'pwsh', arguments: { command: 'git status' } },
    { name: 'pwsh', arguments: { command: 'echo taskkill is a windows command' } },
    { name: 'pwsh', arguments: { command: 'git commit -m "docs: mention taskkill in README"' } },
    { name: 'pwsh', arguments: { command: 'git commit -m "docs: note shutdown behavior"' } },
    { name: 'pwsh', arguments: { command: 'Stop-Process -Name notepad -Force' } },
    { name: 'pwsh', arguments: { command: 'shutdown --help' } },
    { name: 'pwsh', arguments: { command: 'Remove-Item ./tmp.txt' } },
    { name: 'bash', arguments: { command: 'kill -9 777' } },
    { name: 'bash', arguments: { command: 'npx kill-port 3000' } },
    { name: 'pwsh', arguments: { command: 'schtasks /Query /TN dsh-web' } },
    { name: 'write', arguments: { file_path: 'C:/x.md', content: 'taskkill /IM "DeepSeek Harness.exe" /F' } },
    { name: 'web_fetch', arguments: { url: 'https://example.com/taskkill' } },
    { name: 'read', arguments: { file_path: 'C:/notes/DeepSeek Harness.md' } },
    { name: 'continuum_restart', arguments: { reason: 'reload the plugin bundle' } },
  ]
  for (const exec of allowed) {
    assert.equal(detectManualRestart(exec, { pid: 4242, ppid: 999, webPort: 60909 }), null, `must allow ${exec.name}: ${JSON.stringify(exec.arguments)}`)
  }
})

test('the manual-restart guard is registered globally and denies with guidance', () => {
  const { file } = tempStateFile('guard')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })
  assert.equal(fake.guards.length, 1, 'one global guard is registered')
  const guard = fake.guards[0]
  const denial = guard({ name: 'pwsh', arguments: { command: 'taskkill /IM "DeepSeek Harness.exe" /T /F' } })
  assert.equal(typeof denial, 'string')
  assert.match(denial, /continuum_restart/)
  assert.match(denial, /blockManualRestart/)
  assert.equal(guard({ name: 'pwsh', arguments: { command: 'echo safe' } }), undefined)
  assert.equal(guard({ name: 'read', arguments: { file_path: 'a.txt' } }), undefined)
})

test('blockManualRestart: false disables the guard', () => {
  const { file } = tempStateFile('guard-off')
  const fake = createFakeContext()
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, blockManualRestart: false })
  assert.equal(fake.guards.length, 0)
})

/** Minimal Node response stand-in for the health route handler. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk);
    },
  };
}

/** A fake context whose web server records the registered routes. */
function contextWithRoutes(options = {}) {
  const routes = [];
  const fake = createFakeContext({
    ...options,
    services: {
      ...(options.services || {}),
      webServer: {
        register: (route) => {
          routes.push(route);
          return () => {};
        },
      },
    },
  });
  return { fake, routes };
}

test('the health route admits a remote peer the connection service accepts', () => {
  const { file } = tempStateFile('health-browser');
  const { fake, routes } = contextWithRoutes({
    services: {
      // The host admits this browser request: no refusal status at all.
      connection: { requestRejection: () => undefined },
    },
  });
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const res = fakeResponse();
  routes[0].handler({ url: '/__dsh_autorestart/health?state=1', socket: { remoteAddress: '203.0.113.7' } }, res);
  assert.equal(res.statusCode, 200, 'an admitted browser request must not be refused');
  assert.equal(JSON.parse(res.body).ok, true);
});

test('a remote peer that is neither loopback nor admitted keeps the refusal status', () => {
  const { file } = tempStateFile('health-refused');

  // The connection service refuses this browser request.
  const refused = contextWithRoutes({
    services: { connection: { requestRejection: () => 403 } },
  });
  apply(refused.fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const a = fakeResponse();
  refused.routes[0].handler({ url: '/__dsh_autorestart/health', socket: { remoteAddress: '203.0.113.7' } }, a);
  assert.equal(a.statusCode, 403);
  assert.equal(a.body, '{"ok":false,"error":"loopback-only"}');

  // No connection service at all: the old loopback-only behaviour is kept.
  const bare = contextWithRoutes();
  apply(bare.fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const b = fakeResponse();
  bare.routes[0].handler({ url: '/__dsh_autorestart/health', socket: { remoteAddress: '203.0.113.7' } }, b);
  assert.equal(b.statusCode, 403);

  // A throwing connection service must never break the route.
  const broken = contextWithRoutes({
    services: { connection: { requestRejection: () => { throw new Error('boom'); } } },
  });
  apply(broken.fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const c = fakeResponse();
  broken.routes[0].handler({ url: '/__dsh_autorestart/health', socket: { remoteAddress: '203.0.113.7' } }, c);
  assert.equal(c.statusCode, 403);
});

test('the ?gate=1 probe refuses a restart while a conversation has queued inbox work', () => {
  const { file } = tempStateFile('gate-busy');
  const agent = fakeAgent('sess-queued');
  agent.inbox = { nextTurn: [{ id: 'm1' }], nextStep: [] };
  const { fake, routes } = contextWithRoutes({ runningAgents: [agent] });
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  assert.equal(routes.length, 6, 'the health route must be registered');
  const res = fakeResponse();
  routes[0].handler({ url: '/__dsh_autorestart/health?gate=1', socket: { remoteAddress: '127.0.0.1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const payload = JSON.parse(res.body);
  assert.equal(payload.allowRestart, false);
  assert.equal(payload.gate.allow, false);
  assert.equal(payload.gate.reason, 'conversation-active');
  assert.deepEqual(payload.gate.blockedBy, [{ sessionId: 'sess-queued', reason: 'queued' }]);
  assert.equal(payload.busyCount, 1);
  assert.equal(payload.agentCount, 1);
  assert.equal(typeof payload.settleMs, 'number');
});

test('the ?gate=1 probe allows the restart once every conversation is idle and quiet', () => {
  const { file } = tempStateFile('gate-idle');
  const { fake, routes } = contextWithRoutes();
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, settleMs: 0 });
  const res = fakeResponse();
  routes[0].handler({ url: '/__dsh_autorestart/health?gate=1', socket: { remoteAddress: '127.0.0.1' } }, res);
  const payload = JSON.parse(res.body);
  assert.equal(payload.allowRestart, true);
  assert.equal(payload.gate.reason, 'quiet');
  assert.deepEqual(payload.gate.blockedBy, []);
  assert.equal(payload.busyCount, 0);
  assert.equal(payload.settleMs, 0);

  // The normal health payload is unchanged for non-gate requests.
  const normal = fakeResponse();
  routes[0].handler({ url: '/__dsh_autorestart/health', socket: { remoteAddress: '127.0.0.1' } }, normal);
  const body = JSON.parse(normal.body);
  assert.equal(body.ok, true);
  assert.equal(body.plugin, 'dsh-autorestart');
  assert.equal(body.allowRestart, undefined);
});

test('the ?state=1 probe reports the pending-restart state a UI banner needs', () => {
  const { file } = tempStateFile('state-pending');
  seedPreviousBoot(file, (state) => {
    // Two sessions asked for the (coalesced) restart ...
    requestRestart(state, { reason: 'first', bySessionId: 'sess-state-a', now: Date.now() });
    requestRestart(state, { reason: 'second', bySessionId: 'sess-state-b', now: Date.now() });
    // ... and a third session is only waiting to be resumed.
    markPendingResume(state, { sessionId: 'sess-state-c', reason: 'interrupted', now: Date.now() });
  });
  const { fake, routes } = contextWithRoutes();
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  assert.equal(routes.length, 6, 'the health route must be registered');
  const res = fakeResponse();
  routes[0].handler({ url: '/__dsh_autorestart/health?state=1', socket: { remoteAddress: '127.0.0.1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.pendingRestart, true);
  assert.ok(Array.isArray(payload.waiters));
  assert.deepEqual(
    [...payload.waiters].sort(),
    ['sess-state-a', 'sess-state-b', 'sess-state-c'],
    'every requester and every pending session is reported exactly once',
  );
  assert.equal(payload.waiters.length, 3, 'the waiters are deduplicated');
  assert.ok(payload.waiters.every((id) => typeof id === 'string'), 'the waiters are session id strings');
  assert.equal(typeof payload.settleMs, 'number');
  assert.equal(typeof payload.allowRestart, 'boolean');
  assert.equal(typeof payload.quietForMs, 'number');
  assert.ok(Array.isArray(payload.blockedBy));
  assert.equal(typeof payload.phase, 'string');
  assert.equal(typeof payload.generation, 'number');
  assert.equal(typeof payload.updatedAt, 'number');
});

test('continuum_status reports the restart gate verdict', () => {
  const { file } = tempStateFile('status-gate');
  const busy = fakeAgent('sess-status-busy');
  busy.status = 'running';
  const fake = createFakeContext({ runningAgents: [busy] });
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const status = fake.tools.find((tool) => tool.name === 'continuum_status');
  const result = status.execute({});
  assert.equal(result.gateAllow, false);
  assert.deepEqual(result.blockedBy, [{ sessionId: 'sess-status-busy', reason: 'running' }]);
  assert.equal(typeof result.quietForMs, 'number');
  const schema = status.output.schema.properties;
  assert.equal(schema.gateAllow.type, 'boolean');
  assert.equal(schema.quietForMs.type, 'number');
  assert.equal(schema.blockedBy.type, 'array');
});

/**
 * A fake goals service: one live goal per session, with the DISARM/resume
 * transitions of the real host. `disarm` removes the process-local continuation
 * authority without touching the durable phase or revision; `pause` is still
 * recorded so every test can prove the plugin never pauses a goal any more.
 */
function fakeGoalsService(goalsBySession, calls = { pause: [], resume: [], disarm: [] }) {
  const view = (agent) => goalsBySession[String(agent && agent.id)];
  return {
    get: (agent) => view(agent),
    disarm: (agent) => {
      if (calls.disarm) calls.disarm.push({ sessionId: String(agent && agent.id) });
      const goal = view(agent);
      if (!goal) throw new Error('no goal for this session');
      if (goal.disarmError) throw new Error(goal.disarmError);
      // Disarming leaves the durable phase AND the revision untouched.
      goal.activation = 'disarmed';
      return goal;
    },
    pause: (agent, ref) => {
      calls.pause.push({ sessionId: String(agent && agent.id), ref });
      const goal = view(agent);
      if (!goal) throw new Error('no goal for this session');
      goal.phase = 'paused';
      goal.activation = 'disarmed';
      goal.revision += 1;
      return goal;
    },
    resume: (agent, ref) => {
      calls.resume.push({ sessionId: String(agent && agent.id), ref });
      const goal = view(agent);
      if (!goal) throw new Error('no goal for this session');
      if (goal.resumeError) throw new Error(goal.resumeError);
      goal.phase = 'active';
      goal.activation = 'armed';
      goal.revision += 1;
      return goal;
    },
  };
}

/** A POST request stand-in for the park route. */
function postRequest(body, remoteAddress = '127.0.0.1') {
  const payload = JSON.stringify(body);
  const handlers = {};
  return {
    method: 'POST',
    url: '/__dsh_autorestart/park',
    socket: { remoteAddress },
    on(event, handler) {
      handlers[event] = handler;
      if (event === 'data') {
        setTimeout(() => {
          handler(payload);
          if (handlers.end) handlers.end();
        }, 0);
      }
      return this;
    },
  };
}

test('the disarm step disarms an armed goal and never pauses a goal or cancels a turn', () => {
  const { file } = tempStateFile('disarm-block');
  const agent = fakeAgent('sess-goal');
  agent.status = 'running';
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 3, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  // Cancelling a turn would lose the running round: the plugin must never do it.
  const cancelled = [];
  fake.ctx.agents.cancel = (...args) => cancelled.push(args);
  fake.ctx.agents.interrupt = (...args) => cancelled.push(args);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const status = fake.tools.find((tool) => tool.name === 'continuum_status');
  const before = status.execute({});
  assert.equal(before.blockedBy.length, 1);
  assert.equal(before.blockedBy[0].reason, 'goal-active', 'an armed goal is reported as the blocker');

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  restart.execute({ reason: 'test' }, { agent });
  const poll = fake.intervals[fake.intervals.length - 1];
  assert.ok(poll, 'the defer poller must start');
  poll.fn();

  assert.equal(calls.disarm.length, 1, 'the armed goal is disarmed exactly once');
  assert.equal(calls.pause.length, 0, 'a goal is never paused');
  assert.equal(cancelled.length, 0, 'the running turn is never cancelled');
  assert.equal(goals['sess-goal'].activation, 'disarmed');
  assert.equal(goals['sess-goal'].phase, 'active', 'disarming keeps the durable goal active');
  assert.equal(goals['sess-goal'].revision, 3, 'disarming does not bump the revision');

  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.disarmedGoals['sess-goal'].goalId, 'goal-1');
  assert.equal(state.disarmedGoals['sess-goal'].resumedAt, null);
  assert.equal(state.parkedGoals, undefined, 'no legacy parked record is written');
});

test('a restart that turned parkGoals off disarms no goal', () => {
  const { file } = tempStateFile('disarm-off');
  const agent = fakeAgent('sess-goal');
  agent.status = 'running';
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 3, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  const result = restart.execute({ reason: 'test', parkGoals: false }, { agent });
  assert.equal(result.accepted, true);
  fake.intervals[fake.intervals.length - 1].fn();
  assert.equal(calls.disarm.length, 0, 'no goal is disarmed when parkGoals is false');
  assert.equal(goals['sess-goal'].activation, 'armed');
});

test('a goal whose round budget is spent is reported instead of disarmed', () => {
  const { file } = tempStateFile('disarm-exhausted');
  const agent = fakeAgent('sess-goal');
  agent.status = 'running';
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 3, phase: 'active', activation: 'armed', roundsStarted: 10, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  restart.execute({ reason: 'test' }, { agent });
  fake.intervals[fake.intervals.length - 1].fn();
  assert.equal(calls.disarm.length, 0, 'an exhausted goal is never disarmed');
  const status = fake.tools.find((tool) => tool.name === 'continuum_status');
  const after = status.execute({});
  assert.equal(after.blockedBy[0].reason, 'goal-exhausted');
});

test('a goal the user paused is not disarmed by the restart gate', () => {
  const { file } = tempStateFile('disarm-user-paused');
  const agent = fakeAgent('sess-goal');
  agent.status = 'running';
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 3, phase: 'paused', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  restart.execute({ reason: 'test' }, { agent });
  fake.intervals[fake.intervals.length - 1].fn();
  assert.equal(calls.disarm.length, 0, 'a goal somebody else paused stays untouched');
  const status = fake.tools.find((tool) => tool.name === 'continuum_status');
  assert.equal(status.execute({}).blockedBy[0].reason, 'goal-paused');
});

test('after a boot a goal this plugin disarmed is resumed', async () => {
  const { file } = tempStateFile('disarm-resume');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' });
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'active', activation: 'disarmed', roundsStarted: 2, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  assert.equal(calls.resume.length, 1, 'the disarmed goal is re-armed exactly once');
  assert.equal(calls.pause.length, 0, 'recovery never pauses a goal');
  assert.equal(goals['sess-goal'].activation, 'armed');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(state.disarmedGoals['sess-goal'].resumedAt > 0, 'the disarmed record is cleared by the resume');
  assert.equal(state.sessions['sess-goal'].lastRecoveryAction, 'resume-disarmed-goal');
  assert.equal(typeof state.sessions['sess-goal'].lastRecoveryDetail, 'string');
});

test('a goal the previous pause-based build parked is resumed after the boot', async () => {
  const { file } = tempStateFile('legacy-parked-resume');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' });
    setParkedGoal(state, 'sess-goal', { goalId: 'goal-1', parkedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'paused', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  assert.equal(calls.resume.length, 1, 'the goal the previous build paused is resumed');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(state.parkedGoals['sess-goal'].resumedAt > 0, 'the legacy record is cleared by the resume');
  assert.equal(state.sessions['sess-goal'].lastRecoveryAction, 'resume-paused-goal');
});

test('a goal the user paused is NOT resumed after a boot', async () => {
  const { file } = tempStateFile('user-paused-not-resumed');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
  });
  const agent = fakeAgent('sess-goal');
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'paused', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  assert.equal(calls.resume.length, 0, 'a goal the plugin did not pause stays paused');
  assert.equal(agent.followups.length, 1, 'the session still gets the continuation message');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.sessions['sess-goal'].lastRecoveryAction, 'prompt-continuation');
});

test('a failed resume of a disarmed goal falls back to the continuation message', async () => {
  const { file } = tempStateFile('disarm-resume-fail');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' });
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  const goals = {
    'sess-goal': {
      id: 'goal-1',
      revision: 5,
      phase: 'active',
      activation: 'disarmed',
      roundsStarted: 2,
      maxGoalRounds: 10,
      resumeError: 'stale revision',
    },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  assert.equal(agent.followups.length, 1, 'the fallback continuation message is queued');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.disarmedGoals['sess-goal'].resumedAt, null, 'the disarmed record is kept for a later boot');
  assert.match(state.sessions['sess-goal'].lastResumeError, /stale revision/);
  assert.match(state.sessions['sess-goal'].lastRecoveryDetail, /stale revision/);
});

test('every early recovery return records an action and a detail', async () => {
  // (1) The session has no live agent (the controller reports it as gone).
  const gone = tempStateFile('early-agent-not-live');
  seedPreviousBoot(gone.file, (state) => {
    markPendingResume(state, { sessionId: 'sess-early', reason: 'host restart' });
  });
  const notLive = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ error: 'session is gone' }) } },
  });
  apply(notLive.ctx, { stateFile: gone.file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(notLive);
  let state = JSON.parse(fs.readFileSync(gone.file, 'utf8'));
  assert.equal(state.sessions['sess-early'].lastRecoveryAction, 'agent-not-live');
  assert.match(state.sessions['sess-early'].lastRecoveryDetail, /gone/);

  // (2) No session controller at all.
  const noController = tempStateFile('early-no-controller');
  seedPreviousBoot(noController.file, (state) => {
    markPendingResume(state, { sessionId: 'sess-early', reason: 'host restart' });
  });
  const bare = createFakeContext();
  apply(bare.ctx, { stateFile: noController.file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(bare);
  state = JSON.parse(fs.readFileSync(noController.file, 'utf8'));
  assert.equal(state.sessions['sess-early'].lastRecoveryAction, 'session-controller-unavailable');
  assert.equal(typeof state.sessions['sess-early'].lastRecoveryDetail, 'string');

  // (3) The goal lookup throws: the session still gets the continuation message.
  const lookup = tempStateFile('early-goal-lookup');
  seedPreviousBoot(lookup.file, (state) => {
    markPendingResume(state, { sessionId: 'sess-early', reason: 'host restart' });
  });
  const agent = fakeAgent('sess-early');
  const brokenGoals = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  brokenGoals.ctx.goals = {
    get: () => {
      throw new Error('goals service exploded');
    },
    resume: () => {
      throw new Error('goals.resume must not be called');
    },
  };
  apply(brokenGoals.ctx, { stateFile: lookup.file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(brokenGoals);
  assert.equal(agent.followups.length, 1, 'a failed goal lookup still makes progress');
  state = JSON.parse(fs.readFileSync(lookup.file, 'utf8'));
  assert.equal(state.sessions['sess-early'].lastRecoveryAction, 'goal-lookup-failed');
  assert.match(state.sessions['sess-early'].lastRecoveryDetail, /exploded/);

  // (4) The continuation message itself is rejected.
  const prompt = tempStateFile('early-prompt-failed');
  seedPreviousBoot(prompt.file, (state) => {
    markPendingResume(state, { sessionId: 'sess-early', reason: 'host restart' });
  });
  const closed = fakeAgent('sess-early');
  closed.followup = () => {
    throw new Error('inbox closed');
  };
  const noPrompt = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent: closed }) } },
  });
  apply(noPrompt.ctx, { stateFile: prompt.file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(noPrompt);
  state = JSON.parse(fs.readFileSync(prompt.file, 'utf8'));
  assert.equal(state.sessions['sess-early'].lastRecoveryAction, 'prompt-failed');
  assert.match(state.sessions['sess-early'].lastRecoveryDetail, /inbox closed/);
});

test('continuum_recover_now retries a stuck recovery', async () => {
  const { file } = tempStateFile('recover-now');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' });
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  let live = false;
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => (live ? { agent } : { error: 'not loaded yet' }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);
  let state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.sessions['sess-goal'].lastRecoveryAction, 'agent-not-live');
  assert.equal(state.sessions['sess-goal'].pendingResume, true, 'the session stays recoverable');

  live = true;
  const tool = fake.tools.find((entry) => entry.name === 'continuum_recover_now');
  assert.ok(tool, 'continuum_recover_now must be registered');
  const out = await tool.execute({});
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 1, 'the pending session is retried');
  assert.equal(out.results[0].action, 'resume-disarmed-goal');
  assert.equal(goals['sess-goal'].activation, 'armed');
  state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.sessions['sess-goal'].lastRecoveryAction, 'resume-disarmed-goal');
});

test('continuum_recover_now reports a session that is not pending', async () => {
  const { file } = tempStateFile('recover-now-idle');
  const fake = createFakeContext();
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const tool = fake.tools.find((entry) => entry.name === 'continuum_recover_now');
  const out = await tool.execute({ sessionId: 'sess-missing' });
  assert.equal(out.ok, true);
  assert.equal(out.results[0].sessionId, 'sess-missing');
  assert.equal(out.results[0].detail, 'no-pending-recovery');
});

test('the /recover route retries the recovery for a pending session', async () => {
  const { file } = tempStateFile('recover-route');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake, routes } = contextWithRoutes({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  // Consume the boot recovery first, so the route is the only retry path left.
  const pendingBoot = fake.timeouts.shift();
  assert.ok(pendingBoot);
  const route = routes.find((entry) => entry.path === '/__dsh_autorestart/recover');
  assert.ok(route, 'the /recover route must be registered');
  const res = fakeResponse();
  route.handler(postRequest({ sessionId: 'sess-goal' }), res);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.results[0].action, 'resume-disarmed-goal');
  assert.equal(goals['sess-goal'].activation, 'armed');

  const wrongMethod = fakeResponse();
  route.handler({ method: 'GET', url: '/__dsh_autorestart/recover', socket: { remoteAddress: '127.0.0.1' } }, wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
  const remote = fakeResponse();
  route.handler(postRequest({ sessionId: 'sess-goal' }, '203.0.113.7'), remote);
  assert.equal(remote.statusCode, 403);
});

test('a failing disarm never breaks the restart gate', () => {
  const { file } = tempStateFile('disarm-fail');
  const agent = fakeAgent('sess-goal');
  agent.status = 'running';
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 3, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10, disarmError: 'goal is busy' },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  restart.execute({ reason: 'test' }, { agent });
  assert.doesNotThrow(() => fake.intervals[fake.intervals.length - 1].fn());
  const status = fake.tools.find((tool) => tool.name === 'continuum_status');
  const result = status.execute({});
  assert.equal(result.blockedBy.length, 1, 'the session still blocks, but the gate keeps working');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.disarmedGoals, undefined, 'a failed disarm is not recorded');
});

test('continuum_park_goal disarms the goal of the calling session', () => {
  const { file } = tempStateFile('disarm-tool');
  const agent = fakeAgent('sess-tool');
  const goals = {
    'sess-tool': { id: 'goal-7', revision: 2, phase: 'active', activation: 'armed', roundsStarted: 0, maxGoalRounds: 9 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const tool = fake.tools.find((entry) => entry.name === 'continuum_park_goal');
  const result = tool.execute({}, { agent });
  assert.equal(result.ok, true);
  assert.equal(result.disarmed, true);
  assert.equal(result.goalId, 'goal-7');
  assert.equal(calls.disarm.length, 1);
  assert.equal(calls.pause.length, 0);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.disarmedGoals['sess-tool'].goalId, 'goal-7');
});

test('continuum_park_goal reports a goal whose round budget is spent', () => {
  const { file } = tempStateFile('disarm-tool-exhausted');
  const agent = fakeAgent('sess-tool');
  const goals = {
    'sess-tool': { id: 'goal-7', revision: 2, phase: 'active', activation: 'armed', roundsStarted: 9, maxGoalRounds: 9 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const tool = fake.tools.find((entry) => entry.name === 'continuum_park_goal');
  const result = tool.execute({ sessionId: 'sess-tool' }, { agent });
  assert.equal(result.disarmed, false);
  assert.equal(result.reason, 'goal-exhausted');
  assert.equal(calls.disarm.length, 0);
});

test('the tools are owned by the plugin lifecycle: disposing it unregisters them', () => {
  const { file } = tempStateFile('tool-disposer');
  const fake = createFakeContext();
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const names = fake.tools.map((tool) => tool.name);
  for (const name of [
    'continuum_restart',
    'continuum_status',
    'continuum_park_goal',
    'continuum_recover_now',
    'continuum_cancel_restart',
  ]) {
    assert.ok(names.includes(name), `${name} must be registered`);
  }

  // The host owns the disposer of every registration: the tools are registered
  // through ctx.effect (exactly like the HTTP routes), so they are released
  // together with the routes when the plugin is re-applied.
  assert.ok(
    fake.effects.length >= fake.tools.length,
    'every tool registration is owned by an effect, so its disposer reaches the host',
  );

  // Disposing the plugin (the host stops the fiber) releases the tools.
  for (const dispose of fake.effects) {
    if (typeof dispose === 'function') dispose();
  }
  assert.equal(fake.tools.length, 0, 'disposing the plugin unregisters the tools');
});

test('a goal that was armed again is disarmed again even when a stale record exists', () => {
  // REGRESSION: the plugin disarmed the goal before the last restart and the
  // goal was armed again afterwards (a resume), but the stale record was never
  // stamped. The old rule vetoed the disarm because of that record, so the
  // restart waited for the goal forever.
  const { file } = tempStateFile('stale-record-disarm');
  seedPreviousBoot(file, (state) => {
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  agent.status = 'running';
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'active', activation: 'armed', roundsStarted: 2, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  restart.execute({ reason: 'test' }, { agent });
  fake.intervals[fake.intervals.length - 1].fn();

  assert.equal(calls.disarm.length, 1, 'the armed goal is disarmed; the stale record never vetoes it');
  assert.equal(goals['sess-goal'].activation, 'disarmed');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.disarmedGoals['sess-goal'].resumedAt, null, 'the new disarm overwrites the record');
});

test('a goal that was resumed is disarmed again when it blocks the next restart', async () => {
  const { file } = tempStateFile('second-disarm');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' });
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  agent.status = 'running';
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'active', activation: 'disarmed', roundsStarted: 2, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const { fake } = contextWithRoutes({ runningAgents: [agent] });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  // The boot re-armed the goal, so it is armed again and blocks the next restart.
  assert.equal(calls.resume.length, 1, 'the goal is armed again after the boot');
  assert.equal(goals['sess-goal'].activation, 'armed');

  const restart = fake.tools.find((tool) => tool.name === 'continuum_restart');
  restart.execute({ reason: 'test' }, { agent });
  fake.intervals[fake.intervals.length - 1].fn();

  assert.equal(calls.disarm.length, 1, 'the resumed goal is disarmed again (the record never vetoes it)');
  assert.equal(goals['sess-goal'].activation, 'disarmed');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.disarmedGoals['sess-goal'].resumedAt, null, 'the new disarm overwrites the record');
  assert.equal(state.disarmedGoals['sess-goal'].goalId, 'goal-1');
});

test('a resumed goal is stamped in the record, so the status shows it as resumed', async () => {
  const { file } = tempStateFile('resume-stamp');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' });
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'active', activation: 'disarmed', roundsStarted: 2, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(state.disarmedGoals['sess-goal'].resumedAt > 0, 'the resume is stamped in the record');
  const status = fake.tools.find((tool) => tool.name === 'continuum_status');
  const reported = status.execute({}).parkedGoals.find((entry) => entry.sessionId === 'sess-goal');
  assert.equal(reported.kind, 'disarmed');
  assert.equal(reported.resumed, true, 'the status shows the goal as resumed');
});

test('the manual retry stamps the record of the goal it re-armed', async () => {
  const { file } = tempStateFile('recover-now-stamp');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-goal', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-goal', reason: 'turn' });
    setDisarmedGoal(state, 'sess-goal', { goalId: 'goal-1', disarmedAt: Date.now() - 1000 });
  });
  const agent = fakeAgent('sess-goal');
  let live = false;
  const goals = {
    'sess-goal': { id: 'goal-1', revision: 4, phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 10 },
  };
  const calls = { pause: [], resume: [], disarm: [] };
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => (live ? { agent } : { error: 'not loaded yet' }) } },
  });
  fake.ctx.goals = fakeGoalsService(goals, calls);
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  live = true;
  const tool = fake.tools.find((entry) => entry.name === 'continuum_recover_now');
  const out = await tool.execute({});
  assert.equal(out.results[0].action, 'resume-disarmed-goal');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(state.disarmedGoals['sess-goal'].resumedAt > 0, 'the manual retry stamps the resume too');
});

// ---------------------------------------------------------------------------
// The session controller is the only way to resume a session that is NOT live in
// this process. A real incident: it was read through the optional `ctx.get` and
// returned undefined, so every cold session reported "session-controller-unavailable"
// and was silently never resumed.
// ---------------------------------------------------------------------------

test('a controller that only exposes prompt resumes the session and admits the message', async () => {
  const { file } = tempStateFile('controller-prompt');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-cold', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-cold', reason: 'turn' });
  });
  const prompts = [];
  const fake = createFakeContext({
    services: {
      sessionController: {
        prompt: async (request) => {
          prompts.push(request);
          return { accepted: true };
        },
      },
    },
  });
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  assert.equal(prompts.length, 1, 'prompt() is called exactly once');
  assert.equal(prompts[0].sessionId, 'sess-cold');
  assert.equal(prompts[0].mode, 'queue');
  assert.equal(typeof prompts[0].requestId, 'string', 'each call carries a fresh request id');
  assert.ok(prompts[0].content[0].text.includes('continuum_resume'), 'the continuation text is admitted');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.sessions['sess-cold'].lastRecoveryAction, 'resume-via-prompt');
  assert.equal(state.sessions['sess-cold'].pendingResume, false, 'the session is done once the message is accepted');
});

test('a controller with neither resolveAgent nor prompt reports what is missing', async () => {
  const { file } = tempStateFile('controller-empty');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-cold', reason: 'host restart' });
  });
  const fake = createFakeContext({ services: { sessionController: {} } });
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.sessions['sess-cold'].lastRecoveryAction, 'session-controller-unavailable');
  assert.ok(
    state.sessions['sess-cold'].lastRecoveryDetail.includes('neither resolveAgent nor prompt'),
    'the detail names the missing methods, not just "unavailable"',
  );
  assert.equal(state.sessions['sess-cold'].pendingResume, true, 'the session stays recoverable');
});

test('the declared dependency wins over the optional lookup', async () => {
  const { file } = tempStateFile('controller-inject');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-cold', reason: 'host restart' });
  });
  const agent = fakeAgent('sess-cold');
  const prompts = [];
  const fake = createFakeContext({
    services: {
      // The optional lookup would take the prompt-only path.
      sessionController: { prompt: async (request) => { prompts.push(request); return { accepted: true }; } },
    },
  });
  // The declared dependency resolves an agent instead.
  fake.ctx.sessionController = { resolveAgent: async () => ({ agent }) };
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  await runBootRecovery(fake);

  assert.equal(prompts.length, 0, 'the optional path is not used when the dependency is present');
  assert.equal(agent.followups.length, 1, 'the continuation message goes to the resolved agent');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.sessions['sess-cold'].lastRecoveryAction, 'goal-lookup-failed');
  assert.ok(state.sessions['sess-cold'].lastRecoveryDetail.includes('continuation message queued'));
});

test('force re-opens a session whose stale over-limit mark would otherwise skip it', async () => {
  const { file } = tempStateFile('force-recover');
  seedPreviousBoot(file, (state) => {
    markPendingResume(state, { sessionId: 'sess-stale', reason: 'host restart' });
    markRunning(state, { sessionId: 'sess-stale', reason: 'turn' });
    // A false-positive record from the old detector: pendingResume already cleared.
    state.sessions['sess-stale'].pendingResume = false;
    state.sessions['sess-stale'].interrupted = false;
    state.sessions['sess-stale'].resumeAttempts = 2;
    state.sessions['sess-stale'].contextOverflow = {
      over: true,
      inputTokens: null,
      contextWindow: null,
      detail: 'a tool output mentioned the phrase',
      detectedAt: Date.now() - 1000,
    };
  });
  const agent = fakeAgent('sess-stale');
  const fake = createFakeContext({
    services: { sessionController: { resolveAgent: async () => ({ agent }) } },
  });
  apply(fake.ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true });
  const tool = fake.tools.find((entry) => entry.name === 'continuum_recover_now');
  assert.ok(tool, 'continuum_recover_now must accept force');

  const before = await tool.execute({ sessionId: 'sess-stale' });
  assert.equal(before.results[0].detail, 'no-pending-recovery', 'without force the stale record still blocks it');

  const after = await tool.execute({ sessionId: 'sess-stale', force: true });
  assert.equal(after.results.length, 1);
  assert.notEqual(after.results[0].detail, 'no-pending-recovery', 'force re-opens the session');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(state.sessions['sess-stale'].contextOverflow ?? null, null, 'the stale record is cleared');
  assert.equal(state.sessions['sess-stale'].resumeAttempts, 1, 'the attempt counter was reset before the retry');
  assert.equal(agent.followups.length, 1, 'the session got its continuation message');
});
