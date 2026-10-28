/**
 * dsh-autorestart — the supervisor.
 *
 * WHY A SEPARATE PROCESS. The plugin lives INSIDE the host. When the host
 * dies, the plugin dies with it — so the plugin can never be the thing that
 * brings the host back. The supervisor is therefore a standalone Node process
 * (zero dependencies, no plugin imports) that the plugin COPIES into the
 * state directory and registers with the platform's "start at login"
 * mechanism.
 *
 * WHAT IT DOES (the whole job, in order):
 *
 *   1. take the exclusive lock — a second supervisor must never race the
 *      first one (two supervisors = two hosts = two web servers);
 *   2. write its pid and open the control channel (a loopback TCP socket);
 *   3. start the host with the command from `supervisor.json`;
 *   4. watch it. When it exits, wait a backoff and start it again;
 *   5. when the host does NOT come back, restore the snapshot the plugin
 *      asked for (`rollback-request.json`) and try once more;
 *   6. answer the control channel: `restart` (kill + start again) and `stop`
 *      (kill and exit).
 *
 * THE BACKOFF. The delay doubles after every failed start (1s → 2s → 4s …)
 * and is capped (30s by default). It is reset to the base delay ONLY after a
 * start that actually worked — a host that starts and dies again keeps the
 * delay, so a crash loop does not become a spawn loop.
 *
 * THE ENVIRONMENT. The host is NOT started with `env: process.env`: that
 * would carry the host's own internal variables (`DSH_HOME`, `DSH_PROFILE`,
 * …) into the next start and the profile would drift. Only a WHITELIST is
 * inherited, plus the two profile variables the plugin knows and the three
 * markers that tell the plugin "I was started by the supervisor".
 *
 * STANDALONE. This file is copied to `<stateDir>/supervisor/supervisor.js`
 * and runs from there: it imports NOTHING from the plugin (a rollback of the
 * plugin tree would take the supervisor with it otherwise).
 *
 * Usage: `node supervisor.js --config <supervisor.json>`
 */

import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** The version of the supervisor configuration this file understands. */
export const SUPERVISOR_CONFIG_VERSION = 1

/** The name of the autostart record (a scheduled task / a systemd unit). */
export const SUPERVISOR_TASK_NAME = 'dsh-autorestart-web'

/** The environment marker that says "a supervisor started me". */
export const SUPERVISED_ENV = 'DSH_AUTORESTART_SUPERVISED'

/** The environment marker that carries the supervisor's pid. */
export const SUPERVISOR_PID_ENV = 'DSH_AUTORESTART_SUPERVISOR_PID'

/** The environment marker that carries the restart generation. */
export const GENERATION_ENV = 'DSH_AUTORESTART_GENERATION'

/**
 * The variables the host inherits from the supervisor.
 *
 * Everything else is dropped on purpose: the host's own internal variables
 * (`DSH_HOME`, `DSH_PROFILE`, …) must NOT leak into the next start.
 */
export const INHERITED_ENV_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'NUMBER_OF_PROCESSORS',
  'WSLENV',
  'WSL_DISTRO_NAME',
  'WSL_INTEROP',
])

/**
 * The profile files a rollback puts back.
 *
 * The SAME list lives in `lib/backup.js` of the plugin. It is written out
 * here on purpose: the supervisor is a standalone process and may not import
 * the plugin (a rollback of the plugin tree would take it down with it).
 * `test/supervisor.test.mjs` asserts that the two lists agree.
 */
export const CONFIG_FILES = Object.freeze(['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml'])

/** The directory (inside the profile) that holds the installed plugins. */
export const PLUGINS_DIR = 'node_modules'

/** The default backoff: the first retry waits this long. */
export const DEFAULT_RESTART_DELAY_MS = 1000

/** The default cap of the backoff. */
export const DEFAULT_RESTART_DELAY_MAX_MS = 30000

