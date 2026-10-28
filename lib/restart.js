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

/** Default name of the one-shot scheduled task that runs the rollback watcher. */
export const DEFAULT_WATCH_TASK_NAME = 'dsh-autorestart-watch';

/**
 * How long the restart command may run before the plugin stops waiting for it.
 *
 * The command is the user's own: it usually returns in a second or two
 * (`systemctl --user restart …`, a small shell script). A command that starts
 * the host in the FOREGROUND never returns — that is not a failure, but the
 * plugin must not wait for it for ever, so the window is bounded and the
 * outcome is reported as "still running" instead of "failed".
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30000;

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
 * How long ONE restore step (the configuration files, the plugin tree) may take
 * before the watcher gives it up.
 *
 * A `robocopy` of a 117 MB plugin tree can take a while, but it must never
 * hang the watcher for ever: a restore that does not finish in time is
 * abandoned and the reason is written into the rollback report.
 */
export const DEFAULT_ROLLBACK_COPY_TIMEOUT_MS = 120000;

/**
 * Build the PowerShell watcher the `.cmd` helper runs right after the relaunch.
 *
 * WHAT IT DOES NOW (and what it did wrong before):
 *
 *   - It does NOT poll the health route of the OLD instance any more. The
 *     desktop app listens on a RANDOM port (`--port 0`), so the port of the
 *     instance that is being replaced is worthless: the watcher waited for an
 *     answer that could never come, and then rolled back a perfectly healthy
 *     restart. The port of the NEW instance is read from the instance record
 *     (lib/access.js), which also carries the boot id — so the watcher knows
 *     that the answer comes from the instance that replaced the old one.
 *   - The restore runs with a TIME LIMIT. A `robocopy` that hangs is stopped,
 *     and the report says so.
 *   - The restore does NOT start a second copy of the host. The old behaviour
 *     (`Start-Process -FilePath $exe`) launched a SECOND app next to the one
 *     that was already starting up — two web servers, two ports, and a
 *     confusing window. The watcher only restores the files and writes the
 *     report; the host that was launched is left alone.
 *   - The watcher cleans up after itself: the helper script and the marker
 *     file are removed when it ends.
 *
 * The report is written WITHOUT a BOM even on PowerShell 5.1, because the
 * plugin parses it with JSON.parse.
 *
 * @param {{
 *   healthUrl?: string,
 *   healthPath?: string,
 *   portFile?: string,
 *   expectedBootId?: string|null,
 *   outcomeFile?: string,
 *   backupDir?: string,
 *   profileDir?: string,
 *   reportPath?: string,
 *   lockFile?: string,
 *   appExePath?: string|null,
 *   timeoutMs?: number,
 *   rollbackTimeoutMs?: number,
 *   since?: string|number|null,
 *   selfCleanPaths?: string[],
 * }} [options]
 * @returns {string} script text (CRLF line endings)
 */
