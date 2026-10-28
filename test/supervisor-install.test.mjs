/**
 * The platform "start at login" records of the supervisor.
 *
 * NOTHING here touches the machine: the module only GENERATES commands and
 * unit files, and the tests check the generated text. The installation itself
 * is driven through a fake executor, so no scheduled task and no systemd unit
 * is ever created on the machine that runs the tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildInstallSteps,
  buildUninstallSteps,
  composeFragment,
  detectInitSystems,
  runCommand,
  SUPERVISOR_TASK_NAME,
  systemdArgs,
  systemdSystemUnitContent,
  systemdUserUnitContent,
  systemdUserUnitPath,
  windowsStartupCmdContent,
  windowsStartupCmdPath,
  windowsTaskCreateArgs,
  windowsTaskDeleteArgs,
  windowsTaskQueryArgs,
} from '../lib/supervisor-install.js'

const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const SUPERVISOR = 'C:\\state\\dsh-autorestart\\supervisor\\supervisor.js'
const CONFIG = 'C:\\state\\dsh-autorestart\\supervisor\\supervisor.json'

/**
 * A fake executor: it records every call and answers by rule.
 *
 * @param {Record<string, unknown>} [rules]
 */
function fakeExec(rules = {}) {
  const calls = []
  const fn = (file, args) => {
    const entry = { file, args: Array.isArray(args) ? args.map(String) : args }
    calls.push(entry)
    const key = file + ' ' + entry.args.join(' ')
    let rule = rules[key]
    if (rule === undefined) rule = rules[entry.args.join(' ')]
    if (rule === undefined) rule = rules[file]
    if (rule === undefined) rule = rules.default
    if (rule === 'fail') {
      const error = new Error('access is denied')
      error.status = 1
      error.stderr = 'ERROR: Access is denied.'
      throw error
    }
    if (rule instanceof Error) throw rule
    if (typeof rule === 'function') return rule(entry)
    return ''
  }
  fn.calls = calls
  return fn
}

test('the Windows task starts the supervisor at login, without administrator rights', () => {
  const args = windowsTaskCreateArgs({ nodePath: NODE, supervisorPath: SUPERVISOR, configPath: CONFIG })
  assert.deepEqual(args, [
    '/Create',
    '/TN', SUPERVISOR_TASK_NAME,
    '/SC', 'ONLOGON',
    '/TR', `"${NODE}" "${SUPERVISOR}" --config "${CONFIG}"`,
    '/RL', 'LIMITED',
    '/F',
  ])
  // The three flags that would break it on an ordinary machine.
  assert.equal(args.includes('/ru'), false, 'no /ru: the task runs as the current user')
  assert.equal(args.includes('/NP'), false, 'no /NP: that needs the "log on as batch job" right')
  assert.equal(args.includes('/IT'), false, 'no /IT: the host is a headless service')
  assert.equal(args.includes('/F'), true, '/F: installing twice must not fail')
  assert.equal(args.includes('ONLOGON'), true, 'login, not boot (a boot task would need SYSTEM)')
})

test('the scheduled task can be queried and deleted by the same name', () => {
  assert.deepEqual(windowsTaskQueryArgs(), ['/Query', '/TN', SUPERVISOR_TASK_NAME])
  assert.deepEqual(windowsTaskDeleteArgs(), ['/Delete', '/TN', SUPERVISOR_TASK_NAME, '/F'])
})

test('the startup folder fallback is one .cmd that starts the supervisor', () => {
  const file = windowsStartupCmdPath({ startupDir: 'C:\\Users\\x\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup' })
  assert.equal(file.endsWith(SUPERVISOR_TASK_NAME + '.cmd'), true)
  const content = windowsStartupCmdContent({ nodePath: NODE, supervisorPath: SUPERVISOR, configPath: CONFIG })
  assert.equal(content.includes('@echo off'), true)
  assert.equal(content.includes('start ""'), true, 'the console closes right away')
  assert.equal(content.includes(`"${NODE}" "${SUPERVISOR}" --config "${CONFIG}"`), true)
})

test('the systemd user unit carries the settings that matter', () => {
  const unit = systemdUserUnitContent({ nodePath: '/usr/bin/node', supervisorPath: '/state/supervisor.js', configPath: '/state/supervisor.json' })
  // StartLimit* belongs to the Unit section (systemd.unit(5)), NOT to Service.
  const sections = {}
  let current = ''
  for (const line of unit.split('\n')) {
    if (line.startsWith('[') && line.endsWith(']')) {
      current = line.slice(1, -1)
      sections[current] = []
      continue
    }
    if (current !== '') sections[current].push(line)
  }
  const unitSection = sections.Unit.join('\n')
  const serviceSection = sections.Service.join('\n')
  assert.ok(unitSection.includes('StartLimitIntervalSec=60'))
  assert.ok(unitSection.includes('StartLimitBurst=5'))
  assert.equal(serviceSection.includes('StartLimit'), false, 'StartLimit* must not be in the Service section')
  assert.ok(serviceSection.includes('Type=exec'), 'Type=exec reports a failed start')
  assert.ok(serviceSection.includes('Restart=always'))
  assert.ok(serviceSection.includes('RestartSec=3'), 'the default of 100ms is too dense')
  assert.ok(serviceSection.includes('Environment=DSH_AUTORESTART_SUPERVISED=1'))
  assert.ok(serviceSection.includes('KillSignal=SIGTERM'))
  assert.ok(serviceSection.includes('TimeoutStopSec=30'))
  assert.ok(serviceSection.includes('ExecStart="/usr/bin/node" "/state/supervisor.js" --config "/state/supervisor.json"'))
  assert.ok(unit.includes('WantedBy=default.target'))
})

