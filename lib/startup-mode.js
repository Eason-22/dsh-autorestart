/**
 * dsh-autorestart — HOW THIS HOST WAS STARTED.
 *
 * A hosted web host can be started in a dozen ways, and the plugin has to
 * behave correctly in EVERY one of them:
 *
 *   | # | how it was started                          | what the plugin does            |
 *   |---|---------------------------------------------|---------------------------------|
 *   | 1 | a plain terminal (`dsh web`)                | own supervisor MAY be installed |
 *   | 2 | `nohup … &` / `setsid` (detached)          | same, but the replay is detached|
 *   | 3 | a supervisor script (`supervise-*.sh`)      | external → graceful exit only   |
 *   | 4 | a systemd unit                              | external                        |
 *   | 5 | pm2 / forever                               | external                        |
 *   | 6 | docker / compose / kubernetes                | no "at login"; compose fragment |
 *   | 7 | a Windows scheduled task / NSSM service     | external                        |
 *   | 8 | WSL, started by a Windows process           | unknown (the parent is invisible)|
 *   | 9 | `npx` / `pnpm dlx`                          | usable if the argv can be restored|
 *   |10 | another DSH plugin spawned it               | external/unknown → never a second|
 *   |11 | tmux / screen / an SSH session              | replay, but detached from the session |
 *
 * THE TWO RULES THAT MATTER MORE THAN THE TABLE:
 *
 *   1. **NEVER START A SECOND HOST.** Only a `bare` host may get a
 *      self-replay command, and only a `bare` host may get the supervisor of
 *      this plugin. Everything else is somebody else's business.
 *   2. **WHEN IN DOUBT, BE CONSERVATIVE.** An `unknown` host gets
 *      `selfReplay: 'unknown'` and NO supervisor: the plugin would rather
 *      say "I cannot tell" than start a second host next to the first.
 *
 * The classifier is a PURE function: the process chain, the environment and
 * the container markers are injected, so every row of the table can be
 * tested without a machine.
 *
 * ESM only, Node builtins only.
 */

/** The modes the classifier can answer. */
export const STARTUP_MODES = Object.freeze({
  /** The desktop app: it relaunches itself. */
  DESKTOP: 'desktop',
  /** The supervisor of THIS plugin started the instance. */
  SELF_SUPERVISED: 'self-supervised',
  /** Somebody else (systemd, pm2, a script, a service, another plugin). */
  EXTERNAL: 'external',
  /** Nobody manages it: a terminal, a detached process, a session. */
  BARE: 'bare',
  /** A container: the orchestrator decides, not the machine. */
  CONTAINER: 'container',
  /** It could not be established. */
  UNKNOWN: 'unknown',
})

/** The kinds of a startup mode (the finer answer). */
export const STARTUP_KINDS = Object.freeze({
  DESKTOP_APP: 'desktop-app',
  OWN_SUPERVISOR: 'dsh-autorestart-supervisor',
  SYSTEMD: 'systemd',
  PM2: 'pm2',
  FOREVER: 'forever',
  SCRIPT: 'script',
  WINDOWS_TASK: 'windows-task',
  WINDOWS_SERVICE: 'windows-service',
  DSH_PLUGIN: 'dsh-plugin',
  DOCKER: 'docker',
  KUBERNETES: 'kubernetes',
  TERMINAL: 'terminal',
  DETACHED: 'detached',
  SESSION: 'session',
  PACKAGE_RUNNER: 'package-runner',
  WSL_FROM_WINDOWS: 'wsl-from-windows',
  OPAQUE_WRAPPER: 'opaque-wrapper',
  UNREADABLE_CHAIN: 'unreadable-chain',
})

/** The reason codes of the derivation that follow from a startup mode. */
export const STARTUP_REASONS = Object.freeze({
  DESKTOP: 'desktop-app',
  OWN_SUPERVISOR: 'supervised',
  EXTERNAL: 'external-supervisor',
  BARE: 'ok',
  CONTAINER: 'container-no-init',
  UNKNOWN: 'unknown-startup',
})

/**
 * The environment markers of the common supervisors.
 *
 * They are cheap, exact and need no process tree.
 */
