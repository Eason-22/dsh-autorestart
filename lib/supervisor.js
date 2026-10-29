/**
 * dsh-autorestart — the plugin side of the supervisor.
 *
 * The plugin does four things with the supervisor: INSTALL it, UNINSTALL it,
 * ASK about its state, and ASK it to restart the host. Everything else (the
 * daemon itself) lives in `supervisor/supervisor.js` and runs OUTSIDE the
 * host — the plugin cannot be the thing that brings the host back, because
 * the plugin dies with the host.
 *
 * THE THREE RULES OF THIS FILE:
 *
 *   1. **The installation is idempotent.** Installing twice leaves exactly ONE
 *      record (the task name / the unit name / the startup file name are
 *      fixed, and the scheduled task is created with `/F`). A second
 *      supervisor is impossible: the daemon takes an exclusive lock.
 *   2. **The installation is reversible.** The previous `restartMode` /
 *      `restartCommand` are saved before anything is changed, and the
 *      uninstall puts them back. When a step of the uninstall fails, the
 *      pending cleanup is WRITTEN DOWN (never silently dropped) so the user
 *      can finish it by hand.
 *   3. **Nothing is installed without the user's nod.** The caller (the
 *      confirmation card) has to pass `confirmed: true`; without it the
 *      installation only produces a PLAN (the dry run).
 *
 * ESM only, Node builtins only. No DSH / npm imports.
 */

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  buildInstallSteps,
  buildUninstallSteps,
  composeFragment,
  detectInitSystems,
  runCommand,
  SUPERVISOR_TASK_NAME,
  windowsStartupCmdContent,
  windowsStartupCmdPath,
} from './supervisor-install.js'
import { inspectExternalSupervisor } from './supervisor-config.js'

/** The name of the directory the supervisor lives in (inside the state dir). */
export const SUPERVISOR_DIR_NAME = 'supervisor'

/** The name of the file that says "the uninstall did not finish". */
export const UNINSTALL_PENDING_NAME = 'UNINSTALL-PENDING.json'

/** The version of the supervisor configuration this plugin writes. */
export const SUPERVISOR_CONFIG_VERSION = 1

/** The environment marker that says "a supervisor started me". */
export const SUPERVISED_ENV = 'DSH_AUTORESTART_SUPERVISED'

/** The environment marker that carries the supervisor's pid. */
export const SUPERVISOR_PID_ENV = 'DSH_AUTORESTART_SUPERVISOR_PID'

/** @param {unknown} value */
function errorText(value) {
  if (value && typeof value.message === 'string' && value.message) return value.message
  return String(value)
}

/**
 * Every path the supervisor uses inside the state directory.
 *
 * @param {string} stateDir
 * @returns {{
 *   dir: string, script: string, config: string, lock: string, pid: string,
 *   control: string, log: string, rollbackRequest: string, pendingUninstall: string,
 * }}
 */
export function supervisorPaths(stateDir) {
  const dir = path.join(String(stateDir ?? ''), SUPERVISOR_DIR_NAME)
  return {
    dir,
    script: path.join(dir, 'supervisor.js'),
    config: path.join(dir, 'supervisor.json'),
    lock: path.join(dir, 'supervisor.lock'),
    pid: path.join(dir, 'supervisor.pid'),
    control: path.join(dir, 'control.json'),
    log: path.join(dir, 'supervisor.log'),
    rollbackRequest: path.join(dir, 'rollback-request.json'),
    pendingUninstall: path.join(dir, UNINSTALL_PENDING_NAME),
  }
}

/**
 * The path of the supervisor script inside THIS plugin package.
 *
 * @returns {string}
 */
