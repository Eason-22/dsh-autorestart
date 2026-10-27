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

test('the controller is a DROPDOWN in the settings page', () => {
  // The settings page renders a select when the schema key is a union of
  // constants (the host projects it as an enum), not when it is a string.
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const declaration = /sleepController:\s*([^\n]*)\n/.exec(source)
  assert.ok(declaration, 'the schema must declare sleepController')
  assert.match(
    declaration[1],
    /schemastery\.union\(/,
    'the controller must be a union of constants (a dropdown), not a string field',
  )
  assert.match(declaration[1], /'human'/, 'the union must offer the human mode')
  assert.match(declaration[1], /'anyone'/, 'the union must offer the anyone mode')
  assert.match(declaration[1], /default\('human'\)/, 'the safe mode is the default')
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

test('the sleep route answers with exactly the agreed shape', async () => {
  const { file } = tempStateFile('shape')
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true })

  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('GET'), res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.deepEqual(Object.keys(payload).sort(), [
    'armed', 'blockers', 'controller', 'countdownSeconds', 'dryRun', 'host', 'lastRun', 'message', 'ok', 'phase', 'remainingMs', 'showSleepButton', 'ticketReady',
  ])
  assert.equal(payload.ok, true)
  assert.equal(payload.phase, 'idle')
  assert.equal(payload.armed, false)
  assert.equal(payload.showSleepButton, true)
  assert.equal(payload.controller, 'human', 'by default only the page may drive the shutdown')
  assert.equal(payload.ticketReady, false, 'a request without a ticket must be visible in the state')
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
  const { ctx, routes, timers } = createContext({ runningAgents: [busy] })
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, sleepController: 'anyone' })

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
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, sleepController: 'anyone' })

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
/* ------------------------------------------------------------------ *
 * The controller: 'human' (only the page) or 'anyone' (everybody).
 * ------------------------------------------------------------------ */

/**
 * The ticket the host injected into the served page.
 *
 * It travels in a `<meta>` tag, not in a script: the CSP of the host
 * (`script-src 'nonce-…'`) never runs an inline script without that
 * nonce, so a ticket in a script would never arrive.
 *
 * @param {Function[]} taps the index taps the plugin registered
 * @returns {{ ticket: string, issuedAt: number }}
 */
function ticketFromPage(taps) {
  const html = taps.map((fn) => fn('<html><head></head></html>')).join('')
  const match = /<meta name="dsh-autorestart-sleep-ticket" content="([^"]*)">/.exec(html)
  assert.ok(match, 'the page must carry a ticket')
  return JSON.parse(unescapeHtmlAttribute(match[1]))
}

/**
 * Undo the HTML escaping of an attribute value.
 *
 * @param {string} value
 * @returns {string}
 */
function unescapeHtmlAttribute(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

test('the page ticket travels in a META tag, not in a script (the CSP forbids inline scripts)', async () => {
  const { file } = tempStateFile('meta')
  const { ctx, routes, taps } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, sleepController: 'human' })

  const html = taps
    .map((fn) => fn('<html><head><title>DSH</title></head><body>app</body></html>'))
    .join('')

  // A <meta> is not script: the CSP (`script-src 'nonce-…'`) lets it through.
  assert.match(html, /<meta name="dsh-autorestart-sleep-ticket" content="[^"]+">/)
  assert.ok(
    !/<script[^>]*dsh-autorestart-sleep-ticket/.test(html),
    'the ticket must not be injected as an inline script',
  )
  assert.ok(!html.includes('__DSH_SLEEP_TICKET__'), 'the old window variable is not injected any more')

  // The tag sits before </head> …
  assert.ok(
    html.indexOf('dsh-autorestart-sleep-ticket') < html.indexOf('</head>'),
    'the meta tag belongs into the head',
  )
  // … and its content is a parseable JSON with the ticket.
  const grant = ticketFromPage(taps)
  assert.equal(typeof grant.ticket, 'string')
  assert.ok(grant.ticket.length > 0)
  assert.equal(typeof grant.issuedAt, 'number')

  // Idempotent: tapping the same document twice does not add a second tag.
  const ticketTap = taps[0]
  const twice = ticketTap(ticketTap('<html><head></head><body>app</body></html>'))
  assert.equal(
    twice.split('dsh-autorestart-sleep-ticket').length - 1,
    1,
    'the ticket tag must be injected only once',
  )
})

