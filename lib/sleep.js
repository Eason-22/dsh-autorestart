/**
 * dsh-autorestart — the host half of the graceful sleep ("优雅挂机").
 *
 * The feature waits until every conversation is idle, counts down on screen and
 * then powers the REAL host machine off.
 *
 * The hard part is the host detection. When the Host runs inside WSL, shutting
 * the distro down (or calling `wsl.exe --shutdown`) only stops the subsystem:
 * Windows keeps running, so nothing was really switched off. This module
 * therefore detects the host and always produces a command that reaches the
 * physical machine:
 *
 *   win32             → shutdown.exe /s /f /t 0
 *   linux inside WSL  → /mnt/c/Windows/System32/shutdown.exe /s /f /t 0
 *   linux (real)      → systemctl poweroff
 *   darwin            → osascript -e 'tell application "System Events" to shut down'
 *   anything else     → unsupported (NOTHING is ever executed)
 *
 * The countdown is ours, so the shutdown command never asks the operating
 * system for another countdown of its own (`/t 0`).
 *
 * Everything in this module is pure or dependency-injected: the platform, the
 * environment, the file probes, the clock, the spawner and the timer are all
 * parameters. That is what lets the whole matrix be covered by unit tests
 * without touching the machine.
 *
 * ESM only, Node builtins only. No DSH / npm imports.
 */

import { spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs';

/** The Windows shutdown binary as it is reachable from WSL. */
export const WSL_SHUTDOWN_EXE = '/mnt/c/Windows/System32/shutdown.exe';

/** The file that tells a WSL kernel from a real Linux kernel. */
export const WSL_PROC_VERSION = '/proc/version';

/** How many seconds the countdown lasts by default. */
export const DEFAULT_COUNTDOWN_SECONDS = 10;

/** The shortest countdown the configuration may ask for. */
export const MIN_COUNTDOWN_SECONDS = 3;

/** The longest countdown the configuration may ask for. */
export const MAX_COUNTDOWN_SECONDS = 120;

/** How often the controller checks the state (one countdown step per second). */
export const TICK_MS = 1000;

/** The states the sleep controller can be in. */
export const SLEEP_PHASES = Object.freeze([
  'idle',
  'waiting',
  'countdown',
  'shutting-down',
  'cancelled',
  'unsupported',
]);

/** @param {unknown} value */
function errorText(value) {
  if (value && typeof value.message === 'string' && value.message) return value.message;
  return String(value);
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

/**
 * Clamp a countdown length into the supported range.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeCountdownSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return DEFAULT_COUNTDOWN_SECONDS;
  return Math.min(MAX_COUNTDOWN_SECONDS, Math.max(MIN_COUNTDOWN_SECONDS, Math.trunc(seconds)));
}

/**
 * The evidence that this Linux is really a WSL distribution.
 *
 * Any ONE of them is enough:
 *   1. `WSL_DISTRO_NAME` is set (WSL exports it into every process),
 *   2. `WSL_INTEROP` is set (WSL exports it into every process),
 *   3. `/proc/version` mentions "microsoft" (the WSL kernel says so),
 *   4. the Windows shutdown binary is reachable under `/mnt/c`.
 *
 * @param {object} env
 * @param {(file: string) => string} readFile
 * @param {(file: string) => boolean} exists
 * @returns {string|null} the name of the evidence, or null
 */
export function detectWslEvidence(env, readFile, exists) {
  const environ = env && typeof env === 'object' ? env : {};
  if (nonEmptyString(environ.WSL_DISTRO_NAME) !== '') return 'WSL_DISTRO_NAME';
  if (nonEmptyString(environ.WSL_INTEROP) !== '') return 'WSL_INTEROP';
  let version = '';
  try {
    version = String(readFile(WSL_PROC_VERSION) || '');
  } catch {
    version = '';
  }
  if (version.toLowerCase().includes('microsoft')) return WSL_PROC_VERSION;
  let found = false;
  try {
    found = exists(WSL_SHUTDOWN_EXE) === true;
  } catch {
    found = false;
  }
  if (found) return WSL_SHUTDOWN_EXE;
  return null;
}

/**
 * Detect the host and build the command that switches the physical machine off.
 *
 * The returned plan is a plain description: nothing is executed here.
 *
 * @param {{
 *   platform?: string,
 *   env?: object,
 *   readFile?: (file: string) => string,
 *   exists?: (file: string) => boolean,
 * }} [options]
 * @returns {{
 *   kind: 'windows'|'wsl'|'linux'|'macos'|'unsupported',
 *   label: string,
 *   source: string,
 *   command: string|null,
 *   args: string[],
 *   fallbacks: { command: string, args: string[] }[],
 *   platform: string,
 * }}
 */
export function detectShutdownPlan({
  platform = process.platform,
  env = process.env,
  readFile,
  exists,
} = {}) {
  const plat = nonEmptyString(platform) || process.platform;
  const readFileSafe = typeof readFile === 'function'
    ? readFile
    : (file) => fs.readFileSync(file, 'utf8');
  const existsSafe = typeof exists === 'function'
    ? exists
    : (file) => fs.existsSync(file);

  if (plat === 'win32') {
    return {
      kind: 'windows',
      label: '关掉这台 Windows 电脑',
      source: 'process.platform',
      command: 'shutdown.exe',
      // The countdown is ours, so Windows must not count down a second time.
      args: ['/s', '/f', '/t', '0'],
      fallbacks: [],
      platform: plat,
    };
  }

  if (plat === 'linux') {
    const evidence = detectWslEvidence(env, readFileSafe, existsSafe);
    if (evidence !== null) {
      return {
        kind: 'wsl',
        label: 'WSL 里的 DSH → 关掉整台 Windows',
        source: evidence,
        // The Windows binary, reached through the mounted C: drive: this shuts
        // the whole machine down, not the WSL distribution.
        command: WSL_SHUTDOWN_EXE,
        args: ['/s', '/f', '/t', '0'],
        fallbacks: [
          { command: 'powershell.exe', args: ['-NoProfile', '-Command', 'Stop-Computer -Force'] },
          { command: 'cmd.exe', args: ['/c', 'shutdown.exe', '/s', '/f', '/t', '0'] },
        ],
        platform: plat,
      };
    }
    return {
      kind: 'linux',
      label: '关闭这台 Linux 主机',
      source: 'process.platform',
      command: 'systemctl',
      args: ['poweroff'],
      fallbacks: [{ command: 'shutdown', args: ['-h', 'now'] }],
      platform: plat,
    };
  }

  if (plat === 'darwin') {
    return {
      kind: 'macos',
      label: '关闭这台 Mac',
      source: 'process.platform',
      command: 'osascript',
      args: ['-e', 'tell application "System Events" to shut down'],
      fallbacks: [],
      platform: plat,
    };
  }

  return {
    kind: 'unsupported',
    label: '这台机器没有可靠的关机方式',
    source: 'process.platform',
    command: null,
    args: [],
    fallbacks: [],
    platform: plat,
  };
}

/**
 * Apply the configured custom command to a plan.
 *
 * A non-empty `sleepCommand` wins over the detected one: on Windows it runs
 * through `cmd.exe /c`, everywhere else through `/bin/sh -c`. The override is
 * recorded in `source` so the UI can say that the automatic detection was
 * replaced by the operator's own command.
 *
 * @param {object} plan the detected plan
 * @param {{ sleepCommand?: string, platform?: string }} [options]
 * @returns {object} the plan that will actually be executed
 */
export function planInvocation(plan, { sleepCommand = '', platform = process.platform } = {}) {
  const base = plan && typeof plan === 'object' ? plan : {};
  const command = nonEmptyString(sleepCommand);
  if (command === '') return { ...base };
  const plat = nonEmptyString(platform) || base.platform || process.platform;
  const windows = plat === 'win32';
  return {
    ...base,
    command: windows ? 'cmd.exe' : '/bin/sh',
    args: windows ? ['/c', command] : ['-c', command],
    source: 'sleepCommand',
    detectedSource: typeof base.source === 'string' ? base.source : '',
    overridden: true,
  };
}

/**
 * Execute the shutdown command, detached from the host.
 *
 * The gate is checked ONE more time right before the command runs: a session
 * that started working in the meantime must be able to stop the shutdown.
 *
 * With `dryRun` nothing is executed at all: the command that WOULD run is
 * reported instead.
 *
 * @param {object} plan the plan to execute
 * @param {{
 *   spawn?: Function,
 *   dryRun?: boolean,
 *   log?: { warn?: Function, info?: Function },
 *   gate?: () => { allow?: boolean } | null,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   at: string,
 *   command: string|null,
 *   args: string[],
 *   executed: boolean,
 *   pid: number|null,
 *   error: string|null,
 *   dryRun?: boolean,
 * }}
 */
export function runShutdown(plan, { spawn = spawnProcess, dryRun = false, log = console, gate = null } = {}) {
  const at = new Date().toISOString();
  const source = plan && typeof plan === 'object' ? plan : {};
  const command = nonEmptyString(source.command);
  const args = Array.isArray(source.args) ? source.args.map((entry) => String(entry)) : [];
  if (command === '') {
    return { ok: false, at, command: null, args: [], executed: false, pid: null, error: 'no-shutdown-command' };
  }

  if (typeof gate === 'function') {
    let verdict = null;
    try {
      verdict = gate();
    } catch (error) {
      verdict = null;
      if (log && typeof log.warn === 'function') log.warn('the sleep gate failed:', errorText(error));
    }
    if (!verdict || verdict.allow !== true) {
      return { ok: false, at, command, args, executed: false, pid: null, error: 'gate-blocked' };
    }
  }

  if (dryRun === true) {
    return { ok: true, at, command, args, executed: false, pid: null, error: null, dryRun: true };
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    try {
      if (child && typeof child.on === 'function') child.on('error', () => {});
    } catch { /* nothing else to do */ }
    try {
      if (child && typeof child.unref === 'function') child.unref();
    } catch { /* nothing else to do */ }
    const pid = child && Number.isFinite(child.pid) ? child.pid : null;
    return { ok: true, at, command, args, executed: true, pid, error: null };
  } catch (error) {
    return { ok: false, at, command, args, executed: false, pid: null, error: errorText(error) };
  }
}

/**
 * The state machine behind the graceful sleep.
 *
 * `idle → waiting → countdown → shutting-down`, with `cancelled` and
 * `unsupported` as the two ways out. The controller never decides on its own
 * whether a conversation is busy: it asks the injected `busyAgents` and the
 * injected `gate`, so the sleep feature and the restart feature always agree
 * on what "idle" means.
 *
 * Every tick is wrapped in a try/catch: a broken tick must never take the
 * host down.
 *
 * @param {{
 *   now?: () => number,
 *   busyAgents?: () => { sessionId: string, reason?: string }[],
 *   gate?: () => { allow?: boolean, blockedBy?: any[] },
 *   shutdown?: () => any,
 *   countdownSeconds?: number,
 *   log?: { warn?: Function, info?: Function },
 *   setInterval?: (fn: () => void, ms: number) => any,
 *   clearInterval?: (handle: any) => void,
 *   titleOf?: (sessionId: string) => string|undefined,
 *   hostLabel?: string,
 *   supported?: boolean,
 * }} [options]
 */
export function createSleepController({
  now = () => Date.now(),
  busyAgents = () => [],
  gate = () => ({ allow: true, reason: 'quiet', blockedBy: [] }),
  shutdown = () => ({ ok: false, error: 'no-shutdown-handler' }),
  countdownSeconds = DEFAULT_COUNTDOWN_SECONDS,
  log = console,
  setInterval: setIntervalFn = setInterval,
  clearInterval: clearIntervalFn = clearInterval,
  titleOf = () => '',
  hostLabel = '',
  supported = true,
} = {}) {
  const seconds = normalizeCountdownSeconds(countdownSeconds);
  const countdownMs = seconds * 1000;
  const target = nonEmptyString(hostLabel) || '关掉这台电脑';

  let phase = supported ? 'idle' : 'unsupported';
  let armed = false;
  let blockers = [];
  let remainingMs = 0;
  let lastRun = null;
  let message = supported
    ? '还没武装挂机：所有会话收工后倒数几秒，就关掉这台电脑。'
    : '这台机器没有可靠的关机方式，挂机按钮不可用。';
  let timer = null;
  let disposed = false;
  let lastTickAt = now();

  /** The busy conversations, as `{ sessionId, title }` entries. */
  const listBusy = () => {
    let list = [];
    try {
      list = busyAgents();
    } catch (error) {
      if (log && typeof log.warn === 'function') log.warn('could not read the busy conversations:', errorText(error));
      list = [];
    }
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const sessionId = entry.sessionId == null ? '' : String(entry.sessionId);
      if (sessionId === '') continue;
      let title = '';
      try {
        const resolved = titleOf(sessionId);
        title = typeof resolved === 'string' ? resolved.trim() : '';
      } catch { /* a missing title is not a problem */ }
      // The title falls back to the session id: the field always exists, so
      // the UI can always say WHO is still working.
      out.push({ sessionId, title: title !== '' ? title : sessionId });
    }
    return out;
  };

  /** The gate verdict; a broken gate denies, it never opens. */
  const readGate = () => {
    try {
      const verdict = gate();
      if (verdict && typeof verdict === 'object') return verdict;
      return { allow: false, reason: 'gate-unavailable', blockedBy: [] };
    } catch (error) {
      if (log && typeof log.warn === 'function') log.warn('the sleep gate failed:', errorText(error));
      return { allow: false, reason: 'gate-error', blockedBy: [] };
    }
  };

  /** The blockers of a gate verdict, in the shape the UI expects. */
  const blockersFromVerdict = (verdict) => {
    const list = verdict && Array.isArray(verdict.blockedBy) ? verdict.blockedBy : [];
    const out = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const sessionId = entry.sessionId == null ? '' : String(entry.sessionId);
      if (sessionId === '') continue;
      let title = '';
      try {
        const resolved = titleOf(sessionId);
        title = typeof resolved === 'string' ? resolved.trim() : '';
      } catch { /* a missing title is not a problem */ }
      out.push({ sessionId, title: title !== '' ? title : sessionId });
    }
    return out;
  };

  /** The human name of the busy conversations. */
  const names = (list) => list.map((entry) => entry.title || entry.sessionId).join('、');

  /** Normalize whatever the shutdown handler returned into the reported shape. */
  const normalizeRun = (value) => {
    const run = value && typeof value === 'object' ? value : {};
    return {
      at: typeof run.at === 'string' ? run.at : new Date(now()).toISOString(),
      command: typeof run.command === 'string' ? run.command : null,
      args: Array.isArray(run.args) ? run.args.map((entry) => String(entry)) : [],
      executed: run.executed === true,
      pid: Number.isFinite(run.pid) ? run.pid : null,
      error: run.error == null ? null : String(run.error),
    };
  };

  /** The current state of the machine. */
  const status = () => ({
    phase,
    armed,
    countdownSeconds: seconds,
    remainingMs,
    blockers: blockers.map((entry) => ({ ...entry })),
    message,
    lastRun: lastRun === null ? null : { ...lastRun },
  });

  const stopTimer = () => {
    if (timer === null) return;
    const handle = timer;
    timer = null;
    try {
      clearIntervalFn(handle);
    } catch (error) {
      if (log && typeof log.warn === 'function') log.warn('could not stop the sleep timer:', errorText(error));
    }
  };

  const startTimer = () => {
    if (timer !== null) return;
    try {
      timer = setIntervalFn(() => {
        void tick();
      }, TICK_MS);
    } catch (error) {
      timer = null;
      if (log && typeof log.warn === 'function') log.warn('could not start the sleep timer:', errorText(error));
    }
  };

  /**
   * One step of the state machine.
   *
   * Never throws: a broken tick is logged and the state is left as it is.
   */
  const tick = () => {
    if (disposed) return status();
    if (!armed) return status();
    if (phase === 'shutting-down') return status();
    try {
      const busy = listBusy();
      if (busy.length > 0) {
        const again = phase === 'countdown';
        phase = 'waiting';
        blockers = busy;
        remainingMs = countdownMs;
        message = again
          ? `${names(busy)} 又开始干活了，倒数先停一下，等它们收工。`
          : `等 ${busy.length} 个会话收工（${names(busy)}），收工后开始倒数。`;
        return status();
      }

      if (phase !== 'countdown') {
        phase = 'countdown';
        remainingMs = countdownMs;
        lastTickAt = now();
      } else {
        const stamp = now();
        const elapsed = Math.max(TICK_MS, stamp - lastTickAt);
        lastTickAt = stamp;
        remainingMs = Math.max(0, remainingMs - elapsed);
      }
      message = `倒数 ${Math.ceil(remainingMs / 1000)} 秒后${target}……`;
      if (remainingMs > 0) return status();

      // The countdown is over: the gate is checked ONE more time, so a
      // conversation that started working in the meantime still wins.
      const verdict = readGate();
      if (verdict.allow !== true) {
        phase = 'waiting';
        blockers = blockersFromVerdict(verdict);
        remainingMs = countdownMs;
        message = '倒数结束前又有人开始干活了，关机先暂停，等所有会话收工。';
        return status();
      }

      phase = 'shutting-down';
      stopTimer();
      message = `正在${target}……`;
      let result = null;
      try {
        result = shutdown();
      } catch (error) {
        result = { ok: false, error: errorText(error) };
      }
      if (result && typeof result.then === 'function') {
        result.then(
          (value) => { lastRun = normalizeRun(value); },
          (error) => { lastRun = normalizeRun({ ok: false, error: errorText(error) }); },
        );
      } else {
        lastRun = normalizeRun(result);
      }
      return status();
    } catch (error) {
      // A tick must never take the host down.
      if (log && typeof log.warn === 'function') log.warn('the sleep tick failed:', errorText(error));
      return status();
    }
  };

  /** Arm the feature: wait for the conversations, then count down, then shut down. */
  const arm = () => {
    if (disposed) return status();
    if (!supported) {
      armed = false;
      phase = 'unsupported';
      blockers = [];
      remainingMs = 0;
      message = '这台机器没有可靠的关机方式，挂机按钮不可用。';
      return status();
    }
    armed = true;
    phase = 'waiting';
    blockers = [];
    remainingMs = countdownMs;
    lastTickAt = now();
    message = '已武装，等所有会话收工后开始倒数。';
    startTimer();
    tick();
    return status();
  };

  /** Cancel everything: no timer may survive the cancellation. */
  const cancel = () => {
    stopTimer();
    armed = false;
    phase = 'cancelled';
    blockers = [];
    remainingMs = 0;
    message = '挂机已取消，电脑不会关机。';
    return status();
  };

  /** Release the timer when the plugin is unloaded. */
  const dispose = () => {
    disposed = true;
    stopTimer();
    armed = false;
  };

  return { arm, tick, cancel, status, dispose };
}
