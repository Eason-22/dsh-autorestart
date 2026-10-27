/**
 * Tests for the graceful shutdown ("收工关机") — the host half.
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
import vm from 'node:vm'

import {
  COUNTDOWN_CHOICES,
  createSleepController,
  detectShutdownPlan,
  normalizeCountdownSeconds,
  planInvocation,
  runShutdown,
  snapCountdownChoice,
  WSL_SHUTDOWN_EXE,
} from '../lib/sleep.js'
import { createGestureTickets } from '../lib/ticket.js'
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

test('the WSL environment markers are proof, the mounted drive is only a hint', () => {
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
  assert.equal(byMount.command, WSL_SHUTDOWN_EXE)
  // The mounted drive alone is only a HINT: the plan says so out loud.
  assert.equal(byMount.suspect, true)
  assert.match(byMount.source, /疑似 WSL/)
  assert.match(byMount.label, /疑似 WSL/)
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

test('a dry run reports the command and spawns nothing', async () => {
  const calls = []
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  const result = await runShutdown(plan, {
    spawn: (...args) => { calls.push(args); return { pid: 1, unref() {} } },
    dryRun: true,
  })
  assert.equal(calls.length, 0, 'a dry run must not spawn anything')
  assert.equal(result.executed, false)
  assert.equal(result.command, 'shutdown.exe')
  assert.deepEqual(result.args, ['/s', '/f', '/t', '0'])
  assert.equal(result.error, null)
})

test('the shutdown is spawned detached and unreferenced', async () => {
  const calls = []
  let unrefed = 0
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  const result = await runShutdown(plan, {
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

test('the gate is checked again right before the machine is closed', async () => {
  const calls = []
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  const blocked = await runShutdown(plan, {
    spawn: (...args) => { calls.push(args); return { pid: 1, unref() {} } },
    gate: () => ({ allow: false, reason: 'conversation-active' }),
  })
  assert.equal(calls.length, 0, 'a denied gate must not spawn anything')
  assert.equal(blocked.executed, false)
  assert.equal(blocked.error, 'gate-blocked')

  const allowed = await runShutdown(plan, {
    spawn: (...args) => { calls.push(args); return { pid: 2, unref() {} } },
    gate: () => ({ allow: true }),
  })
  assert.equal(calls.length, 1)
  assert.equal(allowed.executed, true)
})

test('a plan without a command never runs anything', async () => {
  const calls = []
  const result = await runShutdown(detectShutdownPlan({ platform: 'freebsd', env: {} }), {
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
  countdownSeconds = 20,
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
  assert.equal(status.countdownSeconds, 20)
  assert.equal(status.remainingMs, 20000)
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
  for (let step = 0; step < 20; step += 1) {
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
  // Twenty ticks: the countdown reaches zero and the gate is asked.
  for (let step = 0; step < 20; step += 1) {
    harness.advance(1000)
    harness.controller.tick()
  }
  const status = harness.controller.status()
  assert.equal(status.phase, 'waiting', 'a denied gate must send the machine back to waiting')
  assert.equal(harness.shutdowns.length, 0, 'a denied gate must not close the machine')

  // The machine stays alive while the gate keeps denying.
  for (let step = 0; step < 20; step += 1) {
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
  assert.equal(normalizeCountdownSeconds(0), 0, 'zero means no countdown at all')
  assert.equal(normalizeCountdownSeconds(-5), 0)
  assert.equal(normalizeCountdownSeconds(999), 120)
  assert.equal(normalizeCountdownSeconds(10), 10)
  assert.equal(normalizeCountdownSeconds('nonsense'), 20)
})

test('an old countdown value is snapped onto one of the offered choices', () => {
  // A profile that still carries a value the dropdown does not offer must
  // not break: the nearest offered length wins, a tie goes to the longer one.
  assert.equal(snapCountdownChoice(15), 20)
  assert.equal(snapCountdownChoice(45), 60)
  assert.equal(snapCountdownChoice('20'), 20)
  assert.equal(snapCountdownChoice(null), 20)
  assert.equal(snapCountdownChoice(undefined), 20)
  assert.equal(snapCountdownChoice(0), 0)
  assert.equal(snapCountdownChoice(10), 10)
  assert.equal(snapCountdownChoice(30), 30)
  assert.equal(snapCountdownChoice(60), 60)
  for (const value of [0, 10, 20, 30, 60]) {
    assert.equal(COUNTDOWN_CHOICES.indexOf(snapCountdownChoice(value)) !== -1, true)
  }
})

test('the countdown length is a DROPDOWN in the settings page', () => {
  // The settings page renders a select when the schema key is a union of
  // constants (the host projects it as an enum), not when it is a number.
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const declaration = /sleepCountdownSeconds:\s*([^\n]*)\n/.exec(source)
  assert.ok(declaration, 'the schema must declare sleepCountdownSeconds')
  assert.match(
    declaration[1],
    /schemastery\.union\(/,
    'the countdown length must be a union of constants (a dropdown), not a number field',
  )
  assert.match(declaration[1], /COUNTDOWN_CHOICES/, 'the union must be built from the offered choices')
  assert.ok(
    !/schemastery\.number\(\)/.test(declaration[1]),
    'the countdown length must not be a free number field any more',
  )
  assert.deepEqual([...COUNTDOWN_CHOICES], [0, 10, 20, 30, 60], 'the dropdown offers exactly five values')
})

test('a countdown of zero seconds switches the machine off right away', () => {
  const harness = createController({ countdownSeconds: 0 })
  const status = harness.controller.arm()
  assert.equal(status.phase, 'shutting-down', 'there is no countdown: the gate is asked at once')
  assert.equal(status.remainingMs, 0)
  assert.equal(harness.shutdowns.length, 1, 'the machine is closed exactly once')
  assert.match(status.message, /0 秒：立即关机/, 'the message must say that there is no countdown')
})

test('a countdown of zero seconds still waits for the busy conversations', () => {
  const harness = createController({
    countdownSeconds: 0,
    busy: [{ sessionId: 'sess-a', reason: 'running' }],
    titles: { 'sess-a': '写代码的会话' },
  })
  const status = harness.controller.arm()
  assert.equal(status.phase, 'waiting', 'a busy conversation blocks the shutdown')
  assert.equal(harness.shutdowns.length, 0, 'nothing may be closed while somebody is working')
  assert.deepEqual(status.blockers, [{ sessionId: 'sess-a', title: '写代码的会话' }])

  // Once the conversation is done, the next tick switches the machine off.
  harness.state.busy = []
  harness.advance(1000)
  const after = harness.controller.tick()
  assert.equal(after.phase, 'shutting-down')
  assert.equal(harness.shutdowns.length, 1)
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

test('a dry run reports the command it WOULD run', async () => {
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  let spawned = 0
  const result = await runShutdown(plan, {
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
  const taps = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:1234',
    tapIndex: (fn) => {
      taps.push(fn)
      return () => {}
    },
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
  return { ctx, routes, warnings, timers, taps }
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
function fakeRequest(method, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: SLEEP_PATH,
    headers,
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

/**
 * The gesture ticket the host injected into the page.
 *
 * The test drives the real mechanism: the page is served, the host's index
 * tap injects a ticket into it, and the client sends that ticket back.
 *
 * @param {Function[]} taps the index taps the plugin registered
 * @returns {{ ticket: string, issuedAt: number }}
 */
