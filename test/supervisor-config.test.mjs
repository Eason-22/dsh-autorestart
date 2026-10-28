/**
 * E (the derivation of a start command) and B (the dry run).
 *
 * The derivation must NEVER guess. A wrong command is worse than no command:
 * it looks like a restart and leaves the user with a dead host. So every
 * refusal has a code and a meaning, and every refusal points at the way out
 * (the supervisor, or the app mode).
 *
 * The module is pure: the tests feed it the facts of a machine instead of
 * probing the one they run on.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDryRunPlan,
  composeRestartFragment,
  DERIVE_MODES,
  DERIVE_REASONS,
  deriveStartCommand,
  detectContainer,
  detectExternalSupervisor,
  formatCommand,
  gracefulExitCommand,
  pickFreePort,
  quoteArgument,
  readPortArgument,
  readProcessCommandLine,
} from '../lib/supervisor-config.js'

/** The facts of a hosted host that was started from a plain shell. */
function hostedFacts(overrides = {}) {
  return {
    execPath: '/usr/bin/node',
    execArgv: [],
    argv: ['/usr/bin/node', '/home/fg/.npm-global/bin/dsh', 'web', '--port', '5601', '--no-open'],
    cwd: '/home/fg',
    platform: 'linux',
    env: {},
    pid: 4242,
    isDesktopApp: false,
    webPort: 5601,
    supervised: false,
    externalSupervisor: null,
    container: false,
    hasInit: true,
    fixedPort: 0,
    healthPath: '/__dsh_autorestart/health',
    ...overrides,
  }
}

test('the derivation restores the command line of the running host', () => {
  const result = deriveStartCommand(hostedFacts())
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.level, 'E3')
  assert.equal(result.mode, DERIVE_MODES.REPLAY)
  assert.equal(result.reason, DERIVE_REASONS.OK)
  assert.deepEqual(
    result.argv,
    ['/usr/bin/node', '/home/fg/.npm-global/bin/dsh', 'web', '--port', '5601', '--no-open'],
    'the command line is replayable AS IT IS',
  )
  assert.equal(result.command, '/usr/bin/node /home/fg/.npm-global/bin/dsh web --port 5601 --no-open')
  assert.equal(result.cwd, '/home/fg')
  assert.equal(result.port, 5601)
  assert.equal(result.portFixed, false, 'the port was already fixed in the command line')
  assert.equal(result.healthUrl, 'http://127.0.0.1:5601/__dsh_autorestart/health')
  assert.equal(result.needsConfirmation, true, 'the command is only written after the user confirmed it')
  assert.deepEqual(result.writes, {
    restartMode: 'command',
    restartCommand: '/usr/bin/node /home/fg/.npm-global/bin/dsh web --port 5601 --no-open',
  })
})

test('the interpreter arguments are part of the derived command', () => {
  const result = deriveStartCommand(hostedFacts({
    execArgv: ['--max-old-space-size=4096'],
  }))
  assert.deepEqual(result.argv.slice(0, 2), ['/usr/bin/node', '--max-old-space-size=4096'])
  assert.ok(result.command.includes('--max-old-space-size=4096'))
})

test('the DESKTOP app refuses the derivation and points at the app mode', () => {
  const result = deriveStartCommand(hostedFacts({
    isDesktopApp: true,
    execPath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    argv: ['C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'],
    webPort: 0,
  }))
  assert.equal(result.ok, false)
  assert.equal(result.reason, DERIVE_REASONS.DESKTOP_APP)
  assert.equal(result.mode, DERIVE_MODES.REFUSED)
  assert.equal(result.command, null, 'no command is derived for the desktop app')
  assert.deepEqual(result.alternatives, ['app-mode'], 'the app mode is the way out')
  assert.equal(result.writes, null, 'nothing is written')
})

test('a host without a web server is refused', () => {
  const result = deriveStartCommand(hostedFacts({ webPort: 0 }))
  assert.equal(result.ok, false)
  assert.equal(result.reason, DERIVE_REASONS.NOT_A_WEB_HOST)
})

