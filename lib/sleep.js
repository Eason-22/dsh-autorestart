/**
 * dsh-autorestart — the host half of the graceful shutdown ("收工关机").
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

import { blockerTaskKeys, countBlockerTasks } from './blockers.js';

/** The Windows shutdown binary as it is reachable from WSL. */
export const WSL_SHUTDOWN_EXE = '/mnt/c/Windows/System32/shutdown.exe';

/** The file that tells a WSL kernel from a real Linux kernel. */
export const WSL_PROC_VERSION = '/proc/version';

/** How many seconds the countdown lasts by default. */
export const DEFAULT_COUNTDOWN_SECONDS = 20;

/**
 * The countdown lengths the settings page offers (a dropdown).
 *
 * `0` means "no countdown at all": the machine is switched off as soon as
 * every conversation is idle and the gate opens.
 */
export const COUNTDOWN_CHOICES = Object.freeze([0, 10, 20, 30, 60]);

/** The shortest countdown the configuration may ask for (0 = no countdown). */
export const MIN_COUNTDOWN_SECONDS = 0;

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
 * Snap a configured countdown onto one of the offered choices.
 *
 * A profile that still carries an old value (`15`, `45`, …) must not break:
 * the nearest offered length wins, and a tie goes to the LONGER one
 * (`15` → `20`, `45` → `60`). Anything that is not a number at all (a
 * string that is not a number, `null`, `undefined`) falls back to the
 * default.
 *
 * @param {unknown} value
 * @returns {number} one of {@link COUNTDOWN_CHOICES}
 */