function ticketFromPage(taps) {
  const html = taps.map((fn) => fn('<html><head></head></html>')).join('')
  const match = /window\.__DSH_SLEEP_TICKET__=(\{[^}]*\});/.exec(html)
  assert.ok(match, 'the page must carry a gesture ticket')
  return JSON.parse(match[1])
}

/**
 * The headers a real click sends: the page's ticket plus the timestamp of
 * the pointerdown.
 *
 * @param {{ ticket: string }} grant
 * @param {number} [at] the moment of the gesture
 * @returns {object}
 */
function gestureHeaders(grant, at = Date.now()) {
  return {
    'x-dsh-sleep-ticket': grant.ticket,
    'x-dsh-sleep-gesture': String(at),
  }
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
    'armed', 'blockers', 'countdownSeconds', 'dryRun', 'host', 'humanOnly', 'lastRun', 'message', 'ok', 'phase', 'remainingMs', 'showSleepButton',
  ])
  assert.equal(payload.ok, true)
  assert.equal(payload.phase, 'idle')
  assert.equal(payload.armed, false)
  assert.equal(payload.showSleepButton, true)
  assert.equal(payload.humanOnly, true, 'the state must say that a human click is needed')
  assert.equal(payload.countdownSeconds, 20)
  assert.equal(payload.remainingMs, 0)
  assert.deepEqual(payload.blockers, [])
  assert.deepEqual(Object.keys(payload.host).sort(), ['kind', 'label', 'platform', 'source', 'suspect'])
  assert.equal(payload.host.platform, process.platform)
  const expected = detectShutdownPlan({ platform: process.platform, env: process.env })
  assert.equal(payload.host.kind, expected.kind, 'the reported host must be the detected host')
  assert.equal(payload.host.label, expected.label)
  assert.equal(payload.host.source, expected.source)
  assert.equal(payload.host.suspect, expected.suspect === true, 'the suspect flag must be machine readable')
  assert.equal(payload.dryRun, false)
  assert.equal(typeof payload.message, 'string')
  assert.equal(payload.lastRun, null)
})

test('arming waits for the busy conversations and lists them', async () => {
  const { file } = tempStateFile('busy')
  const busy = { id: 'sess-busy', status: 'running' }
  const { ctx, routes, timers, taps } = createContext({ runningAgents: [busy] })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  const grant = ticketFromPage(taps)
  sleepRoute(routes).handler(
    fakeRequest('POST', { action: 'arm' }, gestureHeaders(grant)),
    res,
  )
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
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, sleepHumanOnly: false })

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

/* ------------------------------------------------------------------ *
 * The human gesture: only a real click may arm the machine.
 * ------------------------------------------------------------------ */

/**
 * A plugin whose gesture tickets run on a clock the test controls.
 *
 * @param {string} label
 * @param {object} [config] extra configuration
 * @returns {object}
 */
function createGestureHost(label, config = {}) {
  const { file } = tempStateFile(label)
  const clock = { at: 1_700_000_000_000 }
  const tickets = createGestureTickets({ now: () => clock.at })
  const { ctx, routes, taps } = createContext()
  apply(
    ctx,
    { stateFile: file, recoveryDelayMs: 0, enabled: true, ...config },
    { sleepTickets: tickets },
  )
  return { ctx, routes, taps, tickets, clock, file }
}

/** The state the route reports right now. */
function currentStatus(routes) {
  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('GET'), res)
  return JSON.parse(res.body)
}

test('arming without a gesture ticket is refused and arms nothing', async () => {
  const host = createGestureHost('no-ticket')
  const res = fakeResponse()
  sleepRoute(host.routes).handler(fakeRequest('POST', { action: 'arm' }), res)
  await settle()

  assert.equal(res.statusCode, 403)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false)
  assert.equal(payload.reason, 'no-ticket', 'the refusal must name its reason')
  assert.equal(typeof payload.message, 'string')
  assert.ok(payload.message.length > 0, 'the refusal must explain itself')
  // Nothing was armed, nothing was counted down, no command was run.
  const status = currentStatus(host.routes)
  assert.equal(status.armed, false)
  assert.equal(status.phase, 'idle')
  assert.equal(status.remainingMs, 0)
})

