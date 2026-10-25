/**
 * dsh-autorestart — Windows-first detached restart executor.
 *
 * VERIFIED DESIGN (2026-10): the Electron main process does NOT supervise the
 * Host child, and no plugin-callable restart IPC exists. Therefore the only
 * viable restart is a *fully detached* process that (a) waits a moment, (b)
 * kills the whole `DeepSeek Harness.exe` tree, and (c) relaunches the app. The
 * kill+relaunch must live in ONE synchronous `cmd.exe /c ... & ... & ...` line,
 * executed by a service that is not inside the dying Electron job object:
 * WMI `Win32_Process.Create` first, `schtasks` fallback.
 *
 * Nothing here throws: every failure is returned as `{ ok:false, error }`.
 * Unit tests only inspect the generated command strings and use `dryRun`.
 *
 * ESM only, Node builtins only. No DSH / npm imports.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Default name of the one-shot scheduled-task fallback. */
export const DEFAULT_TASK_NAME = 'dsh-autorestart-restart';

/** Default image name that `taskkill` matches on Windows. */
export const DEFAULT_IMAGE_NAME = 'DeepSeek Harness.exe';

/** How long the detached command waits before killing the app, in seconds. */
export const DEFAULT_RELAUNCH_DELAY_SECONDS = 4;

/** @param {unknown} value */
function errorText(value) {
  if (value && typeof value.message === 'string' && value.message) return value.message;
  return String(value);
}

/** Escape a value for a single-quoted PowerShell string. @param {unknown} value */
function psSingle(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Describe the runtime we are executing in.
 *
 * Verified: when the Host runs inside the desktop app, `process.execPath` is the
 * app launcher itself (`...\DeepSeek Harness\DeepSeek Harness.exe`, no CLI args
 * needed). Any other runtime is not a desktop app and has no app exe to launch.
 *
 * @param {{ env?: object, execPath?: string, pid?: number, ppid?: number, platform?: string }} [overrides]
 * @returns {{
 *   platform: string,
 *   pid: number,
 *   ppid: number,
 *   execPath: string,
 *   isDesktopApp: boolean,
 *   appExePath: string|null,
 *   hostPid: number,
 *   mainPid: number,
 *   killPid: number,
 * }}
 */
export function detectEnvironment({
  env = process.env,
  execPath = process.execPath,
  pid = process.pid,
  ppid = process.ppid,
  platform = process.platform,
} = {}) {
  void env; // accepted for signature compatibility / future overrides
  const exe = typeof execPath === 'string' ? execPath : '';
  const isDesktopApp = /deepseek[ -]harness/i.test(exe);
  return {
    platform,
    pid,
    ppid,
    execPath: exe,
    isDesktopApp,
    appExePath: isDesktopApp ? exe : null,
    hostPid: pid,
    mainPid: ppid,
    killPid: ppid,
  };
}

/**
 * Build the one synchronous `cmd.exe` line that waits, kills the app tree and
 * relaunches it.
 *
 * Example (defaults):
 * `cmd.exe /c ping -n 5 127.0.0.1 >nul & taskkill /IM "DeepSeek Harness.exe" /T /F & start "" "C:\...\DeepSeek Harness.exe"`
 *
 * @param {{
 *   appExePath?: string|null,
 *   relaunchDelaySeconds?: number,
 *   taskkillImageName?: string,
 * }} [options]
 * @returns {string}
 */
/**
 * The command that relaunches the host WITHOUT letting it inherit the helper's
 * console.
 *
 * Launching the app with `start "" "<exe>"` attached it to the detached helper's
 * console, and Windows delivers `CTRL_CLOSE_EVENT` to every process attached to a
 * console when that console closes: closing the helper window (or the window going
 * away) therefore killed DSH itself. A hidden PowerShell `Start-Process` goes
 * through ShellExecute instead, so the relaunched host is a console-free process and
 * the helper window can close without touching it.
 *
 * @param {string} exe
 * @returns {string}
 */
export function relaunchCommandLine(exe) {
  const target = psSingle(typeof exe === 'string' ? exe : '');
  return "start \"\" powershell.exe -WindowStyle Hidden -NoProfile -Command Start-Process -FilePath '"
    + target
    + "'";
}

/**
 * Build the Windows one-liner the detached scheduler runs when no idle-gate script
 * is used: wait, kill, relaunch.
 *
 * @param {{
 *   appExePath?: string|null,
 *   relaunchDelaySeconds?: number,
 *   taskkillImageName?: string,
 * }} [options]
 * @returns {string}
 */
export function buildRestartCommand({
  appExePath = null,
  relaunchDelaySeconds = DEFAULT_RELAUNCH_DELAY_SECONDS,
  taskkillImageName = DEFAULT_IMAGE_NAME,
} = {}) {
  const seconds =
    typeof relaunchDelaySeconds === 'number' && Number.isFinite(relaunchDelaySeconds) && relaunchDelaySeconds >= 0
      ? Math.trunc(relaunchDelaySeconds)
      : DEFAULT_RELAUNCH_DELAY_SECONDS;
  const image = nonEmptyString(taskkillImageName) ?? DEFAULT_IMAGE_NAME;
  const exe = typeof appExePath === 'string' ? appExePath : '';
  // `ping -n N` where N = seconds + 1: one packet is sent immediately, so a
  // 4-second delay needs 5 pings. `>nul` keeps the detached console silent.
  return `cmd.exe /c ping -n ${seconds + 1} 127.0.0.1 >nul & taskkill /IM "${image}" /T /F & ${relaunchCommandLine(exe)}`;
}

/**
 * The PowerShell command that creates a process via WMI. Processes created by
 * the WMI service provider are not ownered by the dying Electron job object, so
 * they survive the kill.
 *
 * @param {string} command
 * @returns {{ file: string, args: string[] }}
 */
export function buildWmiRestartCommand(command) {
  return {
    file: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${psSingle(command)}' } | Select-Object ReturnValue | ConvertTo-Json -Compress`,
    ],
  };
}

