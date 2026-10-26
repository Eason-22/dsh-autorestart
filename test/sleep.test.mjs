/**
 * Tests for the graceful sleep ("优雅挂机") — the host half.
 *
 * The feature waits until every conversation is idle, counts down and then
 * switches the REAL machine off. The dangerous part is the host detection: a
 * WSL host must shut WINDOWS down, not the WSL distribution (shutting the
 * distro down leaves Windows running, so nothing was really switched off).
 *
 * Every dependency is injected, so the whole platform matrix and the whole
 * state machine are covered without touching this machine: the platform, the
 * environment, the file probes, the clock, the spawner and the timer are all
 * parameters of the functions under test.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createSleepController,
  detectShutdownPlan,
  normalizeCountdownSeconds,
  planInvocation,
  runShutdown,
  WSL_SHUTDOWN_EXE,
} from '../lib/sleep.js'
import { apply } from '../index.js'

/** The route that serves the graceful sleep. */
const SLEEP_PATH = '/__dsh_autorestart/sleep'

/** A /proc/version that belongs to a WSL kernel. */
const WSL_PROC_VERSION = 'Linux version 5.15.90.1-microsoft-standard-WSL2 (oe-user@oe-host) #1 SMP'

/** A /proc/version of a real Linux kernel. */
const LINUX_PROC_VERSION = 'Linux version 6.1.0-18-amd64 (debian-kernel@lists.debian.org) #1 SMP'

/**
 * The file probes of a machine that is NOT WSL: no env marker, a real Linux
 * kernel and no mounted Windows binary.
 */
function plainLinux() {
  return {
    readFile: (file) => {
      assert.equal(file, '/proc/version')
      return LINUX_PROC_VERSION
    },
    exists: () => false,
  }
}

/* ------------------------------------------------------------------ *
 * The platform matrix.
 * ------------------------------------------------------------------ */

test('Windows shuts the machine down with the built-in shutdown binary', () => {
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  assert.equal(plan.kind, 'windows')
  assert.equal(plan.command, 'shutdown.exe')
  assert.deepEqual(plan.args, ['/s', '/f', '/t', '0'])
  assert.equal(plan.label, '关掉这台 Windows 电脑')
})

test('a WSL host shuts WINDOWS down, never the distribution', () => {
  const plan = detectShutdownPlan({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu-22.04' },
    ...plainLinux(),
  })
  assert.equal(plan.kind, 'wsl')
  assert.equal(plan.command, WSL_SHUTDOWN_EXE)
  assert.equal(plan.command, '/mnt/c/Windows/System32/shutdown.exe')
  assert.deepEqual(plan.args, ['/s', '/f', '/t', '0'])
  assert.equal(plan.source, 'WSL_DISTRO_NAME')
  assert.match(plan.label, /WSL/)
  assert.match(plan.label, /Windows/)
})

test('every WSL evidence is enough on its own', () => {
  const byInterop = detectShutdownPlan({
    platform: 'linux',
    env: { WSL_INTEROP: '/run/WSL/8_interop' },
    ...plainLinux(),
  })
  assert.equal(byInterop.kind, 'wsl')
  assert.equal(byInterop.source, 'WSL_INTEROP')
  assert.equal(byInterop.command, WSL_SHUTDOWN_EXE)

  const byKernel = detectShutdownPlan({
    platform: 'linux',
    env: {},
    readFile: (file) => {
      assert.equal(file, '/proc/version')
      return WSL_PROC_VERSION
    },
    exists: () => false,
  })
  assert.equal(byKernel.kind, 'wsl')
  assert.equal(byKernel.source, '/proc/version')
  assert.equal(byKernel.command, WSL_SHUTDOWN_EXE)

  const byMount = detectShutdownPlan({
    platform: 'linux',
    env: {},
    readFile: () => LINUX_PROC_VERSION,
    exists: (file) => file === WSL_SHUTDOWN_EXE,
  })
  assert.equal(byMount.kind, 'wsl')
  assert.equal(byMount.source, WSL_SHUTDOWN_EXE)
  assert.equal(byMount.command, WSL_SHUTDOWN_EXE)
})