test('the client reads the ticket out of the META tag and arms with it', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [], controller: 'human' },
    meta: { ticket: 'nonce.signature', issuedAt: 1_700_000_000_000 },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  button.props.onClick()
  await settleClient()

  const arms = mounted.fetches
    .filter((call) => String(call.url).includes('/sleep') && call.init && call.init.body)
    .filter((call) => JSON.parse(call.init.body).action === 'arm')
  assert.equal(arms.length, 1, 'the click must arm the machine')
  assert.equal(arms[0].init.headers['x-dsh-sleep-ticket'], 'nonce.signature')
  assert.equal(mounted.reloads.count, 0, 'a page with a ticket never reloads')
})

test('the client still understands the old window variable', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [], controller: 'human' },
    ticket: { ticket: 'nonce.signature', issuedAt: Date.now() },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  button.props.onClick()
  await settleClient()

  const arms = mounted.fetches
    .filter((call) => String(call.url).includes('/sleep') && call.init && call.init.body)
    .filter((call) => JSON.parse(call.init.body).action === 'arm')
  assert.equal(arms.length, 1, 'the fallback must still work')
  assert.equal(arms[0].init.headers['x-dsh-sleep-ticket'], 'nonce.signature')
})

test('in the human mode a request without the page ticket is refused, and nothing changes', async () => {
  const { file } = tempStateFile('human-no-ticket')
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, sleepController: 'human' })

  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'arm' }), res)
  await settle()
  assert.equal(res.statusCode, 403)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false)
  assert.equal(payload.reason, 'no-ticket')
  assert.equal(payload.controller, 'human')
  assert.equal(typeof payload.message, 'string', 'the refusal must explain itself')

  // The state is untouched: nothing is armed, no countdown runs.
  const state = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('GET'), state)
  await settle()
  const status = JSON.parse(state.body)
  assert.equal(status.armed, false)
  assert.equal(status.phase, 'idle')
})

test('in the human mode the page ticket arms the machine — once', async () => {
  const { file } = tempStateFile('human-ticket')
  const { ctx, routes, taps } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, sleepController: 'human' })

  const grant = ticketFromPage(taps)
  const res = fakeResponse()
  sleepRoute(routes).handler(
    fakeRequest('POST', { action: 'arm' }, { 'x-dsh-sleep-ticket': grant.ticket }),
    res,
  )
  await settle()
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).armed, true)

  // The ticket is spent: the same one cannot drive a second request.
  const again = fakeResponse()
  sleepRoute(routes).handler(
    fakeRequest('POST', { action: 'cancel' }, { 'x-dsh-sleep-ticket': grant.ticket }),
    again,
  )
  await settle()
  assert.equal(again.statusCode, 403)
  assert.equal(JSON.parse(again.body).reason, 'replayed-ticket')
})

test('in the human mode a script can neither cancel a running countdown nor arm it', async () => {
  const { file } = tempStateFile('human-script')
  const { ctx, routes, taps } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, sleepController: 'human' })

  // The page arms it (with its ticket) …
  const grant = ticketFromPage(taps)
  sleepRoute(routes).handler(
    fakeRequest('POST', { action: 'arm' }, { 'x-dsh-sleep-ticket': grant.ticket }),
    fakeResponse(),
  )
  await settle()

  // … a script without a ticket cannot take it back.
  const cancel = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'cancel' }), cancel)
  await settle()
  assert.equal(cancel.statusCode, 403)
  assert.equal(JSON.parse(cancel.body).reason, 'no-ticket')

  // The countdown is still running.
  const state = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('GET'), state)
  await settle()
  const status = JSON.parse(state.body)
  assert.equal(status.armed, true, 'the countdown must not be cancelled by a script')
  assert.ok(status.phase === 'countdown' || status.phase === 'waiting')
})

test('in the anyone mode a bare request arms and cancels the machine', async () => {
  const { file } = tempStateFile('anyone')
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, sleepController: 'anyone' })

  // No header, no ticket: a script may drive it.
  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'arm' }), res)
  await settle()
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.armed, true)
  assert.equal(payload.controller, 'anyone')

  const cancel = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'cancel' }), cancel)
  await settle()
  assert.equal(cancel.statusCode, 200)
  assert.equal(JSON.parse(cancel.body).armed, false)
})

