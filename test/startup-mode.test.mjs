/**
 * THE STARTUP MATRIX.
 *
 * Every row of the table gets its own test, and every test runs the PURE
 * classifier with an INJECTED process chain and environment — no machine, no
 * process, no timing. The two rules that matter more than the table are
 * tested for EVERY row:
 *
 *   1. only a `bare` host may get a self-replay command and the supervisor of
 *      this plugin (never a second host next to the first);
 *   2. an `unknown` host is conservative: `selfReplay: 'unknown'` and no
 *      supervisor at all.
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  classifyStartup,
  detachCommand,
  inspectCommandLine,
  isWsl,
  STARTUP_MODES,
} from '../lib/startup-mode.js'
import {
  planSupervisorInstall,
  supervisorStatus,
} from '../lib/supervisor.js'
import { deriveStartCommand } from '../lib/supervisor-config.js'

/**
 * A fake process chain (nearest ancestor first).
 *
 * @param {Array<{ pid?: number, ppid?: number, imageName?: string, commandLine?: string }>} entries
 */
function chain(entries) {
  return entries.map((entry, index) => ({
    pid: entry.pid ?? (4200 - index),
    ppid: entry.ppid ?? 0,
    imageName: entry.imageName ?? '',
    commandLine: entry.commandLine ?? '',
  }))
}

/**
 * The facts of a hosted host that was started by hand in a shell.
 *
 * @param {object} [overrides]
 */
function hostedFacts(overrides = {}) {
  return {
    platform: 'linux',
    env: {},
    ppid: 4242,
    isDesktopApp: false,
    supervised: false,
    container: false,
    argv: ['/usr/bin/node', '/home/fg/.npm-global/bin/dsh', 'web', '--port', '5601'],
    execPath: '/usr/bin/node',
    chain: chain([{ pid: 4242, imageName: 'bash', commandLine: 'bash' }]),
    ...overrides,
  }
}

test('MATRIX 1: a plain terminal is a bare host — the supervisor may be installed', () => {
  const result = classifyStartup(hostedFacts())
  assert.equal(result.mode, STARTUP_MODES.BARE)
  assert.equal(result.kind, 'terminal')
  assert.equal(result.selfReplay, 'allowed', 'the command that starts it again may be written')
  assert.equal(result.canInstallSupervisor, true, 'the supervisor of this plugin may be installed')
  assert.equal(result.detachCommand, false, 'a foreground start needs no detachment')
  assert.match(result.evidence, /^parent:\d+: bash/)
  assert.ok(result.suggestion.length > 0, 'the user gets a hint')
})

test('MATRIX 2: nohup/setsid is bare too, but the replay must be detached', () => {
  const nohup = classifyStartup(hostedFacts({
    chain: chain([{ pid: 4242, imageName: 'bash', commandLine: 'bash -c nohup dsh web &' }]),
  }))
  assert.equal(nohup.mode, STARTUP_MODES.BARE)
  assert.equal(nohup.kind, 'detached')
  assert.equal(nohup.detachCommand, true, 'the new host must not die with the shell')
  assert.equal(nohup.canInstallSupervisor, true)
  assert.match(nohup.evidence, /nohup|nohup command/)

  const setsid = classifyStartup(hostedFacts({
    chain: chain([{ pid: 4242, imageName: 'setsid', commandLine: 'setsid dsh web' }]),
  }))
  assert.equal(setsid.mode, STARTUP_MODES.BARE)
  assert.equal(setsid.kind, 'detached')
  assert.equal(setsid.detachCommand, true)
  assert.ok(detachCommand('node dsh web', 'linux').startsWith('setsid nohup '))
})

test('MATRIX 3: a supervisor script is EXTERNAL — graceful exit only, never a second host', () => {
  const result = classifyStartup(hostedFacts({
    chain: chain([{ pid: 4242, imageName: 'bash', commandLine: '/bin/bash /home/fg/supervise-web.sh' }]),
  }))
  assert.equal(result.mode, STARTUP_MODES.EXTERNAL)
  assert.equal(result.kind, 'script')
  assert.equal(result.selfReplay, 'refused', 'a self-replay would start a SECOND host')
  assert.equal(result.canInstallSupervisor, false, 'no second supervisor')
  assert.match(result.evidence, /ancestor:\d+/)
})

test('MATRIX 4: a systemd unit is EXTERNAL (environment marker or parent chain)', () => {
  const marker = classifyStartup(hostedFacts({ env: { INVOCATION_ID: 'abc-123' } }))
  assert.equal(marker.mode, STARTUP_MODES.EXTERNAL)
  assert.equal(marker.kind, 'systemd')
  assert.equal(marker.evidence, 'env:INVOCATION_ID')
  assert.equal(marker.selfReplay, 'refused')
  assert.equal(marker.canInstallSupervisor, false)

  const chainHit = classifyStartup(hostedFacts({
    chain: chain([{ pid: 4242, imageName: 'systemd', commandLine: '/lib/systemd/systemd --user' }]),
  }))
  assert.equal(chainHit.mode, STARTUP_MODES.EXTERNAL)
  assert.equal(chainHit.kind, 'systemd')
  assert.equal(chainHit.canInstallSupervisor, false)
})