const SUPERVISOR_ENV_MARKERS = Object.freeze([
  { key: 'INVOCATION_ID', kind: STARTUP_KINDS.SYSTEMD, label: 'a systemd unit' },
  { key: 'pm_id', kind: STARTUP_KINDS.PM2, label: 'pm2' },
  { key: 'PM2_HOME', kind: STARTUP_KINDS.PM2, label: 'pm2' },
])

/**
 * The ancestors that mean "somebody else is in charge".
 *
 * The ORDER does not matter here: an external match ANYWHERE in the chain
 * wins, because the nearest ancestor may be a plain shell that a supervisor
 * started (`systemd → bash → dsh web`).
 */
const EXTERNAL_ANCESTORS = Object.freeze([
  { kind: STARTUP_KINDS.SYSTEMD, pattern: /systemd/i, label: 'a systemd unit' },
  { kind: STARTUP_KINDS.PM2, pattern: /\bpm2\b/i, label: 'pm2' },
  { kind: STARTUP_KINDS.FOREVER, pattern: /\bforever\b/i, label: 'forever' },
  {
    kind: STARTUP_KINDS.SCRIPT,
    pattern: /supervise[-_][\w.-]*\.(sh|bash|py|js)|supervisord|\brunsv\b|\bs6-supervise\b|\bmonit\b/i,
    label: 'a supervisor script',
  },
  { kind: STARTUP_KINDS.WINDOWS_SERVICE, pattern: /\bnssm(\.exe)?\b/i, label: 'a Windows service (NSSM)' },
  {
    kind: STARTUP_KINDS.WINDOWS_TASK,
    pattern: /\bsvchost(\.exe)?\b|\btaskhostw(\.exe)?\b/i,
    label: 'the Windows side (a scheduled task or a service)',
  },
  {
    kind: STARTUP_KINDS.DSH_PLUGIN,
    pattern: /[\\/]plugins[\\/][^\\/]+[\\/]/i,
    label: 'another DSH plugin',
  },
])

/** The ancestors that mean "a session" (not a supervisor, but not free either). */
const SESSION_ANCESTORS = Object.freeze([
  { pattern: /\btmux\b/i, label: 'a tmux session' },
  { pattern: /\bscreen\b/i, label: 'a screen session' },
  { pattern: /\bsshd\b|\bssh\b/i, label: 'an SSH session' },
])

/** The ancestors that mean "the command was detached from its shell". */
const DETACHED_ANCESTORS = Object.freeze([
  { pattern: /\bnohup\b/i, label: 'a nohup command' },
  { pattern: /\bsetsid\b/i, label: 'a setsid command' },
])

/** The ancestors that mean "a human started it in a terminal". */
const TERMINAL_ANCESTORS = Object.freeze([
  { pattern: /\b(bash|sh|zsh|fish|dash|ksh|csh|tcsh)\b/i, label: 'a shell' },
  { pattern: /\b(cmd(\.exe)?|powershell(\.exe)?|pwsh(\.exe)?|conhost(\.exe)?|WindowsTerminal(\.exe)?)\b/i, label: 'a Windows terminal' },
])

/** The package runners that may hide the real command line. */
const PACKAGE_RUNNERS = Object.freeze([
  { pattern: /^(npx|pnpm|npm|yarn|bunx|dlx)(\.cmd|\.exe|\.ps1)?$/i, label: 'a package runner' },
])

/** The places in a path that say "a package runner was here". */
const PACKAGE_RUNNER_PATHS = Object.freeze([
  /[\\/]_npx[\\/]/i,
  /[\\/]\.pnpm[\\/]/i,
  /[\\/]node_modules[\\/]\.bin[\\/]/i,
  /[\\/]node_modules[\\/][^\\/]+[\\/]bin[\\/]/i,
])

/**
 * The text of one ancestor (the image name and the command line).
 *
 * @param {{ imageName?: string, commandLine?: string }} entry
 * @returns {string}
 */
function ancestorText(entry) {
  if (!entry || typeof entry !== 'object') return ''
  return [entry.imageName ?? '', entry.commandLine ?? ''].filter(Boolean).join(' ')
}