test('a forged gesture ticket is refused', async () => {
  const host = createGestureHost('bad-ticket')
  const res = fakeResponse()
  const headers = {
    'x-dsh-sleep-ticket': 'deadbeef.deadbeef',
    'x-dsh-sleep-gesture': String(host.clock.at),
  }
  sleepRoute(host.routes).handler(fakeRequest('POST', { action: 'arm' }, headers), res)
  await settle()

  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).reason, 'bad-ticket')
  assert.equal(currentStatus(host.routes).armed, false)
})

test('an expired gesture ticket is refused', async () => {
  const host = createGestureHost('expired-ticket')
  const grant = ticketFromPage(host.taps)
  // The page was loaded a minute and a half ago.
  host.clock.at += 90_000
  const res = fakeResponse()
  sleepRoute(host.routes).handler(
    fakeRequest('POST', { action: 'arm' }, gestureHeaders(grant, host.clock.at)),
    res,
  )
  await settle()

  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).reason, 'expired-ticket')
  assert.equal(currentStatus(host.routes).armed, false)
})

test('a gesture that is too old is refused', async () => {
  const host = createGestureHost('stale-gesture')
  const grant = ticketFromPage(host.taps)
  // The click was five seconds ago: too old for the three second window.
  host.clock.at += 5_000
  const res = fakeResponse()
  sleepRoute(host.routes).handler(
    fakeRequest('POST', { action: 'arm' }, gestureHeaders(grant, host.clock.at - 5_000)),
    res,
  )
  await settle()

  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).reason, 'stale-gesture')
  assert.equal(currentStatus(host.routes).armed, false)
})

test('a cross-site request is refused', async () => {
  const host = createGestureHost('cross-site')
  const grant = ticketFromPage(host.taps)
  const res = fakeResponse()
  const headers = {
    ...gestureHeaders(grant, host.clock.at),
    origin: 'http://evil.example',
    'sec-fetch-site': 'cross-site',
  }
  sleepRoute(host.routes).handler(fakeRequest('POST', { action: 'arm' }, headers), res)
  await settle()

  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).reason, 'cross-site')
  assert.equal(currentStatus(host.routes).armed, false)
})

test('a real click arms the machine, and the ticket is consumed', async () => {
  const host = createGestureHost('gesture')
  const grant = ticketFromPage(host.taps)

  const first = fakeResponse()
  sleepRoute(host.routes).handler(
    fakeRequest('POST', { action: 'arm' }, gestureHeaders(grant, host.clock.at)),
    first,
  )
  await settle()
  assert.equal(first.statusCode, 200)
  const payload = JSON.parse(first.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.armed, true)

  // The same ticket a second time: one ticket, one arm.
  const second = fakeResponse()
  sleepRoute(host.routes).handler(
    fakeRequest('POST', { action: 'arm' }, gestureHeaders(grant, host.clock.at)),
    second,
  )
  await settle()
  assert.equal(second.statusCode, 403)
  assert.equal(JSON.parse(second.body).reason, 'replayed-ticket')
})

test('a request from the page itself is not cross-site', async () => {
  const host = createGestureHost('same-site')
  const grant = ticketFromPage(host.taps)
  const res = fakeResponse()
  const headers = {
    ...gestureHeaders(grant, host.clock.at),
    // What a browser sends for a same-origin request.
    origin: 'http://127.0.0.1:57545',
    host: '127.0.0.1:57545',
    'sec-fetch-site': 'same-origin',
  }
  sleepRoute(host.routes).handler(fakeRequest('POST', { action: 'arm' }, headers), res)
  await settle()

  assert.equal(res.statusCode, 200, 'the page itself must be able to arm the machine')
  assert.equal(JSON.parse(res.body).armed, true)
})

test('cancelling needs no gesture', async () => {
  const host = createGestureHost('cancel')
  const grant = ticketFromPage(host.taps)
  const armed = fakeResponse()
  sleepRoute(host.routes).handler(
    fakeRequest('POST', { action: 'arm' }, gestureHeaders(grant, host.clock.at)),
    armed,
  )
  await settle()
  assert.equal(armed.statusCode, 200)

  const res = fakeResponse()
  sleepRoute(host.routes).handler(fakeRequest('POST', { action: 'cancel' }), res)
  await settle()
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).phase, 'cancelled')
})

test('sleepHumanOnly: false lets a script arm the machine again', async () => {
  const host = createGestureHost('human-only-off', { sleepHumanOnly: false })
  const res = fakeResponse()
  sleepRoute(host.routes).handler(fakeRequest('POST', { action: 'arm' }), res)
  await settle()

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.armed, true)
  assert.equal(payload.humanOnly, false, 'the state must say that a script may arm it')
})

test('the gesture ticket is bound to this host start', async () => {
  const host = createGestureHost('bound')
  const grant = ticketFromPage(host.taps)
  // A ticket of another host start (another secret) is worthless.
  const other = createGestureTickets()
  const foreign = other.issue()
  const res = fakeResponse()
  sleepRoute(host.routes).handler(
    fakeRequest('POST', { action: 'arm' }, gestureHeaders(foreign, host.clock.at)),
    res,
  )
  await settle()
  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).reason, 'bad-ticket')
  assert.ok(grant.ticket !== foreign.ticket, 'two host starts must not share a ticket')
})