test('MATRIX 5: pm2 and forever are EXTERNAL', () => {
  const pm2 = classifyStartup(hostedFacts({ env: { pm_id: '0', PM2_HOME: '/home/fg/.pm2' } }))
  assert.equal(pm2.mode, STARTUP_MODES.EXTERNAL)
  assert.equal(pm2.kind, 'pm2')
  assert.match(pm2.evidence, /^env:/)
  assert.equal(pm2.canInstallSupervisor, false)

  const forever = classifyStartup(hostedFacts({
    chain: chain([{ pid: 4242, imageName: 'node', commandLine: 'node /home/fg/.npm-global/bin/forever start dsh.js' }]),
  }))
  assert.equal(forever.mode, STARTUP_MODES.EXTERNAL)
  assert.equal(forever.kind, 'forever')
  assert.equal(forever.canInstallSupervisor, false)
})

test('MATRIX 6: a container promises nothing — the orchestrator brings it back', () => {
  const docker = classifyStartup(hostedFacts({ container: true }))
  assert.equal(docker.mode, STARTUP_MODES.CONTAINER)
  assert.equal(docker.kind, 'docker')
  assert.equal(docker.selfReplay, 'refused')
  assert.equal(docker.canInstallSupervisor, false, 'no systemd inside a container')
  assert.match(docker.suggestion, /restart: always/)

  const kubernetes = classifyStartup(hostedFacts({
    container: true,
    env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' },
  }))
  assert.equal(kubernetes.mode, STARTUP_MODES.CONTAINER)
  assert.equal(kubernetes.kind, 'kubernetes')
  assert.equal(kubernetes.canInstallSupervisor, false)
})

test('MATRIX 7: the Windows side (scheduled task, NSSM service) is EXTERNAL', () => {
  const task = classifyStartup(hostedFacts({
    platform: 'win32',
    chain: chain([{ pid: 4242, imageName: 'svchost.exe', commandLine: 'svchost.exe -k netsvcs' }]),
  }))
  assert.equal(task.mode, STARTUP_MODES.EXTERNAL)
  assert.equal(task.kind, 'windows-task')
  assert.equal(task.selfReplay, 'refused')
  assert.equal(task.canInstallSupervisor, false)

  const service = classifyStartup(hostedFacts({
    platform: 'win32',
    chain: chain([{ pid: 4242, imageName: 'nssm.exe', commandLine: 'nssm.exe run DshWeb' }]),
  }))
  assert.equal(service.mode, STARTUP_MODES.EXTERNAL)
  assert.equal(service.kind, 'windows-service', 'NSSM is a service')
  assert.equal(service.canInstallSupervisor, false)
})

test('MATRIX 8: WSL started by the Windows side is UNKNOWN — never a bare host', () => {
  const result = classifyStartup(hostedFacts({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu-22.04', WSL_INTEROP: '/run/WSL/8_interop' },
    chain: [],
  }))
  assert.equal(result.mode, STARTUP_MODES.UNKNOWN)
  assert.equal(result.kind, 'wsl-from-windows')
  assert.equal(result.selfReplay, 'unknown')
  assert.equal(result.canInstallSupervisor, false, 'an unknown host gets no supervisor')
  assert.match(result.suggestion, /WSL/)
})

test('MATRIX 8b: WSL whose parent is the init (the Windows side is invisible) is UNKNOWN', () => {
  const result = classifyStartup(hostedFacts({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu-22.04' },
    chain: chain([{ pid: 1, imageName: 'init', commandLine: '/sbin/init' }]),
  }))
  assert.equal(result.mode, STARTUP_MODES.UNKNOWN)
  assert.equal(result.kind, 'wsl-from-windows')
  assert.equal(result.selfReplay, 'unknown')
  assert.equal(result.canInstallSupervisor, false)
  assert.equal(isWsl({ WSL_DISTRO_NAME: 'Ubuntu-22.04' }), true)
  assert.equal(isWsl({}), false)
})