export function packagedSupervisorPath() {
  return new URL('../supervisor/supervisor.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
}

/**
 * The configuration of the supervisor.
 *
 * @param {{
 *   execPath?: string, execArgv?: string[], argv?: string[], cwd?: string,
 *   env?: object, profileEnv?: object, port?: number, healthUrl?: string,
 *   profileDir?: string, stateDir?: string, ownerUser?: string,
 *   timings?: object, previous?: object, mode?: string, generation?: number,
 * }} [options]
 * @returns {object}
 */
export function buildSupervisorConfig(options = {}) {
  return {
    version: SUPERVISOR_CONFIG_VERSION,
    installedAt: new Date().toISOString(),
    ownerUser: typeof options.ownerUser === 'string' ? options.ownerUser : '',
    execPath: typeof options.execPath === 'string' ? options.execPath : '',
    execArgv: Array.isArray(options.execArgv) ? options.execArgv.map(String) : [],
    argv: Array.isArray(options.argv) ? options.argv.map(String) : [],
    cwd: typeof options.cwd === 'string' ? options.cwd : '',
    env: options.env && typeof options.env === 'object' ? options.env : {},
    profileEnv: options.profileEnv && typeof options.profileEnv === 'object' ? options.profileEnv : {},
    port: Number.isFinite(Number(options.port)) ? Number(options.port) : 0,
    healthUrl: typeof options.healthUrl === 'string' ? options.healthUrl : '',
    profileDir: typeof options.profileDir === 'string' ? options.profileDir : '',
    stateDir: typeof options.stateDir === 'string' ? options.stateDir : '',
    control: { type: 'tcp', host: '127.0.0.1', port: 0 },
    timings: {
      restartDelayMs: 1000,
      restartDelayMaxMs: 30000,
      startTimeoutMs: 90000,
      killGraceMs: 15000,
      portFreeTimeoutMs: 30000,
      ...(options.timings && typeof options.timings === 'object' ? options.timings : {}),
    },
    previous: options.previous && typeof options.previous === 'object' ? options.previous : null,
    mode: options.mode === 'external' ? 'external' : 'installed',
    // Which form was actually registered (it can differ from the plan when the
    // scheduled task was refused and the startup folder took over).
    kind: typeof options.kind === 'string' && options.kind !== '' ? options.kind : null,
    generation: Number.isFinite(Number(options.generation)) ? Number(options.generation) : 1,
  }
}

/**
 * Write the supervisor configuration.
 *
 * @param {string} stateDir
 * @param {object} config
 * @returns {{ ok: boolean, path: string, error: string|null }}
 */
export function writeSupervisorConfig(stateDir, config) {
  const paths = supervisorPaths(stateDir)
  try {
    fs.mkdirSync(paths.dir, { recursive: true })
    const temporary = paths.config + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', 'utf8')
    fs.renameSync(temporary, paths.config)
    return { ok: true, path: paths.config, error: null }
  } catch (error) {
    return { ok: false, path: paths.config, error: errorText(error) }
  }
}

/**
 * Read the supervisor configuration.
 *
 * @param {string} stateDir
 * @returns {{ ok: boolean, config: object|null, error: string|null }}
 */
export function readSupervisorConfig(stateDir) {
  const paths = supervisorPaths(stateDir)
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.config, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return { ok: false, config: null, error: 'the configuration is not an object' }
    return { ok: true, config: parsed, error: null }
  } catch (error) {
    return { ok: false, config: null, error: errorText(error) }
  }
}

/**
 * Write the rollback request the daemon reads when the host does not come back.
 *
 * @param {string} stateDir
 * @param {{ backupDir: string, profileDir: string, generation?: number, reason?: string }} request
 * @returns {{ ok: boolean, path: string, error: string|null }}
 */