test('a real Linux host shuts itself down', () => {
  const plan = detectShutdownPlan({ platform: 'linux', env: {}, ...plainLinux() })
  assert.equal(plan.kind, 'linux')
  assert.equal(plan.command, 'systemctl')
  assert.deepEqual(plan.args, ['poweroff'])
  assert.equal(plan.label, '关闭这台 Linux 主机')
  assert.deepEqual(plan.fallbacks, [{ command: 'shutdown', args: ['-h', 'now'] }])
})

test('a Mac shuts itself down through osascript', () => {
  const plan = detectShutdownPlan({ platform: 'darwin', env: {} })
  assert.equal(plan.kind, 'macos')
  assert.equal(plan.command, 'osascript')
  assert.deepEqual(plan.args, ['-e', 'tell application "System Events" to shut down'])
  assert.equal(plan.label, '关闭这台 Mac')
})

test('an unknown platform is unsupported and has no command at all', () => {
  const plan = detectShutdownPlan({ platform: 'freebsd', env: {} })
  assert.equal(plan.kind, 'unsupported')
  assert.equal(plan.command, null)
  assert.deepEqual(plan.args, [])
  assert.deepEqual(plan.fallbacks, [])
})

test('no plan ever shuts the SUBSYSTEM down instead of the machine', () => {
  const plans = [
    detectShutdownPlan({ platform: 'win32', env: {} }),
    detectShutdownPlan({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, ...plainLinux() }),
    detectShutdownPlan({ platform: 'linux', env: { WSL_INTEROP: 'x' }, ...plainLinux() }),
    detectShutdownPlan({
      platform: 'linux',
      env: {},
      readFile: () => WSL_PROC_VERSION,
      exists: () => false,
    }),
    detectShutdownPlan({ platform: 'linux', env: {}, ...plainLinux() }),
    detectShutdownPlan({ platform: 'darwin', env: {} }),
    detectShutdownPlan({ platform: 'freebsd', env: {} }),
  ]
  for (const plan of plans) {
    const text = JSON.stringify(plan)
    assert.doesNotMatch(text, /wsl\.exe/i, `the plan must never call wsl.exe: ${text}`)
    assert.doesNotMatch(text, /--shutdown/, `the plan must never use --shutdown: ${text}`)
    if (plan.kind === 'wsl') {
      assert.doesNotMatch(text, /systemctl/, `a WSL plan must never use systemctl: ${text}`)
    }
  }
})

test('the WSL fallbacks still reach Windows', () => {
  const plan = detectShutdownPlan({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    ...plainLinux(),
  })
  assert.equal(plan.fallbacks.length, 2)
  assert.deepEqual(plan.fallbacks[0], {
    command: 'powershell.exe',
    args: ['-NoProfile', '-Command', 'Stop-Computer -Force'],
  })
  assert.deepEqual(plan.fallbacks[1], {
    command: 'cmd.exe',
    args: ['/c', 'shutdown.exe', '/s', '/f', '/t', '0'],
  })
})

test('the label is a sentence a Chinese user can read', () => {
  const labels = [
    detectShutdownPlan({ platform: 'win32', env: {} }).label,
    detectShutdownPlan({ platform: 'linux', env: { WSL_DISTRO_NAME: 'U' }, ...plainLinux() }).label,
    detectShutdownPlan({ platform: 'linux', env: {}, ...plainLinux() }).label,
    detectShutdownPlan({ platform: 'darwin', env: {} }).label,
  ]
  for (const label of labels) {
    assert.equal(typeof label, 'string')
    assert.ok(label.length >= 4, `the label must be a sentence: ${label}`)
    assert.match(label, /[一-鿿]/, `the label must be Chinese: ${label}`)
  }
  assert.equal(labels[0], '关掉这台 Windows 电脑')
  assert.match(labels[1], /WSL 里的 DSH → 关掉整台 Windows/)
})

/* ------------------------------------------------------------------ *
 * The custom command.
 * ------------------------------------------------------------------ */