/* ------------------------------------------------------------------ *
 * The new cases: a command that does not start, the fallbacks, the
 * WSL hint, and the client half (the button, the overlay, the second
 * install question).
 * ------------------------------------------------------------------ */

test('a command that does not start is a failure, not a success', async () => {
  const plan = detectShutdownPlan({ platform: 'win32', env: {} })
  const result = await runShutdown(plan, {
    spawn: () => ({
      on(event, handler) {
        if (event === 'error') setTimeout(() => handler(new Error('spawn shutdown.exe ENOENT')), 0)
      },
      unref() {},
    }),
  })
  assert.equal(result.executed, false, 'a command that did not start is never "executed"')
  assert.equal(result.ok, false)
  assert.match(result.error, /spawn-failed/)
  assert.match(result.error, /ENOENT/)
})

test('the fallbacks are tried one after another when the main command does not start', async () => {
  const attempts = []
  const plan = detectShutdownPlan({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    ...plainLinux(),
  })
  const result = await runShutdown(plan, {
    spawn: (command) => {
      attempts.push(command)
      const fails = attempts.length === 1
      return {
        pid: 99,
        on(event, handler) {
          if (event === 'error' && fails) setTimeout(() => handler(new Error(`spawn ${command} ENOENT`)), 0)
          if (event === 'spawn' && !fails) setTimeout(() => handler(), 0)
        },
        unref() {},
      }
    },
  })
  assert.equal(attempts.length, 2, 'the main command and the first fallback are tried')
  assert.equal(attempts[0], WSL_SHUTDOWN_EXE)
  assert.equal(attempts[1], 'powershell.exe')
  assert.equal(result.executed, true, 'the fallback that started counts')
  assert.equal(result.command, 'powershell.exe', 'the command that really started is reported')
})

test('every command failing is reported with the last error', async () => {
  const plan = detectShutdownPlan({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    ...plainLinux(),
  })
  const result = await runShutdown(plan, {
    spawn: (command) => ({
      on(event, handler) {
        if (event === 'error') setTimeout(() => handler(new Error(`nope ${command}`)), 0)
      },
      unref() {},
    }),
  })
  assert.equal(result.executed, false)
  assert.equal(result.ok, false)
  assert.match(result.error, /nope cmd\.exe/, 'the LAST error is the one that is reported')
})

test('the mounted Windows drive alone is only a hint, not proof', () => {
  const plan = detectShutdownPlan({
    platform: 'linux',
    env: {},
    readFile: () => LINUX_PROC_VERSION,
    exists: (file) => file === WSL_SHUTDOWN_EXE,
  })
  assert.equal(plan.kind, 'wsl')
  assert.equal(plan.suspect, true, 'the plan must say that it only guesses')
  assert.match(plan.source, /疑似 WSL/)
  assert.match(plan.label, /疑似 WSL/)
})

test('a machine that was not quiet long enough is not reported as busy', () => {
  let clock = 1000
  const controller = createSleepController({
    now: () => clock,
    busyAgents: () => [],
    gate: () => ({ allow: false, reason: 'settling', blockedBy: [] }),
    shutdown: () => { throw new Error('the machine must not be closed') },
    setInterval: () => 0,
    clearInterval: () => {},
  })
  controller.arm()
  for (let step = 0; step < 20; step += 1) {
    clock += 1000
    controller.tick()
  }
  const status = controller.status()
  assert.equal(status.phase, 'waiting')
  assert.match(status.message, /还没安静够久/)
  assert.doesNotMatch(status.message, /有人开始干活/, 'nobody started working: the copy must not say so')
})

test('a shutdown command that does not start leaves the machine idle, not "shutting down"', async () => {
  const controller = createSleepController({
    busyAgents: () => [],
    shutdown: () => Promise.resolve({ ok: false, executed: false, error: 'spawn-failed: ENOENT' }),
    setInterval: () => 0,
    clearInterval: () => {},
  })
  controller.arm()
  for (let step = 0; step < 20; step += 1) controller.tick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const status = controller.status()
  assert.equal(status.phase, 'idle', 'the state must not keep saying "shutting down"')
  assert.equal(status.armed, false)
  assert.equal(status.lastRun.executed, false)
  assert.match(status.lastRun.error, /spawn-failed/)
  assert.match(status.message, /没跑起来/)
})

test('a dry run goes back to idle and says what it WOULD have run', async () => {
  const controller = createSleepController({
    busyAgents: () => [],
    gate: () => ({ allow: true, blockedBy: [] }),
    shutdown: () => Promise.resolve({
      ok: true,
      at: new Date().toISOString(),
      command: 'shutdown.exe',
      args: ['/s', '/f', '/t', '0'],
      executed: false,
      pid: null,
      error: null,
      dryRun: true,
    }),
    setInterval: () => 0,
    clearInterval: () => {},
  })
  controller.arm()
  for (let step = 0; step < 20; step += 1) controller.tick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const status = controller.status()
  assert.equal(status.phase, 'idle', 'a dry run must not leave the state at "shutting down"')
  assert.equal(status.armed, false, 'a dry run leaves nothing armed')
  assert.equal(status.remainingMs, 0)
  assert.match(status.message, /试运行/, 'the message must say that this was only a rehearsal')
  assert.match(status.message, /shutdown\.exe/, 'the message must name the command it would have run')
  assert.match(status.message, /不会真的关机/, 'the message must say that nothing was powered off')
  assert.equal(status.lastRun.dryRun, true, 'the last run must be marked as a dry run')
  assert.equal(status.lastRun.executed, false, 'a dry run never executes anything')
  assert.equal(status.lastRun.command, 'shutdown.exe')
  assert.deepEqual(status.lastRun.args, ['/s', '/f', '/t', '0'])
})