export function writeRollbackRequest(stateDir, request) {
  const paths = supervisorPaths(stateDir)
  try {
    fs.mkdirSync(paths.dir, { recursive: true })
    fs.writeFileSync(paths.rollbackRequest, JSON.stringify({
      backupDir: String(request && request.backupDir ? request.backupDir : ''),
      profileDir: String(request && request.profileDir ? request.profileDir : ''),
      generation: Number.isFinite(Number(request && request.generation)) ? Number(request.generation) : 0,
      reason: String(request && request.reason ? request.reason : 'plugin-restart'),
      requestedAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8')
    return { ok: true, path: paths.rollbackRequest, error: null }
  } catch (error) {
    return { ok: false, path: paths.rollbackRequest, error: errorText(error) }
  }
}

/**
 * Read the rollback request.
 *
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readRollbackRequest(stateDir) {
  const paths = supervisorPaths(stateDir)
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.rollbackRequest, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Is this instance the one the supervisor started?
 *
 * The ENVIRONMENT MARKER is the authoritative evidence: the daemon injects it
 * into the host it starts. The pid file is the second hand (it also carries
 * the address of the control channel); the process tree is NOT used — a
 * daemon that `exec`s the host, or a daemon that died first, leaves the host
 * re-parented to pid 1, so the parent chain proves nothing.
 *
 * @param {{ env?: object, stateDir?: string }} [options]
 * @returns {{ supervised: boolean, reason: string, control: object|null, pid: number|null }}
 */
export function detectSupervisor(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : ''
  const marker = env[SUPERVISED_ENV]
  const markerPid = Number(env[SUPERVISOR_PID_ENV])
  let control = null
  let pid = Number.isFinite(markerPid) && markerPid > 0 ? markerPid : null
  if (stateDir !== '') {
    const paths = supervisorPaths(stateDir)
    try {
      control = JSON.parse(fs.readFileSync(paths.control, 'utf8'))
    } catch {
      control = null
    }
    try {
      const written = Number(fs.readFileSync(paths.pid, 'utf8').trim())
      if (Number.isFinite(written) && written > 0) pid = written
    } catch {
      /* the pid file is optional */
    }
  }
  if (marker === '1' || marker === 'true') {
    return { supervised: true, reason: 'the supervisor started this instance', control, pid }
  }
  if (control !== null && pid !== null) {
    return {
      supervised: false,
      reason: 'a supervisor is installed, but this instance was not started by it',
      control,
      pid,
    }
  }
  return { supervised: false, reason: 'this instance was not started by a supervisor', control, pid }
}

/**
 * Is a process alive?
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  const number = Number(pid)
  if (!Number.isFinite(number) || number <= 0) return false
  try {
    process.kill(number, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

/**
 * Ask the supervisor to do something over its control channel.
 *
 * @param {{ stateDir?: string, control?: object, action?: string, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, response: object|null, error: string|null }>}
 */
export function requestSupervisorAction(options = {}) {
  const action = typeof options.action === 'string' && options.action !== '' ? options.action : 'restart'
  let control = options.control && typeof options.control === 'object' ? options.control : null
  if (control === null && typeof options.stateDir === 'string' && options.stateDir !== '') {
    try {
      control = JSON.parse(fs.readFileSync(supervisorPaths(options.stateDir).control, 'utf8'))
    } catch {
      control = null
    }
  }
  if (!control || control.type !== 'tcp' || !Number.isFinite(Number(control.port)) || Number(control.port) <= 0) {
    return Promise.resolve({ ok: false, response: null, error: 'the supervisor has no control channel' })
  }
  const timeout = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Math.trunc(Number(options.timeoutMs))
    : 5000
  return new Promise((resolve) => {
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const socket = net.connect({ port: Number(control.port), host: String(control.host || '127.0.0.1') })
    let buffer = ''
    const timer = setTimeout(() => {
      try {
        socket.destroy()
      } catch {
        /* nothing else to do */
      }
      done({ ok: false, response: null, error: 'the supervisor did not answer in time' })
    }, timeout)
    socket.on('connect', () => {
      try {
        socket.write(JSON.stringify({ action }) + '\n')
      } catch {
        /* the timeout below reports it */
      }
    })
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      const index = buffer.indexOf('\n')
      if (index < 0) return
      clearTimeout(timer)
      let response = null
      try {
        response = JSON.parse(buffer.slice(0, index))
      } catch {
        response = null
      }
      try {
        socket.destroy()
      } catch {
        /* nothing else to do */
      }
      done({ ok: Boolean(response && response.ok === true), response, error: null })
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      done({ ok: false, response: null, error: errorText(error) })
    })
  })
}

/**
 * The plan of an installation (what WOULD be changed).
 *
 * @param {{
 *   platform?: string, nodePath?: string, supervisorPath?: string, configPath?: string,
 *   homeDir?: string, startupDir?: string, user?: string, kind?: string,
 * }} options
 * @returns {{
 *   kind: string,
 *   steps: Array<object>,
 *   degraded: boolean,
 *   compose: string|null,
 *   reason: string,
 * }}
 */
export function planSupervisorInstall(options = {}) {
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const detected = detectInitSystems({
    platform,
    homeDir: options.homeDir,
    env: options.env,
    existsSyncFn: options.existsSyncFn,
    execFileSyncFn: options.execFileSyncFn,
  })
  const steps = buildInstallSteps({
    platform,
    kind: options.kind,
    nodePath: options.nodePath,
    supervisorPath: options.supervisorPath,
    configPath: options.configPath,
    homeDir: options.homeDir,
    startupDir: options.startupDir,
    user: options.user,
  })
  if (platform !== 'win32' && !detected.systemdUser) {
    return {
      kind: 'none',
      steps: [],
      degraded: false,
      compose: composeFragment(options),
      reason: detected.reason,
    }
  }
  return {
    kind: platform === 'win32' ? 'windows-schtasks' : (options.kind === 'systemd-system' ? 'systemd-system' : 'systemd-user'),
    steps,
    degraded: false,
    compose: null,
    reason: detected.reason,
  }
}

/**
 * Install the supervisor.
 *
 * The order is fixed: the FILES first (the daemon, the configuration), then
 * the autostart record. When the record cannot be registered, the files are
 * removed again — a half-installed supervisor must not stay behind.
 *
 * @param {{
 *   stateDir?: string,
 *   profileDir?: string,
 *   nodePath?: string,
 *   execPath?: string,
 *   execArgv?: string[],
 *   argv?: string[],
 *   cwd?: string,
 *   env?: object,
 *   profileEnv?: object,
 *   port?: number,
 *   healthUrl?: string,
 *   ownerUser?: string,
 *   timings?: object,
 *   previous?: object|null,
 *   platform?: string,
 *   homeDir?: string,
 *   startupDir?: string,
 *   user?: string,
 *   kind?: string,
 *   confirmed?: boolean,
 *   dryRun?: boolean,
 *   execFileSyncFn?: Function,
 *   existsSyncFn?: Function,
 *   copySupervisor?: Function,
 *   log?: Function,
 * }} [options]
 * @returns {{
 *   ok: boolean, kind: string, installed: boolean, degraded: boolean,
 *   steps: Array<object>, error: string|null, reason: string, config: object|null,
 *   compose: string|null, plan: object|null,
 * }}
 */
export function installSupervisor(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : ''
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const paths = supervisorPaths(stateDir)
  const homeDir = typeof options.homeDir === 'string' && options.homeDir !== '' ? options.homeDir : os.homedir()
  const startupDir = typeof options.startupDir === 'string'
    ? options.startupDir
    : (process.env.APPDATA
      ? path.join(String(process.env.APPDATA), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
      : '')
  const exec = typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : execFileSync
  const exists = typeof options.existsSyncFn === 'function' ? options.existsSyncFn : fs.existsSync
  const nodePath = typeof options.nodePath === 'string' && options.nodePath !== '' ? options.nodePath : process.execPath

  const plan = planSupervisorInstall({
    platform,
    nodePath,
    supervisorPath: paths.script,
    configPath: paths.config,
    homeDir,
    startupDir,
    user: options.user,
    kind: options.kind,
    env: options.env,
    existsSyncFn: options.existsSyncFn,
    execFileSyncFn: options.execFileSyncFn,
  })

  const base = {
    ok: false,
    kind: plan.kind,
    installed: false,
    degraded: false,
    steps: [],
    error: null,
    reason: plan.reason,
    config: null,
    compose: plan.compose,
    plan,
  }

  if (stateDir === '') return { ...base, error: 'installSupervisor requires stateDir' }
  if (plan.kind === 'none') {
    return {
      ...base,
      error: 'this machine has no "start at login" mechanism: ' + plan.reason,
    }
  }

  // The plan is what the confirmation card shows. Without the user's nod
  // nothing is written at all.
  if (options.dryRun === true || options.confirmed !== true) {
    return {
      ...base,
      ok: options.dryRun === true,
      steps: plan.steps,
      reason: options.dryRun === true
        ? 'dry run: nothing was written'
        : 'the installation needs the confirmation card',
      error: options.dryRun === true ? null : 'the installation needs the confirmation card',
    }
  }

  // (1) The files.
  try {
    fs.mkdirSync(paths.dir, { recursive: true })
    const source = typeof options.copySupervisor === 'function'
      ? options.copySupervisor()
      : fs.readFileSync(packagedSupervisorPath())
    const temporary = paths.script + '.tmp'
    fs.writeFileSync(temporary, source)
    fs.renameSync(temporary, paths.script)
  } catch (error) {
    return { ...base, error: 'the supervisor script could not be copied: ' + errorText(error) }
  }

  const config = buildSupervisorConfig({
    execPath: options.execPath,
    execArgv: options.execArgv,
    argv: options.argv,
    cwd: options.cwd,
    env: options.env,
    profileEnv: options.profileEnv,
    port: options.port,
    healthUrl: options.healthUrl,
    profileDir: options.profileDir,
    stateDir,
    ownerUser: options.ownerUser,
    timings: options.timings,
    previous: options.previous,
    mode: 'installed',
  })
  const written = writeSupervisorConfig(stateDir, config)
  if (!written.ok) {
    return { ...base, error: 'the supervisor configuration could not be written: ' + written.error }
  }

  // (2) The autostart record.
  const steps = []
  let kind = plan.kind
  let degraded = false
  let error = null

  if (platform === 'win32') {
    const task = buildInstallSteps({
      platform,
      nodePath,
      supervisorPath: paths.script,
      configPath: paths.config,
      startupDir,
    })
    const taskStep = task[0]
    const fallbackStep = task[1]
    const created = runCommand(taskStep.file, taskStep.args, { execFileSyncFn: exec })
    steps.push({ kind: taskStep.kind, description: taskStep.description, ok: created.ok, error: created.error })
    if (created.ok) {
      // "It answered" is not "it is there": the record is verified.
      const query = runCommand('schtasks', ['/Query', '/TN', SUPERVISOR_TASK_NAME], { execFileSyncFn: exec })
      steps.push({ kind: 'verify', description: 'check that the scheduled task exists', ok: query.ok, error: query.error })
      if (!query.ok) {
        error = 'the scheduled task was created but cannot be queried: ' + String(query.error)
      }
    } else {
      // The degradation: the startup folder needs no rights at all.
      log('the scheduled task was refused; falling back to the startup folder: ' + String(created.error))
      degraded = true
      kind = 'windows-startup'
      try {
        fs.mkdirSync(path.dirname(fallbackStep.path), { recursive: true })
        fs.writeFileSync(fallbackStep.path, fallbackStep.content, 'utf8')
        steps.push({ kind: fallbackStep.kind, description: fallbackStep.description, ok: true, error: null })
      } catch (fallbackError) {
        error = 'the scheduled task was refused (' + String(created.error)
          + ') and the startup folder could not be written: ' + errorText(fallbackError)
      }
    }
  } else {
    const unit = buildInstallSteps({
      platform,
      kind: options.kind,
      nodePath,
      supervisorPath: paths.script,
      configPath: paths.config,
      homeDir,
      user: options.user,
    })
    for (const step of unit) {
      if (step.kind === 'systemd-user' || step.kind === 'systemd-system') {
        try {
          fs.mkdirSync(path.dirname(step.path), { recursive: true })
          fs.writeFileSync(step.path, step.content, 'utf8')
          steps.push({ kind: step.kind, description: step.description, ok: true, error: null })
        } catch (writeError) {
          error = 'the unit file could not be written: ' + errorText(writeError)
          steps.push({ kind: step.kind, description: step.description, ok: false, error: writeText(error) })
          break
        }
        continue
      }
      const answer = runCommand(step.file, step.args, { execFileSyncFn: exec })
      steps.push({ kind: step.kind, description: step.description, ok: answer.ok, error: answer.error })
      if (!answer.ok) {
        error = step.description + ' failed: ' + String(answer.error)
        break
      }
    }
  }

  if (error !== null) {
    // Nothing may stay half-installed: the record that was written is taken
    // away again.
    const cleanup = buildUninstallSteps({ platform, kind, homeDir, startupDir })
    for (const step of cleanup) {
      if (step.path) {
        try {
          fs.rmSync(step.path, { force: true })
        } catch {
          /* the report says what is left */
        }
        continue
      }
      if (step.file) runCommand(step.file, step.args, { execFileSyncFn: exec })
    }
    try {
      fs.rmSync(paths.dir, { recursive: true, force: true })
    } catch {
      /* nothing else to do */
    }
    return { ...base, kind, degraded, steps, error, config }
  }

  // The kind is known now (it may have changed through the degradation), so the
  // configuration is written again with it.
  config.kind = kind
  writeSupervisorConfig(stateDir, config)

  return {
    ...base,
    ok: true,
    kind,
    degraded,
    installed: true,
    steps,
    error: null,
    config,
    reason: degraded
      ? 'the scheduled task was not allowed; the startup folder is used instead'
      : plan.reason,
  }
}

/**
 * Uninstall the supervisor and give the machine back to the user.
 *
 * @param {{
 *   stateDir?: string,
 *   platform?: string,
 *   homeDir?: string,
 *   startupDir?: string,
 *   dryRun?: boolean,
 *   execFileSyncFn?: Function,
 *   stopSupervisor?: Function,
 *   log?: Function,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean, steps: Array<object>, error: string|null,
 *   pending: object|null, previous: object|null,
 * }>}
 */
export async function uninstallSupervisor(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : ''
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const paths = supervisorPaths(stateDir)
  const exec = typeof options.execFileSyncFn === 'function' ? options.execFileSyncFn : null
  const homeDir = typeof options.homeDir === 'string' && options.homeDir !== '' ? options.homeDir : os.homedir()
  const startupDir = typeof options.startupDir === 'string'
    ? options.startupDir
    : (process.env.APPDATA
      ? path.join(String(process.env.APPDATA), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
      : '')

  const config = readSupervisorConfig(stateDir)
  const kind = config.ok && config.config && typeof config.config.kind === 'string'
    ? config.config.kind
    : (platform === 'win32' ? 'windows-schtasks' : 'systemd-user')
  const previous = config.ok && config.config && config.config.previous && typeof config.config.previous === 'object'
    ? config.config.previous
    : null

  const steps = buildUninstallSteps({ platform, kind, homeDir, startupDir })
  const base = {
    ok: false,
    steps: [],
    error: null,
    pending: null,
    previous,
  }
  if (stateDir === '') return { ...base, error: 'uninstallSupervisor requires stateDir' }

  if (options.dryRun === true) {
    return { ...base, ok: true, steps, error: null, reason: 'dry run: nothing was changed' }
  }

  const done = []

  // (1) Stop the supervisor. The control channel is the polite way; the pid
  // is the fallback.
  const stop = typeof options.stopSupervisor === 'function'
    ? options.stopSupervisor
    : (args) => requestSupervisorAction(args)
  const stopped = await stop({ stateDir, action: 'stop' })
  if (!stopped || stopped.ok !== true) {
    log('the supervisor did not stop through its control channel: ' + String(stopped && stopped.error))
  }
  done.push({ kind: 'stop', description: 'stop the supervisor', ok: true, error: null })

  // (2) The autostart record.
  for (const step of steps) {
    if (step.path) {
      try {
        fs.rmSync(step.path, { force: true })
        done.push({ kind: step.kind, description: step.description, ok: true, error: null })
      } catch (error) {
        done.push({ kind: step.kind, description: step.description, ok: false, error: errorText(error) })
      }
      continue
    }
    const answer = runCommand(step.file, step.args, { execFileSyncFn: exec })
    done.push({ kind: step.kind, description: step.description, ok: answer.ok, error: answer.error })
  }

  // (3) The state directory of the supervisor.
  try {
    fs.rmSync(paths.dir, { recursive: true, force: true })
    done.push({ kind: 'cleanup', description: 'remove the supervisor directory', ok: true, error: null })
  } catch (error) {
    done.push({ kind: 'cleanup', description: 'remove the supervisor directory', ok: false, error: errorText(error) })
  }

  const failed = done.filter((step) => step.ok !== true)
  if (failed.length > 0) {
    // The uninstall did not finish: what is left is written down, with the
    // commands that finish it by hand. A half-removed record that still
    // starts a stale supervisor would be worse than a written-down list.
    const pending = {
      createdAt: new Date().toISOString(),
      failed: failed.map((step) => ({ kind: step.kind, description: step.description, error: step.error })),
      manual: steps.map((step) => (
        step.file
          ? step.file + ' ' + step.args.join(' ')
          : 'delete ' + step.path
      )),
      directory: paths.dir,
    }
    try {
      fs.mkdirSync(paths.dir, { recursive: true })
      fs.writeFileSync(paths.pendingUninstall, JSON.stringify(pending, null, 2) + '\n', 'utf8')
    } catch {
      /* the list is in the answer either way */
    }
    return {
      ...base,
      ok: false,
      steps: done,
      error: 'the uninstall did not finish; the pending cleanup was written to ' + paths.pendingUninstall,
      pending,
    }
  }

  return { ...base, ok: true, steps: done, error: null, pending: null }
}

/**
 * What the plugin knows about the supervisor.
 *
 * THREE SOURCES, ONE ANSWER:
 *
 *   1. the plugin's OWN supervisor (the marker in the environment and the
 *      configuration file it wrote);
 *   2. an EXTERNAL supervisor (systemd, pm2, a `supervise-*.sh` script of the
 *      user) — the parent chain of this very process;
 *   3. the configured mode (`external` = "my own way", `off`).
 *
 * The second one used to be missing here: the status answered "nothing is
 * known about how this host is started" while the parent chain plainly said
 * `/bin/bash /home/fg/supervise-web.sh`. That is not a cosmetic gap — a host
 * that somebody else supervises must NOT be restarted by a self-replay (the
 * supervisor starts it again, and the replay would start a SECOND host on the
 * same port). So the external supervisor is detected here, reported with its
 * evidence, and the self-replay is refused.
 *
 * @param {{
 *   stateDir?: string,
 *   env?: object,
 *   platform?: string,
 *   mode?: string,
 *   ppid?: number,
 *   inspectExternal?: Function,
 *   execFileSyncFn?: Function,
 *   existsSyncFn?: Function,
 * }} [options]
 * @returns {{
 *   mode: 'installed'|'external'|'unknown'|'off',
 *   kind: string|null,
 *   installed: boolean,
 *   running: boolean,
 *   supervised: boolean,
 *   restartCapable: boolean,
 *   reason: string,
 *   external: { kind: string, evidence: string, commandLine: string }|null,
 *   selfReplay: 'allowed'|'refused'|'unknown',
 *   detail: object,
 * }}
 */
export function supervisorStatus(options = {}) {
  const stateDir = typeof options.stateDir === 'string' ? options.stateDir : ''
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const detected = detectSupervisor({ env: options.env, stateDir })
  const config = readSupervisorConfig(stateDir)
  const paths = supervisorPaths(stateDir)
  const installed = config.ok && config.config !== null
  const running = detected.pid !== null && isProcessAlive(detected.pid)
  const kind = installed && config.config && typeof config.config.kind === 'string' ? config.config.kind : null
  const configuredMode = typeof options.mode === 'string' ? options.mode : (installed && config.config ? config.config.mode : 'auto')

  // WHO ELSE IS IN CHARGE? The parent chain of this very process is the
  // evidence (Linux: `/proc/<ppid>/cmdline`). The inspection never throws and
  // always answers — with a reason when it found nothing.
  let external = null
  let externalReason = ''
  try {
    const inspect = typeof options.inspectExternal === 'function'
      ? options.inspectExternal
      : inspectExternalSupervisor
    const found = inspect({
      env: options.env,
      platform,
      ppid: options.ppid,
    })
    externalReason = found && typeof found.reason === 'string' ? found.reason : ''
    if (found && typeof found.kind === 'string' && found.kind !== '') {
      external = {
        kind: found.kind,
        evidence: typeof found.evidence === 'string' ? found.evidence : '',
        commandLine: typeof found.commandLine === 'string' ? found.commandLine : '',
      }
    }
  } catch (error) {
    externalReason = 'the supervisor detection failed: ' + errorText(error)
  }

  let mode = 'unknown'
  let reason = 'nothing is known about how this host is started'
  if (configuredMode === 'external') {
    // The user said so: their own way of starting this host.
    mode = 'external'
    reason = 'this host is started by your own way'
  } else if (installed) {
    mode = 'installed'
    reason = running
      ? 'the supervisor of this plugin is running'
      : 'the supervisor of this plugin is installed but not running'
  } else if (detected.supervised) {
    mode = 'installed'
    reason = 'this instance was started by a supervisor'
  } else if (external !== null) {
    // Somebody else is in charge. The plugin must not start a second copy.
    mode = 'external'
    reason = `this host is started by an external supervisor (${external.kind}, ${external.evidence})`
  } else if (configuredMode === 'off') {
    mode = 'off'
    reason = 'the automatic restart is switched off'
  } else if (externalReason !== '') {
    // "Nothing is known" is NOT "a bare host": the plugin says so instead of
    // pretending it may replay its own command.
    reason = 'it could not be established who starts this host: ' + externalReason
  }

  // The restart can only work when SOMEBODY brings the host back: the
  // supervisor of this plugin, or the one of the user.
  const restartCapable = detected.supervised || mode === 'external' || (mode === 'installed' && running)

  // May the plugin write a command that starts THIS host again? Only when it
  // is in charge itself. With an external supervisor the answer is a plain
  // "no" (the supervisor starts the host again) — and when nothing is known
  // the answer is "unknown", never a silent "yes".
  let selfReplay = 'unknown'
  if (mode === 'installed') selfReplay = 'allowed'
  else if (mode === 'external' || mode === 'off') selfReplay = 'refused'

  // A conflict is a real double-start risk: the supervisor of this plugin is
  // registered AND somebody else is in charge. Both would start the host.
  const conflict = installed && external !== null
  const finalReason = conflict
    ? reason + ' — and an external supervisor (' + external.kind + ') is in charge as well: both would start this host, so one of them has to go'
    : reason

  return {
    mode,
    kind,
    installed,
    running,
    supervised: detected.supervised,
    restartCapable,
    reason: finalReason,
    external,
    selfReplay,
    detail: {
      detected: detected.reason,
      pid: detected.pid,
      control: detected.control,
      configPath: paths.config,
      // The evidence of the external supervisor (and WHY nothing was found).
      externalReason,
      externalChecked: external !== null ? [external.evidence] : [],
      conflict,
      pendingUninstall: (() => {
        try {
          return fs.existsSync(paths.pendingUninstall)
        } catch {
          return false
        }
      })(),
      // What the user has to run by hand when the uninstall did not finish.
      pendingCommands: (() => {
        try {
          const raw = fs.readFileSync(paths.pendingUninstall, 'utf8')
          const parsed = JSON.parse(raw)
          return parsed && Array.isArray(parsed.manual) ? parsed.manual.map(String) : []
        } catch {
          return []
        }
      })(),
    },
  }
}
