/**
 * THE WATCHDOG DRILL: four real scenarios, and the tiers on a real machine.
 *
 * Nothing here touches the profile of a running DSH: the drill works in its
 * own directory under the temp directory, with a FAKE host (a small script
 * that either comes up and writes the ready marker, or stays down).
 *
 *   1. the host comes up            -> the watchdog stands down, NO restore
 *   2. the host never comes up      -> restore, start again, RECOVERED
 *   3. the host stays down          -> restore ONCE, start again, FAILED
 *   4. the host is UP but wrote NO ready marker (the 0.8.2 incident) -> the
 *      watchdog ASKS THE HEALTH ROUTE, sees the host answer, does NOT restore,
 *      and still deletes the pending marker AND the scheduled task.
 *
 * And then the tiers, for real:
 *
 *   - the Windows scheduled task is registered, read back, and REALLY FIRES
 *     (a marker file appears), and is deleted completely afterwards;
 *   - the detached process tier runs inside WSL (setsid nohup), and the
 *     systemd tier runs there too.
 *
 * The drill cleans up after itself: no leftover task, no leftover process,
 * no leftover directory.
 */

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPending,
  readReport,
  readyPath,
  writePending,
  writeReady,
} from '../lib/watchdog.js';
import {
  detachedPidPath,
  localIso,
  registerDetachedProcess,
  registerScheduledTask,
  removeScheduledTask,
} from '../lib/watchdog-schedule.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..');
const drillRoot = path.join(os.tmpdir(), 'dsh-watchdog-drill-' + crypto.randomUUID());

/** The checks of the drill: every one of them must pass. */
const failures = [];
/**
 * @param {string} what
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(what, ok, detail = '') {
  const line = (ok ? '  ok   ' : '  FAIL ') + what + (detail ? ' (' + detail + ')' : '');
  console.log(line);
  if (!ok) failures.push(line);
}

/**
 * Wait for a file to appear.
 *
 * @param {string} file
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return fs.existsSync(file);
}

/**
 * The fake host: it comes up (and writes the ready marker) or it stays down.
 *
 * @param {string} dir
 * @param {'up'|'down'} behaviour
 */
function fakeHost(dir, behaviour) {
  const marker = path.join(dir, 'restore.log');
  const script = path.join(dir, 'fake-host.mjs');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const dir = process.argv[2];",
    "const behaviour = process.argv[3];",
    "if (behaviour === 'up') {",
    "  fs.writeFileSync(path.join(dir, 'watchdog-ready.json'), JSON.stringify({ at: Date.now() }));",
    "}",
    "fs.appendFileSync(path.join(dir, 'host.log'), behaviour + '\\n');",
    "setTimeout(() => process.exit(0), 30000);",
    '',
  ].join('\n'), 'utf8');
  return { script, marker };
}

/**
 * The fake restore: it counts the attempts, and it can make the host come up.
 *
 * @param {string} dir
 * @param {boolean} fixIt whether the restore makes the host come up
 */
function fakeRestore(dir, fixIt) {
  const script = path.join(dir, 'fake-restore.mjs');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const dir = process.argv[2];",
    "fs.appendFileSync(path.join(dir, 'restore.log'), 'restore\\n');",
    fixIt
      ? "fs.writeFileSync(path.join(dir, 'behaviour.txt'), 'up');"
      : "fs.writeFileSync(path.join(dir, 'behaviour.txt'), 'down');",
    '',
  ].join('\n'), 'utf8');
  return script;
}

/**
 * The "start the host again" command: it reads the behaviour file.
 *
 * @param {string} dir
 */
function fakeStart(dir) {
  const script = path.join(dir, 'fake-start.mjs');
  fs.writeFileSync(script, [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const dir = process.argv[2];",
    "const behaviour = fs.existsSync(path.join(dir, 'behaviour.txt'))",
    "  ? fs.readFileSync(path.join(dir, 'behaviour.txt'), 'utf8').trim()",
    "  : 'down';",
    "const child = spawn(process.execPath, [path.join(dir, 'fake-host.mjs'), dir, behaviour], { detached: true, stdio: 'ignore' });",
    "child.unref();",
    '',
  ].join('\n'), 'utf8');
  return script;
}

/**
 * Run one scenario of the drill.
 *
 * @param {{ name: string, behaviour: 'up'|'down', fixIt: boolean, expect: string }} options
 */