test('MATRIX 9: a package runner is usable when the real argv can be restored', () => {
  const usable = classifyStartup(hostedFacts({
    argv: ['/usr/bin/node', '/home/fg/.npm/_npx/abc/node_modules/dsh/bin/dsh.js', 'web', '--port', '5601'],
    execPath: '/usr/bin/node',
  }))
  assert.equal(usable.mode, STARTUP_MODES.BARE)
  assert.equal(usable.kind, 'package-runner')
  assert.equal(usable.selfReplay, 'allowed')
  assert.equal(usable.canInstallSupervisor, true)

  const opaque = classifyStartup(hostedFacts({
    argv: ['/usr/bin/node'],
    execPath: '/usr/bin/npx',
  }))
  assert.equal(opaque.mode, STARTUP_MODES.UNKNOWN)
  assert.equal(opaque.kind, 'opaque-wrapper')
  assert.equal(opaque.selfReplay, 'unknown')
  assert.equal(opaque.canInstallSupervisor, false, 'nothing is guessed')
  assert.equal(inspectCommandLine({ argv: ['/usr/bin/node'], execPath: '/usr/bin/npx' }).ok, false)
})

test('MATRIX 10: another DSH plugin spawned it — external, never a second host', () => {
  const result = classifyStartup(hostedFacts({
    chain: chain([
      { pid: 4242, imageName: 'node', commandLine: 'node /home/fg/.dsh/profiles/web/plugins/dsh-workspace/index.js' },
    ]),
  }))
  assert.equal(result.mode, STARTUP_MODES.EXTERNAL)
  assert.equal(result.kind, 'dsh-plugin')
  assert.equal(result.selfReplay, 'refused', 'a self-replay would start a SECOND host')
  assert.equal(result.canInstallSupervisor, false, 'no second supervisor')
})

test('MATRIX 11: a tmux/screen/ssh session replays the command — detached from the session', () => {
  const tmux = classifyStartup(hostedFacts({
    chain: chain([{ pid: 4242, imageName: 'tmux: server', commandLine: 'tmux: server' }]),
  }))
  assert.equal(tmux.mode, STARTUP_MODES.BARE)
  assert.equal(tmux.kind, 'session')
  assert.equal(tmux.selfReplay, 'allowed', 'the command is replayed, not a graceful exit')
  assert.equal(tmux.detachCommand, true, 'the new host must outlive the session')
  assert.equal(tmux.canInstallSupervisor, true)

  const screen = classifyStartup(hostedFacts({
    chain: chain([{ pid: 4242, imageName: 'SCREEN', commandLine: 'SCREEN /bin/bash' }]),
  }))
  assert.equal(screen.kind, 'session')

  const ssh = classifyStartup(hostedFacts({
    chain: chain([{ pid: 4242, imageName: 'sshd', commandLine: 'sshd: user@pts/0' }]),
  }))
  assert.equal(ssh.kind, 'session')
  assert.equal(ssh.detachCommand, true)
})

test('the desktop app manages itself', () => {
  const result = classifyStartup(hostedFacts({
    isDesktopApp: true,
    execPath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
  }))
  assert.equal(result.mode, STARTUP_MODES.DESKTOP)
  assert.equal(result.selfReplay, 'n/a')
  assert.equal(result.canInstallSupervisor, false)
})

test('our own supervisor is in charge', () => {
  const result = classifyStartup(hostedFacts({ supervised: true }))
  assert.equal(result.mode, STARTUP_MODES.SELF_SUPERVISED)
  assert.equal(result.selfReplay, 'n/a')
  assert.equal(result.canInstallSupervisor, false, 'a second supervisor is impossible')
})

test('RULE: only a bare host may replay itself and may get the supervisor', () => {
  const rows = [
    classifyStartup(hostedFacts({ isDesktopApp: true })),
    classifyStartup(hostedFacts({ supervised: true })),
    classifyStartup(hostedFacts({ container: true })),
    classifyStartup(hostedFacts({ env: { INVOCATION_ID: 'x' } })),
    classifyStartup(hostedFacts({ chain: chain([{ pid: 4242, imageName: 'systemd', commandLine: 'systemd' }]) })),
    classifyStartup(hostedFacts({ chain: [] })),
    classifyStartup(hostedFacts({
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      chain: [],
    })),
  ]
  for (const row of rows) {
    if (row.mode === STARTUP_MODES.BARE) continue
    assert.notEqual(row.selfReplay, 'allowed', 'no self-replay for ' + row.mode)
    assert.equal(row.canInstallSupervisor, false, 'no supervisor for ' + row.mode)
  }
})

test('RULE: an unknown host is conservative — no replay, no supervisor', () => {
  const unknown = classifyStartup(hostedFacts({ chain: [] }))
  assert.equal(unknown.mode, STARTUP_MODES.UNKNOWN)
  assert.equal(unknown.selfReplay, 'unknown')
  assert.equal(unknown.canInstallSupervisor, false)
  assert.ok(unknown.evidence.length > 0, 'the user sees WHY nothing could be established')
  assert.ok(unknown.suggestion.length > 0, 'the user gets a way out')
})