export function buildWatchScript({
  healthUrl = '',
  healthPath = '/__dsh_autorestart/health',
  portFile = '',
  expectedBootId = null,
  outcomeFile = '',
  backupDir = '',
  profileDir = '',
  reportPath = '',
  lockFile = '',
  appExePath = null,
  timeoutMs = DEFAULT_ROLLBACK_TIMEOUT_MS,
  rollbackTimeoutMs = DEFAULT_ROLLBACK_COPY_TIMEOUT_MS,
  since = null,
  selfCleanPaths = [],
} = {}) {
  const timeout =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 1000
      ? Math.trunc(timeoutMs)
      : DEFAULT_ROLLBACK_TIMEOUT_MS;
  const copyTimeout =
    typeof rollbackTimeoutMs === 'number' && Number.isFinite(rollbackTimeoutMs) && rollbackTimeoutMs >= 1000
      ? Math.trunc(rollbackTimeoutMs)
      : DEFAULT_ROLLBACK_COPY_TIMEOUT_MS;
  // `Wait-Job -Timeout` counts SECONDS.
  const copyTimeoutSeconds = Math.max(1, Math.ceil(copyTimeout / 1000));
  // Only a crash log written AFTER the restart is evidence about it: an older one
  // would blame last week's failure for this one.
  const sinceText = typeof since === 'string' && since.trim() !== ''
    ? since.trim()
    : (Number.isFinite(Number(since)) ? new Date(Number(since)).toISOString() : '');
  const quote = (value) => "'" + psSingle(typeof value === 'string' ? value : '') + "'";
  const expected = typeof expectedBootId === 'string' && expectedBootId !== '' ? expectedBootId : '';
  const cleanPaths = (Array.isArray(selfCleanPaths) ? selfCleanPaths : [])
    .filter((entry) => typeof entry === 'string' && entry !== '')
    .map((entry) => quote(entry));
  const lines = [
    '# dsh-autorestart: wait for the relaunched host; roll the pre-restart backup back when it never answers.',
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$health = ' + quote(nonEmptyString(healthUrl) ?? ''),
    '$healthPath = ' + quote(nonEmptyString(healthPath) ?? '/__dsh_autorestart/health'),
    '$portFile = ' + quote(nonEmptyString(portFile) ?? ''),
    '$expected = ' + quote(expected),
    '$outcome = ' + quote(nonEmptyString(outcomeFile) ?? ''),
    '$backup = ' + quote(nonEmptyString(backupDir) ?? ''),
    '$profile = ' + quote(nonEmptyString(profileDir) ?? ''),
    '$report = ' + quote(nonEmptyString(reportPath) ?? ''),
    '$deadline = (Get-Date).AddMilliseconds(' + timeout + ')',
    '$healthy = $false',
    '$decided = $false',
    '$newPort = 0',
    'while ((Get-Date) -lt $deadline) {',
    '  # The plugin may have decided on its own (the restart command failed): stand down.',
    "  if ($outcome -ne '' -and (Test-Path -LiteralPath $outcome)) {",
    '    $marker = $null',
    '    try { $marker = Get-Content -LiteralPath $outcome -Raw | ConvertFrom-Json } catch { $marker = $null }',
    '    if ($marker -and $marker.decided -eq $true) { $decided = $true; break }',
    '  }',
    '  # The NEW instance publishes its own port; the port of the old one is worthless.',
    "  if ($portFile -ne '' -and (Test-Path -LiteralPath $portFile)) {",
    '    $record = $null',
    '    try { $record = Get-Content -LiteralPath $portFile -Raw | ConvertFrom-Json } catch { $record = $null }',
    '    if ($record -and $record.bootId -and $record.bootId -ne $expected -and $record.port) {',
    "      $url = 'http://127.0.0.1:' + $record.port + $healthPath",
    '      try { $h = Invoke-RestMethod -Uri $url -TimeoutSec 5; if ($h.ok -eq $true) { $healthy = $true; $newPort = $record.port; break } } catch { }',
    '    }',
    '  } elseif ($health -ne \'\') {',
    '    # No instance record at all (a Host that does not publish one): the old URL.',
    '    try { $h = Invoke-RestMethod -Uri $health -TimeoutSec 5; if ($h.ok -eq $true) { $healthy = $true; break } } catch { }',
    '  }',
    '  Start-Sleep -Seconds 2',
    '}',
    'if ($decided -or $healthy) { exit 0 }',
    '$crashDir = Join-Path $env:APPDATA \'@deepseek-ai\\dsh-desktop\\logs\'',
    '$since = ' + quote(sinceText),
    '$crash = $null',
    'if ($since -ne \'\') { $crash = Get-ChildItem $crashDir -Filter \'crash-*.log\' | Where-Object { $_.LastWriteTime -gt ([datetime]$since) } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }',
    'if (-not $crash) { $crash = Get-ChildItem $crashDir -Filter \'crash-*.log\' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }',
    "$tail = ''",
    'if ($crash) { $tail = ((Get-Content $crash.FullName -Tail 60) -join [char]10) }',
    '# THE LOCK: the plugin may be restoring the snapshot at the same time (it',
    '# saw that the restart failed). Exactly ONE of them restores the files.',
    '$lock = ' + quote(nonEmptyString(lockFile) ?? ''),
    '$locked = $false',
    'if ($lock -ne \'\') {',
    '  # A lock that is older than 10 minutes belongs to a process that died',
    '  # in the middle of its restore: it must not block the rollback for ever.',
    '  if (Test-Path -LiteralPath $lock) {',
    '    $age = (Get-Date) - (Get-Item -LiteralPath $lock).LastWriteTime',
    '    if ($age.TotalMinutes -gt 10) { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue }',
    '  }',
    '  try { $handle = [System.IO.File]::Open($lock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None); $handle.Close(); $locked = $true } catch { $locked = $false }',
    '}',
    '$rolledBack = $false',
    '$rollbackError = $null',
    'if (-not $locked) {',
    '  $rollbackError = \'another rollback is already running\'',
    '} else {',
    '  $configBackup = Join-Path $backup \'config\'',
    '  if (Test-Path $configBackup) {',
    '    $job = Start-Job -ScriptBlock { param($src, $dst) & robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP | Out-Null } -ArgumentList $configBackup, $profile',
    '    if (Wait-Job $job -Timeout ' + copyTimeoutSeconds + ') { Receive-Job $job | Out-Null; $rolledBack = $true } else { Stop-Job $job; $rollbackError = \'the configuration restore did not finish within ' + copyTimeout + ' ms\' }',
    '    Remove-Job $job -Force',
    '  }',
    '  $pluginsBackup = Join-Path $backup \'node_modules\'',
    '  if (Test-Path $pluginsBackup) {',
    '    $job = Start-Job -ScriptBlock { param($src, $dst) & robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP | Out-Null } -ArgumentList $pluginsBackup, (Join-Path $profile \'node_modules\')',
    '    if (Wait-Job $job -Timeout ' + copyTimeoutSeconds + ') { Receive-Job $job | Out-Null; $rolledBack = $true } else { Stop-Job $job; $rollbackError = \'the plugin tree restore did not finish within ' + copyTimeout + ' ms\' }',
    '    Remove-Job $job -Force',
    '  }',
    '}',
    '$crashName = $null',
    'if ($crash) { $crashName = $crash.Name }',
    '# `appStarted` is always false: the rollback branch restores the files and',
    '# writes the report, it never launches a SECOND copy of the host.',
    '$payload = [ordered]@{ ok = $false; at = (Get-Date).ToString(\'o\'); waitedMs = ' + timeout + '; rolledBack = $rolledBack; rollbackError = $rollbackError; backupDir = $backup; newPort = $newPort; appStarted = $false; crashLog = $crashName; crashTail = $tail }',
    '$json = $payload | ConvertTo-Json -Depth 4',
    '[System.IO.File]::WriteAllText($report, $json, (New-Object System.Text.UTF8Encoding($false)))',
    '# The watcher cleans up after itself (and releases the lock it holds).',
    'foreach ($p in @(' + cleanPaths.join(', ') + ')) {',
    '  if ($p -and (Test-Path -LiteralPath $p)) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }',
    '}',
    '# The lock is released by the party that HOLDS it — the one that stood',
    '# down must not take it away from the one that is restoring.',
    'if ($locked -and $lock -ne \'\') { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue }',
    'exit 1',
    '',
  ];
  return lines.join('\r\n');
}