async function scenario({ name, behaviour, fixIt, expect }) {
  const dir = path.join(drillRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const restoreLog = path.join(dir, 'restore.log');
  const readyMarker = readyPath(dir);
  const host = fakeHost(dir, behaviour);
  const restore = fakeRestore(dir, fixIt);
  const start = fakeStart(dir);
  fs.writeFileSync(path.join(dir, 'behaviour.txt'), behaviour);

  // The pending marker: what the plugin writes before the restart.
  writePending(dir, buildPending({
    tier: 'detached-process',
    tierReason: 'the drill starts the watchdog directly',
    restoreCommand: { file: process.execPath, args: [restore, dir] },
    relaunchCommand: { file: process.execPath, args: [start, dir] },
    timeoutMs: 4000,
    recheckMs: 1500,
    readyTimeoutMs: 6000,
    now: Date.now(),
  }));

  // Scenario 1: the host comes up. The others: it stays down.
  if (behaviour === 'up') {
    const child = spawn(process.execPath, [host.script, dir, 'up'], { detached: true, stdio: 'ignore' });
    child.unref();
  }

  // The watchdog itself: the real CLI, in its own process.
  const watchdog = spawn(process.execPath, [path.join(here, 'watchdog.mjs'), '--state-dir', dir], { stdio: 'ignore' });
  await new Promise((resolve) => watchdog.on('exit', resolve));

  const report = readReport(dir);
  const restores = fs.existsSync(restoreLog) ? fs.readFileSync(restoreLog, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  check(name + ': the report says ' + expect, report !== null && report.result === expect, report ? report.result : 'no report');
  if (expect === 'not-needed') {
    check(name + ': nothing was restored', restores === 0, restores + ' restore(s)');
  } else {
    check(name + ': the restore ran exactly once', restores === 1, restores + ' restore(s)');
    check(name + ': the report says which tier was used', report !== null && typeof report.tier === 'string' && report.tier !== '', report ? report.tier : '');
  }
  check(name + ': the pending marker is gone', !fs.existsSync(path.join(dir, 'watchdog-pending.json')));
  check(name + ': the report was kept', fs.existsSync(path.join(dir, 'last-watchdog-report.json')));
  return report;
}

/**
 * A fake host that is UP and answers the health route -- and NEVER writes the
 * ready marker. That is exactly the 0.8.2 incident: a healthy host with no
 * marker, because the marker write failed and the failure was swallowed.
 *
 * @param {string} dir
 */
function fakeHealthOnlyHost(dir) {
  const script = path.join(dir, 'fake-health-host.mjs');
  const portFile = path.join(dir, 'health-port.txt');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    "import http from 'node:http';",
    "import path from 'node:path';",
    "const dir = process.argv[2];",
    "const server = http.createServer((req, res) => {",
    "  res.statusCode = 200;",
    "  res.setHeader('content-type', 'application/json');",
    "  res.end(JSON.stringify({ ok: true }));",
    "});",
    "server.listen(0, '127.0.0.1', () => {",
    "  fs.writeFileSync(path.join(dir, 'health-port.txt'), String(server.address().port));",
    "});",
    "setTimeout(() => process.exit(0), 90000);",
    '',
  ].join('\n'), 'utf8');
  return { script, portFile };
}

/**
 * Does the Windows task still exist?
 *
 * @param {string} taskName
 * @returns {boolean}
 */