/** The default time the supervisor waits for the host to answer. */
export const DEFAULT_START_TIMEOUT_MS = 90000

/** The default grace period between SIGTERM and SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 15000

/** The default time the supervisor waits for the port to become free. */
export const DEFAULT_PORT_FREE_TIMEOUT_MS = 30000

/** The log file grows to this size before it is truncated. */
export const MAX_LOG_BYTES = 2 * 1024 * 1024

/** @param {unknown} value */
function errorText(value) {
  if (value && typeof value.message === 'string' && value.message) return value.message
  return String(value)
}

/**
 * Parse the command line of the supervisor.
 *
 * @param {string[]} argv
 * @returns {{ configPath: string|null, help: boolean }}
 */
export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : []
  let configPath = null
  for (let index = 0; index < list.length; index += 1) {
    const arg = String(list[index] ?? '')
    if (arg === '--config' || arg === '-c') {
      configPath = typeof list[index + 1] === 'string' ? list[index + 1] : null
      index += 1
      continue
    }
    if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length)
      continue
    }
    if (arg === '--help' || arg === '-h') return { configPath: null, help: true }
  }
  return { configPath, help: false }
}

/**
 * The environment the host is started with.
 *
 * @param {object} baseEnv the environment of the supervisor
 * @param {{ supervisorPid?: number, generation?: number, profileEnv?: object }} [options]
 * @returns {Record<string, string>}
 */
export function buildChildEnv(baseEnv, options = {}) {
  const source = baseEnv && typeof baseEnv === 'object' ? baseEnv : {}
  const env = {}
  for (const key of INHERITED_ENV_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  const profileEnv = options.profileEnv && typeof options.profileEnv === 'object' ? options.profileEnv : {}
  for (const [key, value] of Object.entries(profileEnv)) {
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  env[SUPERVISED_ENV] = '1'
  if (Number.isFinite(Number(options.supervisorPid))) env[SUPERVISOR_PID_ENV] = String(options.supervisorPid)
  if (Number.isFinite(Number(options.generation))) env[GENERATION_ENV] = String(options.generation)
  return env
}

/**
 * The next backoff delay.
 *
 * The delay DOUBLES (and is capped). It is reset to the base delay only
 * after a start that worked — see {@link shouldResetBackoff}.
 *
 * @param {number} current the delay of the last attempt
 * @param {{ baseMs?: number, maxMs?: number }} [options]
 * @returns {number} the delay for the next attempt, in milliseconds
 */
export function nextRestartDelay(current, options = {}) {
  const base = Number.isFinite(Number(options.baseMs)) && Number(options.baseMs) > 0
    ? Math.trunc(Number(options.baseMs))
    : DEFAULT_RESTART_DELAY_MS
  const max = Number.isFinite(Number(options.maxMs)) && Number(options.maxMs) > 0
    ? Math.trunc(Number(options.maxMs))
    : DEFAULT_RESTART_DELAY_MAX_MS
  const previous = Number.isFinite(Number(current)) && Number(current) > 0 ? Math.trunc(Number(current)) : base
  if (previous >= max) return max
  return Math.min(max, previous * 2)
}

/**
 * Whether the backoff is reset after this attempt.
 *
 * ONLY a start that worked resets it: a host that starts and dies again
 * keeps the delay, so a crash loop does not become a spawn loop.
 *
 * @param {boolean} healthy whether the host answered its health route
 * @returns {boolean}
 */
export function shouldResetBackoff(healthy) {
  return healthy === true
}

/**
 * Whether a pid is alive.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  const number = Number(pid)
  if (!Number.isFinite(number) || number <= 0) return false
  try {
    process.kill(number, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to somebody else.
    return error && error.code === 'EPERM'
  }
}

/**
 * Take the exclusive lock of the supervisor.
 *
 * A lock that belongs to a DEAD process is stale and is taken over — a
 * supervisor that was killed must not block its own successor for ever.
 *
 * @param {string} lockPath
 * @param {{ pid?: number, isAlive?: (pid: number) => boolean }} [options]
 * @returns {{ ok: boolean, stale: boolean, error: string|null }}
 */
export function acquireLock(lockPath, options = {}) {
  const file = typeof lockPath === 'string' ? lockPath.trim() : ''
  if (file === '') return { ok: false, stale: false, error: 'acquireLock requires a path' }
  const pid = Number.isFinite(Number(options.pid)) ? Number(options.pid) : process.pid
  const alive = typeof options.isAlive === 'function' ? options.isAlive : isProcessAlive
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  } catch {
    /* the directory may already be there */
  }
  try {
    const handle = fs.openSync(file, 'wx')
    try {
      fs.writeFileSync(handle, JSON.stringify({ pid, at: new Date().toISOString() }), 'utf8')
    } catch {
      /* the owner is what matters */
    }
    try {
      fs.closeSync(handle)
    } catch {
      /* nothing else to do */
    }
    return { ok: true, stale: false, error: null }
  } catch {
    // The lock exists: is its owner still alive?
    let owner = 0
    try {
      const raw = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      owner = Number(parsed && parsed.pid)
    } catch {
      owner = 0
    }
    if (owner > 0 && alive(owner)) {
      return { ok: false, stale: false, error: 'another supervisor is already running (pid ' + owner + ')' }
    }
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* the takeover fails below */
    }
    try {
      const handle = fs.openSync(file, 'wx')
      try {
        fs.writeFileSync(handle, JSON.stringify({ pid, at: new Date().toISOString() }), 'utf8')
      } catch {
        /* the owner is what matters */
      }
      try {
        fs.closeSync(handle)
      } catch {
        /* nothing else to do */
      }
      return { ok: true, stale: true, error: null }
    } catch (error) {
      return { ok: false, stale: false, error: errorText(error) }
    }
  }
}