/**
 * The command line that runs the rollback watcher as its own hidden process.
 *
 * @param {string} scriptPath
 * @param {{ executable?: string }} [options]
 * @returns {string}
 */
export function buildWatcherCommandLine(scriptPath, { executable = 'powershell.exe' } = {}) {
  const file = nonEmptyString(scriptPath);
  if (file === null) return '';
  return executable
    + ' -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'
    + file
    + '"';
}

/**
 * Write a helper script atomically: a temporary file + a rename, so a
 * half-written script can never be executed.
 *
 * @param {string} file
 * @param {string} text
 * @returns {{ ok: boolean, error: string|null }}
 */
export function writeTextFileAtomic(file, text) {
  const target = nonEmptyString(file);
  if (target === null) return { ok: false, error: 'writeTextFileAtomic requires a path' };
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    const temporary = target + '.tmp';
    writeFileSync(temporary, String(text), { encoding: 'utf8' });
    renameSync(temporary, target);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: 'could not write ' + target + ': ' + errorText(error) };
  }
}

/**
 * Start the rollback watcher as a process that survives the death of the host.
 *
 * The watcher is the only thing that can confirm the new instance when the
 * restart command kills the host itself — which is exactly what a hosted
 * restart does. It is therefore started OUTSIDE the process tree of the host:
 *
 *   - on Windows through WMI (the same mechanism the detached restart uses),
 *     with a one-shot scheduled task as the fallback;
 *   - everywhere else through a detached child (POSIX `setsid`), which is in
 *     its own session and therefore immune to a kill of the host's process
 *     group.
 *
 * @param {{
 *   watchScriptPath?: string|null,
 *   watchCommand?: string|null,
 *   taskName?: string,
 *   timeoutMs?: number,
 *   dryRun?: boolean,
 *   platform?: string,
 *   spawnFn?: Function,
 *   execFileSyncFn?: Function,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   method: 'wmi'|'schtasks'|'spawn'|'none',
 *   command: string,
 *   error: string|null,
 *   dryRun: boolean,
 * }}
 */
