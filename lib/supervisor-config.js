/**
 * dsh-autorestart — E (the derivation of a start command) and B (the dry run).
 *
 * E answers ONE question: **can this host be started again by a command we
 * write down?** It must never guess. A wrong command is worse than no
 * command: it looks like a restart and leaves the user with a dead host.
 *
 * The derivation is built from what the process itself knows:
 *
 *   - `process.execPath`  → the interpreter (node in the hosted mode, the
 *                            desktop exe in the desktop app);
 *   - `process.execArgv`  → the arguments of the interpreter itself;
 *   - `process.argv`      → `[execPath, script, ...args]`; `argv.slice(1)` is
 *                            the command line, replayable AS IT IS;
 *   - `process.cwd()`     → the working directory.
 *
 * → the candidate is `[execPath, ...execArgv, ...argv.slice(1)]`.
 *
 * The PRIORITY (from the design):
 *
 *   - **E0** our own supervisor started this instance → no card at all: the
 *     restart is asked of the supervisor over its control channel;
 *   - **E1** an EXTERNAL supervisor is in charge (systemd, a user script,
 *     pm2) → refuse to install a second one (they would fight over the
 *     port) and write "exit gracefully, the supervisor starts me again";
 *   - **E2** no supervisor and no init (a container) → do not promise an
 *     automatic start: give the command and the orchestrator fragment;
 *   - **E3** no supervisor, an init is available → the normal flow.
 *
 * The REFUSALS (each one has a code, the client translates it):
 *
 *   - `desktop-app`        → the desktop app brings itself back up;
 *   - `not-a-web-host`     → a CLI/TUI host has no port and no watcher;
 *   - `argv-unavailable`   → the command line cannot be read back;
 *   - `external-supervisor`→ somebody else is already the supervisor;
 *   - `container-no-init`  → there is no "at login" on this machine;
 *   - `port-not-fixable`   → the port changes on every start, so the cookie
 *                            of the browser would die with it.
 *
 * ESM only, Node builtins only.
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

/** The reason codes of the derivation (the client translates them). */
export const DERIVE_REASONS = Object.freeze({
  OK: 'ok',
  DESKTOP_APP: 'desktop-app',
  NOT_A_WEB_HOST: 'not-a-web-host',
  ARGV_UNAVAILABLE: 'argv-unavailable',
  EXTERNAL_SUPERVISOR: 'external-supervisor',
  CONTAINER_NO_INIT: 'container-no-init',
  PORT_NOT_FIXABLE: 'port-not-fixable',
  SUPERVISED: 'supervised',
})

/** The modes the derivation can end in. */
export const DERIVE_MODES = Object.freeze({
  /** The plugin's own supervisor is in charge. */
  SUPERVISED: 'supervised',
  /** An external supervisor is in charge: exit gracefully and let it start us. */
  GRACEFUL_EXIT: 'graceful-exit',
  /** A replayable command was derived. */
  REPLAY: 'replay',
  /** Nothing could be derived. */
  REFUSED: 'refused',
})

/**
 * The environment markers of the common supervisors.
 *
 * `INVOCATION_ID` is set by systemd for every unit it starts; `pm_id` and
 * `PM2_HOME` are pm2's. They are cheap, exact and need no process tree.
 */
const SUPERVISOR_ENV_MARKERS = Object.freeze([
  { key: 'INVOCATION_ID', kind: 'systemd' },
  { key: 'pm_id', kind: 'pm2' },
  { key: 'PM2_HOME', kind: 'pm2' },
])

/**
 * The command lines of the common supervisors.
 *
 * The user's own script (`supervise-web.sh`) is matched by the shape of the
 * name: a script that supervises something is a supervisor.
 */
const SUPERVISOR_CMD_PATTERNS = Object.freeze([
  { pattern: /systemd/i, kind: 'systemd' },
  { pattern: /pm2/i, kind: 'pm2' },
  { pattern: /supervisord/i, kind: 'runit' },
  { pattern: /supervise[-_][\w.-]*\.(sh|bash|py|js)/i, kind: 'script' },
  { pattern: /run[-_]?web[-_]?supervisor/i, kind: 'script' },
])

/**
 * Quote one argument for a shell command line.
 *
 * @param {string} value
 * @returns {string}
 */