export function snapCountdownChoice(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return DEFAULT_COUNTDOWN_SECONDS;
  if (typeof value === 'string' && value.trim() === '') return DEFAULT_COUNTDOWN_SECONDS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return DEFAULT_COUNTDOWN_SECONDS;
  let best = COUNTDOWN_CHOICES[0];
  let bestDistance = Infinity;
  for (const choice of COUNTDOWN_CHOICES) {
    const distance = Math.abs(choice - seconds);
    // `<=` so a tie goes to the LONGER choice (15 → 20, 45 → 60).
    if (distance <= bestDistance) {
      best = choice;
      bestDistance = distance;
    }
  }
  return best;
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
      // The mounted Windows binary is only a HINT: a real Linux with a
      // manually mounted C: drive looks exactly the same. When that is the
      // only evidence, the plan says so instead of pretending to be sure.
      const suspect = evidence === WSL_SHUTDOWN_EXE;
      return {
        kind: 'wsl',
        label: suspect
          ? '疑似 WSL（仅凭 /mnt/c 探测）→ 关掉整台 Windows'
          : 'WSL 里的 DSH → 关掉整台 Windows',
        source: suspect
          ? `${WSL_SHUTDOWN_EXE}（疑似 WSL，仅凭 /mnt/c 探测）`
          : evidence,
        // The Windows binary, reached through the mounted C: drive: this shuts
        // the whole machine down, not the WSL distribution.
        command: WSL_SHUTDOWN_EXE,
        args: ['/s', '/f', '/t', '0'],
        fallbacks: [
          { command: 'powershell.exe', args: ['-NoProfile', '-Command', 'Stop-Computer -Force'] },
          { command: 'cmd.exe', args: ['/c', 'shutdown.exe', '/s', '/f', '/t', '0'] },
        ],
        // True when the plan rests on the mounted drive alone.
        suspect,
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
 * How long a command may take to really start before it counts as failed (ms).
 *
 * `spawn()` reports a failure through the child's `error` event, so the answer
 * only arrives asynchronously. The timeout is the safety net for a spawner
 * that never answers at all.
 */
export const SPAWN_TIMEOUT_MS = 5000;

/**
 * Start ONE command and wait for the real answer.
 *
 * `spawn` means the command really started; `error` means it did not (the
 * binary is missing, the permission is denied, ...). Nothing is swallowed:
 * the caller learns which one of the two happened.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{
 *   spawn?: Function,
 *   log?: { warn?: Function },
 *   timeoutMs?: number,
 *   setTimeout?: Function,
 *   clearTimeout?: Function,
 * }} [options]
 * @returns {Promise<{ ok: boolean, pid: number|null, error: string|null }>}
 */
function startCommand(command, args, {
  spawn = spawnProcess,
  timeoutMs = SPAWN_TIMEOUT_MS,
  setTimeout: setTimeoutFn = setTimeout,
  clearTimeout: clearTimeoutFn = clearTimeout,
} = {}) {
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (error) {
      resolve({ ok: false, pid: null, error: `spawn-failed: ${errorText(error)}` });
      return;
    }
    const pid = child && Number.isFinite(child.pid) ? child.pid : null;
    if (!child || typeof child.on !== 'function') {
      // A spawner without events (a test double) counts as started.
      try {
        if (child && typeof child.unref === 'function') child.unref();
      } catch { /* nothing else to do */ }
      resolve({ ok: true, pid, error: null });
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        try {
          clearTimeoutFn(timer);
        } catch { /* nothing else to do */ }
        timer = null;
      }
      resolve({ ok, pid, error });
    };
    child.on('spawn', () => {
      try {
        if (child && typeof child.unref === 'function') child.unref();
      } catch { /* nothing else to do */ }
      finish(true, null);
    });
    child.on('error', (error) => {
      finish(false, `spawn-failed: ${errorText(error)}`);
    });
    try {
      timer = setTimeoutFn(() => {
        finish(false, `spawn-timeout: ${command} did not start within ${timeoutMs}ms`);
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    } catch { /* the timeout is only a safety net */ }
  });
}

/**
 * Execute the shutdown command, detached from the host.
 *
 * The gate is checked ONE more time right before the command runs: a session
 * that started working in the meantime must be able to stop the shutdown.
 *
 * The command is really started, not merely requested: the answer arrives
 * with the child's `spawn` event, and a command that does not start is
 * reported as a FAILURE (`executed: false`). When the main command does not
 * start, the plan's fallbacks are tried one after another (the WSL plan
 * reaches Windows through two of them), and the first one that starts wins.
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
 *   timeoutMs?: number,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   at: string,
 *   command: string|null,
 *   args: string[],
 *   executed: boolean,
 *   pid: number|null,
 *   error: string|null,
 *   dryRun?: boolean,
 * }>}
 */
export function runShutdown(plan, {
  spawn = spawnProcess,
  dryRun = false,
  log = console,
  gate = null,
  timeoutMs = SPAWN_TIMEOUT_MS,
} = {}) {
  const at = new Date().toISOString();
  const source = plan && typeof plan === 'object' ? plan : {};
  const command = nonEmptyString(source.command);
  const args = Array.isArray(source.args) ? source.args.map((entry) => String(entry)) : [];
  if (command === '') {
    return Promise.resolve({ ok: false, at, command: null, args: [], executed: false, pid: null, error: 'no-shutdown-command' });
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
      return Promise.resolve({ ok: false, at, command, args, executed: false, pid: null, error: 'gate-blocked' });
    }
  }

  if (dryRun === true) {
    return Promise.resolve({ ok: true, at, command, args, executed: false, pid: null, error: null, dryRun: true });
  }

  // The main command first, then the fallbacks in the order of the plan.
  const attempts = [{ command, args }];
  const fallbacks = Array.isArray(source.fallbacks) ? source.fallbacks : [];
  for (const fallback of fallbacks) {
    if (!fallback || typeof fallback !== 'object') continue;
    const fallbackCommand = nonEmptyString(fallback.command);
    if (fallbackCommand === '') continue;
    attempts.push({
      command: fallbackCommand,
      args: Array.isArray(fallback.args) ? fallback.args.map((entry) => String(entry)) : [],
    });
  }

  return (async () => {
    let lastError = 'no-shutdown-command';
    for (const attempt of attempts) {
      const outcome = await startCommand(attempt.command, attempt.args, { spawn, timeoutMs });
      if (outcome.ok) {
        return {
          ok: true,
          at,
          command: attempt.command,
          args: attempt.args,
          executed: true,
          pid: outcome.pid,
          error: null,
        };
      }
      lastError = outcome.error;
      if (log && typeof log.warn === 'function') {
        log.warn(`the sleep command ${attempt.command} did not start:`, outcome.error);
      }
    }
    return { ok: false, at, command, args, executed: false, pid: null, error: lastError };
  })();
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
 *   quietForMs?: () => number,
 *   graceMs?: () => number,
 *   restartPending?: () => { pending: boolean, blockers?: any[] },
 *   onDisarm?: (reason: string) => void,
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
  quietForMs = () => 0,
  graceMs = () => 0,
  restartPending = () => ({ pending: false, blockers: [] }),
  onDisarm = () => {},
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
  // The countdown is over and only the grace window was missing: the machine
  // goes off when the grace is over, WITHOUT counting down again.
  let countdownDone = false;
  let lastRun = null;
  let message = supported
    ? '还没点「收工关机」：所有会话收工后倒数几秒，就关掉这台电脑。'
    : '这台机器没有可靠的关机方式，「收工关机」按钮不可用。';
  let timer = null;
  let disposed = false;
  let lastTickAt = now();

  /**
   * One blocker entry, in the shape the UI expects.
   *
   * The Host knows WHAT the blocker is (`kind`: a session or a subagent) and
   * HOW it is called (`label`: the title of the session, or of the session
   * that created the subagent). A raw session id never reaches the
   * interface: an unknown name is a generic one.
   *
   * `parentSessionId` is kept: it is the exact identity of the session that
   * created a subagent, so the card can count a parent and its subagents as
   * ONE task (the rule of `lib/blockers.js`). It is null when the Host did
   * not report one — the title is then the fallback.
   *
   * @param {any} entry the entry the Host produced
   * @param {string} sessionId
   * @returns {{ sessionId: string, kind: string, label: string|null, name: string, parentTitle: string|null, parentSessionId: string|null, title: string }}
   */
  const blockerEntry = (entry, sessionId) => {
    const kind = entry.kind === 'subagent' ? 'subagent' : 'session';
    let label = typeof entry.label === 'string' ? entry.label.trim() : '';
    if (label === '') {
      try {
        const resolved = titleOf(sessionId);
        label = typeof resolved === 'string' ? resolved.trim() : '';
      } catch { /* a missing title is not a problem */ }
    }
    let name = typeof entry.name === 'string' ? entry.name.trim() : '';
    // No title, no name: a generic "会话" would only produce a list of
    // identical entries ("会话、会话、会话"), which says nothing. The client
    // writes the generic line when the name is empty.
    if (name === '') name = label;
    const parentTitle = typeof entry.parentTitle === 'string' ? entry.parentTitle.trim() : '';
    const parentSessionId = typeof entry.parentSessionId === 'string' ? entry.parentSessionId.trim() : '';
    return {
      sessionId,
      kind,
      label: label !== '' ? label : null,
      name,
      parentTitle: parentTitle !== '' ? parentTitle : null,
      // The identity of the session that created the subagent: it is what lets
      // the card count a parent and its subagents as ONE task. It is only
      // there when the Host knows it — a plain session keeps its old shape.
      ...(parentSessionId !== '' ? { parentSessionId } : {}),
      // `title` is the old name of `label`: it stays, so an older client
      // keeps working.
      title: label !== '' ? label : name,
    };
  };

  /** The busy conversations, as `{ sessionId, kind, label, name }` entries. */
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
      out.push(blockerEntry(entry, sessionId));
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

  /**
   * Leave the armed state: the shutdown is over (done, refused or cancelled).
   *
   * The Host uses this to forget the recorded intent — the machine stays on
   * (or it already went off), so the intent must not survive.
   *
   * @param {string} reason
   */
  const disarm = (reason) => {
    try { onDisarm(reason); } catch (error) {
      if (log && typeof log.warn === 'function') log.warn('the disarm hook failed:', errorText(error));
    }
  };

  /**
   * The pending restart, if there is one.
   *
   * A restart goes FIRST: the shutdown waits for it — and for the sessions
   * that resume with it. The intent survives the restart, so the machine goes
   * off after everything is done, not before.
   *
   * @returns {{ pending: boolean, blockers: any[] }}
   */
  const readRestartPending = () => {
    let verdict = null;
    try { verdict = restartPending(); } catch { verdict = null; }
    if (!verdict || typeof verdict !== 'object') return { pending: false, blockers: [] };
    const blockers = Array.isArray(verdict.blockers) ? verdict.blockers : [];
    return { pending: verdict.pending === true, blockers };
  };

  /**
   * The grace window that is still open.
   *
   * The plugin only sees the DSH agents. Other plugins (a memory plugin
   * that writes its notes a few seconds after the conversation ended, a
   * summary, an MCP callback) queue their work with a timer of their own —
   * work that is invisible here. The grace window is the extra wait that
   * leaves them time.
   *
   * @returns {{ pending: boolean, remainingMs: number }}
   */
  const readGrace = () => {
    let grace = 0;
    try { grace = Number(graceMs()); } catch { grace = 0; }
    if (!Number.isFinite(grace) || grace <= 0) return { pending: false, remainingMs: 0 };
    let quiet = 0;
    try { quiet = Number(quietForMs()); } catch { quiet = 0; }
    if (!Number.isFinite(quiet) || quiet < 0) quiet = 0;
    const remainingMs = Math.max(0, grace - quiet);
    return { pending: remainingMs > 0, remainingMs };
  };

  /** The blockers of a gate verdict, in the shape the UI expects. */
  const blockersFromVerdict = (verdict) => {
    const list = verdict && Array.isArray(verdict.blockedBy) ? verdict.blockedBy : [];
    const out = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const sessionId = entry.sessionId == null ? '' : String(entry.sessionId);
      if (sessionId === '') continue;
      out.push(blockerEntry(entry, sessionId));
    }
    return out;
  };

  /**
   * The names of the blockers — but only when EVERY one of them has a title.
   *
   * A list of generic names ("会话、会话、会话") says nothing and looks like a
   * bug, so a list with a nameless entry in it is left out entirely: the
   * caller then writes the line without the parenthetical.
   *
   * The names are the names of the TASKS: a session and its own subagents are
   * ONE task, and it is named after the session itself (after its subagent
   * when the session is idle and only the subagent works). So the list has as
   * many names as the count has tasks.
   *
   * @param {any[]} list
   * @returns {string} the joined names, or '' when the list cannot be named
   */
  const names = (list) => {
    const entries = Array.isArray(list) ? list : [];
    const keys = blockerTaskKeys(entries);
    const byTask = new Map();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const label = entry && typeof entry.label === 'string' ? entry.label.trim() : '';
      const name = entry && typeof entry.name === 'string' ? entry.name.trim() : '';
      if (label === '' || name === '') return '';
      const key = keys[index] !== '' ? keys[index] : ('entry:' + index);
      const isSubagent = entry.kind === 'subagent';
      const known = byTask.get(key);
      if (!known || (known.isSubagent && !isSubagent)) {
        byTask.set(key, { name, isSubagent });
      }
    }
    return Array.from(byTask.values()).map((item) => item.name).join('、');
  };

  /**
   * The line that says WHO the machine waits for.
   *
   * - every blocker has a title → the names are listed;
   * - one blocker with a title → the singular form ("等「甲」收工");
   * - otherwise → the plain count, without a parenthetical.
   *
   * The count is about TASKS: a session and its own subagents are ONE task
   * (the rule of `lib/blockers.js`), the same number the left sidebar shows.
   *
   * @param {any[]} list the blockers
   * @param {{ immediate?: boolean }} options `immediate` = no countdown at all
   * @returns {string}
   */
  const waitingFor = (list, { immediate = false } = {}) => {
    const count = countBlockerTasks(list);
    const tail = immediate ? '收工后立即关机。' : '收工后开始倒数。';
    const named = names(list);
    if (count === 1 && named !== '') return `等「${named}」收工，${tail}`;
    if (count > 0 && named !== '') return `等 ${count} 个任务收工（${named}），${tail}`;
    return `等 ${count} 个任务收工，${tail}`;
  };

  /** Normalize whatever the shutdown handler returned into the reported shape. */
  const normalizeRun = (value) => {
    const run = value && typeof value === 'object' ? value : {};
    const normalized = {
      at: typeof run.at === 'string' ? run.at : new Date(now()).toISOString(),
      command: typeof run.command === 'string' ? run.command : null,
      args: Array.isArray(run.args) ? run.args.map((entry) => String(entry)) : [],
      executed: run.executed === true,
      pid: Number.isFinite(run.pid) ? run.pid : null,
      error: run.error == null ? null : String(run.error),
    };
    // A dry run is reported as such, because the UI has to know that the
    // command was NOT executed. A real run keeps its shape untouched.
    if (run.dryRun === true) normalized.dryRun = true;
    return normalized;
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
      // A pending restart goes FIRST. The shutdown waits for it — and for the
      // sessions that resume with it. The intent survives the restart, so the
      // machine goes off after everything is done.
      const pendingRestart = readRestartPending();
      if (pendingRestart.pending) {
        phase = 'waiting';
        blockers = pendingRestart.blockers;
        countdownDone = false;
        remainingMs = countdownMs;
        message = '等这次重启完成后再关机……';
        return status();
      }

      const busy = listBusy();
      if (busy.length > 0) {
        const again = phase === 'countdown';
        phase = 'waiting';
        blockers = busy;
        countdownDone = false;
        remainingMs = countdownMs;
        message = again
          ? (names(busy) !== ''
            ? `${names(busy)} 又开始干活了，倒数先停一下，等它们收工。`
            : '又有任务开始干活了，倒数先停一下，等它们收工。')
          : waitingFor(busy, { immediate: countdownMs === 0 });
        return status();
      }

      // The grace window: the last conversation finished a moment ago, and
      // other plugins still have work queued that this plugin cannot see (a
      // memory plugin writing its notes, a summary). The countdown does not
      // start before the grace is over — so the grace never pushes the
      // countdown back, it only delays its start.
      const grace = readGrace();
      if (grace.pending) {
        phase = 'waiting';
        blockers = [];
        remainingMs = countdownMs;
        message = `再等 ${Math.ceil(grace.remainingMs / 1000)} 秒，给记忆/总结类插件留点时间……`;
        return status();
      }

      if (phase !== 'countdown') {
        phase = 'countdown';
        // The countdown runs: nobody blocks it any more.
        blockers = [];
        if (countdownDone) {
          // The countdown is over and only the grace window was missing: the
          // countdown does NOT start again, the machine goes off as soon as
          // the grace is over (the gate below decides).
          remainingMs = 0;
        } else {
          remainingMs = countdownMs;
          lastTickAt = now();
        }
      } else {
        const stamp = now();
        const elapsed = Math.max(TICK_MS, stamp - lastTickAt);
        lastTickAt = stamp;
        remainingMs = Math.max(0, remainingMs - elapsed);
      }
      // A countdown of zero seconds is no countdown at all: the gate is asked
      // right away and the machine is switched off the moment it opens.
      message = countdownMs > 0
        ? `倒数 ${Math.ceil(remainingMs / 1000)} 秒后${target}……`
        : '0 秒：立即关机。';
      if (remainingMs > 0) return status();

      // The countdown is over: the gate is checked ONE more time, so a
      // conversation that started working in the meantime still wins.
      const verdict = readGate();
      if (verdict.allow !== true) {
        phase = 'waiting';
        blockers = blockersFromVerdict(verdict);
        const reason = typeof verdict.reason === 'string' ? verdict.reason : '';
        if (reason === 'grace') {
          // Only the grace window was missing: the countdown is over and
          // stays over — the machine goes off when the grace is over.
          countdownDone = true;
          remainingMs = 0;
          message = '最后一点收尾还没结束，再给记忆/总结类插件留几秒……';
        } else {
          countdownDone = false;
          remainingMs = countdownMs;
          if (reason === 'settling') {
            // The machine was not quiet long enough: say THAT, and do not claim
            // that somebody started working.
            message = '机器还没安静够久，再等一轮……';
          } else if (blockers.length > 0) {
            message = `倒数结束前又有人开始干活了${names(blockers) !== '' ? `（${names(blockers)}）` : ''}，关机先暂停，等所有会话收工。`;
          } else {
            message = '倒数结束时机器还没安静下来，关机先暂停，再等一轮。';
          }
        }
        return status();
      }

      phase = 'shutting-down';
      stopTimer();
      // A countdown of zero seconds says so in the message too: the user
      // must see that the machine went off without any countdown.
      message = countdownMs > 0
        ? `正在${target}……`
        : '0 秒：立即关机，正在关掉这台电脑。';
      let result = null;
      try {
        result = shutdown();
      } catch (error) {
        result = { ok: false, error: errorText(error) };
      }
      /**
       * The phase only says "shutting down" when the command really started:
       * a command that did not start leaves the machine alone, and the state
       * must never keep saying "正在关机" (the UI would then show a screen
       * without a way out).
       */
      const applyRun = (value) => {
        const raw = value && typeof value === 'object' ? value : {};
        const run = normalizeRun(value);
        lastRun = run;
        // A dry run reports the command it WOULD run: nothing was executed, and
        // the state must NOT keep saying "shutting down" — the UI would then
        // show a screen without a way out (the countdown is over, the moon
        // button is covered, and there is no cancel button on that screen).
        if (raw.dryRun === true) {
          phase = 'idle';
          armed = false;
          blockers = [];
          remainingMs = 0;
          const planned = [run.command || '', ...run.args].filter((part) => part !== '').join(' ');
          message = `试运行：本来会执行 ${planned}，这次不会真的关机。`;
          disarm('dry-run');
          return;
        }
        if (run.executed === true) {
          // The machine is going off: the intent is spent.
          disarm('shutdown-completed');
          return;
        }
        if (run.error === 'gate-blocked') {
          // Somebody started working in the very last moment: wait for them —
          // and KEEP the list, so the waiting card can say WHO is still busy.
          const verdict = readGate();
          phase = 'waiting';
          blockers = blockersFromVerdict(verdict);
          remainingMs = countdownMs;
          const reason = typeof verdict.reason === 'string' ? verdict.reason : '';
          if (reason === 'settling') {
            // The machine was not quiet long enough: say THAT, and do not claim
            // that somebody started working.
            message = '机器还没安静够久，再等一轮……';
          } else if (blockers.length > 0) {
            message = `倒数结束时又有人开始干活了${names(blockers) !== '' ? `（${names(blockers)}）` : ''}，关机先暂停，等所有会话收工。`;
          } else {
            message = '倒数结束时机器还没安静下来，关机先暂停，再等一轮。';
          }
          startTimer();
          return;
        }
        phase = 'idle';
        armed = false;
        blockers = [];
        remainingMs = 0;
        message = `关机命令没跑起来（${run.error || 'unknown error'}），电脑还开着，可以再点一次月亮按钮。`;
        disarm('shutdown-failed');
      };
      if (result && typeof result.then === 'function') {
        result.then(
          (value) => { applyRun(value); },
          (error) => { applyRun({ ok: false, error: errorText(error) }); },
        );
      } else {
        applyRun(result);
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
      message = '这台机器没有可靠的关机方式，「收工关机」按钮不可用。';
      return status();
    }
    armed = true;
    phase = 'waiting';
    blockers = [];
    countdownDone = false;
    remainingMs = countdownMs;
    lastTickAt = now();
    message = countdownMs > 0
      ? '已武装，等所有会话收工后开始倒数。'
      : '已武装：等所有会话收工后立即关机。';
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
    countdownDone = false;
    remainingMs = 0;
    message = '收工关机已取消，电脑不会关机。';
    disarm('cancelled');
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