/**
 * Build the Windows `.cmd` helper the detached scheduler runs instead of the inline
 * one-liner whenever an idle-gate URL is available.
 *
 * The helper waits `relaunchDelaySeconds` (a `ping` delay, no external tools), then
 * re-checks the plugin's idle gate over loopback. If the gate denies the restart — or
 * the request fails — it aborts WITHOUT killing anything. Only an allowed gate
 * proceeds to `taskkill` and the relaunch.
 *
 * @param {{
 *   appExePath?: string|null,
 *   relaunchDelaySeconds?: number,
 *   gateUrl?: string,
 *   taskkillImageName?: string,
 * }} [options]
 * @returns {string} `.cmd` script text (CRLF line endings, no BOM)
 */
export function buildGateScript({
  appExePath = null,
  relaunchDelaySeconds = DEFAULT_RELAUNCH_DELAY_SECONDS,
  gateUrl = '',
  taskkillImageName = DEFAULT_IMAGE_NAME,
  watchScriptPath = null,
} = {}) {
  const seconds =
    typeof relaunchDelaySeconds === 'number' && Number.isFinite(relaunchDelaySeconds) && relaunchDelaySeconds >= 0
      ? Math.trunc(relaunchDelaySeconds)
      : DEFAULT_RELAUNCH_DELAY_SECONDS;
  const image = nonEmptyString(taskkillImageName) ?? DEFAULT_IMAGE_NAME;
  const exe = typeof appExePath === 'string' ? appExePath : '';
  const url = psSingle(nonEmptyString(gateUrl) ?? '');
  const gateArgument = "'" + url + "'";
  const gateLine = 'powershell.exe -NoProfile -NonInteractive -Command '
    + '"try { $r = Invoke-RestMethod -Uri '
    + gateArgument
    + ' -TimeoutSec 5; if ($r.allowRestart -ne $true) { exit 3 } } catch { exit 4 }"';
  const watch = nonEmptyString(watchScriptPath);
  const lines = [
    '@echo off',
    'rem dsh-autorestart: wait, re-check the idle gate, then kill + relaunch DeepSeek Harness.',
    'ping -n ' + (seconds + 1) + ' 127.0.0.1 >nul',
    gateLine,
    'if errorlevel 1 exit /b 0',
    'taskkill /IM "' + image + '" /T /F',
    'ping -n 3 127.0.0.1 >nul',
    relaunchCommandLine(exe),
  ];
  if (watch !== null) {
    lines.push('rem dsh-autorestart: wait for the host to come back; roll the backup back when it does not.');
    // Launched as its own hidden process so the .cmd can end immediately: the
    // helper console must close as soon as the relaunch is issued (a visible
    // console window parked in front of the app is not acceptable), and the
    // watcher must survive that console closing.
    lines.push('start "" powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "' + watch + '"');
  }
  lines.push('');
  return lines.join('\r\n');
}

