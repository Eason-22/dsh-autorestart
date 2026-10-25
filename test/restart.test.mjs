import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_IMAGE_NAME,
  DEFAULT_RELAUNCH_DELAY_SECONDS,
  DEFAULT_ROLLBACK_TIMEOUT_MS,
  DEFAULT_TASK_NAME,
  buildCustomCommand,
  buildGateScript,
  buildRestartCommand,
  buildWatchScript,
  buildWmiRestartCommand,
  detectEnvironment,
  runCommandNow,
  scheduleDetachedRestart,
} from '../lib/restart.js';

const APP_EXE = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe';
const RUNTIME_NODE =
  'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe';

test('detectEnvironment reports the desktop app exe and the host pid chain', () => {
  const environment = detectEnvironment({
    platform: 'win32',
    execPath: APP_EXE,
    pid: 4321,
    ppid: 1234,
    env: {},
  });
  assert.deepEqual(Object.keys(environment).sort(), [
    'appExePath',
    'execPath',
    'hostPid',
    'isDesktopApp',
    'killPid',
    'mainPid',
    'pid',
    'platform',
    'ppid',
  ]);
  assert.equal(environment.platform, 'win32');
  assert.equal(environment.pid, 4321);
  assert.equal(environment.ppid, 1234);
  assert.equal(environment.hostPid, 4321);
  assert.equal(environment.mainPid, 1234);
  assert.equal(environment.killPid, 1234);
  assert.equal(environment.execPath, APP_EXE);
  assert.equal(environment.isDesktopApp, true);
  assert.equal(environment.appExePath, APP_EXE);
});

test('detectEnvironment treats any DeepSeek Harness execPath as the desktop app', () => {
  const environment = detectEnvironment({ platform: 'win32', execPath: RUNTIME_NODE, env: {}, pid: 1, ppid: 2 });
  assert.equal(environment.isDesktopApp, true);
  // Verified rule: appExePath is the runtime exec path itself when it is the app.
  assert.equal(environment.appExePath, RUNTIME_NODE);
});

test('detectEnvironment does not pretend a plain node install is the desktop app', () => {
  const environment = detectEnvironment({
    platform: 'win32',
    execPath: 'C:\\nodejs\\node.exe',
    env: {},
    pid: 1,
    ppid: 2,
  });
  assert.equal(environment.isDesktopApp, false);
  assert.equal(environment.appExePath, null);
  assert.equal(environment.killPid, 2);
});

test('buildRestartCommand produces the exact verified detached cmd line', () => {
  const command = buildRestartCommand({ appExePath: APP_EXE });
  const expected =
    `cmd.exe /c ping -n ${DEFAULT_RELAUNCH_DELAY_SECONDS + 1} 127.0.0.1 >nul` +
    ` & taskkill /IM "${DEFAULT_IMAGE_NAME}" /T /F & start "" "${APP_EXE}"`;
  assert.equal(command, expected);
  assert.equal(command.includes('& taskkill /IM "DeepSeek Harness.exe" /T /F & start "" '), true);
});

test('buildRestartCommand honours the delay, image name and missing exe', () => {
  assert.equal(buildRestartCommand({ appExePath: APP_EXE, relaunchDelaySeconds: 0 }).includes('ping -n 1 '), true);
  assert.equal(buildRestartCommand({ appExePath: APP_EXE, relaunchDelaySeconds: 9 }).includes('ping -n 10 '), true);
  assert.equal(
    buildRestartCommand({ appExePath: APP_EXE, taskkillImageName: 'Other App.exe' }).includes(
      'taskkill /IM "Other App.exe" /T /F',
    ),
    true,
  );
  const noExe = buildRestartCommand({});
  assert.equal(noExe.includes('start "" ""'), true);
});