test('the last gate keeps the busy conversations in the waiting card', async () => {
  // The gate allows the countdown to end and denies the very last check, which
  // is the race a conversation that starts working in that exact moment wins.
  let gateCalls = 0
  const controller = createSleepController({
    busyAgents: () => [],
    gate: () => {
      gateCalls += 1
      return gateCalls === 1
        ? { allow: true, blockedBy: [] }
        : { allow: false, reason: 'busy', blockedBy: [{ sessionId: 'sess-late' }] }
    },
    titleOf: () => '收尾的会话',
    shutdown: () => Promise.resolve({ ok: false, executed: false, error: 'gate-blocked' }),
    setInterval: () => 0,
    clearInterval: () => {},
  })
  controller.arm()
  for (let step = 0; step < 20; step += 1) controller.tick()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const status = controller.status()
  assert.equal(status.phase, 'waiting', 'the machine must not be closed')
  assert.deepEqual(
    status.blockers,
    [{ sessionId: 'sess-late', title: '收尾的会话' }],
    'the waiting card must still know WHO is busy',
  )
  assert.match(status.message, /收尾的会话/)
  assert.doesNotMatch(status.message, /0 个会话/, 'the copy must never talk about zero busy sessions')
})

/* ------------------------------------------------------------------ *
 * The client half.
 * ------------------------------------------------------------------ */

/** A fake browser localStorage. */
function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    clear: () => { map.clear() },
    has: (key) => map.has(key),
  }
}

/** Compare two dependency lists the way React does. */
function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/** A tiny React stand-in: enough for the classic client script. */
function createReactHarness() {
  const hooks = []
  let cursor = 0
  let pendingEffects = []
  const slotAt = (index) => {
    while (hooks.length <= index) {
      hooks.push({ value: undefined, deps: undefined, cleanup: undefined, initialized: false, effectInit: false })
    }
    return hooks[index]
  }
  const React = {
    createElement(type, props, ...children) {
      const flat = []
      const push = (child) => {
        if (Array.isArray(child)) child.forEach(push)
        else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child)
      }
      children.forEach(push)
      return { type, props: props || {}, children: flat }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index)
      if (!slot.initialized) {
        slot.initialized = true
        slot.value = typeof initial === 'function' ? initial() : initial
      }
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
      }
      return [slot.value, setState]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      return { current: initial }
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      const slot = slotAt(index)
      const changed = !slot.effectInit || !sameDeps(slot.deps, deps)
      slot.deps = deps
      slot.effectInit = true
      if (changed) pendingEffects.push({ slot, fn })
    },
  }
  const render = (Component, props) => {
    cursor = 0
    pendingEffects = []
    const tree = Component(props)
    const effects = pendingEffects
    pendingEffects = []
    for (const { slot, fn } of effects) {
      if (typeof slot.cleanup === 'function') slot.cleanup()
      slot.cleanup = fn()
    }
    return tree
  }
  return { React, render }
}

/** Every node of a rendered tree, depth first. */
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children || []) walk(child, out)
  return out
}

/** The concatenated text of a rendered subtree. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}

/** Let the pending promises settle. */
const settleClient = () => new Promise((resolve) => setTimeout(resolve, 5))

/**
 * Load the classic client script in a sandbox and mount its surfaces.
 *
 * @param {{ status?: object, storage?: object, language?: string, ticket?: object, refuseArm?: object }} options
 */
function mountClient({
  status = null,
  storage = createStorage(),
  language = 'zh',
  ticket = null,
  refuseArm = null,
  sessionStorage = createStorage(),
} = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
  const fetches = []
  const polls = []
  const state = { status }
  // How often the page reloaded itself (the self-heal of a stale page).
  const reloads = { count: 0 }
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (value) => { definition = value } },
      localStorage: storage,
      sessionStorage,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { reload: () => { reloads.count += 1 } },
      // The one-time gesture ticket the host injected into this page.
      __DSH_SLEEP_TICKET__: ticket,
    },
    document: {
      getElementById: () => null,
      createElement: (tag) => ({ tag, id: '', textContent: '', parentNode: null, setAttribute: () => {}, appendChild: () => {} }),
      head: { appendChild: (node) => { node.parentNode = sandbox.document.head; return node }, removeChild: () => {} },
    },
    fetch: (url, init) => {
      fetches.push({ url: String(url), init })
      const action = init && init.body ? JSON.parse(init.body).action : null
      const isSleep = String(url).includes('/sleep')
      // The host refuses an arm without a real gesture.
      if (isSleep && action === 'arm' && refuseArm) {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: async () => ({ ok: false, error: 'human-gesture-required', ...refuseArm }),
        })
      }
      const body = isSleep
        ? (action === 'cancel'
          ? { ...(state.status || {}), phase: 'cancelled', armed: false }
          : (state.status || {}))
        : { ok: true, pendingRestart: false, choiceUrl: '/__dsh_autorestart/choice' }
      return Promise.resolve({ ok: true, status: 200, json: async () => body })
    },
    console,
    setTimeout,
    clearTimeout,
    // The shared poll: the callback is kept, so a test can deliver a new
    // status without waiting for the real 2s tick.
    setInterval: (fn) => { polls.push(fn); return polls.length },
    clearInterval: () => {},
    AbortController,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })

  const harness = createReactHarness()
  const module = definition.factory(() => harness.React)
  const dictionaries = {}
  const slots = new Map()
  module.apply({
    effect: (fn) => { fn(); return () => {} },
    locale: {
      register: (namespace, value) => { dictionaries[namespace] = value },
      bind: (namespace) => (key) => {
        const table = (dictionaries[namespace] || {})[language] || {}
        return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key
      },
    },
    slots: {
      inject: (name, thunk) => { slots.set(name, thunk) },
      register: (registration, Component) => ({ registration, Component }),
    },
  })
  const componentOf = (name) => {
    const thunk = slots.get(name)
    assert.ok(thunk, `the slot ${name} must be registered`)
    return thunk()
  }
  return {
    fetches,
    dictionaries,
    slots,
    reloads,
    setStatus: (next) => { state.status = next },
    // Deliver the new status the way the shared poll would.
    poll: async () => {
      for (const fn of polls) fn()
      await settleClient()
    },
    render: (name, props) => harness.render(componentOf(name).Component, props || {}),
    // Render, let the shared poll deliver the status, render again.
    settled: async (name, props) => {
      harness.render(componentOf(name).Component, props || {})
      await settleClient()
      return harness.render(componentOf(name).Component, props || {})
    },
  }
}