test('the systemd system unit runs as the user, not as root', () => {
  const unit = systemdSystemUnitContent({
    nodePath: '/usr/bin/node',
    supervisorPath: '/state/supervisor.js',
    configPath: '/state/supervisor.json',
    user: 'fg',
    homeDir: '/home/fg',
  })
  assert.ok(unit.includes('User=fg'), 'without User= the host would read ROOTs home directory')
  assert.ok(unit.includes('Environment=HOME=/home/fg'))
  assert.ok(unit.includes('WantedBy=multi-user.target'))
})

test('the systemd unit path lives in the home directory of the user', () => {
  const file = systemdUserUnitPath({ homeDir: '/home/fg' })
  assert.equal(file, '/home/fg/.config/systemd/user/' + SUPERVISOR_TASK_NAME + '.service')
})

test('the systemd commands are the user ones by default', () => {
  const args = systemdArgs()
  assert.deepEqual(args.daemonReload, ['systemctl', '--user', 'daemon-reload'])
  assert.deepEqual(args.enable, ['systemctl', '--user', 'enable', '--now', SUPERVISOR_TASK_NAME + '.service'])
  assert.deepEqual(args.disable, ['systemctl', '--user', 'disable', '--now', SUPERVISOR_TASK_NAME + '.service'])
  const system = systemdArgs({ system: true })
  assert.deepEqual(system.enable[1], '--system')
})

test('a machine without a service manager is reported as such', () => {
  const detected = detectInitSystems({
    platform: 'linux',
    homeDir: '/home/fg',
    existsSyncFn: (target) => target === '/.dockerenv',
    execFileSyncFn: fakeExec(),
  })
  assert.equal(detected.systemdUser, false)
  assert.equal(detected.container, true, 'no /run/systemd/system means a container')
  assert.match(detected.reason, /no system service manager/)
})

test('a machine with a user manager is reported as usable', () => {
  const detected = detectInitSystems({
    platform: 'linux',
    homeDir: '/home/fg',
    existsSyncFn: (target) => target === '/run/systemd/system',
    execFileSyncFn: fakeExec({ default: 'running' }),
  })
  assert.equal(detected.systemdUser, true)
  assert.equal(detected.container, false)
})

test('the install steps of Windows are the task first and the startup folder second', () => {
  const steps = buildInstallSteps({
    platform: 'win32',
    nodePath: NODE,
    supervisorPath: SUPERVISOR,
    configPath: CONFIG,
    startupDir: 'C:\\Startup',
  })
  assert.equal(steps.length, 2)
  assert.equal(steps[0].kind, 'windows-schtasks')
  assert.equal(steps[0].file, 'schtasks')
  assert.equal(steps[1].kind, 'windows-startup')
  assert.ok(steps[1].path.endsWith('.cmd'))
})

test('the install steps of Linux write the unit, reload and enable it', () => {
  const steps = buildInstallSteps({
    platform: 'linux',
    nodePath: '/usr/bin/node',
    supervisorPath: '/state/supervisor.js',
    configPath: '/state/supervisor.json',
    homeDir: '/home/fg',
  })
  assert.deepEqual(steps.map((step) => step.kind), ['systemd-user', 'daemon-reload', 'enable', 'verify'])
  assert.equal(steps[0].path, '/home/fg/.config/systemd/user/' + SUPERVISOR_TASK_NAME + '.service')
})

test('the uninstall steps take the record away again', () => {
  const windows = buildUninstallSteps({ platform: 'win32' })
  assert.deepEqual(windows.map((step) => step.kind), ['windows-schtasks'])
  assert.deepEqual(windows[0].args, windowsTaskDeleteArgs())
  const linux = buildUninstallSteps({ platform: 'linux', homeDir: '/home/fg' })
  assert.deepEqual(linux.map((step) => step.kind), ['disable', 'unit-file', 'daemon-reload'])
  const startup = buildUninstallSteps({ platform: 'win32', kind: 'windows-startup', startupDir: 'C:\\Startup' })
  assert.deepEqual(startup.map((step) => step.kind), ['windows-startup'])
})

test('the compose fragment is the answer for a machine without a service manager', () => {
  const fragment = composeFragment({ nodePath: '/usr/bin/node', supervisorPath: '/state/supervisor.js', configPath: '/state/supervisor.json' })
  assert.ok(fragment.includes('restart: always'))
  assert.ok(fragment.includes('/state/supervisor.js'))
})

test('a failing command is reported, never thrown', () => {
  const exec = fakeExec({ default: 'fail' })
  const answer = runCommand('schtasks', ['/Create'], { execFileSyncFn: exec })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 1)
  assert.match(answer.stderr, /Access is denied/)
  assert.match(String(answer.error), /denied/)
})