/* ------------------------------------------------------------------ *
 * THE WIRING: the matrix must reach the status, the plan and the
 * derivation — otherwise it is only a table.
 * ------------------------------------------------------------------ */

test('WIRING: the status carries the startup mode with its evidence', () => {
  const startup = classifyStartup(hostedFacts({
    chain: chain([{ pid: 4242, imageName: 'bash', commandLine: '/bin/bash /home/fg/supervise-web.sh' }]),
  }))
  const status = supervisorStatus({
    stateDir: path.join(os.tmpdir(), 'dsh-ar-startup-status-does-not-exist'),
    env: {},
    platform: 'linux',
    startup,
  })
  assert.equal(status.startup.mode, STARTUP_MODES.EXTERNAL)
  assert.equal(status.startup.kind, 'script')
  assert.ok(status.startup.evidence.length > 0, 'the settings page can show WHY')
  assert.equal(status.startup.canInstallSupervisor, false)
})

test('WIRING: only a bare host may get a supervisor (the plan refuses the others)', () => {
  const base = {
    platform: 'linux',
    nodePath: '/usr/bin/node',
    supervisorPath: '/state/supervisor.js',
    configPath: '/state/supervisor.json',
    homeDir: '/home/fg',
    // The machine has a systemd user manager (and no container).
    existsSyncFn: (target) => target === '/run/systemd/system',
  }
  const external = planSupervisorInstall({
    ...base,
    startup: classifyStartup(hostedFacts({
      chain: chain([{ pid: 4242, imageName: 'systemd', commandLine: '/lib/systemd/systemd --user' }]),
    })),
  })
  assert.equal(external.error, 'startup-not-installable')
  assert.deepEqual(external.steps, [], 'no step may be generated')

  const unknown = planSupervisorInstall({
    ...base,
    startup: classifyStartup(hostedFacts({ chain: [] })),
  })
  assert.equal(unknown.error, 'startup-not-installable')
  assert.deepEqual(unknown.steps, [])

  const bare = planSupervisorInstall({
    ...base,
    startup: classifyStartup(hostedFacts()),
  })
  assert.equal(bare.error, null)
  assert.ok(bare.steps.length > 0, 'a bare host still gets its plan')
})

test('WIRING: an unknown starter gets NO restart command (nothing is guessed)', () => {
  const result = deriveStartCommand({
    execPath: '/usr/bin/node',
    execArgv: [],
    argv: ['/usr/bin/node', '/home/fg/.npm-global/bin/dsh', 'web', '--port', '5601'],
    cwd: '/home/fg',
    platform: 'linux',
    env: {},
    webPort: 5601,
    startup: classifyStartup(hostedFacts({ chain: [] })),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unknown-startup')
  assert.equal(result.command, null, 'no command is derived')
  assert.equal(result.writes, null, 'nothing is written')
})

test('WIRING: a session or a detached start gets a DETACHED command', () => {
  const facts = {
    execPath: '/usr/bin/node',
    execArgv: [],
    argv: ['/usr/bin/node', '/home/fg/.npm-global/bin/dsh', 'web', '--port', '5601'],
    cwd: '/home/fg',
    platform: 'linux',
    env: {},
    webPort: 5601,
  }
  const session = deriveStartCommand({
    ...facts,
    startup: classifyStartup(hostedFacts({
      chain: chain([{ pid: 4242, imageName: 'tmux: server', commandLine: 'tmux: server' }]),
    })),
  })
  assert.equal(session.ok, true)
  assert.match(session.command, /^setsid nohup /, 'the new host must outlive the session')
  assert.ok(session.plan.some((line) => line.label === 'detached'))

  const detached = deriveStartCommand({
    ...facts,
    startup: classifyStartup(hostedFacts({
      chain: chain([{ pid: 4242, imageName: 'bash', commandLine: 'bash -c nohup dsh web &' }]),
    })),
  })
  assert.match(detached.command, /^setsid nohup /)
})

test('WIRING: an external starter keeps the graceful exit (no second host)', () => {
  const result = deriveStartCommand({
    execPath: '/usr/bin/node',
    execArgv: [],
    argv: ['/usr/bin/node', '/home/fg/.npm-global/bin/dsh', 'web', '--port', '5601'],
    cwd: '/home/fg',
    platform: 'linux',
    env: {},
    pid: 4242,
    webPort: 5601,
    startup: classifyStartup(hostedFacts({
      chain: chain([{ pid: 4242, imageName: 'systemd', commandLine: '/lib/systemd/systemd --user' }]),
    })),
  })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'graceful-exit')
  assert.equal(result.writes.restartCommand, 'kill -TERM 4242')
  assert.equal(
    result.command.includes('/home/fg/.npm-global/bin/dsh'),
    false,
    'a self-replay would start a SECOND host',
  )
})