test('the countdown overlay comes back after a cancellation', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'countdown', showSleepButton: true, remainingMs: 8000, blockers: [] },
  })
  const first = await mounted.settled('shell.overlay')
  assert.ok(first, 'the countdown must be on screen')
  const cancel = walk(first).find(
    (node) => node.type === 'button' && textOf(node).includes('算了，别关'),
  )
  assert.ok(cancel, 'the countdown offers a cancel button')

  cancel.props.onClick()
  await settleClient()
  const posts = mounted.fetches.filter((call) => String(call.url).includes('/sleep') && call.init)
  assert.ok(posts.length >= 1, 'the cancel must reach the Host')
  assert.deepEqual(JSON.parse(posts[posts.length - 1].init.body), { action: 'cancel' })
  assert.equal(mounted.render('shell.overlay'), null, 'the overlay folds away once the Host confirms')

  // The NEXT countdown must show the overlay again: a cancellation may never
  // leave the layer folded away for good.
  mounted.setStatus({ ok: true, phase: 'countdown', showSleepButton: true, remainingMs: 8000, blockers: [] })
  await mounted.poll()
  const again = await mounted.settled('shell.overlay')
  assert.ok(again, 'the overlay must come back for the next countdown')
  assert.ok(textOf(again).includes('8'), 'the big number must be on screen again')
})

test('the second install question is reachable on its own', async () => {
  // The backup question was answered (on an earlier install), the shutdown
  // button question was not: the second question must still be asked.
  const storage = createStorage({ 'dsh-autorestart:backup-choice-v1': 'plugins' })
  const mounted = mountClient({ storage })
  const tree = await mounted.settled('conversation.input.dock')
  assert.ok(tree, 'the panel must be rendered')
  assert.equal(tree.props['data-dsh-autorestart-choice-step'], 'sleep', 'the second question must be the one on screen')
  assert.ok(walk(tree).some((node) => node.props && node.props['data-sleep-choice']), 'the sleep options must be there')
})

test('the button waits for the first poll before it appears', async () => {
  // The Host has not answered yet: the button must not flash.
  const mounted = mountClient({ status: { ok: true, phase: 'idle' } })
  assert.equal(mounted.render('sidebar.footer.action'), null, 'an unknown answer renders nothing')
  // The first poll has to arrive before the Host changes its mind.
  await settleClient()

  mounted.setStatus({ ok: true, phase: 'idle', showSleepButton: true })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  assert.ok(button, 'the button appears once the Host answered')
  assert.equal(button.type, 'button')

  mounted.setStatus({ ok: true, phase: 'idle', showSleepButton: false })
  await mounted.poll()
  assert.equal(
    await mounted.settled('sidebar.footer.action'),
    null,
    'a hidden button leaves no placeholder',
  )
})

test('the button lives at the foot of the sidebar, not in the conversation header', async () => {
  const mounted = mountClient({ status: { ok: true, phase: 'idle', showSleepButton: true } })
  await mounted.poll()

  // The new seat: the list slot at the foot of the left sidebar.
  assert.ok(
    mounted.slots.has('sidebar.footer.action'),
    'the button must be registered in sidebar.footer.action',
  )
  const registration = mounted.slots.get('sidebar.footer.action')().registration
  assert.equal(registration.name, 'sidebar.footer.action')
  assert.equal(registration.id, 'autorestart-sleep-button', 'the list slot needs its own id')
  assert.equal(typeof registration.order, 'number', 'the list slot needs an order')

  // The old seat is gone for good: nothing may register there any more.
  assert.equal(
    mounted.slots.has('conversation.header.leading'),
    false,
    'the button must not be registered in the conversation header any more',
  )
})

test('the collapsed sidebar shows the icon only, the wide one the label', async () => {
  const mounted = mountClient({ status: { ok: true, phase: 'idle', showSleepButton: true } })
  await mounted.poll()

  const wide = await mounted.settled('sidebar.footer.action', { wide: true })
  assert.ok(wide, 'the wide column shows the button')
  assert.ok(textOf(wide).includes('收工关机'), 'the wide column shows the label')
  assert.ok(!wide.props.className.includes('--rail'), 'the wide column is not the rail')
  assert.ok(wide.props.title, 'the button always has a title')
  assert.ok(wide.props['aria-label'], 'the button always has an aria-label')

  const rail = await mounted.settled('sidebar.footer.action', { wide: false })
  assert.ok(rail, 'the narrow rail shows the button too')
  assert.ok(!textOf(rail).includes('收工关机'), 'the narrow rail shows the icon only')
  assert.ok(rail.props.className.includes('--rail'), 'the narrow rail uses the rail style')
  assert.ok(rail.props.title, 'the rail button still has a title')
  assert.ok(rail.props['aria-label'], 'the rail button still has an aria-label')
})