/**
 * Release the lock.
 *
 * @param {string} lockPath
 * @returns {boolean}
 */
export function releaseLock(lockPath) {
  try {
    fs.rmSync(String(lockPath ?? ''), { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Whether a port is free (nothing is listening on it).
 *
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export function isPortFree(port, host = '127.0.0.1') {
  const number = Number(port)
  if (!Number.isFinite(number) || number <= 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const socket = net.connect({ port: number, host })
    const done = (free) => {
      try {
        socket.destroy()
      } catch {
        /* nothing else to do */
      }
      resolve(free)
    }
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
    socket.setTimeout(1000, () => done(true))
  })
}

/**
 * Wait until a port is free.
 *
 * @param {number} port
 * @param {{ timeoutMs?: number, intervalMs?: number, host?: string, isFree?: Function }} [options]
 * @returns {Promise<boolean>} whether the port became free in time
 */
export async function waitForPortFree(port, options = {}) {
  const timeout = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Math.trunc(Number(options.timeoutMs))
    : DEFAULT_PORT_FREE_TIMEOUT_MS
  const interval = Number.isFinite(Number(options.intervalMs)) && Number(options.intervalMs) > 0
    ? Math.trunc(Number(options.intervalMs))
    : 500
  const isFree = typeof options.isFree === 'function' ? options.isFree : isPortFree
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await isFree(port, options.host || '127.0.0.1')) return true
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  return false
}

/**
 * Read the configuration of the supervisor.
 *
 * @param {string} configPath
 * @returns {{ ok: boolean, config: object|null, error: string|null }}
 */
export function readConfig(configPath) {
  const file = typeof configPath === 'string' ? configPath.trim() : ''
  if (file === '') return { ok: false, config: null, error: 'readConfig requires a path' }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return { ok: false, config: null, error: 'the configuration is not an object' }
    return { ok: true, config: parsed, error: null }
  } catch (error) {
    return { ok: false, config: null, error: errorText(error) }
  }
}

/**
 * Append a line to the log file (and truncate it when it grew too big).
 *
 * @param {string} logPath
 * @param {string} message
 * @returns {boolean} whether the line was written
 */
export function appendLog(logPath, message) {
  const file = typeof logPath === 'string' ? logPath.trim() : ''
  if (file === '') return false
  const line = new Date().toISOString() + ' ' + String(message ?? '') + '\n'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      const stat = fs.statSync(file)
      if (stat.size > MAX_LOG_BYTES) fs.rmSync(file, { force: true })
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(file, line, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * The answer of the control channel to one request.
 *
 * @param {unknown} request
 * @returns {{ ok: boolean, action: string, error: string|null }}
 */
export function buildControlResponse(request) {
  const body = request && typeof request === 'object' ? request : {}
  const action = typeof body.action === 'string' ? body.action.trim() : ''
  if (action === 'ping') return { ok: true, action: 'ping', error: null }
  if (action === 'restart') return { ok: true, action: 'restart', error: null }
  if (action === 'stop') return { ok: true, action: 'stop', error: null }
  return { ok: false, action: '', error: 'unknown action' }
}

/**
 * Restore a snapshot over the profile.
 *
 * The same semantics as `restoreBackup` in the plugin, implemented here
 * because the supervisor may not import the plugin.
 *
 * @param {{ backupDir?: string, profileDir?: string }} options
 * @returns {{ ok: boolean, restored: string[], error: string|null }}
 */
export function restoreSnapshot({ backupDir = '', profileDir = '' } = {}) {
  const backup = typeof backupDir === 'string' ? backupDir.trim() : ''
  const profile = typeof profileDir === 'string' ? profileDir.trim() : ''
  const restored = []
  if (backup === '') return { ok: false, restored, error: 'restoreSnapshot requires backupDir' }
  if (profile === '') return { ok: false, restored, error: 'restoreSnapshot requires profileDir' }
  try {
    const configDir = path.join(backup, 'config')
    for (const name of CONFIG_FILES) {
      const source = path.join(configDir, name)
      if (!fs.existsSync(source)) continue
      fs.copyFileSync(source, path.join(profile, name))
      restored.push(name)
    }
    const plugins = path.join(backup, PLUGINS_DIR)
    if (fs.existsSync(plugins)) {
      fs.cpSync(plugins, path.join(profile, PLUGINS_DIR), { recursive: true, force: true })
      restored.push(PLUGINS_DIR)
    }
  } catch (error) {
    return { ok: false, restored, error: errorText(error) }
  }
  if (restored.length === 0) return { ok: false, restored, error: 'the snapshot holds nothing that could be restored' }
  return { ok: true, restored, error: null }
}

/**
 * Read the rollback request the plugin left behind.
 *
 * @param {string} file
 * @returns {object|null}
 */
export function readRollbackRequest(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(String(file ?? ''), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Ask the health route whether the host is alive.
 *
 * The URL is the LOOPBACK one WITHOUT a token: the plugin's health route
 * answers loopback requests without authentication, so the supervisor never
 * needs (and never sees) the boot token.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export function probeHealth(url, options = {}) {
  const target = typeof url === 'string' ? url.trim() : ''
  if (target === '') return Promise.resolve(false)
  const timeout = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Math.trunc(Number(options.timeoutMs))
    : 5000
  return new Promise((resolve) => {
    let settled = false
    const done = (healthy) => {
      if (settled) return
      settled = true
      resolve(healthy)
    }
    let request
    try {
      request = http.get(target, { timeout }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            done(body && body.ok === true)
          } catch {
            done(false)
          }
        })
        response.on('error', () => done(false))
      })
    } catch {
      done(false)
      return
    }
    request.on('timeout', () => {
      try {
        request.destroy()
      } catch {
        /* nothing else to do */
      }
      done(false)
    })
    request.on('error', () => done(false))
  })
}

/**
 * Start the host and wait until it exits.
 *
 * @param {{
 *   config: object,
 *   generation: number,
 *   log: (message: string) => void,
 *   spawnFn?: Function,
 *   onControl?: (action: string) => void,
 * }} options
 * @returns {Promise<{ code: number|null, signal: string|null, stopped: boolean }>}
 */
export async function runChild({ config, generation = 1, log = () => {}, spawnFn = spawn, onControl = null } = {}) {
  const execPath = typeof config.execPath === 'string' ? config.execPath : ''
  const execArgv = Array.isArray(config.execArgv) ? config.execArgv.map(String) : []
  const argv = Array.isArray(config.argv) ? config.argv.map(String) : []
  if (execPath === '' || argv.length === 0) {
    log('the configuration has no start command')
    return { code: null, signal: null, stopped: false }
  }
  const env = buildChildEnv(process.env, {
    supervisorPid: process.pid,
    generation,
    profileEnv: config.profileEnv && typeof config.profileEnv === 'object' ? config.profileEnv : {},
  })
  log('starting the host: ' + [execPath, ...execArgv, ...argv].join(' '))
  const child = spawnFn(execPath, [...execArgv, ...argv], {
    cwd: typeof config.cwd === 'string' && config.cwd !== '' ? config.cwd : process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (child.stdout && typeof child.stdout.on === 'function') {
    child.stdout.on('data', (chunk) => log('host: ' + String(chunk).trimEnd()))
  }
  if (child.stderr && typeof child.stderr.on === 'function') {
    child.stderr.on('data', (chunk) => log('host: ' + String(chunk).trimEnd()))
  }
  return await new Promise((resolve) => {
    let stopped = false
    let settled = false
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      resolve({ code, signal, stopped })
    }
    if (typeof onControl === 'function') {
      onControl((action) => {
        if (action === 'stop') {
          stopped = true
          try {
            child.kill('SIGTERM')
          } catch {
            /* nothing else to do */
          }
        }
        if (action === 'restart') {
          try {
            child.kill('SIGTERM')
          } catch {
            /* nothing else to do */
          }
        }
      })
    }
    child.on('error', (error) => {
      log('the host could not be started: ' + errorText(error))
      finish(null, null)
    })
    child.on('exit', (code, signal) => {
      log('the host exited (code ' + String(code) + ', signal ' + String(signal) + ')')
      finish(code === undefined ? null : code, signal ?? null)
    })
  })
}

/**
 * The control channel: a loopback TCP socket the plugin can talk to.
 *
 * @param {{ host?: string, port?: number, onAction?: (action: string) => void, log?: (message: string) => void }} options
 * @returns {Promise<{ ok: boolean, port: number, close: () => void, error: string|null }>}
 */
export function openControlChannel(options = {}) {
  const host = typeof options.host === 'string' && options.host !== '' ? options.host : '127.0.0.1'
  const log = typeof options.log === 'function' ? options.log : () => {}
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += String(chunk)
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          let request = null
          try {
            request = JSON.parse(line)
          } catch {
            request = null
          }
          const response = buildControlResponse(request)
          try {
            socket.write(JSON.stringify(response) + '\n')
          } catch {
            /* the socket is gone */
          }
          if (response.ok && typeof options.onAction === 'function') options.onAction(response.action)
          index = buffer.indexOf('\n')
        }
      })
      socket.on('error', () => {
        /* a broken client must not take the supervisor down */
      })
    })
    server.on('error', (error) => {
      log('the control channel could not be opened: ' + errorText(error))
      resolve({ ok: false, port: 0, close: () => {}, error: errorText(error) })
    })
    server.listen(options.port && Number(options.port) > 0 ? Number(options.port) : 0, host, () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? Number(address.port) : 0
      resolve({
        ok: true,
        port,
        close: () => {
          try {
            server.close()
          } catch {
            /* nothing else to do */
          }
        },
        error: null,
      })
    })
  })
}