test('an EXTERNAL supervisor means: exit gracefully, let IT start us again', () => {
  const result = deriveStartCommand(hostedFacts({
    externalSupervisor: { kind: 'systemd', evidence: 'env:INVOCATION_ID', commandLine: '' },
  }))
  assert.equal(result.ok, true)
  assert.equal(result.level, 'E1')
  assert.equal(result.mode, DERIVE_MODES.GRACEFUL_EXIT)
  assert.equal(result.reason, DERIVE_REASONS.EXTERNAL_SUPERVISOR)
  // NOT a self-replay command: that would start a SECOND host next to the one
  // the supervisor starts.
  assert.equal(result.writes.restartCommand, 'kill -TERM 4242')
  assert.equal(result.writes.restartMode, 'command')
  assert.equal(
    result.command.includes('/home/fg/.npm-global/bin/dsh'),
    false,
    'the replay command is NOT written when somebody else is the supervisor',
  )
  assert.ok(result.plan.some((line) => line.value.includes('systemd')), 'the plan says who is in charge')
})

test('the graceful exit command is a TERM, not a KILL, and it is platform specific', () => {
  assert.equal(gracefulExitCommand({ pid: 42, platform: 'linux' }), 'kill -TERM 42')
  assert.equal(gracefulExitCommand({ pid: 42, platform: 'darwin' }), 'kill -TERM 42')
  assert.equal(gracefulExitCommand({ pid: 42, platform: 'win32' }), 'taskkill /PID 42')
})

test('a CONTAINER refuses the promise of an automatic start and points at the orchestrator', () => {
  const result = deriveStartCommand(hostedFacts({ container: true, hasInit: false }))
  assert.equal(result.ok, true, 'the command is still derived')
  assert.equal(result.level, 'E2')
  assert.equal(result.reason, DERIVE_REASONS.CONTAINER_NO_INIT)
  assert.ok(result.alternatives.includes('install-supervisor'), 'the way out is offered')
  assert.ok(result.alternatives.includes('orchestrator-fragment'))
  assert.ok(result.command.length > 0, 'the command is handed out for the orchestrator')
  assert.ok(result.plan.length >= 3, 'the dry run shows the command, the port and the health URL')
})

test('a RANDOM port is fixed, or the derivation is refused', () => {
  const random = deriveStartCommand(hostedFacts({
    argv: ['/usr/bin/node', '/home/fg/.npm-global/bin/dsh', 'web', '--port', '0', '--no-open'],
    webPort: 51234,
  }))
  assert.equal(random.ok, false, 'without a fixed port there is no way to keep the browser logged in')
  assert.equal(random.reason, DERIVE_REASONS.PORT_NOT_FIXABLE)

  const fixed = deriveStartCommand(hostedFacts({
    argv: ['/usr/bin/node', '/home/fg/.npm-global/bin/dsh', 'web', '--port', '0', '--no-open'],
    webPort: 51234,
    fixedPort: 51234,
  }))
  assert.equal(fixed.ok, true)
  assert.equal(fixed.port, 51234)
  assert.equal(fixed.portFixed, true, 'the port was fixed by the plugin')
  assert.ok(fixed.command.endsWith('--port 51234'), 'the fixed port is written into the command')
  assert.equal(fixed.healthUrl, 'http://127.0.0.1:51234/__dsh_autorestart/health')
})

test('a command line that cannot be read back is refused', () => {
  const result = deriveStartCommand(hostedFacts({
    argv: ['/usr/bin/node'],
  }))
  assert.equal(result.ok, false)
  assert.equal(result.reason, DERIVE_REASONS.ARGV_UNAVAILABLE)
  assert.ok(result.alternatives.includes('install-supervisor'))
})

test('OUR OWN supervisor means: no card at all, the restart is asked of it', () => {
  const result = deriveStartCommand(hostedFacts({ supervised: true }))
  assert.equal(result.ok, true)
  assert.equal(result.level, 'E0')
  assert.equal(result.mode, DERIVE_MODES.SUPERVISED)
  assert.equal(result.reason, DERIVE_REASONS.SUPERVISED)
  assert.equal(result.needsConfirmation, false, 'nothing has to be confirmed')
  assert.equal(result.writes, null, 'no command is written')
})