/** How long the watcher waits for the relaunched host before it rolls back. */
export const DEFAULT_ROLLBACK_TIMEOUT_MS = 90000;

/**
 * Build the PowerShell watcher the `.cmd` helper runs right after the relaunch.
 *
 * It polls the health route for `timeoutMs`; a healthy answer ends the watch. When
 * the host does not come back, the snapshot taken before the restart is copied back
 * over the profile (configuration files, and the plugin tree when the backup holds
 * one), a report is written next to the checkpoint, and the host is launched again
 * with the restored configuration.
 *
 * The report is written WITHOUT a BOM even on PowerShell 5.1, because the plugin
 * parses it with JSON.parse.
 *
 * @param {{
 *   healthUrl?: string,
 *   backupDir?: string,
 *   profileDir?: string,
 *   reportPath?: string,
 *   appExePath?: string|null,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {string} script text (CRLF line endings)
 */
export function buildWatchScript({
  healthUrl = '',
  backupDir = '',
  profileDir = '',
  reportPath = '',
  appExePath = null,
  timeoutMs = DEFAULT_ROLLBACK_TIMEOUT_MS,
  since = null,
} = {}) {
  const timeout =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 1000
      ? Math.trunc(timeoutMs)
      : DEFAULT_ROLLBACK_TIMEOUT_MS;
  // Only a crash log written AFTER the restart is evidence about it: an older one
  // would blame last week's failure for this one.
  const sinceText = typeof since === 'string' && since.trim() !== ''
    ? since.trim()
    : (Number.isFinite(Number(since)) ? new Date(Number(since)).toISOString() : '');
  const quote = (value) => "'" + psSingle(typeof value === 'string' ? value : '') + "'";
  const lines = [
    '# dsh-autorestart: wait for the relaunched host; roll the pre-restart backup back when it never answers.',
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$health = ' + quote(nonEmptyString(healthUrl) ?? ''),
    '$backup = ' + quote(nonEmptyString(backupDir) ?? ''),
    '$profile = ' + quote(nonEmptyString(profileDir) ?? ''),
    '$report = ' + quote(nonEmptyString(reportPath) ?? ''),
    '$exe = ' + quote(nonEmptyString(appExePath) ?? ''),
    '$deadline = (Get-Date).AddMilliseconds(' + timeout + ')',
    '$healthy = $false',
    'while ((Get-Date) -lt $deadline) {',
    '  try { $r = Invoke-RestMethod -Uri $health -TimeoutSec 5; if ($r.ok -eq $true) { $healthy = $true; break } } catch { }',
    '  Start-Sleep -Seconds 2',
    '}',
    'if ($healthy) { exit 0 }',
    '$crashDir = Join-Path $env:APPDATA \'@deepseek-ai\\dsh-desktop\\logs\'',
    '$since = ' + quote(sinceText),
    '$crash = $null',
    'if ($since -ne \'\') { $crash = Get-ChildItem $crashDir -Filter \'crash-*.log\' | Where-Object { $_.LastWriteTime -gt ([datetime]$since) } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }',
    'if (-not $crash) { $crash = Get-ChildItem $crashDir -Filter \'crash-*.log\' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }',
    "$tail = ''",
    'if ($crash) { $tail = ((Get-Content $crash.FullName -Tail 60) -join [char]10) }',
    '$rolledBack = $false',
    '$configBackup = Join-Path $backup \'config\'',
    'if (Test-Path $configBackup) {',
    '  robocopy $configBackup $profile /E /NFL /NDL /NJH /NJS /NP | Out-Null',
    '  $rolledBack = $true',
    '}',
    '$pluginsBackup = Join-Path $backup \'node_modules\'',
    'if (Test-Path $pluginsBackup) {',
    '  robocopy $pluginsBackup (Join-Path $profile \'node_modules\') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null',
    '  $rolledBack = $true',
    '}',
    '$crashName = $null',
    'if ($crash) { $crashName = $crash.Name }',
    '$payload = [ordered]@{ ok = $false; at = (Get-Date).ToString(\'o\'); waitedMs = ' + timeout + '; rolledBack = $rolledBack; backupDir = $backup; crashLog = $crashName; crashTail = $tail }',
    '$json = $payload | ConvertTo-Json -Depth 4',
    '[System.IO.File]::WriteAllText($report, $json, (New-Object System.Text.UTF8Encoding($false)))',
    'Start-Process -FilePath $exe',
    'exit 0',
    '',
  ];
  return lines.join('\r\n');
}