test('a configured command replaces the detected one and says so', () => {
  const windows = detectShutdownPlan({ platform: 'win32', env: {} })
  const overridden = planInvocation(windows, { sleepCommand: 'my-shutdown.exe --now', platform: 'win32' })
  assert.equal(overridden.command, 'cmd.exe')
  assert.deepEqual(overridden.args, ['/c', 'my-shutdown.exe --now'])
  assert.equal(overridden.source, 'sleepCommand')
  assert.equal(overridden.detectedSource, 'process.platform')
  assert.equal(overridden.overridden, true)
  assert.equal(overridden.kind, 'windows', 'the host kind does not change')

  const linux = detectShutdownPlan({ platform: 'linux', env: {}, ...plainLinux() })
  const shell = planInvocation(linux, { sleepCommand: 'do-reboot', platform: 'linux' })
  assert.equal(shell.command, '/bin/sh')
  assert.deepEqual(shell.args, ['-c', 'do-reboot'])
  assert.equal(shell.source, 'sleepCommand')
})

test('an empty custom command leaves the detected plan alone', () => {
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  const same = planInvocation(plan, { sleepCommand: '   ', platform: 'win32' })
  assert.equal(same.command, 'shutdown.exe')
  assert.deepEqual(same.args, ['/s', '/f', '/t', '0'])
  assert.equal(same.source, 'process.platform')
})

/* ------------------------------------------------------------------ *
 * The execution.
 * ------------------------------------------------------------------ */

test('a dry run reports the command and spawns nothing', () => {
  const calls = []
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  const result = runShutdown(plan, {
    spawn: (...args) => { calls.push(args); return { pid: 1, unref() {} } },
    dryRun: true,
  })
  assert.equal(calls.length, 0, 'a dry run must not spawn anything')
  assert.equal(result.executed, false)
  assert.equal(result.command, 'shutdown.exe')
  assert.deepEqual(result.args, ['/s', '/f', '/t', '0'])
  assert.equal(result.error, null)
})