test('buildWmiRestartCommand escapes the cmd line for PowerShell', () => {
  const command = buildRestartCommand({ appExePath: "C:\\O'Brien\\app.exe", relaunchDelaySeconds: 2 });
  const wmi = buildWmiRestartCommand(command);
  assert.equal(wmi.file, 'powershell.exe');
  assert.deepEqual(wmi.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(wmi.args[3].includes("O''Brien"), true);
  assert.equal(wmi.args[3].includes('Invoke-CimMethod -ClassName Win32_Process -MethodName Create'), true);
  assert.equal(wmi.args[3].includes('CommandLine = '), true);
});

test('scheduleDetachedRestart dry-run plans WMI + schtasks without executing', () => {
  const result = scheduleDetachedRestart({ appExePath: APP_EXE, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.method, 'wmi');
  assert.equal(result.error, null);

  const expectedCommand =
    `cmd.exe /c ping -n ${DEFAULT_RELAUNCH_DELAY_SECONDS + 1} 127.0.0.1 >nul` +
    ` & taskkill /IM "DeepSeek Harness.exe" /T /F & start "" "${APP_EXE}"`;
  assert.equal(result.command, expectedCommand);

  assert.equal(Array.isArray(result.commands), true);
  assert.deepEqual(result.commands.map((entry) => entry.method), ['wmi', 'schtasks-create', 'schtasks-run']);

  // Primary WMI invocation.
  assert.equal(result.commands[0].file, 'powershell.exe');
  assert.equal(result.commands[0].args.includes('-Command'), true);
  assert.equal(result.commands[0].args.join(' ').includes('Invoke-CimMethod'), true);
  assert.equal(result.commands[0].args.join(' ').includes('Win32_Process'), true);
  assert.equal(result.commands[0].args.join(' ').includes('MethodName Create'), true);

  // Fallback one-shot scheduled task.
  assert.deepEqual(result.schtasksCreate, [
    '/Create',
    '/SC',
    'ONCE',
    '/ST',
    '23:59',
    '/TN',
    DEFAULT_TASK_NAME,
    '/TR',
    expectedCommand,
    '/F',
  ]);
  assert.deepEqual(result.schtasksRun, ['/Run', '/TN', DEFAULT_TASK_NAME]);
});

test('scheduleDetachedRestart dry-run refuses to plan a restart without an exe', () => {
  const result = scheduleDetachedRestart({ dryRun: true });
  assert.equal(result.ok, false);
  assert.equal(result.dryRun, true);
  assert.equal(typeof result.error, 'string');
  assert.match(result.error, /appExePath/);
  assert.equal(typeof result.command, 'string');
});

test('scheduleDetachedRestart dry-run honours task name and delay', () => {
  const result = scheduleDetachedRestart({
    appExePath: APP_EXE,
    taskName: 'dsh-autorestart-test',
    relaunchDelaySeconds: 2,
    dryRun: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.schtasksCreate.includes('dsh-autorestart-test'), true);
  assert.equal(result.schtasksRun.includes('dsh-autorestart-test'), true);
  assert.equal(result.command.includes('ping -n 3 127.0.0.1'), true);
});

test('runCommandNow dry-run reports the command without spawning', () => {
  const command = buildRestartCommand({ appExePath: APP_EXE });
  const result = runCommandNow({ command, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.command, command);
  assert.equal(result.pid, null);

  const missing = runCommandNow({ dryRun: true });
  assert.equal(missing.ok, false);
  assert.equal(typeof missing.error, 'string');
});

test('buildCustomCommand expands {pid} {ppid} {app} placeholders', () => {
  const command = buildCustomCommand({
    template: 'launch {app} --owner {pid} --parent {ppid}',
    pid: 10,
    ppid: 20,
    appExePath: 'C:\\App.exe',
  });
  assert.equal(command, 'launch C:\\App.exe --owner 10 --parent 20');
  assert.equal(buildCustomCommand({ template: '{pid}-{pid}', pid: 7 }), '7-7');
  assert.equal(buildCustomCommand({ template: '{app}|{pid}', pid: null, appExePath: null }), '|');
  assert.equal(buildCustomCommand({}), '');
  assert.equal(buildCustomCommand({ template: 'plain command' }), 'plain command');
});

test('buildGateScript re-checks the idle gate before killing anything', () => {
  const gateUrl = 'http://127.0.0.1:51004/__dsh_autorestart/health?gate=1';
  const script = buildGateScript({
    appExePath: APP_EXE,
    relaunchDelaySeconds: 4,
    gateUrl,
    taskkillImageName: 'DeepSeek Harness.exe',
  });
  assert.equal(script.includes('\r\n'), true, 'a .cmd script must use CRLF lines');
  assert.equal(script.startsWith('@echo off\r\n'), true);
  assert.equal(script.includes('ping -n 5 127.0.0.1 >nul'), true);
  assert.equal(script.includes(gateUrl), true);
  assert.equal(script.includes('Invoke-RestMethod'), true);
  assert.equal(script.includes('allowRestart'), true);
  const gateIndex = script.indexOf('Invoke-RestMethod');
  const killIndex = script.indexOf('taskkill');
  const startIndex = script.indexOf('start ""');
  assert.ok(gateIndex > 0 && gateIndex < killIndex, 'the gate check must come before taskkill');
  assert.ok(killIndex < startIndex, 'the kill must come before the relaunch');
  assert.equal(script.includes('taskkill /IM "DeepSeek Harness.exe" /T /F'), true);
  assert.equal(script.includes('start "" "' + APP_EXE + '"'), true);
  assert.equal(script.includes('exit /b 0'), true, 'a denied gate must abort without killing');
  // The delay is the ping count minus one, as in the inline command.
  assert.equal(buildGateScript({ appExePath: APP_EXE, gateUrl, relaunchDelaySeconds: 0 }).includes('ping -n 1 '), true);
});

test('scheduleDetachedRestart gate dry-run plans the helper script without writing it', () => {
  const gateUrl = 'http://127.0.0.1:51004/__dsh_autorestart/health?gate=1';
  const scriptPath = path.join(os.tmpdir(), 'dsh-autorestart-gate-' + process.pid, 'restart-1.cmd');
  const result = scheduleDetachedRestart({
    appExePath: APP_EXE,
    relaunchDelaySeconds: 2,
    gateUrl,
    scriptPath,
    dryRun: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.gated, true);
  assert.equal(result.scriptPath, scriptPath);
  assert.equal(result.command, 'cmd.exe /c "' + scriptPath + '"');
  assert.equal(typeof result.script, 'string');
  assert.equal(result.script.includes(gateUrl), true);
  assert.equal(result.script.includes('Invoke-RestMethod'), true);
  assert.equal(result.script.includes('taskkill /IM "DeepSeek Harness.exe" /T /F'), true);
  assert.equal(result.script.includes('start "" "' + APP_EXE + '"'), true);
  assert.equal(result.commands.length, 3);
  assert.equal(fs.existsSync(scriptPath), false, 'a dry run must write no files');
  assert.equal(fs.existsSync(path.dirname(scriptPath)), false, 'a dry run must create no directories');

  // A gate URL without a script path is refused, never thrown.
  const missing = scheduleDetachedRestart({ appExePath: APP_EXE, gateUrl, dryRun: true });
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /scriptPath/);

  // Ungated scheduling keeps the exact inline command.
  const plain = scheduleDetachedRestart({ appExePath: APP_EXE, dryRun: true });
  assert.equal(plain.gated, false);
  assert.equal(plain.script, null);
  assert.equal(plain.scriptPath, null);
});

// ---------------------------------------------------------------------------
// Rollback watcher: runs right after the relaunch, waits for the host to answer
// its health route, and puts the pre-restart snapshot back when it never does.
// ---------------------------------------------------------------------------

test('buildWatchScript polls the health route, rolls the snapshot back and relaunches', () => {
  const script = buildWatchScript({
    healthUrl: 'http://127.0.0.1:51004/__dsh_autorestart/health',
    backupDir: 'C:/state/backups/2026-10-25T12-00-00-000Z',
    profileDir: 'C:/Users/x/.dsh/profiles/desktop',
    reportPath: 'C:/state/last-rollback.json',
    appExePath: APP_EXE,
    timeoutMs: 90000,
  });

  assert.equal(script.includes('\r\n'), true, 'the watcher uses CRLF lines');
  assert.ok(script.includes('Invoke-RestMethod'), 'it polls the health route');
  assert.ok(script.includes('AddMilliseconds(90000)'), 'it honours the configured timeout');
  assert.ok(script.includes('robocopy $configBackup $profile /E'), 'it restores the configuration files');
  assert.ok(
    script.includes("robocopy $pluginsBackup (Join-Path $profile 'node_modules') /MIR"),
    'it restores the plugin tree',
  );
  assert.ok(script.includes('last-rollback.json'), 'it writes the report where the plugin reads it');
  assert.ok(
    script.includes('UTF8Encoding($false)'),
    'the report must be written without a BOM (the plugin parses it with JSON.parse)',
  );
  assert.ok(script.includes('Start-Process -FilePath $exe'), 'it launches the host again');
  assert.ok(script.includes('[datetime]'), 'the crash log is filtered to this restart');
  assert.equal(DEFAULT_ROLLBACK_TIMEOUT_MS, 90000);
});

test('the gated helper runs the watcher only after the relaunch', () => {
  const gateUrl = 'http://127.0.0.1:51004/__dsh_autorestart/health?gate=1';
  const watchPath = 'C:/state/restart-3-watch.ps1';
  const script = buildGateScript({
    appExePath: APP_EXE,
    relaunchDelaySeconds: 2,
    gateUrl,
    watchScriptPath: watchPath,
  });
  const startIndex = script.indexOf('start ""');
  const watchIndex = script.indexOf('powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File');
  assert.ok(startIndex > 0, 'the relaunch is still there');
  assert.ok(watchIndex > startIndex, 'the watcher starts after the relaunch');
  assert.ok(
    script.includes('powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File'),
    'the watcher runs as its own hidden process, so the helper console closes right away',
  );
  assert.ok(script.includes(watchPath));

  const plain = buildGateScript({ appExePath: APP_EXE, relaunchDelaySeconds: 2, gateUrl });
  assert.equal(plain.includes('ExecutionPolicy'), false, 'without a watcher the helper is unchanged');
});

test('a planned restart refuses a watcher path without its text', () => {
  const gateUrl = 'http://127.0.0.1:51004/__dsh_autorestart/health?gate=1';
  const scriptPath = path.join(os.tmpdir(), 'dsh-ar-watch-dry', 'restart-1.cmd');
  const watchScriptPath = path.join(os.tmpdir(), 'dsh-ar-watch-dry', 'restart-1-watch.ps1');

  const missing = scheduleDetachedRestart({
    appExePath: APP_EXE,
    gateUrl,
    scriptPath,
    watchScriptPath,
    dryRun: true,
  });
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /watchScript/);

  const planned = scheduleDetachedRestart({
    appExePath: APP_EXE,
    gateUrl,
    scriptPath,
    watchScriptPath,
    watchScript: '# watcher',
    dryRun: true,
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.watchScriptPath, watchScriptPath);
  assert.ok(String(planned.script).includes(watchScriptPath));
  assert.equal(fs.existsSync(path.dirname(scriptPath)), false, 'a dry run still writes nothing');
});