test('the external supervisor is found in the environment and in the parent process', () => {
  assert.deepEqual(
    detectExternalSupervisor({ env: { INVOCATION_ID: 'abc' }, platform: 'linux' }),
    { kind: 'systemd', evidence: 'env:INVOCATION_ID', commandLine: '' },
  )
  assert.equal(detectExternalSupervisor({ env: { pm_id: '3' }, platform: 'linux' }).kind, 'pm2')
  assert.equal(detectExternalSupervisor({ env: {}, platform: 'linux' }), null, 'a bare shell has no supervisor')
  // The parent process: a script that supervises the host.
  const script = detectExternalSupervisor({
    env: {},
    platform: 'linux',
    ppid: 99,
    readFileSync: () => '/bin/bash\x00/home/fg/supervise-web.sh\x00',
  })
  assert.equal(script.kind, 'script')
  assert.equal(script.evidence, 'parent:99')
  assert.ok(script.commandLine.includes('supervise-web.sh'))
  // systemd as the parent.
  const systemd = detectExternalSupervisor({
    env: {},
    platform: 'linux',
    ppid: 98,
    readFileSync: () => '/lib/systemd/systemd\x00--user\x00',
  })
  assert.equal(systemd.kind, 'systemd')
  // Windows has no /proc: the env markers are all there is.
  assert.equal(detectExternalSupervisor({ env: {}, platform: 'win32' }), null)
})

test('the command line of a process is read from /proc', () => {
  const text = readProcessCommandLine(77, {
    readFileSync: () => '/bin/sh\x00-c\x00dsh web\x00',
  })
  assert.equal(text, '/bin/sh -c dsh web')
  assert.equal(readProcessCommandLine(0, { readFileSync: () => { throw new Error('nope') } }), '')
})

test('a container is detected from the filesystem and from the environment', () => {
  assert.equal(detectContainer({ existsSyncFn: () => false, env: {} }).container, false)
  assert.equal(detectContainer({ existsSyncFn: (p) => p === '/.dockerenv', env: {} }).container, true)
  assert.equal(detectContainer({ existsSyncFn: () => false, env: { container: '1' } }).container, true)
  assert.equal(detectContainer({ existsSyncFn: () => false, env: { KUBERNETES_SERVICE_HOST: '1' } }).container, true)
})

test('the port of a command line is read in both spellings', () => {
  assert.deepEqual(readPortArgument(['dsh', 'web', '--port', '5601']), { present: true, value: 5601 })
  assert.deepEqual(readPortArgument(['dsh', 'web', '--port=5601']), { present: true, value: 5601 })
  assert.deepEqual(readPortArgument(['dsh', 'web', '--port', '0']), { present: true, value: 0 })
  assert.deepEqual(readPortArgument(['dsh', 'web']), { present: false, value: null })
})

test('a command line is quoted for the shell', () => {
  assert.equal(quoteArgument('/usr/bin/node'), '/usr/bin/node')
  assert.equal(quoteArgument('C:\\Program Files\\node.exe'), '"C:\\Program Files\\node.exe"')
  assert.equal(formatCommand(['node', 'a b', 'c']), 'node "a b" c')
})

test('the dry run shows the plan and writes nothing', () => {
  const derivation = deriveStartCommand(hostedFacts())
  const plan = buildDryRunPlan(derivation)
  assert.equal(plan.ok, true)
  assert.equal(plan.needsConfirmation, true)
  assert.equal(plan.command, derivation.command)
  assert.deepEqual(plan.writes, derivation.writes)
  // The plan says WHAT would be done: the command, the working directory, the
  // port and the health URL.
  const labels = plan.plan.map((line) => line.label)
  assert.deepEqual(labels, ['command', 'cwd', 'port', 'health'])
  assert.equal(plan.plan.find((line) => line.label === 'health').value, 'http://127.0.0.1:5601/__dsh_autorestart/health')
})

test('the compose fragment carries the command for a container', () => {
  const fragment = composeRestartFragment(['node', '/app/dsh.js', 'web'])
  assert.ok(fragment.includes('restart: always'))
  assert.ok(fragment.includes('"/app/dsh.js"'), 'the path stays one argument')
})

test('a free port can be picked', async () => {
  const port = await pickFreePort()
  assert.ok(Number.isInteger(port), 'a port was picked')
  assert.ok(port > 0, 'the port is a real one')
})