function taskStillExists(taskName) {
  try {
    execFileSync('schtasks', ['/Query', '/TN', taskName], { stdio: 'ignore', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * SCENARIO 4 -- THE HOST IS UP BUT WROTE NO READY MARKER (the 0.8.2 incident).
 *
 * The watchdog must ask the health route itself before it restores anything.
 * The host answers, so the snapshot is NOT restored -- and the pending marker
 * and the real scheduled task are still cleaned up (an armed task that fires
 * later would restore a healthy profile).
 */
async function scenarioHostUpWithoutMarker() {
  const name = 'scenario-4-no-marker';
  const dir = path.join(drillRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const restoreLog = path.join(dir, 'restore.log');
  const restore = fakeRestore(dir, false);

  // (1) The host: up, answering health, NO ready marker.
  const host = fakeHealthOnlyHost(dir);
  const child = spawn(process.execPath, [host.script, dir], { detached: true, stdio: 'ignore' });
  child.unref();
  const up = await waitForFile(host.portFile, 15000);
  check(name + ': the fake host came up and answers health', up);
  const port = up ? Number(fs.readFileSync(host.portFile, 'utf8').trim()) : 0;
  check(name + ': the health port is known', Number.isFinite(port) && port > 0, String(port));

  // (2) The instance record the real host writes at boot -- WITHOUT a boot id,
  //     so "is an instance alive" cannot be answered from it alone: only the
  //     direct health question can. That is the guard this scenario tests.
  const portFile = path.join(dir, 'access.json');
  fs.writeFileSync(portFile, JSON.stringify({ bootId: null, port: port > 0 ? port : null, at: Date.now() }), 'utf8');

  // (3) A REAL scheduling item: the watchdog has to delete it, not only the
  //     pending marker. (On a machine without the task scheduler the drill
  //     falls back to the detached-process tier and checks the markers only.)
  const taskName = 'dsh-autorestart-drill-' + crypto.randomUUID().slice(0, 8);
  let registered = { ok: false, error: 'the task scheduler is not used here' };
  if (process.platform === 'win32') {
    registered = registerScheduledTask({
      taskName,
      startIso: localIso(new Date(Date.now() + 15 * 60 * 1000)),
      endIso: localIso(new Date(Date.now() + 45 * 60 * 1000)),
      command: 'echo fired > "' + path.join(dir, 'task-fired.txt') + '"',
      xmlPath: path.join(dir, 'task.xml'),
    });
    check(name + ': the real scheduled task was registered', registered.ok === true, registered.error || '');
  }

  writePending(dir, buildPending({
    tier: registered.ok === true ? 'scheduled-task' : 'detached-process',
    tierReason: 'the drill arms the watchdog itself',
    taskName: registered.ok === true ? taskName : '',
    restoreCommand: { file: process.execPath, args: [restore, dir] },
    healthPath: '/__dsh_autorestart/health',
    portFile,
    expectedBootId: 'the-boot-before-the-restart',
    timeoutMs: 3000,
    recheckMs: 800,
    readyTimeoutMs: 4000,
    now: Date.now(),
  }));

  const watchdog = spawn(process.execPath, [path.join(here, 'watchdog.mjs'), '--state-dir', dir], { stdio: 'ignore' });
  await new Promise((resolve) => watchdog.on('exit', resolve));

  const report = readReport(dir);
  const restores = fs.existsSync(restoreLog)
    ? fs.readFileSync(restoreLog, 'utf8').trim().split('\n').filter(Boolean).length
    : 0;
  check(name + ': the report says not-needed', report !== null && report.result === 'not-needed', report ? String(report.result) : 'no report');
  check(name + ': the health route was asked and answered', report !== null && report.healthCheck === 'healthy', report ? String(report.healthCheck) : 'no report');
  check(name + ': nothing was restored', restores === 0, restores + ' restore(s)');
  check(name + ': the pending marker is gone', !fs.existsSync(path.join(dir, 'watchdog-pending.json')));
  check(name + ': no task was fired', !fs.existsSync(path.join(dir, 'task-fired.txt')));
  if (registered.ok === true) {
    check(name + ': the scheduled task is gone', !taskStillExists(taskName), taskName);
  }
  try {
    child.kill();
  } catch {
    // It is gone anyway (it exits by itself).
  }
  return report;
}

/**
 * The Windows scheduled task, for real: register it, read it back, let it
 * fire, delete it.
 */
async function windowsTier() {
  const dir = path.join(drillRoot, 'tier-windows');
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, 'fired.txt');
  const taskName = 'dsh-autorestart-drill-' + crypto.randomUUID().slice(0, 8);
  const xmlPath = path.join(dir, 'task.xml');
  const start = new Date(Date.now() + 60 * 1000);
  const end = new Date(Date.now() + 10 * 60 * 1000);
  const registered = registerScheduledTask({
    taskName,
    startIso: localIso(start),
    endIso: localIso(end),
    command: 'echo fired > "' + marker + '"',
    xmlPath,
  });
  check('tier 1: the task was registered and read back', registered.ok === true, registered.error || '');
  if (!registered.ok) return;
  // It must REALLY fire.
  const fired = await waitForFile(marker, 100000);
  check('tier 1: the task really fired', fired);
  const removed = removeScheduledTask({ taskName });
  check('tier 1: the task was deleted', removed.ok === true, removed.error || '');
  let gone = false;
  try {
    execFileSync('schtasks', ['/Query', '/TN', taskName], { stdio: 'ignore', timeout: 15000 });
  } catch {
    gone = true;
  }
  check('tier 1: the task is really gone', gone);
  try {
    fs.rmSync(xmlPath, { force: true });
  } catch {
    // It is gone either way.
  }
}

/**
 * The Linux tiers, for real: inside WSL.
 */
async function linuxTiers() {
  const dir = path.join(drillRoot, 'tier-linux');
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, 'fired.txt');
  const wslDir = wslPath(dir);
  const helper = path.join(dir, 'tier.mjs');
  fs.writeFileSync(helper, [
    "import { registerDetachedProcess, registerSystemdRun, cleanupSystemdUnit } from '" + wslPath(path.join(pluginDir, 'lib', 'watchdog-schedule.js')).replace(/\\/g, '/') + "';",
    "const dir = process.argv[2];",
    "const marker = process.argv[3];",
    "const which = process.argv[4];",
    "if (which === 'systemd') {",
    "  const unit = 'dsh-watchdog-drill-' + Date.now();",
    "  const answer = registerSystemdRun({ unitId: unit, delaySeconds: 2, command: ['sh', '-c', 'sleep 1; echo fired > ' + marker] });",
    "  console.log(JSON.stringify({ ok: answer.ok, error: answer.error }));",
    "  setTimeout(() => { cleanupSystemdUnit({ unitId: unit }); }, 6000);",
    "} else {",
    "  const answer = registerDetachedProcess({ delaySeconds: 2, command: \"sh -c 'echo fired > \" + marker + \"'\", pidPath: dir + '/pid' });",
    "  console.log(JSON.stringify({ ok: answer.ok, pid: answer.pid, error: answer.error }));",
    "}",
    '',
  ].join('\n'), 'utf8');

  // Tier 3: the detached process of our own.
  try {
    const out = execFileSync('wsl.exe', ['-e', 'node', wslPath(helper), wslDir, wslPath(marker), 'detached'], { encoding: 'utf8', timeout: 60000 });
    const answer = JSON.parse(String(out).trim().split('\n').pop());
    check('tier 3: the background process was started', answer.ok === true, answer.error || '');
    check('tier 3: it really ran later', await waitForFile(marker, 20000));
  } catch (error) {
    check('tier 3: the background process was started', false, String(error && error.message ? error.message : error));
  }
  try {
    fs.rmSync(marker, { force: true });
  } catch {
    // It is gone either way.
  }

  // Tier 2: the systemd user timer.
  try {
    const out = execFileSync('wsl.exe', ['-e', 'node', wslPath(helper), wslDir, wslPath(marker), 'systemd'], { encoding: 'utf8', timeout: 60000 });
    const answer = JSON.parse(String(out).trim().split('\n').pop());
    check('tier 2: the systemd unit was registered', answer.ok === true, answer.error || '');
    check('tier 2: it really ran later', await waitForFile(marker, 30000));
  } catch (error) {
    check('tier 2: the systemd unit was registered', false, String(error && error.message ? error.message : error));
  }
}

/**
 * The WSL path of a Windows path.
 *
 * @param {string} target
 * @returns {string}
 */
function wslPath(target) {
  const normalized = target.replace(/\\/g, '/');
  const match = /^[A-Za-z]:\/(.*)$/.exec(normalized);
  if (!match) return normalized;
  return '/mnt/' + normalized[0].toLowerCase() + '/' + match[1];
}

/**
 * Wait a moment (the drill is not in a hurry).
 *
 * @param {number} ms
 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log('dsh-autorestart watchdog drill');
console.log('  workspace: ' + drillRoot);
console.log('');

console.log('--- the four scenarios ---');
await scenario({ name: 'scenario-1-normal', behaviour: 'up', fixIt: false, expect: 'not-needed' });
await scenario({ name: 'scenario-2-recovered', behaviour: 'down', fixIt: true, expect: 'recovered' });
await scenario({ name: 'scenario-3-failed', behaviour: 'down', fixIt: false, expect: 'failed' });
// THE 0.8.2 INCIDENT: a healthy host that never wrote the ready marker. The
// watchdog has to ask the health route instead of trusting the marker.
await scenarioHostUpWithoutMarker();

console.log('');
console.log('--- the tiers, for real ---');
await windowsTier();
await linuxTiers();

console.log('');
console.log('--- cleanup ---');
try {
  fs.rmSync(drillRoot, { recursive: true, force: true });
  check('the drill directory is gone', !fs.existsSync(drillRoot));
} catch (error) {
  check('the drill directory is gone', false, String(error && error.message ? error.message : error));
}
await wait(500);

console.log('');
if (failures.length === 0) {
  console.log('the watchdog drill passed: every scenario behaved as it should, every tier really fires.');
  process.exit(0);
}
console.log('the watchdog drill FAILED:');
for (const line of failures) console.log('  ' + line);
process.exit(1);