test('the shutdown is spawned detached and unreferenced', () => {
  const calls = []
  let unrefed = 0
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  const result = runShutdown(plan, {
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      return { pid: 4321, unref: () => { unrefed += 1 } }
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'shutdown.exe')
  assert.deepEqual(calls[0].args, ['/s', '/f', '/t', '0'])
  assert.deepEqual(calls[0].options, { detached: true, stdio: 'ignore', windowsHide: true })
  assert.equal(unrefed, 1, 'the child must be unrefed')
  assert.equal(result.executed, true)
  assert.equal(result.pid, 4321)
})

test('the gate is checked again right before the machine is closed', () => {
  const calls = []
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  const blocked = runShutdown(plan, {
    spawn: (...args) => { calls.push(args); return { pid: 1, unref() {} } },
    gate: () => ({ allow: false, reason: 'conversation-active' }),
  })
  assert.equal(calls.length, 0, 'a denied gate must not spawn anything')
  assert.equal(blocked.executed, false)
  assert.equal(blocked.error, 'gate-blocked')

  const allowed = runShutdown(plan, {
    spawn: (...args) => { calls.push(args); return { pid: 2, unref() {} } },
    gate: () => ({ allow: true }),
  })
  assert.equal(calls.length, 1)
  assert.equal(allowed.executed, true)
})

test('a plan without a command never runs anything', () => {
  const calls = []
  const result = runShutdown(detectShutdownPlan({ platform: 'freebsd', env: {} }), {
    spawn: (...args) => { calls.push(args); return { pid: 1, unref() {} } },
  })
  assert.equal(calls.length, 0)
  assert.equal(result.executed, false)
  assert.equal(result.error, 'no-shutdown-command')
})

/* ------------------------------------------------------------------ *
 * The state machine.
 * ------------------------------------------------------------------ */

/** A controller with a fake clock, a fake timer and a fake shutdown. */
function createController({
  busy = [],
  allow = true,
  countdownSeconds = 10,
  titles = {},
} = {}) {
  let clock = 1000
  const timers = []
  const shutdowns = []
  const state = { busy: [...busy], allow }
  const controller = createSleepController({
    now: () => clock,
    busyAgents: () => state.busy,
    gate: () => ({ allow: state.allow, blockedBy: state.busy }),
    titleOf: (sessionId) => titles[sessionId],
    countdownSeconds,
    shutdown: () => {
      shutdowns.push({ at: clock })
      return { ok: true, at: new Date(clock).toISOString(), command: 'shutdown.exe', args: ['/s'], executed: true, pid: 7, error: null }
    },
    setInterval: (fn, ms) => {
      const timer = { fn, ms, disposed: false }
      timers.push(timer)
      return timer
    },
    clearInterval: (handle) => {
      if (handle) handle.disposed = true
    },
  })
  return {
    controller,
    timers,
    shutdowns,
    state,
    advance: (ms) => { clock += ms },
  }
}

test('arming with nothing to do starts the countdown', () => {
  const harness = createController()
  const status = harness.controller.arm()
  assert.equal(status.phase, 'countdown')
  assert.equal(status.armed, true)
  assert.equal(status.countdownSeconds, 10)
  assert.equal(status.remainingMs, 10000)
  assert.deepEqual(status.blockers, [])
  assert.equal(harness.timers.length, 1, 'exactly one timer may run')
  assert.equal(harness.timers[0].disposed, false)
})

test('a busy conversation keeps the machine alive and is listed', () => {
  const harness = createController({
    busy: [{ sessionId: 'sess-a', reason: 'running' }],
    titles: { 'sess-a': '写代码的会话' },
  })
  const status = harness.controller.arm()
  assert.equal(status.phase, 'waiting')
  assert.equal(status.armed, true)
  assert.deepEqual(status.blockers, [{ sessionId: 'sess-a', title: '写代码的会话' }])
  assert.equal(harness.shutdowns.length, 0)
  assert.match(status.message, /写代码的会话/)
})

test('a blocker without a title falls back to its session id', () => {
  const harness = createController({ busy: [{ sessionId: 'sess-b', reason: 'running' }] })
  const status = harness.controller.arm()
  assert.deepEqual(status.blockers, [{ sessionId: 'sess-b', title: 'sess-b' }])
})

test('the countdown runs down and closes the machine', () => {
  const harness = createController()
  harness.controller.arm()
  for (let step = 0; step < 10; step += 1) {
    harness.advance(1000)
    harness.controller.tick()
  }
  const status = harness.controller.status()
  assert.equal(status.phase, 'shutting-down')
  assert.equal(status.remainingMs, 0)
  assert.equal(harness.shutdowns.length, 1, 'the machine must be closed exactly once')
  assert.ok(status.lastRun, 'the last run must be reported')
  assert.deepEqual(Object.keys(status.lastRun).sort(), ['args', 'at', 'command', 'error', 'executed', 'pid'])
  assert.equal(status.lastRun.command, 'shutdown.exe')
  assert.equal(status.lastRun.executed, true)
  assert.equal(status.lastRun.pid, 7)
  assert.equal(status.lastRun.error, null)
  assert.ok(harness.timers[0].disposed, 'the timer must be released when the machine is closed')
})

test('a conversation that starts working during the countdown stops the shutdown', () => {
  const harness = createController()
  harness.controller.arm()
  harness.advance(1000)
  harness.controller.tick()
  assert.equal(harness.controller.status().phase, 'countdown')

  // Somebody starts working again.
  harness.state.busy = [{ sessionId: 'sess-c', reason: 'running' }]
  harness.advance(1000)
  const status = harness.controller.tick()
  assert.equal(status.phase, 'waiting', 'the countdown must go back to waiting')
  assert.equal(harness.shutdowns.length, 0, 'nothing may be closed')
  assert.deepEqual(status.blockers, [{ sessionId: 'sess-c', title: 'sess-c' }])
  assert.match(status.message, /又开始干活了/, 'the message must say who started working')
  assert.match(status.message, /sess-c/)
})

test('the gate is asked once more before the machine is closed', () => {
  const harness = createController()
  harness.controller.arm()
  harness.state.allow = false
  // Ten ticks: the countdown reaches zero and the gate is asked.
  for (let step = 0; step < 10; step += 1) {
    harness.advance(1000)
    harness.controller.tick()
  }
  const status = harness.controller.status()
  assert.equal(status.phase, 'waiting', 'a denied gate must send the machine back to waiting')
  assert.equal(harness.shutdowns.length, 0, 'a denied gate must not close the machine')

  // The machine stays alive while the gate keeps denying.
  for (let step = 0; step < 10; step += 1) {
    harness.advance(1000)
    harness.controller.tick()
  }
  assert.equal(harness.shutdowns.length, 0, 'the machine must never be closed while the gate denies')
})

test('cancelling stops everything and leaves no timer behind', () => {
  const harness = createController()
  harness.controller.arm()
  assert.equal(harness.timers.length, 1)
  const status = harness.controller.cancel()
  assert.equal(status.phase, 'cancelled')
  assert.equal(status.armed, false)
  assert.equal(status.remainingMs, 0)
  assert.ok(harness.timers[0].disposed, 'the timer must be disposed on cancel')
})

test('a broken tick never takes the host down', () => {
  const warnings = []
  const controller = createSleepController({
    busyAgents: () => { throw new Error('the agent list exploded') },
    log: { warn: (...parts) => warnings.push(parts.join(' ')) },
    setInterval: () => ({}),
    clearInterval: () => {},
  })
  const status = controller.arm()
  assert.equal(status.phase, 'countdown')
  assert.ok(warnings.length > 0, 'the failure must be logged')
})

test('the countdown length is clamped into the supported range', () => {
  assert.equal(normalizeCountdownSeconds(0), 3)
  assert.equal(normalizeCountdownSeconds(999), 120)
  assert.equal(normalizeCountdownSeconds(10), 10)
  assert.equal(normalizeCountdownSeconds('nonsense'), 10)
})

test('the shortest and the longest countdown show every second', () => {
  for (const seconds of [3, 120]) {
    const harness = createController({ countdownSeconds: seconds })
    const first = harness.controller.arm()
    assert.equal(first.remainingMs, seconds * 1000, 'the countdown starts with the full time')
    const visible = [Math.ceil(first.remainingMs / 1000)]
    for (let step = 0; step < seconds + 2 && harness.shutdowns.length === 0; step += 1) {
      harness.advance(1000)
      visible.push(Math.ceil(harness.controller.tick().remainingMs / 1000))
    }
    // The user sees every second down to one, and the machine is closed right
    // after the last one: there is no "0 seconds and instantly off" moment.
    assert.deepEqual(
      visible.slice(0, seconds),
      Array.from({ length: seconds }, (unused, index) => seconds - index),
      `the countdown of ${seconds}s must show ${seconds}..1`,
    )
    assert.equal(harness.shutdowns.length, 1, 'the machine is closed exactly once')
    assert.equal(harness.controller.status().phase, 'shutting-down')
  }
})

test('arming twice does not start a second timer', () => {
  const harness = createController()
  harness.controller.arm()
  harness.controller.arm()
  harness.controller.arm()
  assert.equal(harness.timers.length, 1, 'there must be exactly one timer')
  assert.equal(harness.timers[0].disposed, false)
  assert.equal(harness.controller.status().phase, 'countdown')
})

test('a disposed controller never touches the host again', () => {
  const harness = createController()
  harness.controller.arm()
  harness.advance(1000)
  harness.controller.tick()
  harness.controller.dispose()
  assert.ok(harness.timers[0].disposed, 'the timer must be released')

  const status = harness.controller.tick()
  assert.equal(status.phase, 'countdown', 'a tick after the dispose must do nothing')
  assert.equal(harness.shutdowns.length, 0, 'nothing may be closed after the dispose')
  harness.controller.arm()
  assert.equal(harness.timers.length, 1, 'a disposed controller must not start a new timer')
  harness.advance(5000)
  harness.controller.tick()
  assert.equal(harness.shutdowns.length, 0, 'the machine must stay alive')
})

test('a dry run reports the command it WOULD run', () => {
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  let spawned = 0
  const result = runShutdown(plan, {
    spawn: () => { spawned += 1; return { pid: 1, unref() {} } },
    dryRun: true,
  })
  assert.equal(spawned, 0)
  assert.equal(result.executed, false, 'a dry run never executes anything')
  assert.equal(result.command, 'shutdown.exe', 'the command is still reported')
  assert.deepEqual(result.args, ['/s', '/f', '/t', '0'])
  assert.equal(result.error, null)
})

test('an unsupported host never arms and never runs a command', () => {
  const shutdowns = []
  const controller = createSleepController({
    supported: false,
    shutdown: () => { shutdowns.push(true) },
    setInterval: () => ({}),
    clearInterval: () => {},
  })
  assert.equal(controller.status().phase, 'unsupported')
  const status = controller.arm()
  assert.equal(status.phase, 'unsupported')
  assert.equal(status.armed, false)
  assert.equal(shutdowns.length, 0)
})

/* ------------------------------------------------------------------ *
 * The route.
 * ------------------------------------------------------------------ */

/** A fake Cordis context that records the routes and the timers. */
function createContext({ runningAgents = [] } = {}) {
  const routes = []
  const warnings = []
  const timers = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: () => () => {},
  }
  const ctx = {
    logger: {
      info: () => undefined,
      warn: (...parts) => { warnings.push(parts.join(' ')) },
      error: () => undefined,
    },
    fiber: { state: 2 },
    agents: { list: () => runningAgents, roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => undefined },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    interval: (fn, ms) => {
      const timer = { fn, ms, disposed: false }
      timers.push(timer)
      return () => { timer.disposed = true }
    },
    timeout: () => () => {},
    get: (name) => (name === 'webServer' ? webServer : undefined),
  }
  return { ctx, routes, warnings, timers }
}