/**
 * The evidence of one ancestor: what it is and how it was found.
 *
 * @param {{ pid?: number, imageName?: string, commandLine?: string }} entry
 * @returns {string}
 */
function ancestorEvidence(entry) {
  const pid = Number(entry?.pid)
  const text = ancestorText(entry).trim()
  return 'ancestor:' + (Number.isFinite(pid) ? pid : '?') + ': ' + (text === '' ? '?' : text)
}

/**
 * The first ancestor that matches one of the patterns.
 *
 * @param {Array<object>} chain
 * @param {Array<{ pattern: RegExp, label: string, kind?: string }>} patterns
 * @returns {{ entry: object, label: string, kind: string }|null}
 */
function firstMatch(chain, patterns) {
  for (const entry of chain) {
    const text = ancestorText(entry)
    if (text === '') continue
    for (const rule of patterns) {
      if (rule.pattern.test(text)) {
        return { entry, label: rule.label, kind: rule.kind ?? '' }
      }
    }
  }
  return null
}

/**
 * Is this a WSL instance?
 *
 * @param {object} env
 * @returns {boolean}
 */
export function isWsl(env) {
  if (!env || typeof env !== 'object') return false
  if (typeof env.WSL_DISTRO_NAME === 'string' && env.WSL_DISTRO_NAME !== '') return true
  if (typeof env.WSL_INTEROP === 'string' && env.WSL_INTEROP !== '') return true
  return false
}

/**
 * Can the real command line be restored?
 *
 * A package runner (`npx dsh web`) starts the host with the RESOLVED script
 * path in `argv[1]` — that is replayable. A wrapper that erased the command
 * line is not: the plugin must not guess which script it was.
 *
 * @param {{ argv?: string[], execPath?: string }} options
 * @returns {{ ok: boolean, kind: string, label: string, reason: string }}
 */
export function inspectCommandLine(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv.map(String) : []
  const execPath = String(options.execPath ?? '')
  const script = String(argv[1] ?? '').trim()
  const runner = PACKAGE_RUNNERS.find((rule) => (
    rule.pattern.test(argv[0] ?? '') || rule.pattern.test(execPath.split(/[\\/]/).pop() ?? '')
  ))
  const runnerInPath = PACKAGE_RUNNER_PATHS.some((rule) => rule.test(script))
  if (runner === undefined && !runnerInPath) {
    // Not a package runner: the command line is used as it is.
    if (script === '') {
      return { ok: false, kind: STARTUP_KINDS.OPAQUE_WRAPPER, label: 'an unreadable command line', reason: 'the command line of this host cannot be read back' }
    }
    return { ok: true, kind: '', label: '', reason: '' }
  }
  const label = runner !== undefined ? runner.label : 'a package runner'
  // A package runner: the resolved script path must be there, or nothing can
  // be replayed.
  if (script !== '' && (/[\\/]/.test(script) || /\.(mjs|cjs|js)$/i.test(script))) {
    return { ok: true, kind: STARTUP_KINDS.PACKAGE_RUNNER, label, reason: '' }
  }
  return {
    ok: false,
    kind: STARTUP_KINDS.OPAQUE_WRAPPER,
    label,
    reason: 'this host was started through ' + label + ', and the real command line cannot be restored: nothing is guessed',
  }
}

/**
 * The command that starts the host again, DETACHED from the shell that runs
 * it.
 *
 * A host that was started with `nohup … &` (or inside a tmux/ssh session)
 * must not die with the shell that runs the command: the new host has to
 * outlive it.
 *
 * @param {string} command
 * @param {string} platform
 * @returns {string}
 */
export function detachCommand(command, platform) {
  const text = String(command ?? '').trim()
  if (text === '') return ''
  if (platform === 'win32') return 'start "" /B ' + text
  return 'setsid nohup ' + text + ' >/dev/null 2>&1 &'
}