export function quoteArgument(value) {
  const text = String(value ?? '')
  if (text === '') return '""'
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text
  return '"' + text.replace(/"/g, '\\"') + '"'
}

/**
 * The command line of an argument list.
 *
 * @param {string[]} argv
 * @returns {string}
 */
export function formatCommand(argv) {
  if (!Array.isArray(argv)) return ''
  return argv.map((part) => quoteArgument(part)).join(' ')
}

/**
 * Read the command line of a process (Linux: `/proc/<pid>/cmdline`).
 *
 * @param {number} pid
 * @param {{ readFileSync?: Function }} [options]
 * @returns {string} the command line, or an empty string
 */
export function readProcessCommandLine(pid, options = {}) {
  const read = typeof options.readFileSync === 'function' ? options.readFileSync : fs.readFileSync
  const number = Number(pid)
  if (!Number.isFinite(number) || number <= 0) return ''
  try {
    const raw = read(`/proc/${number}/cmdline`)
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
    return text.split('\0').filter((part) => part !== '').join(' ')
  } catch {
    return ''
  }
}

/**
 * Is somebody ELSE already supervising this host?
 *
 * The answer decides two things: whether a SECOND supervisor may be installed
 * (it may not — two of them fight over the port), and what the restart
 * command has to be (a graceful exit, because the other supervisor starts us
 * again).
 *
 * @param {{
 *   ppid?: number,
 *   env?: object,
 *   platform?: string,
 *   readFileSync?: Function,
 *   selfMarker?: string,
 * }} [options]
 * @returns {{ kind: string, evidence: string, commandLine: string }|null}
 */
export function detectExternalSupervisor(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  const platform = typeof options.platform === 'string' ? options.platform : process.platform

  for (const marker of SUPERVISOR_ENV_MARKERS) {
    const value = env[marker.key]
    if (typeof value === 'string' && value !== '') {
      return { kind: marker.kind, evidence: `env:${marker.key}`, commandLine: '' }
    }
  }

  if (platform === 'win32') return null
  const ppid = Number.isFinite(Number(options.ppid)) ? Number(options.ppid) : process.ppid
  const commandLine = readProcessCommandLine(ppid, options)
  if (commandLine === '') return null
  for (const entry of SUPERVISOR_CMD_PATTERNS) {
    if (entry.pattern.test(commandLine)) {
      return { kind: entry.kind, evidence: `parent:${ppid}`, commandLine }
    }
  }
  return null
}

/**
 * Is this a container (so there is no "at login")?
 *
 * @param {{ existsSync?: Function, env?: object }} [options]
 * @returns {{ container: boolean, evidence: string }}
 */
export function detectContainer(options = {}) {
  const exists = typeof options.existsSyncFn === 'function' ? options.existsSyncFn : fs.existsSync
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  if (env.container === '1' || env.KUBERNETES_SERVICE_HOST) {
    return { container: true, evidence: 'env' }
  }
  if (exists('/.dockerenv')) return { container: true, evidence: '/.dockerenv' }
  if (exists('/run/.containerenv')) return { container: true, evidence: '/run/.containerenv' }
  return { container: false, evidence: '' }
}

/**
 * The `--port` of a command line, if it has one.
 *
 * @param {string[]} argv
 * @returns {{ present: boolean, value: number|null }}
 */
export function readPortArgument(argv) {
  if (!Array.isArray(argv)) return { present: false, value: null }
  for (let index = 0; index < argv.length; index += 1) {
    const part = String(argv[index] ?? '')
    if (part === '--port') {
      const value = Number(argv[index + 1])
      return { present: true, value: Number.isFinite(value) ? value : null }
    }
    if (part.startsWith('--port=')) {
      const value = Number(part.slice('--port='.length))
      return { present: true, value: Number.isFinite(value) ? value : null }
    }
  }
  return { present: false, value: null }
}

/**
 * The command that stops this host GRACEFULLY.
 *
 * It is what an EXTERNAL supervisor needs: the host goes away, the supervisor
 * starts it again. It must NOT be a self-replay command — that would start a
 * SECOND host next to the one the supervisor starts.
 *
 * @param {{ pid?: number, platform?: string }} [options]
 * @returns {string}
 */
export function gracefulExitCommand(options = {}) {
  const pid = Number.isFinite(Number(options.pid)) ? Number(options.pid) : process.pid
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  if (platform === 'win32') return `taskkill /PID ${pid}`
  return `kill -TERM ${pid}`
}

/**
 * Derive the command that starts this host again — or say why there is none.
 *
 * @param {{
 *   execPath?: string,
 *   execArgv?: string[],
 *   argv?: string[],
 *   cwd?: string,
 *   platform?: string,
 *   env?: object,
 *   isDesktopApp?: boolean,
 *   webPort?: number,
 *   supervised?: boolean,
 *   externalSupervisor?: object|null,
 *   container?: boolean,
 *   hasInit?: boolean,
 *   fixedPort?: number,
 *   currentRestartMode?: string,
 *   currentRestartCommand?: string,
 *   healthPath?: string,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   level: 'E0'|'E1'|'E2'|'E3',
 *   mode: string,
 *   reason: string,
 *   command: string|null,
 *   argv: string[]|null,
 *   cwd: string|null,
 *   port: number|null,
 *   portFixed: boolean,
 *   healthUrl: string|null,
 *   needsConfirmation: boolean,
 *   writes: { restartMode: string, restartCommand: string }|null,
 *   plan: Array<{ label: string, value: string }>,
 *   alternatives: string[],
 * }}
 */
export function deriveStartCommand(options = {}) {
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  const execPath = typeof options.execPath === 'string' ? options.execPath : process.execPath
  const execArgv = Array.isArray(options.execArgv) ? options.execArgv.map(String) : []
  const argv = Array.isArray(options.argv) ? options.argv.map(String) : []
  const cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd()
  const isDesktopApp = options.isDesktopApp === true
  const webPort = Number(options.webPort) > 0 ? Number(options.webPort) : 0
  const supervised = options.supervised === true
  const external = options.externalSupervisor && typeof options.externalSupervisor === 'object'
    ? options.externalSupervisor
    : null
  const container = options.container === true
  const hasInit = options.hasInit !== false
  const fixedPort = Number(options.fixedPort) > 0 ? Number(options.fixedPort) : 0
  const healthPath = typeof options.healthPath === 'string' && options.healthPath !== ''
    ? options.healthPath
    : '/__dsh_autorestart/health'

  const base = {
    ok: false,
    level: 'E3',
    mode: DERIVE_MODES.REFUSED,
    reason: DERIVE_REASONS.OK,
    command: null,
    argv: null,
    cwd: null,
    port: null,
    portFixed: false,
    healthUrl: null,
    needsConfirmation: true,
    writes: null,
    plan: [],
    alternatives: [],
  }

  // E0: OUR supervisor started this instance. There is nothing to derive: the
  // restart is asked of the supervisor over its control channel.
  if (supervised) {
    return {
      ...base,
      ok: true,
      level: 'E0',
      mode: DERIVE_MODES.SUPERVISED,
      reason: DERIVE_REASONS.SUPERVISED,
      needsConfirmation: false,
      port: webPort || null,
      healthUrl: webPort > 0 ? `http://127.0.0.1:${webPort}${healthPath}` : null,
      plan: [
        { label: 'supervisor', value: 'the supervisor of this plugin (its control channel)' },
        { label: 'port', value: webPort > 0 ? String(webPort) : 'unknown' },
      ],
    }
  }

  // The desktop app brings ITSELF back up (restartMode: app): there is no
  // command to derive.
  if (isDesktopApp) {
    return {
      ...base,
      level: 'E3',
      mode: DERIVE_MODES.REFUSED,
      reason: DERIVE_REASONS.DESKTOP_APP,
      alternatives: ['app-mode'],
    }
  }

  // A host without a web server has no port and no watcher: the plugin must
  // not even ask.
  if (webPort <= 0) {
    return {
      ...base,
      level: 'E3',
      mode: DERIVE_MODES.REFUSED,
      reason: DERIVE_REASONS.NOT_A_WEB_HOST,
    }
  }

  // E1: somebody else is already the supervisor. A second one would fight
  // over the port — so it is refused, and the restart becomes "exit
  // gracefully, the other supervisor starts us again".
  if (external !== null) {
    const command = gracefulExitCommand({ pid: options.pid, platform })
    return {
      ...base,
      ok: true,
      level: 'E1',
      mode: DERIVE_MODES.GRACEFUL_EXIT,
      reason: DERIVE_REASONS.EXTERNAL_SUPERVISOR,
      command,
      argv: platform === 'win32' ? ['taskkill', '/PID', String(options.pid ?? process.pid)] : ['kill', '-TERM', String(options.pid ?? process.pid)],
      cwd,
      port: webPort,
      healthUrl: `http://127.0.0.1:${webPort}${healthPath}`,
      writes: { restartMode: 'command', restartCommand: command },
      plan: [
        { label: 'supervisor', value: `${external.kind} (${external.evidence})` },
        { label: 'command', value: command },
        { label: 'port', value: String(webPort) },
        { label: 'health', value: `http://127.0.0.1:${webPort}${healthPath}` },
      ],
      alternatives: [],
    }
  }

  // The command line has to be readable back: without `argv[1]` the host was
  // started by a wrapper that erased it, and a replay would start the WRONG
  // thing.
  if (argv.length < 2 || String(argv[1] ?? '').trim() === '') {
    return {
      ...base,
      level: 'E3',
      mode: DERIVE_MODES.REFUSED,
      reason: DERIVE_REASONS.ARGV_UNAVAILABLE,
      alternatives: ['install-supervisor'],
    }
  }

  // The port has to be FIXED: a random port changes the authority of the
  // cookie, so the browser is kicked out after every restart.
  const portArgument = readPortArgument(argv.slice(1))
  let port = webPort
  let portFixed = false
  let replayArgv = [execPath, ...execArgv, ...argv.slice(1)]
  if (!portArgument.present || portArgument.value === null || portArgument.value === 0) {
    if (fixedPort <= 0) {
      // Without a fixed port there is no way to keep the browser logged in.
      return {
        ...base,
        level: 'E3',
        mode: DERIVE_MODES.REFUSED,
        reason: DERIVE_REASONS.PORT_NOT_FIXABLE,
        alternatives: ['install-supervisor'],
      }
    }
    port = fixedPort
    portFixed = true
    replayArgv = [...replayArgv, '--port', String(fixedPort)]
  } else {
    port = portArgument.value
  }

  const command = formatCommand(replayArgv)

  // E2: a container has no "at login": the plugin does not promise an
  // automatic start, it hands out the command and the orchestrator fragment.
  if (container || !hasInit) {
    return {
      ...base,
      ok: true,
      level: 'E2',
      mode: DERIVE_MODES.REPLAY,
      reason: DERIVE_REASONS.CONTAINER_NO_INIT,
      command,
      argv: replayArgv,
      cwd,
      port,
      portFixed,
      healthUrl: `http://127.0.0.1:${port}${healthPath}`,
      writes: { restartMode: 'command', restartCommand: command },
      plan: [
        { label: 'command', value: command },
        { label: 'cwd', value: cwd },
        { label: 'port', value: String(port) },
        { label: 'health', value: `http://127.0.0.1:${port}${healthPath}` },
      ],
      alternatives: ['install-supervisor', 'orchestrator-fragment'],
    }
  }

  // E3: the normal flow. The command is written down only after the user
  // confirmed it (the dry run shows it first).
  return {
    ...base,
    ok: true,
    level: 'E3',
    mode: DERIVE_MODES.REPLAY,
    reason: DERIVE_REASONS.OK,
    command,
    argv: replayArgv,
    cwd,
    port,
    portFixed,
    healthUrl: `http://127.0.0.1:${port}${healthPath}`,
    writes: { restartMode: 'command', restartCommand: command },
    plan: [
      { label: 'command', value: command },
      { label: 'cwd', value: cwd },
      { label: 'port', value: String(port) },
      { label: 'health', value: `http://127.0.0.1:${port}${healthPath}` },
    ],
    alternatives: ['install-supervisor'],
  }
}

/**
 * Pick a free port.
 *
 * It is used when the host listens on a random port: the port has to be
 * FIXED, or the authority of the browser's cookie changes with every start
 * and the user is logged out after every restart.
 *
 * @returns {Promise<number>} the port (0 when nothing was free)
 */
export function pickFreePort() {
  return new Promise((resolve) => {
    let settled = false
    const done = (port) => {
      if (settled) return
      settled = true
      resolve(port)
    }
    const server = net.createServer()
    server.on('error', () => done(0))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? Number(address.port) : 0
      try {
        server.close(() => done(port))
      } catch {
        done(port)
      }
    })
  })
}

