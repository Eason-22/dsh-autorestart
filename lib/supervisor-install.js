/**
 * dsh-autorestart — the platform "start at login" records of the supervisor.
 *
 * This module GENERATES the commands and the unit files. It never runs
 * them: the running of a command is the job of `lib/supervisor.js`, and the
 * tests check the generated commands against a fake executor — so the tests
 * never register anything on the machine they run on.
 *
 * THE FORMS (and why):
 *
 *   - **Windows / scheduled task** (`schtasks /SC ONLOGON /RL LIMITED`):
 *     the default. It needs NO administrator (a service would), it runs in the
 *     user's own session, and it starts when the user LOGS IN (not when the
 *     machine boots — a boot task would need `/ru SYSTEM`, and then the host
 *     would read the WRONG home directory).
 *     `/F` makes it idempotent: installing twice does not create a second
 *     task. `/ru`, `/NP` and `/IT` are deliberately NOT passed: `/NP` needs
 *     the "log on as batch job" right that ordinary users do not have, and
 *     `/IT` kills the task when the user logs off.
 *   - **Windows / startup folder** (a `.cmd` in the Startup folder): the
 *     DEGRADATION when the scheduled task cannot be created (some machines
 *     forbid ordinary users from creating tasks). Same zero rights, same
 *     "start at login" semantics.
 *   - **Linux / systemd user unit** (`~/.config/systemd/user/…`): the
 *     default on Linux and WSL. `systemctl --user` needs no administrator.
 *   - **Linux / systemd system unit** (`/etc/systemd/system/…`): only an
 *     EXPLICIT choice ("install it as a system service"), because it needs
 *     root — and it must carry `User=` so the host does not read root's home
 *     directory.
 *
 * A machine WITHOUT a system service manager (a container, a WSL without
 * systemd) has no "start at login" at all: there is no form to register, so
 * the plugin refuses and leaves the start command to the user.
 *
 * ESM only, Node builtins only.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** The name of the autostart record (a scheduled task, a systemd unit). */
export const SUPERVISOR_TASK_NAME = 'dsh-autorestart-web'

/** The kinds the plugin knows. */
export const SUPERVISOR_KINDS = Object.freeze([
  'windows-schtasks',
  'windows-startup',
  'systemd-user',
  'systemd-system',
])

/** @param {unknown} value */
function errorText(value) {
  if (value && typeof value.message === 'string' && value.message) return value.message
  return String(value)
}

/**
 * The command line that starts the supervisor.
 *
 * @param {{ nodePath?: string, supervisorPath?: string, configPath?: string }} options
 * @returns {string}
 */
export function supervisorCommandLine({ nodePath = '', supervisorPath = '', configPath = '' } = {}) {
  const node = String(nodePath ?? '')
  const supervisor = String(supervisorPath ?? '')
  const config = String(configPath ?? '')
  if (node === '' || supervisor === '') return ''
  return `"${node}" "${supervisor}" --config "${config}"`
}

/**
 * The arguments of `schtasks /Create` that register the supervisor.
 *
 * @param {{ nodePath?: string, supervisorPath?: string, configPath?: string, taskName?: string }} options
 * @returns {string[]}
 */
export function windowsTaskCreateArgs({
  nodePath = '',
  supervisorPath = '',
  configPath = '',
  taskName = SUPERVISOR_TASK_NAME,
} = {}) {
  const command = supervisorCommandLine({ nodePath, supervisorPath, configPath })
  return [
    '/Create',
    '/TN', taskName,
    '/SC', 'ONLOGON',
    '/TR', command,
    '/RL', 'LIMITED',
    '/F',
  ]
}

/**
 * The arguments of `schtasks /Query` that check the record.
 *
 * @param {{ taskName?: string }} [options]
 * @returns {string[]}
 */
export function windowsTaskQueryArgs({ taskName = SUPERVISOR_TASK_NAME } = {}) {
  return ['/Query', '/TN', taskName]
}

/**
 * The arguments of `schtasks /Delete` that remove the record.
 *
 * @param {{ taskName?: string }} [options]
 * @returns {string[]}
 */