/**
 * The main loop of the supervisor.
 *
 * @param {{
 *   config: object,
 *   stateDir?: string,
 *   log?: (message: string) => void,
 *   spawnFn?: Function,
 *   probe?: (url: string, options: object) => Promise<boolean>,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} options
 * @returns {Promise<{ ok: boolean, reason: string }>}
 */
export async function runSupervisor(options = {}) {
  const config = options.config && typeof options.config === 'object' ? options.config : {}
  const log = typeof options.log === 'function' ? options.log : () => {}
  const probe = typeof options.probe === 'function' ? options.probe : probeHealth
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const stateDir = typeof options.stateDir === 'string' && options.stateDir !== ''
    ? options.stateDir
    : (typeof config.stateDir === 'string' ? config.stateDir : '')
  const supervisorDir = path.join(stateDir, 'supervisor')
  const lockPath = path.join(supervisorDir, 'supervisor.lock')
  const pidPath = path.join(supervisorDir, 'supervisor.pid')
  const controlPath = path.join(supervisorDir, 'control.json')
  const rollbackRequestPath = path.join(supervisorDir, 'rollback-request.json')
  const reportPath = path.join(stateDir, 'last-rollback.json')

  const lock = acquireLock(lockPath)
  if (!lock.ok) {
    log('another supervisor is already running: ' + String(lock.error))
    return { ok: false, reason: String(lock.error) }
  }
  if (lock.stale) log('the lock of a dead supervisor was taken over')

  const timings = config.timings && typeof config.timings === 'object' ? config.timings : {}
  const baseDelay = Number(timings.restartDelayMs) > 0 ? Number(timings.restartDelayMs) : DEFAULT_RESTART_DELAY_MS
  const maxDelay = Number(timings.restartDelayMaxMs) > 0 ? Number(timings.restartDelayMaxMs) : DEFAULT_RESTART_DELAY_MAX_MS
  const startTimeout = Number(timings.startTimeoutMs) > 0 ? Number(timings.startTimeoutMs) : DEFAULT_START_TIMEOUT_MS
  const killGrace = Number(timings.killGraceMs) > 0 ? Number(timings.killGraceMs) : DEFAULT_KILL_GRACE_MS
  const portFreeTimeout = Number(timings.portFreeTimeoutMs) > 0
    ? Number(timings.portFreeTimeoutMs)
    : DEFAULT_PORT_FREE_TIMEOUT_MS

  try {
    fs.mkdirSync(supervisorDir, { recursive: true })
    fs.writeFileSync(pidPath, String(process.pid), 'utf8')
  } catch {
    /* the lock is the real guard */
  }

  let pendingAction = null
  const channel = await openControlChannel({
    host: config.control && typeof config.control.host === 'string' ? config.control.host : '127.0.0.1',
    port: config.control && Number(config.control.port) > 0 ? Number(config.control.port) : 0,
    log,
    onAction: (action) => {
      pendingAction = action
    },
  })
  if (!channel.ok) {
    releaseLock(lockPath)
    return { ok: false, reason: String(channel.error) }
  }
  try {
    fs.writeFileSync(controlPath, JSON.stringify({
      type: 'tcp',
      host: config.control && typeof config.control.host === 'string' ? config.control.host : '127.0.0.1',
      port: channel.port,
      pid: process.pid,
      at: new Date().toISOString(),
    }), 'utf8')
  } catch {
    /* the control port is written into the config as well */
  }
  log('the supervisor is up (pid ' + process.pid + ', control port ' + channel.port + ')')

  let delay = baseDelay
  let generation = Number(config.generation) > 0 ? Number(config.generation) : 1
  let stopping = false
  try {
    while (!stopping) {
      const port = Number(config.port) > 0 ? Number(config.port) : 0
      if (port > 0) {
        const free = await waitForPortFree(port, { timeoutMs: portFreeTimeout })
        if (!free) log('the port ' + port + ' is still taken; starting anyway')
      }
      const result = await runChild({
        config,
        generation,
        log,
        spawnFn: options.spawnFn,
        onControl: (action) => {
          pendingAction = action
        },
      })
      if (pendingAction === 'stop') {
        stopping = true
        log('the supervisor was asked to stop')
        break
      }
      if (pendingAction === 'restart') {
        pendingAction = null
        log('the supervisor was asked to restart the host')
        delay = baseDelay
        continue
      }
      pendingAction = null

      // The host exited. Did it come back on its own (a self-healing host)?
      const deadline = Date.now() + startTimeout
      let healthy = false
      while (Date.now() < deadline) {
        healthy = await probe(config.healthUrl, { timeoutMs: 5000 })
        if (healthy) break
        await sleep(2000)
      }
      if (healthy) {
        log('the host is answering its health route again; the supervisor waits')
        delay = shouldResetBackoff(true) ? baseDelay : delay
        await sleep(delay)
        continue
      }

      // It never came back. A snapshot may be waiting to be put back.
      const request = readRollbackRequest(rollbackRequestPath)
      if (request && typeof request.backupDir === 'string') {
        log('the host never came back; restoring the snapshot')
        const restored = restoreSnapshot({
          backupDir: request.backupDir,
          profileDir: typeof request.profileDir === 'string' ? request.profileDir : '',
        })
        try {
          fs.writeFileSync(reportPath, JSON.stringify({
            ok: false,
            at: new Date().toISOString(),
            waitedMs: startTimeout,
            rolledBack: restored.ok === true,
            rollbackError: restored.ok === true ? null : String(restored.error),
            reason: 'the host never came back',
            backupDir: request.backupDir,
            appStarted: false,
          }), 'utf8')
        } catch {
          /* the report is advisory */
        }
        try {
          fs.rmSync(rollbackRequestPath, { force: true })
        } catch {
          /* nothing else to do */
        }
        generation += 1
        continue
      }

      delay = nextRestartDelay(delay, { baseMs: baseDelay, maxMs: maxDelay })
      log('restarting the host in ' + delay + 'ms')
      await sleep(delay)
    }
  } finally {
    channel.close()
    try {
      fs.rmSync(pidPath, { force: true })
    } catch {
      /* nothing else to do */
    }
    releaseLock(lockPath)
  }
  return { ok: true, reason: 'the supervisor stopped' }
}