export function launchDetachedWatcher({
  watchScriptPath = null,
  watchCommand = null,
  taskName = DEFAULT_WATCH_TASK_NAME,
  timeoutMs = 20000,
  dryRun = false,
  platform = process.platform,
  spawnFn = spawn,
  execFileSyncFn = execFileSync,
} = {}) {
  const command = nonEmptyString(watchCommand) ?? buildWatcherCommandLine(watchScriptPath);
  const task = nonEmptyString(taskName) ?? DEFAULT_WATCH_TASK_NAME;
  const base = {
    ok: false,
    method: /** @type {'wmi'|'schtasks'|'spawn'|'none'} */ ('none'),
    command,
    error: null,
    dryRun: dryRun === true,
  };
  if (command === '') {
    return { ...base, error: 'launchDetachedWatcher requires a watcher command' };
  }
  if (dryRun === true) {
    return { ...base, ok: true, method: 'none' };
  }

  if (platform === 'win32') {
    const wmiCommand = buildWmiRestartCommand(command);
    const schtasksCreate = ['/Create', '/SC', 'ONCE', '/ST', '23:59', '/TN', task, '/TR', command, '/F'];
    const schtasksRun = ['/Run', '/TN', task];
    const execOptions = { windowsHide: true, timeout: timeoutMs, stdio: 'ignore' };
    let lastError = null;
    try {
      const stdout = execFileSyncFn(wmiCommand.file, wmiCommand.args, {
        ...execOptions,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      const match = /"ReturnValue"\s*:\s*(\d+)/.exec(String(stdout ?? ''));
      if (match !== null && Number(match[1]) !== 0) {
        throw new Error(`WMI Win32_Process.Create returned ReturnValue=${match[1]}`);
      }
      return { ...base, ok: true, method: 'wmi' };
    } catch (error) {
      lastError = errorText(error);
    }
    try {
      execFileSyncFn('schtasks', schtasksCreate, execOptions);
      execFileSyncFn('schtasks', schtasksRun, execOptions);
      return { ...base, ok: true, method: 'schtasks', error: lastError };
    } catch (error) {
      lastError = `${lastError ? `${lastError}; ` : ''}${errorText(error)}`;
    }
    // The last resort: a detached child. On Windows it shares the job object
    // of the host, so it may die with it — but a watcher that dies with the
    // host is better than no watcher at all.
    try {
      const child = spawnFn(command, { shell: true, detached: true, windowsHide: true, stdio: 'ignore' });
      if (typeof child.on === 'function') child.on('error', () => {});
      try {
        child.unref();
      } catch {
        /* nothing else to do */
      }
      if (typeof child.pid !== 'number') {
        return { ...base, method: 'spawn', error: lastError || 'the watcher could not be started' };
      }
      return { ...base, ok: true, method: 'spawn', error: lastError };
    } catch (error) {
      return { ...base, method: 'spawn', error: `${lastError ? `${lastError}; ` : ''}${errorText(error)}` };
    }
  }

  // POSIX: a detached child is its own session leader (setsid), so it survives
  // the death of the host — even when the host is killed as a process group.
  try {
    const child = spawnFn(command, { shell: true, detached: true, stdio: 'ignore' });
    if (typeof child.on === 'function') child.on('error', () => {});
    try {
      child.unref();
    } catch {
      /* nothing else to do */
    }
    if (typeof child.pid !== 'number') {
      return { ...base, method: 'spawn', error: 'the watcher could not be started' };
    }
    return { ...base, ok: true, method: 'spawn' };
  } catch (error) {
    return { ...base, method: 'spawn', error: errorText(error) };
  }
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
    const written = writeTextFileAtomic(watchFile, watchText);
    if (!written.ok) {
      return { ...base, error: 'could not write the rollback watcher: ' + written.error };
    }
  }

  if (gated) {
    // The helper must exist before the scheduler runs it: write it atomically
    // (tmp file + rename) so a half-written .cmd can never be executed.
    const written = writeTextFileAtomic(scriptFile, script);
    if (!written.ok) {
      return { ...base, error: 'could not write the gate script: ' + written.error };
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
 * THE SUCCESS OF THE RESTART IS NOT "THE COMMAND STARTED".
 *
 * The old implementation spawned the command with `stdio: 'ignore'`, threw
 * the `error` event away and answered `ok: true` as soon as the spawn
 * succeeded. A command that does not exist (`command not found`), a command
 * that exits with a non-zero code and a command that dies immediately were
 * all reported as a successful restart. The host was then "restarted" into
 * nothing, and nobody was told.
 *
 * This implementation answers with what actually happened:
 *
 *   - `exitCode` — the code the command ended with;
 *   - `timedOut` — the command was still running when the window closed
 *     (a command that starts the host in the foreground never returns, so this
 *     is NOT a failure — but it is not a success either);
 *   - `error` — the reason a failure happened (the command could not be
 *     started at all, or it exited with a non-zero code);
 *   - `output` — what the command printed (the tail of it), so the reason of a
 *     failure is readable in the log.
 *
 * @param {{
 *   command?: string,
 *   dryRun?: boolean,
 *   timeoutMs?: number,
 *   spawnFn?: Function,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   command: string|null,
 *   dryRun: boolean,
 *   pid: number|null,
 *   exitCode: number|null,
 *   signal: string|null,
 *   timedOut: boolean,
 *   error: string|null,
 *   output: string,
 * }>}
 */
export function runCommandNow({
  command,
  dryRun = false,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  spawnFn = spawn,
} = {}) {
  const text = typeof command === 'string' ? command : '';
  if (!text.trim()) {
    return Promise.resolve({
      ok: false,
      command: null,
      dryRun: dryRun === true,
      pid: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      error: 'runCommandNow requires a command',
      output: '',
    });
  }
  if (dryRun === true) {
    return Promise.resolve({
      ok: true,
      command: text,
      dryRun: true,
      pid: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      error: null,
      output: '',
    });
  }
  const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.trunc(Number(timeoutMs))
    : DEFAULT_COMMAND_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        try {
          clearTimeout(timer);
        } catch {
          /* nothing else to do */
        }
        timer = null;
      }
      resolve({
        ok: false,
        command: text,
        dryRun: false,
        pid: null,
        exitCode: null,
        signal: null,
        timedOut: false,
        error: 'the restart command did not run',
        output,
        ...result,
      });
    };

    let child;
    try {
      child = spawnFn(text, {
        shell: true,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ error: 'the restart command could not be started: ' + errorText(error) });
      return;
    }
    if (!child) {
      finish({ error: 'the restart command could not be started' });
      return;
    }

    const collect = (chunk) => {
      output = (output + String(chunk ?? '')).slice(-4096);
    };
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', collect);
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', collect);

    // A spawn that fails (the command does not exist) is reported — never
    // swallowed. This is the defect the old implementation hid.
    if (typeof child.on === 'function') {
      child.on('error', (error) => {
        finish({ error: 'the restart command could not be started: ' + errorText(error) });
      });
      child.on('exit', (code, signal) => {
        const exitCode = Number.isFinite(Number(code)) ? Number(code) : null;
        if (exitCode === 0) {
          finish({ ok: true, pid: child.pid ?? null, exitCode: 0, signal: signal ?? null, error: null });
          return;
        }
        const tail = output.trim();
        finish({
          ok: false,
          pid: child.pid ?? null,
          exitCode,
          signal: signal ?? null,
          error: 'the restart command exited with code ' + String(exitCode)
            + (tail === '' ? '' : ': ' + tail),
        });
      });
    }

    // The window: the command is given this long to finish. A command that
    // outlives it is NOT killed (it may be the host itself, running in the
    // foreground) — it is reported as "still running", and the caller decides.
    timer = setTimeout(() => {
      finish({
        ok: true,
        pid: child.pid ?? null,
        exitCode: null,
        signal: null,
        timedOut: true,
        error: null,
      });
    }, budget);

    try {
      child.unref();
    } catch {
      /* nothing else to do */
    }
  });
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