test('the state says whether the calling page holds a usable ticket — without spending it', async () => {
  const { file } = tempStateFile('ticket-ready')
  const { ctx, routes, taps } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, sleepController: 'human' })

  const grant = ticketFromPage(taps)
  const res = fakeResponse()
  sleepRoute(routes).handler(
    fakeRequest('GET', undefined, { 'x-dsh-sleep-ticket': grant.ticket }),
    res,
  )
  await settle()
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ticketReady, true, 'the page holds a ticket')
  assert.equal(payload.controller, 'human')

  // The check does not spend it: the ticket still arms the machine.
  const arm = fakeResponse()
  sleepRoute(routes).handler(
    fakeRequest('POST', { action: 'arm' }, { 'x-dsh-sleep-ticket': grant.ticket }),
    arm,
  )
  await settle()
  assert.equal(arm.statusCode, 200)
})

test('in the anyone mode a bare arm request arms the machine', async () => {
  const { file } = tempStateFile('bare-arm')
  const { ctx, routes } = createContext()
  apply(ctx, { stateFile: file, recoveryDelayMs: 0, enabled: true, sleepController: 'anyone' })

  // Nothing but the action: no headers, no ticket, no ceremony.
  const res = fakeResponse()
  sleepRoute(routes).handler(fakeRequest('POST', { action: 'arm' }), res)
  await settle()
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.armed, true, 'a plain request arms the machine')
  assert.ok(
    payload.phase === 'countdown' || payload.phase === 'waiting',
    `the machine must be armed, got: ${payload.phase}`,
  )
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
 * @param {{ status?: object, storage?: object, language?: string, ticket?: object, meta?: object, refuseArm?: object, sessionStorage?: object, fakeTimers?: boolean }} options
 */
function mountClient({
  status = null,
  storage = createStorage(),
  language = 'zh',
  ticket = null,
  meta = null,
  refuseArm = null,
  sessionStorage = createStorage(),
  fakeTimers = false,
} = {}) {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let definition = null
  const fetches = []
  const polls = []
  const state = { status }
  // How often the page reloaded itself (the button must never do that).
  const reloads = { count: 0 }
  // The timers the client scheduled (only with `fakeTimers`): a test fires
  // them by hand instead of waiting for the real clock.
  const timers = []
  let timerId = 0
  const fakeSetTimeout = (fn, ms) => {
    timerId += 1
    timers.push({ id: timerId, fn, ms })
    return timerId
  }
  const fakeClearTimeout = (id) => {
    const index = timers.findIndex((entry) => entry.id === id)
    if (index !== -1) timers.splice(index, 1)
  }
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (value) => { definition = value } },
      localStorage: storage,
      sessionStorage,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { reload: () => { reloads.count += 1 } },
      // The one-time ticket the host injected into this page.
      __DSH_SLEEP_TICKET__: ticket,
    },
    document: {
      getElementById: () => null,
      createElement: (tag) => ({ tag, id: '', textContent: '', parentNode: null, setAttribute: () => {}, appendChild: () => {} }),
      head: { appendChild: (node) => { node.parentNode = sandbox.document.head; return node }, removeChild: () => {} },
      // The ticket the host injected into the page: the real host puts it
      // into a <meta> tag (the CSP would never run an inline script).
      querySelector: (selector) => {
        if (meta === null) return null
        if (selector !== 'meta[name="dsh-autorestart-sleep-ticket"]') return null
        const content = typeof meta === 'string' ? meta : JSON.stringify(meta)
        return { getAttribute: (name) => (name === 'content' ? content : null) }
      },
    },
    fetch: (url, init) => {
      fetches.push({ url: String(url), init })
      const action = init && init.body ? JSON.parse(init.body).action : null
      const isSleep = String(url).includes('/sleep')
      // The host refuses the request (a failure the user must see).
      if (isSleep && action && refuseArm && (!refuseArm.action || refuseArm.action === action)) {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: async () => ({ ok: false, error: 'page-ticket-required', ...refuseArm }),
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
    setTimeout: fakeTimers ? fakeSetTimeout : setTimeout,
    clearTimeout: fakeTimers ? fakeClearTimeout : clearTimeout,
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
    timers,
    sessionStorage,
    // Fire every timer the client scheduled with this delay.
    fireTimers: (ms) => {
      const due = timers.filter((entry) => entry.ms === ms)
      timers.length = 0
      for (const entry of due) entry.fn()
      return due.length
    },
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
    status: { ok: true, phase: 'countdown', showSleepButton: true, remainingMs: 8000, blockers: [], controller: 'anyone' },
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
    status: { ok: true, phase: 'countdown', armed: true, showSleepButton: true, remainingMs: 8000, blockers: [], controller: 'anyone' },
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

test('in the anyone mode one click arms the machine: one request, no reload', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [], controller: 'anyone' },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  assert.ok(button, 'the button must be rendered')

  button.props.onClick()
  await settleClient()

  const arms = mounted.fetches
    .filter((call) => String(call.url).includes('/sleep') && call.init && call.init.body)
    .filter((call) => JSON.parse(call.init.body).action === 'arm')
  assert.equal(arms.length, 1, 'one click must send exactly one arm request')
  // Nobody needs a ticket in this mode.
  assert.deepEqual(
    Object.keys(arms[0].init.headers).filter((key) => key.startsWith('x-dsh-')),
    [],
    'the request must not carry any custom header',
  )
  assert.equal(mounted.reloads.count, 0, 'the button must never reload the page')
})