export function windowsTaskDeleteArgs({ taskName = SUPERVISOR_TASK_NAME } = {}) {
  return ['/Delete', '/TN', taskName, '/F']
}

/**
 * The path of the `.cmd` in the startup folder (the Windows degradation).
 *
 * @param {{ startupDir?: string, taskName?: string }} [options]
 * @returns {string}
 */
export function windowsStartupCmdPath({ startupDir = '', taskName = SUPERVISOR_TASK_NAME } = {}) {
  const dir = String(startupDir ?? '')
  if (dir === '') return ''
  return path.join(dir, taskName + '.cmd')
}

/**
 * The content of the `.cmd` in the startup folder.
 *
 * `start ""` detaches the supervisor from the console, so the window closes
 * right away (a console parked in front of the user is not acceptable).
 *
 * @param {{ nodePath?: string, supervisorPath?: string, configPath?: string }} options
 * @returns {string} the script text (CRLF lines)
 */
export function windowsStartupCmdContent({ nodePath = '', supervisorPath = '', configPath = '' } = {}) {
  const command = supervisorCommandLine({ nodePath, supervisorPath, configPath })
  return [
    '@echo off',
    'rem dsh-autorestart: start the supervisor when the user logs in.',
    'start "" ' + command,
    '',
  ].join('\r\n')
}

/**
 * The path of the systemd USER unit.
 *
 * A systemd path is ALWAYS a POSIX path, so it is built with POSIX
 * separators — even when the plugin runs on Windows (a WSL instance is
 * configured from a Windows host more often than not).
 *
 * @param {{ homeDir?: string, taskName?: string }} [options]
 * @returns {string}
 */