test('the moon button is a toggle: an armed shutdown is cancelled by the same click', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'countdown', armed: true, showSleepButton: true, remainingMs: 8000, blockers: [] },
  })
  const button = await mounted.settled('sidebar.footer.action')
  assert.ok(button, 'the button must be rendered')
  assert.equal(button.props['data-armed'], 'true')
  button.props.onClick()
  await settleClient()
  const posts = mounted.fetches.filter((call) => String(call.url).includes('/sleep') && call.init)
  assert.ok(posts.length >= 1)
  assert.deepEqual(JSON.parse(posts[posts.length - 1].init.body), { action: 'cancel' }, 'an armed shutdown is cancelled')
})

test('the countdown is a floating card: it never covers the interface', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'countdown', showSleepButton: true, remainingMs: 8000, blockers: [] },
  })
  const card = await mounted.settled('shell.overlay')
  assert.ok(card, 'the countdown card must be on screen')

  // No full-screen mask: the card is a corner card, not a cover.
  assert.ok(
    !card.props.className.includes('mask'),
    'the countdown must not be a full-screen mask',
  )
  assert.equal(
    card.props.style && card.props.style.pointerEvents,
    'none',
    'the card lets every click through',
  )
  // Only the cancel button takes clicks.
  const cancel = walk(card).find((node) => node.type === 'button')
  assert.ok(cancel, 'the card still offers a way out')
  assert.equal(cancel.props.style && cancel.props.style.pointerEvents, 'auto')

  // The big number is still big: at least 72px.
  const number = walk(card).find((node) => String(node.props && node.props.className || '').includes('__number'))
  assert.ok(number, 'the big number must be on screen')
})

test('switching the conversation does not interrupt the countdown', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'countdown', showSleepButton: true, remainingMs: 20000, blockers: [] },
  })
  const first = await mounted.settled('shell.overlay')
  assert.ok(first, 'the countdown must be on screen')
  assert.ok(textOf(first).includes('20'), 'the countdown starts at 20 seconds')

  // A session switch re-renders the surfaces: the countdown keeps running.
  const again = mounted.render('shell.overlay')
  assert.ok(again, 'the countdown survives a re-render')
  assert.ok(textOf(again).includes('20'), 'the countdown is not reset by a re-render')
  assert.equal(
    again.props['data-dsh-autorestart-sleep-countdown'],
    'true',
    'the countdown card is still the countdown card',
  )
})

test('a countdown of zero seconds shows no card at all', async () => {
  // 0 means "no countdown": the machine goes off as soon as the gate opens,
  // so there is no number, no whale and no card.
  const mounted = mountClient({
    status: {
      ok: true,
      phase: 'countdown',
      showSleepButton: true,
      countdownSeconds: 0,
      remainingMs: 0,
      blockers: [],
    },
  })
  const card = await mounted.settled('shell.overlay')
  assert.equal(card, null, 'a countdown of zero seconds must not render a card')
})

test('the button title says how long the countdown lasts', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, countdownSeconds: 60, blockers: [] },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  assert.ok(button, 'the button must be rendered')
  assert.match(String(button.props.title), /60/, 'the title must carry the countdown length')
})

test('a real click sends the gesture ticket, a scripted one does not', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [] },
    ticket: { ticket: 'nonce.signature', issuedAt: Date.now() },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  assert.ok(button, 'the button must be rendered')
  assert.equal(typeof button.props.onPointerDown, 'function', 'the button must watch the pointer')

  // A scripted pointerdown (isTrusted === false) is not a gesture: nothing
  // is sent at all, because the host would refuse it anyway.
  button.props.onPointerDown({ isTrusted: false })
  button.props.onClick({ isTrusted: false })
  await settleClient()
  const scripted = mounted.fetches
    .filter((call) => String(call.url).includes('/sleep') && call.init && call.init.body)
    .find((call) => JSON.parse(call.init.body).action === 'arm')
  assert.equal(scripted, undefined, 'a scripted pointerdown must not arm anything')

  // A trusted pointerdown is a real gesture: the ticket goes with it.
  button.props.onPointerDown({ isTrusted: true })
  button.props.onClick({ isTrusted: true })
  await settleClient()
  const real = mounted.fetches
    .filter((call) => String(call.url).includes('/sleep') && call.init && call.init.body)
    .filter((call) => JSON.parse(call.init.body).action === 'arm')
    .pop()
  assert.ok(real, 'the click must reach the host')
  assert.equal(real.init.headers['x-dsh-sleep-ticket'], 'nonce.signature')
  assert.ok(real.init.headers['x-dsh-sleep-gesture'], 'the gesture timestamp must be sent')
})

/** The arm requests the client sent so far. */
function armRequests(mounted) {
  return mounted.fetches
    .filter((call) => String(call.url).includes('/sleep') && call.init && call.init.body)
    .filter((call) => JSON.parse(call.init.body).action === 'arm')
}

/** A client with a fresh ticket, waiting for a click. */
async function mountedWithTicket() {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [] },
    ticket: { ticket: 'nonce.signature', issuedAt: Date.now() },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  assert.ok(button, 'the button must be rendered')
  return { mounted, button }
}

test('a synthetic mousedown is not a gesture and arms nothing', async () => {
  const { mounted, button } = await mountedWithTicket()
  button.props.onMouseDown({ isTrusted: false })
  button.props.onClick({ isTrusted: false })
  await settleClient()
  assert.equal(armRequests(mounted).length, 0, 'a synthetic event must not arm anything')
})