test('in the human mode the click sends the page ticket', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [], controller: 'human' },
    ticket: { ticket: 'nonce.signature', issuedAt: Date.now() },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  button.props.onClick()
  await settleClient()

  const arms = mounted.fetches
    .filter((call) => String(call.url).includes('/sleep') && call.init && call.init.body)
    .filter((call) => JSON.parse(call.init.body).action === 'arm')
  assert.equal(arms.length, 1, 'one click must send exactly one arm request')
  assert.equal(arms[0].init.headers['x-dsh-sleep-ticket'], 'nonce.signature')
  assert.equal(mounted.reloads.count, 0, 'a page with a ticket never reloads')
})

test('a click without a ticket writes the intent and reloads the page once', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [], controller: 'human' },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  button.props.onClick()
  await settleClient()

  assert.equal(mounted.reloads.count, 1, 'the page reloads itself once')
  assert.equal(
    mounted.sessionStorage.getItem('dsh-autorestart-pending-arm'),
    '1',
    'the intent is remembered for the new page',
  )
  const arms = mounted.fetches
    .filter((call) => String(call.url).includes('/sleep') && call.init && call.init.body)
    .filter((call) => JSON.parse(call.init.body).action === 'arm')
  assert.equal(arms.length, 0, 'nothing is armed before the page has a ticket')
})

test('the reloaded page carries the intent out: the user clicked ONCE', async () => {
  const storage = createStorage({ 'dsh-autorestart-pending-arm': '1' })
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [], controller: 'human' },
    ticket: { ticket: 'nonce.signature', issuedAt: Date.now() },
    sessionStorage: storage,
  })
  await settleClient()

  const arms = mounted.fetches
    .filter((call) => String(call.url).includes('/sleep') && call.init && call.init.body)
    .filter((call) => JSON.parse(call.init.body).action === 'arm')
  assert.equal(arms.length, 1, 'the new page arms the machine by itself')
  assert.equal(arms[0].init.headers['x-dsh-sleep-ticket'], 'nonce.signature')
  assert.equal(
    storage.getItem('dsh-autorestart-pending-arm'),
    null,
    'the intent is cleared: it can happen only once',
  )
})

test('a cancel that could not be carried out is remembered as a cancel', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'countdown', armed: true, showSleepButton: true, blockers: [], controller: 'human' },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  button.props.onClick()
  await settleClient()

  assert.equal(mounted.reloads.count, 1, 'the page reloads itself once')
  assert.equal(
    mounted.sessionStorage.getItem('dsh-autorestart-pending-cancel'),
    '1',
    'the cancel is remembered for the new page',
  )
})

test('after the reload there is still no ticket: the hint appears, nothing else happens', async () => {
  const storage = createStorage({
    'dsh-autorestart-pending-arm': '1',
    'dsh-autorestart-reloaded': '1',
  })
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [], controller: 'human' },
    sessionStorage: storage,
  })
  await settleClient()

  const arms = mounted.fetches
    .filter((call) => String(call.url).includes('/sleep') && call.init && call.init.body)
    .filter((call) => JSON.parse(call.init.body).action === 'arm')
  assert.equal(arms.length, 0, 'nothing is armed without a ticket')
  assert.equal(mounted.reloads.count, 0, 'the page must not reload for ever')

  const after = await mounted.settled('sidebar.footer.action')
  assert.ok(
    textOf(after).includes('点一下会自动刷新一次'),
    `the hint must be visible, got: ${textOf(after)}`,
  )
})