export function systemdUserUnitPath({ homeDir = '', taskName = SUPERVISOR_TASK_NAME } = {}) {
  const home = String(homeDir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (home === '') return ''
  return home + '/.config/systemd/user/' + taskName + '.service'
}

/**
 * The content of the systemd USER unit.
 *
 * `StartLimit*` belongs to `[Unit]` (systemd.unit(5)), not to `[Service]`.
 * `Restart=always` only covers the supervisor itself (the supervisor never
 * exits by itself), and `systemctl stop` does NOT restart it — so the
 * uninstall is clean.
 *
 * @param {{ nodePath?: string, supervisorPath?: string, configPath?: string }} options
 * @returns {string} the unit text
 */
export function systemdUserUnitContent({ nodePath = '', supervisorPath = '', configPath = '' } = {}) {
  const command = supervisorCommandLine({ nodePath, supervisorPath, configPath })
  return [
    '[Unit]',
    'Description=dsh-autorestart web supervisor',
    '# StartLimit* must be written in the Unit section (systemd.unit(5)), not in the Service section.',
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=exec',
    'ExecStart=' + command,
    'Restart=always',
    'RestartSec=3',
    'Environment=DSH_AUTORESTART_SUPERVISED=1',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/**
 * The content of the systemd SYSTEM unit.
 *
 * It needs `User=` (and the matching `HOME`): without it the unit would run
 * as root and the host would read ROOT's home directory — a different
 * profile, a different port file, a different everything.
 *
 * @param {{ nodePath?: string, supervisorPath?: string, configPath?: string, user?: string, homeDir?: string }} options
 * @returns {string} the unit text
 */
export function systemdSystemUnitContent({
  nodePath = '',
  supervisorPath = '',
  configPath = '',
  user = '',
  homeDir = '',
} = {}) {
  const command = supervisorCommandLine({ nodePath, supervisorPath, configPath })
  const lines = [
    '[Unit]',
    'Description=dsh-autorestart web supervisor',
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=exec',
    'ExecStart=' + command,
    'Restart=always',
    'RestartSec=3',
    'Environment=DSH_AUTORESTART_SUPERVISED=1',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=30',
  ]
  if (user !== '') lines.push('User=' + user)
  if (homeDir !== '') {
    lines.push('Environment=HOME=' + homeDir)
    lines.push('Environment=USER=' + (user || ''))
  }
  lines.push('', '[Install]', 'WantedBy=multi-user.target', '')
  return lines.join('\n')
}

/**
 * The arguments of the systemd commands the plugin uses.
 *
 * THE PROGRAM IS NOT PART OF THE ARGUMENTS. A step carries the program in
 * `file` and the arguments in `args`, so `systemctl` must NOT appear in the
 * arguments as well: `systemctl systemctl --user daemon-reload` is a command
 * nobody can run ("Unknown command verb systemctl"), and it made the whole
 * "install at login" fail on every Linux machine.
 *
 * @param {{ taskName?: string, system?: boolean }} [options]
 * @returns {{
 *   daemonReload: string[],
 *   enable: string[],
 *   disable: string[],
 *   isActive: string[],
 * }}
 */
export function systemdArgs({ taskName = SUPERVISOR_TASK_NAME, system = false } = {}) {
  const scope = system ? ['--system'] : ['--user']
  const unit = taskName + '.service'
  return {
    daemonReload: [...scope, 'daemon-reload'],
    enable: [...scope, 'enable', '--now', unit],
    disable: [...scope, 'disable', '--now', unit],
    isActive: [...scope, 'is-active', '--quiet', unit],
  }
}

/**
 * The arguments of a command, without a repeated program name.
 *
 * A step carries the program in `file` and the arguments in `args`. When the
 * arguments repeat the program (`['systemctl', '--user', …]` for the file
 * `systemctl`), the command would run as `systemctl systemctl …` and fail.
 * The repetition is dropped here, so such a mistake can never reach the
 * machine — and the command line that is reported to the user is the one
 * that really runs.
 *
 * @param {string} file
 * @param {string[]} args
 * @returns {string[]}
 */
export function normalizeCommandArgs(file, args) {
  const list = Array.isArray(args) ? args.map(String) : []
  if (list.length < 2) return list
  const program = path.basename(String(file ?? '')).toLowerCase()
  const first = path.basename(list[0]).toLowerCase()
  if (program !== '' && first === program) return list.slice(1)
  return list
}

/**
 * The command line of a step (what the user can run by hand).
 *
 * @param {{ file?: string, args?: string[], path?: string }} step
 * @returns {string}
 */
export function stepCommandLine(step) {
  if (!step || typeof step !== 'object') return ''
  if (typeof step.file === 'string' && step.file !== '') {
    return [step.file, ...normalizeCommandArgs(step.file, step.args)].join(' ')
  }
  if (typeof step.path === 'string' && step.path !== '') return 'delete ' + step.path
  return ''
}

/**
 * Run one command and report what happened (never throws).
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ execFileSyncFn?: Function, timeoutMs?: number }} [options]
 * @returns {{ ok: boolean, code: number|null, stdout: string, stderr: string, error: string|null }}
 */
export function runCommand(file, args, options = {}) {
  const exec = typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync
  if (typeof exec !== 'function') {
    return { ok: false, code: null, stdout: '', stderr: '', error: 'no executor' }
  }
  // The program is in `file`; the arguments must not repeat it.
  const commandArgs = normalizeCommandArgs(file, args)
  try {
    // `stdio: ['ignore','pipe','pipe']` + a timeout: a command that asks for a
    // password gets EOF on stdin instead of hanging for ever.
    const stdout = exec(file, commandArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 20000,
      windowsHide: true,
    })
    return { ok: true, code: 0, stdout: String(stdout ?? ''), stderr: '', error: null }
  } catch (error) {
    const code = error && Number.isFinite(Number(error.status)) ? Number(error.status) : null
    const stdout = error && typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = error && typeof error.stderr === 'string' ? error.stderr : ''
    return { ok: false, code, stdout, stderr, error: errorText(error) }
  }
}

/**
 * What this machine offers.
 *
 * NOTHING is registered here: the detection only LOOKS. The permission of a
 * scheduled task is probed by really creating it during the installation (it
 * is idempotent) — the MS documentation is ambiguous about whether an
 * ordinary user may create a task, so the plugin asks the machine instead of
 * assuming.
 *
 * @param {{
 *   platform?: string,
 *   homeDir?: string,
 *   env?: object,
 *   existsSyncFn?: Function,
 *   execFileSyncFn?: Function,
 * }} [options]
 * @returns {{
 *   platform: string,
 *   schtasks: boolean,
 *   startupFolder: string|null,
 *   systemdUser: boolean,
 *   systemdSystem: boolean,
 *   container: boolean,
 *   reason: string,
 * }}
 */
export function detectInitSystems(options = {}) {
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const home = typeof options.homeDir === 'string' && options.homeDir !== '' ? options.homeDir : os.homedir()
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  const exists = typeof options.existsSyncFn === 'function' ? options.existsSyncFn : fs.existsSync
  const exec = typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync

  if (platform === 'win32') {
    const startupDir = env.APPDATA
      ? path.join(String(env.APPDATA), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
      : ''
    const startupFolder = startupDir !== '' && exists(startupDir) ? startupDir : null
    return {
      platform: 'win32',
      // Whether `schtasks` MAY create a task is NOT probed here: the
      // documentation is ambiguous about ordinary users, so the INSTALLATION
      // asks the machine (it runs the idempotent `/Create` and falls back when
      // it is refused). What is reported here is whether the tool is there at
      // all — and the fallback that exists when it is not.
      schtasks: exec !== null,
      startupFolder,
      systemdUser: false,
      systemdSystem: false,
      container: false,
      reason: startupFolder === null
        ? 'the startup folder was not found'
        : 'a scheduled task is the default; the startup folder is the fallback',
    }
  }

  // POSIX: is there a system service manager at all?
  const systemdPresent = exists('/run/systemd/system')
  let systemdUser = false
  if (systemdPresent && exec !== null) {
    const answer = runCommand('systemctl', ['--user', 'is-system-running'], { execFileSyncFn: exec })
    // `is-system-running` answers "degraded" with a non-zero code when the
    // manager is up but some unit failed — that still means the manager works.
    systemdUser = answer.code !== null && answer.code <= 1
  }
  const container = exists('/.dockerenv') || exists('/run/.containerenv')
  const reason = !systemdPresent
    ? 'this machine has no system service manager (a container, or a WSL without systemd)'
    : (systemdUser
      ? 'a systemd user manager is available'
      : 'systemd is present but the user manager is not reachable')
  return {
    platform,
    schtasks: false,
    startupFolder: null,
    systemdUser,
    systemdSystem: systemdPresent,
    container,
    reason,
  }
}

/**
 * The ordered list of steps that install the supervisor.
 *
 * The list is the CONTRACT: the installer walks it and stops at the first
 * step that fails. The Windows list has a degradation built in (the
 * scheduled task, then the startup folder), the POSIX list has none (there is
 * no second way to register a user unit).
 *
 * @param {{
 *   platform?: string,
 *   kind?: string,
 *   nodePath?: string,
 *   supervisorPath?: string,
 *   configPath?: string,
 *   homeDir?: string,
 *   startupDir?: string,
 *   user?: string,
 *   taskName?: string,
 * }} options
 * @returns {Array<{ kind: string, description: string, file?: string, args?: string[], unit?: string, path?: string, nodePath?: string, command?: string }>}
 */
export function buildInstallSteps(options = {}) {
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const taskName = typeof options.taskName === 'string' && options.taskName !== '' ? options.taskName : SUPERVISOR_TASK_NAME
  const nodePath = String(options.nodePath ?? '')
  const supervisorPath = String(options.supervisorPath ?? '')
  const configPath = String(options.configPath ?? '')
  const command = supervisorCommandLine({ nodePath, supervisorPath, configPath })
  const steps = []
  if (platform === 'win32') {
    steps.push({
      kind: 'windows-schtasks',
      description: 'register a scheduled task that starts the supervisor at login',
      file: 'schtasks',
      args: windowsTaskCreateArgs({ nodePath, supervisorPath, configPath, taskName }),
      // The interpreter and the command it starts: both are reported so the
      // caller (and the tests) can see that the record starts a REAL node and
      // not the application executable.
      nodePath,
      command,
    })
    steps.push({
      kind: 'windows-startup',
      description: 'put a .cmd into the startup folder (the fallback when tasks are not allowed)',
      path: windowsStartupCmdPath({ startupDir: String(options.startupDir ?? ''), taskName }),
      content: windowsStartupCmdContent({ nodePath, supervisorPath, configPath }),
      nodePath,
      command,
    })
    return steps
  }
  const unit = options.kind === 'systemd-system'
    ? systemdSystemUnitContent({ nodePath, supervisorPath, configPath, user: String(options.user ?? ''), homeDir: String(options.homeDir ?? '') })
    : systemdUserUnitContent({ nodePath, supervisorPath, configPath })
  const args = systemdArgs({ taskName, system: options.kind === 'systemd-system' })
  steps.push({
    kind: options.kind === 'systemd-system' ? 'systemd-system' : 'systemd-user',
    description: 'write the systemd unit',
    path: options.kind === 'systemd-system'
      ? '/etc/systemd/system/' + taskName + '.service'
      : systemdUserUnitPath({ homeDir: String(options.homeDir ?? ''), taskName }),
    content: unit,
    nodePath,
    command,
  })
  steps.push({ kind: 'daemon-reload', description: 'reload the systemd units', file: 'systemctl', args: args.daemonReload })
  steps.push({ kind: 'enable', description: 'enable and start the unit', file: 'systemctl', args: args.enable })
  steps.push({ kind: 'verify', description: 'check that the unit is active', file: 'systemctl', args: args.isActive })
  return steps
}

/**
 * The ordered list of steps that uninstall the supervisor.
 *
 * @param {{
 *   platform?: string,
 *   kind?: string,
 *   homeDir?: string,
 *   startupDir?: string,
 *   taskName?: string,
 * }} [options]
 * @returns {Array<{ kind: string, description: string, file?: string, args?: string[], path?: string }>}
 */
export function buildUninstallSteps(options = {}) {
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const taskName = typeof options.taskName === 'string' && options.taskName !== '' ? options.taskName : SUPERVISOR_TASK_NAME
  const steps = []
  if (platform === 'win32') {
    if (options.kind === 'windows-startup') {
      steps.push({
        kind: 'windows-startup',
        description: 'remove the .cmd from the startup folder',
        path: windowsStartupCmdPath({ startupDir: String(options.startupDir ?? ''), taskName }),
      })
      return steps
    }
    steps.push({
      kind: 'windows-schtasks',
      description: 'delete the scheduled task',
      file: 'schtasks',
      args: windowsTaskDeleteArgs({ taskName }),
    })
    return steps
  }
  const args = systemdArgs({ taskName, system: options.kind === 'systemd-system' })
  steps.push({ kind: 'disable', description: 'stop and disable the unit', file: 'systemctl', args: args.disable })
  steps.push({
    kind: 'unit-file',
    description: 'remove the unit file',
    path: options.kind === 'systemd-system'
      ? '/etc/systemd/system/' + taskName + '.service'
      : systemdUserUnitPath({ homeDir: String(options.homeDir ?? ''), taskName }),
  })
  steps.push({ kind: 'daemon-reload', description: 'reload the systemd units', file: 'systemctl', args: args.daemonReload })
  return steps
}

/**
 * The compose fragment for a machine without a service manager.
 *
 * A container has no "start at login": the only correct answer is the
 * orchestrator's own restart policy.
 *
 * @param {{ nodePath?: string, supervisorPath?: string, configPath?: string }} options
 * @returns {string}
 */
export function composeFragment({ nodePath = '', supervisorPath = '', configPath = '' } = {}) {
  const command = supervisorCommandLine({ nodePath, supervisorPath, configPath })
  return [
    'services:',
    '  dsh:',
    '    image: <your dsh image>',
    '    command: ["' + String(nodePath) + '", "' + String(supervisorPath) + '", "--config", "' + String(configPath) + '"]',
    '    restart: always',
  ].join('\n')
}