/**
 * The entry point: `node supervisor.js --config <supervisor.json>`.
 *
 * @param {string[]} [argv]
 * @returns {Promise<{ ok: boolean, reason: string }>}
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    // eslint-disable-next-line no-console
    console.log('usage: node supervisor.js --config <supervisor.json>')
    return { ok: true, reason: 'help' }
  }
  if (!args.configPath) {
    // eslint-disable-next-line no-console
    console.error('the supervisor needs --config <supervisor.json>')
    return { ok: false, reason: 'no --config' }
  }
  const read = readConfig(args.configPath)
  if (!read.ok) {
    // eslint-disable-next-line no-console
    console.error('the supervisor configuration could not be read: ' + String(read.error))
    return { ok: false, reason: String(read.error) }
  }
  const config = read.config
  const stateDir = typeof config.stateDir === 'string' ? config.stateDir : path.dirname(path.dirname(args.configPath))
  const logPath = path.join(stateDir, 'supervisor', 'supervisor.log')
  const log = (message) => {
    appendLog(logPath, message)
    // eslint-disable-next-line no-console
    console.log(message)
  }
  return await runSupervisor({ config: { ...config, stateDir }, stateDir, log })
}

// The file is a script AND a module: the tests import the pure pieces, the
// scheduler runs it.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1]
    if (!entry) return false
    return path.resolve(entry) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  void main()
}