/** A temporary state file for the plugin. */
function tempStateFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-autorestart-sleep-${label}-`))
  return { dir, file: path.join(dir, 'state.json') }
}

/** A minimal Node response stand-in. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk) },
  }
}

/** A request with a JSON body, good enough for `readJsonBody`. */
function fakeRequest(method, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: SLEEP_PATH,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      if (event === 'data') handler(payload)
      else if (event === 'end') handler()
      return this
    },
  }
}

/** Let the route's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

/** The sleep route of a freshly applied plugin. */
function sleepRoute(routes) {
  const route = routes.find((entry) => entry.path === SLEEP_PATH)
  assert.ok(route, `the sleep route ${SLEEP_PATH} must be registered`)
  return route
}

test('the sleep route answers with exactly the agreed shape', async () => {
  const { file } = tempStateFile('shape')
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('GET'), res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.deepEqual(Object.keys(payload).sort(), [
    'armed', 'blockers', 'countdownSeconds', 'dryRun', 'host', 'lastRun', 'message', 'ok', 'phase', 'remainingMs', 'showSleepButton',
  ])
  assert.equal(payload.ok, true)
  assert.equal(payload.phase, 'idle')
  assert.equal(payload.armed, false)
  assert.equal(payload.showSleepButton, true)
  assert.equal(payload.countdownSeconds, 10)
  assert.equal(payload.remainingMs, 0)
  assert.deepEqual(payload.blockers, [])
  assert.deepEqual(Object.keys(payload.host).sort(), ['kind', 'label', 'platform', 'source'])
  assert.equal(payload.host.platform, process.platform)
  const expected = detectShutdownPlan({ platform: process.platform, env: process.env })
  assert.equal(payload.host.kind, expected.kind, 'the reported host must be the detected host')
  assert.equal(payload.host.label, expected.label)
  assert.equal(payload.host.source, expected.source)
  assert.equal(payload.dryRun, false)
  assert.equal(typeof payload.message, 'string')
  assert.equal(payload.lastRun, null)
})

test('arming waits for the busy conversations and lists them', async () => {
  const { file } = tempStateFile('busy')
  const busy = { id: 'sess-busy', status: 'running' }
  const { ctx, routes, timers } = createContext({ runningAgents: [busy] })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'arm' }), res)
  await settle()

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.phase, 'waiting')
  assert.equal(payload.armed, true)
  assert.deepEqual(payload.blockers, [{ sessionId: 'sess-busy', title: 'sess-busy' }])
  assert.equal(timers.length, 1, 'the countdown timer belongs to the plugin')
})

test('cancelling stops the countdown and releases the timer', async () => {
  const { file } = tempStateFile('cancel')
  const { ctx, routes, timers } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  sleepRoute(routes).handler(fakeRequest('POST', { action: 'arm' }), fakeResponse())
  await settle()
  assert.equal(timers.length, 1)

  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'cancel' }), res)
  await settle()
  const payload = JSON.parse(res.body)
  assert.equal(payload.phase, 'cancelled')
  assert.equal(payload.armed, false)
  assert.ok(timers[0].disposed, 'the timer must be disposed when the sleep is cancelled')
})

test('an unknown action is refused', async () => {
  const { file } = tempStateFile('unknown')
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'explode' }), res)
  await settle()
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).ok, false)
})