test('a real mousedown arms the machine', async () => {
  const { mounted, button } = await mountedWithTicket()
  button.props.onMouseDown({ isTrusted: true })
  button.props.onClick({ isTrusted: true })
  await settleClient()
  const armed = armRequests(mounted).pop()
  assert.ok(armed, 'a real mousedown must reach the host')
  assert.equal(armed.init.headers['x-dsh-sleep-ticket'], 'nonce.signature')
  assert.ok(armed.init.headers['x-dsh-sleep-gesture'], 'the gesture timestamp must be sent')
})

test('a real touchstart arms the machine', async () => {
  const { mounted, button } = await mountedWithTicket()
  // A touch screen sends touchstart and no pointer event at all.
  button.props.onTouchStart({ isTrusted: true })
  button.props.onClick()
  await settleClient()
  const armed = armRequests(mounted).pop()
  assert.ok(armed, 'a real touchstart must reach the host')
  assert.equal(armed.init.headers['x-dsh-sleep-ticket'], 'nonce.signature')
  assert.ok(armed.init.headers['x-dsh-sleep-gesture'], 'the gesture timestamp must be sent')
})

test('a real click alone arms the machine', async () => {
  const { mounted, button } = await mountedWithTicket()
  // A driver that sends no pointer event at all still sends a trusted click.
  button.props.onClick({ isTrusted: true })
  await settleClient()
  const armed = armRequests(mounted).pop()
  assert.ok(armed, 'a real click must reach the host')
  assert.equal(armed.init.headers['x-dsh-sleep-ticket'], 'nonce.signature')
  assert.ok(armed.init.headers['x-dsh-sleep-gesture'], 'the gesture timestamp must be sent')
})

test('a page without a gesture ticket does not arm: it reloads itself and offers a refresh', async () => {
  // The page was opened before the plugin was updated: it has no ticket at
  // all. There is no HTTP route that hands one out, so the only way out is a
  // fresh page.
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [] },
    ticket: null,
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  button.props.onPointerDown({ isTrusted: true })
  button.props.onClick()
  await settleClient()

  const armed = mounted.fetches
    .filter((call) => String(call.url).includes('/sleep') && call.init && call.init.body)
    .filter((call) => JSON.parse(call.init.body).action === 'arm')
  assert.equal(armed.length, 0, 'without a ticket nothing may be armed')
  assert.equal(mounted.reloads.count, 1, 'the page reloads itself once')

  // The button offers the way out: a refresh the user can click. A reload
  // the user asked for always happens.
  const after = mounted.render('sidebar.footer.action')
  const shown = textOf(after)
  assert.ok(shown.includes('刷新'), `the refresh entry must be visible, got: ${shown}`)
  const refresh = walk(after).find((node) => node.type === 'button' && textOf(node).includes('刷新'))
  assert.ok(refresh, 'there must be a clickable refresh button')
  refresh.props.onClick()
  await settleClient()
  assert.equal(mounted.reloads.count, 2, 'the refresh the user asked for happens')
})

test('the page never reloads itself for ever', async () => {
  // The flag in sessionStorage survives the reload: the second attempt only
  // shows the refresh button.
  const sessionStorage = createStorage()
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [] },
    ticket: null,
    sessionStorage,
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')

  button.props.onPointerDown({ isTrusted: true })
  button.props.onClick()
  await settleClient()
  assert.equal(mounted.reloads.count, 1, 'the first click reloads the page')
  assert.equal(sessionStorage.getItem('dsh-autorestart-sleep-ticket-reload'), '1')

  // The reloaded page has no ticket either (the test keeps the same page).
  const again = mounted.render('sidebar.footer.action')
  const againButton = walk(again).find(
    (node) => node.props && node.props['data-dsh-autorestart-sleep-button'] === 'true',
  )
  assert.ok(againButton, 'the button must still be there')
  againButton.props.onPointerDown({ isTrusted: true })
  againButton.props.onClick()
  await settleClient()
  assert.equal(mounted.reloads.count, 1, 'the second click must not reload again')

  // The button still offers the refresh the user can click.
  const after = mounted.render('sidebar.footer.action')
  assert.ok(textOf(after).includes('刷新'), 'the refresh entry stays visible')
  const refresh = walk(after).find((node) => node.type === 'button' && textOf(node).includes('刷新'))
  assert.ok(refresh, 'the refresh button stays clickable')
  refresh.props.onClick()
  await settleClient()
  assert.equal(mounted.reloads.count, 2, 'a refresh the user asked for always happens')
})

test('a spent ticket is fixed by a fresh page', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [] },
    ticket: { ticket: 'nonce.signature', issuedAt: Date.now() },
    refuseArm: { reason: 'replayed-ticket', message: '这张手势票据已经用过了。' },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  button.props.onPointerDown({ isTrusted: true })
  button.props.onClick()
  await settleClient()

  assert.equal(mounted.reloads.count, 1, 'a spent ticket reloads the page once')
  const after = mounted.render('sidebar.footer.action')
  assert.ok(textOf(after).includes('刷新'), 'the refresh entry must be visible')
})

test('a refused request is shown, never silent', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [] },
    ticket: { ticket: 'nonce.signature', issuedAt: Date.now() },
    refuseArm: { reason: 'stale-gesture', message: '这次点击不是刚刚发生的真人手势，请在 3 秒内再点一次。' },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  button.props.onPointerDown({ isTrusted: true })
  button.props.onClick()
  await settleClient()

  const after = mounted.render('sidebar.footer.action')
  const shown = textOf(after)
  assert.ok(
    shown.includes('真人手势') || String(after.props.title || '').includes('真人手势'),
    `the refusal must be visible, got: ${shown} / ${after.props.title}`,
  )
  assert.equal(mounted.reloads.count, 0, 'a stale gesture is not fixed by a reload')
})