/**
 * The dry run: everything the user has to see BEFORE anything is written.
 *
 * It answers "what would happen" — it never runs anything.
 *
 * @param {object} derivation the answer of {@link deriveStartCommand}
 * @returns {{
 *   ok: boolean,
 *   level: string,
 *   mode: string,
 *   reason: string,
 *   plan: Array<{ label: string, value: string }>,
 *   command: string|null,
 *   writes: object|null,
 *   needsConfirmation: boolean,
 * }}
 */
export function buildDryRunPlan(derivation) {
  const value = derivation && typeof derivation === 'object' ? derivation : {}
  return {
    ok: value.ok === true,
    level: typeof value.level === 'string' ? value.level : 'E3',
    mode: typeof value.mode === 'string' ? value.mode : DERIVE_MODES.REFUSED,
    reason: typeof value.reason === 'string' ? value.reason : DERIVE_REASONS.OK,
    plan: Array.isArray(value.plan) ? value.plan : [],
    command: typeof value.command === 'string' ? value.command : null,
    writes: value.writes && typeof value.writes === 'object' ? value.writes : null,
    needsConfirmation: value.needsConfirmation !== false,
  }
}

/**
 * The compose fragment for a machine without a service manager.
 *
 * The command is an ARGUMENT LIST, not a string: a path with a space in it
 * must not be cut in half.
 *
 * @param {string[]|string} argv
 * @returns {string}
 */
export function composeRestartFragment(argv) {
  const list = Array.isArray(argv)
    ? argv.map((part) => String(part))
    : String(argv ?? '').split(' ').filter((part) => part !== '')
  return [
    'services:',
    '  dsh:',
    '    image: <your dsh image>',
    '    command: ' + JSON.stringify(list),
    '    restart: always',
  ].join('\n')
}

/**
 * The path of the supervisor script inside the package (for the E0 control
 * command).
 *
 * @param {string} stateDir
 * @returns {string}
 */
export function supervisorScriptPath(stateDir) {
  return path.join(String(stateDir ?? ''), 'supervisor', 'supervisor.js')
}