/**
 * Classify HOW this host was started.
 *
 * @param {{
 *   platform?: string,
 *   env?: object,
 *   ppid?: number,
 *   isDesktopApp?: boolean,
 *   supervised?: boolean,
 *   container?: boolean,
 *   argv?: string[],
 *   execPath?: string,
 *   chain?: Array<object>,
 *   readChain?: Function,
 * }} [options]
 * @returns {{
 *   mode: string,
 *   kind: string,
 *   evidence: string,
 *   selfReplay: 'allowed'|'refused'|'unknown'|'n/a',
 *   canInstallSupervisor: boolean,
 *   detachCommand: boolean,
 *   suggestion: string,
 *   chain: Array<object>,
 * }}
 */
export function classifyStartup(options = {}) {
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  const chain = Array.isArray(options.chain)
    ? options.chain
    : readChainSafely(options)
  const wsl = options.wsl === true || (options.wsl === undefined && isWsl(env))

  const answer = (mode, kind, evidence, selfReplay, canInstallSupervisor, suggestion, extra = {}) => ({
    mode,
    kind,
    evidence,
    selfReplay,
    canInstallSupervisor,
    detachCommand: extra.detachCommand === true,
    suggestion,
    chain,
  })

  // (1) THE DESKTOP APP. It relaunches itself; nobody may install anything.
  if (options.isDesktopApp === true) {
    return answer(
      STARTUP_MODES.DESKTOP,
      STARTUP_KINDS.DESKTOP_APP,
      'the executable of this process is the desktop client',
      'n/a',
      false,
      'the desktop app relaunches itself (restartMode: app) — there is no supervisor to install and no command to write',
    )
  }

  // (2) OUR OWN SUPERVISOR started this instance: the restart is asked of it.
  if (options.supervised === true) {
    return answer(
      STARTUP_MODES.SELF_SUPERVISED,
      STARTUP_KINDS.OWN_SUPERVISOR,
      'the environment marker DSH_AUTORESTART_SUPERVISED says who started this instance',
      'n/a',
      false,
      'the supervisor of this plugin is in charge: the restart is handed to it',
    )
  }

  // (3) A CONTAINER. There is no "at login" inside a container; the
  // orchestrator decides (compose: restart: always).
  if (options.container === true) {
    const kubernetes = typeof env.KUBERNETES_SERVICE_HOST === 'string' && env.KUBERNETES_SERVICE_HOST !== ''
    return answer(
      STARTUP_MODES.CONTAINER,
      kubernetes ? STARTUP_KINDS.KUBERNETES : STARTUP_KINDS.DOCKER,
      kubernetes ? 'the environment marker KUBERNETES_SERVICE_HOST' : 'the container markers of this process',
      'refused',
      false,
      'this host runs in a container: there is no "at login" here — the orchestrator brings it back (compose: restart: always)',
    )
  }

  // (4) THE ENVIRONMENT MARKERS of the common supervisors.
  for (const marker of SUPERVISOR_ENV_MARKERS) {
    const value = env[marker.key]
    if (typeof value === 'string' && value !== '') {
      return answer(
        STARTUP_MODES.EXTERNAL,
        marker.kind,
        'env:' + marker.key,
        'refused',
        false,
        'this host is started by ' + marker.label + ' — it brings the host back, so the plugin only exits gracefully',
      )
    }
  }

  // (5) THE PROCESS CHAIN. An external match ANYWHERE in the chain wins: the
  // nearest ancestor may be a plain shell that a supervisor started.
  const external = firstMatch(chain, EXTERNAL_ANCESTORS)
  if (external !== null) {
    return answer(
      STARTUP_MODES.EXTERNAL,
      external.kind === '' ? STARTUP_KINDS.SCRIPT : external.kind,
      ancestorEvidence(external.entry),
      'refused',
      false,
      'this host is started by ' + external.label + ' — it brings the host back, so the plugin only exits gracefully',
    )
  }

  // (6) WSL: a host that the WINDOWS side started has no visible parent
  // here. It must NOT be treated as a bare host.
  if (wsl && (chain.length === 0 || chain.every((entry) => Number(entry.pid) <= 1))) {
    return answer(
      STARTUP_MODES.UNKNOWN,
      STARTUP_KINDS.WSL_FROM_WINDOWS,
      chain.length === 0
        ? 'the parent chain cannot be read (in WSL the Windows side is invisible)'
        : 'the nearest ancestor is the WSL init — the Windows side that started it is invisible',
      'unknown',
      false,
      'this host runs in WSL and was started by a Windows process: the parent is invisible here — pick the plain terminal (install your own supervisor) or configure the start command yourself',
    )
  }

  // (7) THE COMMAND LINE. A package runner that hid the real command line
  // cannot be replayed — and must not be guessed.
  const command = inspectCommandLine({ argv: options.argv, execPath: options.execPath })
  if (!command.ok) {
    return answer(
      STARTUP_MODES.UNKNOWN,
      command.kind,
      command.reason,
      'unknown',
      false,
      'this host was started through ' + command.label + ' and the real command line cannot be restored: nothing is guessed, and no supervisor is installed',
    )
  }

  // (8) A SESSION (tmux / screen / ssh): nobody restarts the host, so a
  // replay is possible — but it must be detached from the session.
  const session = firstMatch(chain, SESSION_ANCESTORS)
  if (session !== null) {
    return answer(
      STARTUP_MODES.BARE,
      STARTUP_KINDS.SESSION,
      ancestorEvidence(session.entry),
      'allowed',
      true,
      'this host runs in ' + session.label + ': nobody brings it back, so the restart command must be detached from the session (setsid/nohup) and needs your confirmation',
      { detachCommand: true },
    )
  }

  // (9) A DETACHED start (`nohup … &`): nobody brings it back either, but
  // the replay must not die with the shell that runs it.
  const detached = firstMatch(chain, DETACHED_ANCESTORS)
  if (detached !== null) {
    return answer(
      STARTUP_MODES.BARE,
      STARTUP_KINDS.DETACHED,
      ancestorEvidence(detached.entry),
      'allowed',
      true,
      'this host was started detached (' + detached.label + '): the restart command must outlive the shell that runs it (setsid/nohup)',
      { detachCommand: true },
    )
  }

  // (10) A PLAIN TERMINAL: nobody manages it. This is the only case in
  // which the plugin may install its own supervisor.
  if (chain.length > 0) {
    const nearest = chain[0]
    const terminal = firstMatch(chain, TERMINAL_ANCESTORS)
    const label = terminal !== null ? terminal.label : 'the process that started it'
    return answer(
      STARTUP_MODES.BARE,
      command.kind === STARTUP_KINDS.PACKAGE_RUNNER ? STARTUP_KINDS.PACKAGE_RUNNER : STARTUP_KINDS.TERMINAL,
      'parent:' + (Number.isFinite(Number(nearest.pid)) ? nearest.pid : '?') + ': '
        + (nearest.imageName !== '' ? nearest.imageName : label)
        + (command.kind === STARTUP_KINDS.PACKAGE_RUNNER ? ' (' + command.label + ')' : ''),
      'allowed',
      true,
      'this host was started by hand in ' + label + ': nobody brings it back, so the plugin may install its own supervisor — or write down the command that starts it again (after your confirmation)',
    )
  }

  // (11) NOTHING COULD BE READ. Say so, and stay conservative.
  return answer(
    STARTUP_MODES.UNKNOWN,
    STARTUP_KINDS.UNREADABLE_CHAIN,
    platform === 'win32'
      ? 'the process table of Windows could not be read: who starts this host is unknown'
      : 'the parent chain cannot be read: who starts this host is unknown',
    'unknown',
    false,
    'it could not be established who starts this host: nothing is written and no supervisor is installed',
  )
}

/**
 * Read the parent chain without ever throwing.
 *
 * @param {{ ppid?: number, platform?: string, readChain?: Function }} options
 * @returns {Array<object>}
 */
function readChainSafely(options) {
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const ppid = Number(options.ppid)
  if (!Number.isFinite(ppid) || ppid <= 0) return []
  const read = typeof options.readChain === 'function' ? options.readChain : null
  if (read === null) return []
  try {
    const chain = read(ppid, { platform })
    return Array.isArray(chain) ? chain : []
  } catch {
    return []
  }
}