test('a spent ticket makes the next click reload the page instead of failing', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'countdown', armed: true, showSleepButton: true, blockers: [], controller: 'human' },
    ticket: { ticket: 'nonce.signature', issuedAt: Date.now() },
    refuseArm: { reason: 'replayed-ticket', message: '这张页面票据已经用过了。', action: 'cancel' },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  button.props.onClick()
  await settleClient()

  assert.equal(mounted.reloads.count, 1, 'the page reloads itself to get a fresh ticket')
  assert.equal(
    mounted.sessionStorage.getItem('dsh-autorestart-pending-cancel'),
    '1',
    'the cancel is remembered for the new page',
  )
})

test('a refused request is shown, never silent', async () => {
  const mounted = mountClient({
    status: { ok: true, phase: 'idle', showSleepButton: true, blockers: [], controller: 'anyone' },
    refuseArm: { reason: 'not-armed', message: '关机命令没能启动。' },
  })
  await mounted.poll()
  const button = await mounted.settled('sidebar.footer.action')
  button.props.onClick()
  await settleClient()

  const after = mounted.render('sidebar.footer.action')
  const shown = textOf(after)
  assert.ok(
    shown.includes('没能启动') || String(after.props.title || '').includes('没能启动'),
    `the refusal must be visible, got: ${shown} / ${after.props.title}`,
  )
  assert.equal(mounted.reloads.count, 0, 'a failure never reloads the page')
})

/* ------------------------------------------------------------------ *
 * The rehearsal (dry run): the user must see what WOULD have run.
 * ------------------------------------------------------------------ */

/** A status that reports a finished rehearsal. */
function rehearsalStatus(extra = {}) {
  return {
    ok: true,
    phase: 'idle',
    showSleepButton: true,
    blockers: [],
    lastRun: {
      at: '2026-01-01T00:00:00.000Z',
      command: 'shutdown.exe',
      args: ['/s', '/f', '/t', '0'],
      executed: false,
      dryRun: true,
      error: null,
      ...extra,
    },
  }
}

test('a finished rehearsal says what it WOULD have run', async () => {
  const mounted = mountClient({ status: rehearsalStatus(), fakeTimers: true })
  await mounted.poll()
  await mounted.settled('shell.overlay')
  const notice = mounted.render('shell.overlay')
  assert.ok(notice, 'the rehearsal must leave a note')
  const shown = textOf(notice)
  assert.ok(shown.includes('试运行'), `the note must say what it is, got: ${shown}`)
  assert.ok(shown.includes('shutdown.exe'), 'the command must be shown')
  assert.ok(shown.includes('/s'), 'the arguments must be shown')
  assert.equal(notice.props.style.pointerEvents, 'none', 'the note must never eat a click')
})

test('the note of a rehearsal can be closed', async () => {
  const mounted = mountClient({ status: rehearsalStatus(), fakeTimers: true })
  await mounted.poll()
  await mounted.settled('shell.overlay')
  const notice = mounted.render('shell.overlay')
  const close = walk(notice).find((node) => node.type === 'button' && textOf(node).includes('知道了'))
  assert.ok(close, 'the note must offer a close button')
  close.props.onClick()
  await settleClient()
  assert.equal(mounted.render('shell.overlay'), null, 'the note must be gone')
})

test('the note of a rehearsal goes away after eight seconds', async () => {
  const mounted = mountClient({ status: rehearsalStatus(), fakeTimers: true })
  await mounted.poll()
  await mounted.settled('shell.overlay')
  assert.ok(mounted.render('shell.overlay'), 'the note must be on screen')
  assert.equal(mounted.fireTimers(8000), 1, 'the note must disappear after eight seconds')
  assert.equal(mounted.render('shell.overlay'), null, 'the note must be gone')
})

test('a real failure is never reported as a rehearsal', async () => {
  const mounted = mountClient({
    status: rehearsalStatus({ dryRun: undefined, executed: false, error: 'spawn-failed' }),
    fakeTimers: true,
  })
  await mounted.poll()
  await mounted.settled('shell.overlay')
  assert.equal(mounted.render('shell.overlay'), null, 'a failure must not leave a note')
})