/**
 * Execute the detached restart. Primary method: WMI process creation. Fallback:
 * a one-shot scheduled task. Never throws.
 *
 * With `dryRun: true` nothing is executed (and no file is written): the planned
 * command and the exact WMI / schtasks invocations are returned for inspection.
 *
 * @param {{
 *   appExePath?: string|null,
 *   relaunchDelaySeconds?: number,
 *   taskkillImageName?: string,
 *   taskName?: string,
 *   timeoutMs?: number,
 *   dryRun?: boolean,
 *   gateUrl?: string|null,
 *   scriptPath?: string|null,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   method: 'wmi'|'schtasks',
 *   command: string,
 *   error: string|null,
 *   dryRun: boolean,
 *   commands: Array<{ method: string, file: string, args: string[] }>,
 *   wmiCommand: { file: string, args: string[] },
 *   schtasksCreate: string[],
 *   schtasksRun: string[],
 *   gated: boolean,
 *   scriptPath: string|null,
 *   script: string|null,
 * }}
 */
export function scheduleDetachedRestart({
  appExePath = null,
  relaunchDelaySeconds = DEFAULT_RELAUNCH_DELAY_SECONDS,
  taskkillImageName = DEFAULT_IMAGE_NAME,
  taskName = DEFAULT_TASK_NAME,
  timeoutMs = 20000,
  dryRun = false,
  gateUrl = null,
  scriptPath = null,
  watchScriptPath = null,
  watchScript = null,
} = {}) {
  const task = nonEmptyString(taskName) ?? DEFAULT_TASK_NAME;
  const gate = nonEmptyString(gateUrl);
  const scriptFile = nonEmptyString(scriptPath);
  const watchFile = nonEmptyString(watchScriptPath);
  const watchText = typeof watchScript === 'string' ? watchScript : null;
  const gated = gate !== null;
  let script = null;
  let command;
  if (gated) {
    script = buildGateScript({
      appExePath,
      relaunchDelaySeconds,
      gateUrl: gate,
      taskkillImageName,
      watchScriptPath: watchFile,
    });
    command = scriptFile === null ? '' : 'cmd.exe /c "' + scriptFile + '"';
  } else {
    command = buildRestartCommand({ appExePath, relaunchDelaySeconds, taskkillImageName });
  }
  const wmiCommand = buildWmiRestartCommand(command);
  const schtasksCreate = ['/Create', '/SC', 'ONCE', '/ST', '23:59', '/TN', task, '/TR', command, '/F'];
  const schtasksRun = ['/Run', '/TN', task];

  const base = {
    ok: false,
    method: /** @type {'wmi'|'schtasks'} */ ('wmi'),
    command,
    error: null,
    dryRun: dryRun === true,
    commands: [
      { method: 'wmi', file: wmiCommand.file, args: wmiCommand.args },
      { method: 'schtasks-create', file: 'schtasks', args: schtasksCreate },
      { method: 'schtasks-run', file: 'schtasks', args: schtasksRun },
    ],
    wmiCommand,
    schtasksCreate,
    schtasksRun,
    gated,
    scriptPath: scriptFile,
    script,
    watchScriptPath: watchFile,
    watchScript: watchText,
  };

  if (!nonEmptyString(appExePath)) {
    return { ...base, error: 'scheduleDetachedRestart requires appExePath' };
  }

  if (gated && scriptFile === null) {
    return { ...base, error: 'scheduleDetachedRestart requires scriptPath when gateUrl is set' };
  }

  if (watchFile !== null && watchText === null) {
    return { ...base, error: 'scheduleDetachedRestart requires watchScript when watchScriptPath is set' };
  }

  if (dryRun === true) {
    return { ...base, ok: true, dryRun: true };
  }

  if (watchFile !== null && watchText !== null) {
    // The watcher must exist before the .cmd runs it: same atomic write as the
    // gate script, so a half-written .ps1 can never be executed.
    try {
      mkdirSync(path.dirname(watchFile), { recursive: true });
      const temporary = watchFile + '.tmp';
      writeFileSync(temporary, String(watchText), { encoding: 'utf8' });
      renameSync(temporary, watchFile);
    } catch (error) {
      return { ...base, error: 'could not write the rollback watcher: ' + errorText(error) };
    }
  }

  if (gated) {
    // The helper must exist before the scheduler runs it: write it atomically
    // (tmp file + rename) so a half-written .cmd can never be executed.
    try {
      mkdirSync(path.dirname(scriptFile), { recursive: true });
      const temporary = scriptFile + '.tmp';
      writeFileSync(temporary, String(script), { encoding: 'utf8' });
      renameSync(temporary, scriptFile);
    } catch (error) {
      return { ...base, error: 'could not write the gate script: ' + errorText(error) };
    }
  }

  const execOptions = { windowsHide: true, timeout: timeoutMs, stdio: 'ignore' };
  let lastError = null;

  // 1) Preferred: WMI-created process, outside the Electron job object.
  try {
    const stdout = execFileSync(wmiCommand.file, wmiCommand.args, {
      ...execOptions,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const match = /"ReturnValue"\s*:\s*(\d+)/.exec(String(stdout ?? ''));
    if (match === null) {
      // The command exited successfully but the ReturnValue was not observable:
      // treat it as success (a schtasks fallback here could schedule a second
      // kill) while surfacing the uncertainty to the caller's log.
      return {
        ...base,
        ok: true,
        method: 'wmi',
        error: 'WMI returned no observable ReturnValue; assuming the detached process was created',
      };
    }
    if (Number(match[1]) !== 0) {
      throw new Error(`WMI Win32_Process.Create returned ReturnValue=${match[1]}`);
    }
    return { ...base, ok: true, method: 'wmi', error: null };
  } catch (error) {
    lastError = errorText(error);
  }

  // 2) Fallback: one-shot scheduled task.
  try {
    execFileSync('schtasks', schtasksCreate, execOptions);
    execFileSync('schtasks', schtasksRun, execOptions);
    return { ...base, ok: true, method: 'schtasks', error: lastError };
  } catch (error) {
    return {
      ...base,
      ok: false,
      method: 'schtasks',
      error: `${lastError ? `${lastError}; ` : ''}${errorText(error)}`,
    };
  }
}

/**
 * Run a command string detached, or (with `dryRun`) just report it. Tests use
 * `dryRun` exclusively so they never kill or relaunch anything.
 *
 * @param {{ command?: string, dryRun?: boolean }} [options]
 * @returns {{ ok: boolean, command: string|null, dryRun: boolean, pid?: number|null, error?: string }}
 */
export function runCommandNow({ command, dryRun = false } = {}) {
  const text = typeof command === 'string' ? command : '';
  try {
    if (!text.trim()) {
      return { ok: false, command: null, dryRun: dryRun === true, error: 'runCommandNow requires a command' };
    }
    if (dryRun === true) {
      return { ok: true, command: text, dryRun: true, pid: null };
    }
    const child = spawn(text, { shell: true, detached: true, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
    try {
      child.unref();
    } catch {
      /* nothing else to do */
    }
    return { ok: true, command: text, dryRun: false, pid: child.pid ?? null };
  } catch (error) {
    return { ok: false, command: text || null, dryRun: dryRun === true, error: errorText(error) };
  }
}

/**
 * Expand a user-provided restart command template. Unknown/none values become
 * empty strings so the command is at least syntactically valid.
 *
 * @param {{ template?: string, pid?: number, ppid?: number, appExePath?: string|null }} [options]
 * @returns {string}
 */
export function buildCustomCommand({ template, pid, ppid, appExePath } = {}) {
  if (typeof template !== 'string') return '';
  return template
    .split('{pid}')
    .join(pid == null ? '' : String(pid))
    .split('{ppid}')
    .join(ppid == null ? '' : String(ppid))
    .split('{app}')
    .join(appExePath == null ? '' : String(appExePath));
}
