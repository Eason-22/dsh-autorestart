/**
 * dsh-autorestart watchdog: the one-off process that watches the relaunch.
 *
 * The tiers (a Windows scheduled task, a systemd user timer, a detached
 * process of our own) differ only in HOW this file is made to run. What it
 * does is always the same, and it lives in lib/watchdog.js:
 *
 *   wait for the ready marker -> ask again -> is an instance alive? -> take
 *   the lock -> restore the snapshot -> start the host again -> report.
 *
 * This file only provides the parts that touch the machine: the health probe,
 * the restore command, the start-again command, and the lock.
 *
 * It is ASCII on purpose (like every other script of this plugin): the
 * console reads it with the code page of the machine.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  acquireLock,
  LOCK_NAME,
  readPending,
  releaseLock,
  restoreFromSnapshot,
  runWatchdogFlow,
} from '../lib/watchdog.js';
import { removeScheduleItem } from '../lib/watchdog-schedule.js';

/**
 * The value of a command line flag.
 *
 * @param {string[]} args
 * @param {string} name
 * @returns {string}
 */
function valueOf(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return '';
  const next = args[index + 1];
  return typeof next === 'string' && !next.startsWith('--') ? next : '';
}

/**
 * Ask a health route whether it is alive.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function healthOk(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const request = http.get(url, { timeout: timeoutMs }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            done(parsed && parsed.ok === true);
          } catch {
            done(false);
          }
        });
      });
      request.on('timeout', () => { request.destroy(); done(false); });
      request.on('error', () => done(false));
    } catch {
      done(false);
    }
  });
}

/**
 * Every health URL that could answer for this host, most trustworthy first.
 *
 * The NEW instance of the desktop app listens on a RANDOM port, so the URL the
 * old instance knew (`pending.healthUrl`) is usually worthless after a
 * restart. The new instance publishes its own port in the instance record
 * (`pending.portFile`), and that record is asked REGARDLESS of its boot id: any
 * host that answers this route is a host that must not be restored.
 *
 * @param {object} pending
 * @returns {string[]}
 */
function healthCandidates(pending) {
  const healthPath = pending.healthPath || '/__dsh_autorestart/health';
  const urls = [];
  const add = (url) => {
    if (typeof url === 'string' && url !== '' && !urls.includes(url)) urls.push(url);
  };
  // (1) The port the running instance published about itself.
  if (pending.portFile) {
    try {
      const record = JSON.parse(fs.readFileSync(pending.portFile, 'utf8'));
      const port = Number(record && record.port);
      if (Number.isFinite(port) && port > 0) add('http://127.0.0.1:' + port + healthPath);
    } catch {
      // No record yet: the host may not have written it.
    }
  }
  // (2) A port the plugin put into the pending marker itself.
  const own = Number(pending.port);
  if (Number.isFinite(own) && own > 0) add('http://127.0.0.1:' + own + healthPath);
  // (3) The URL of the instance that is being replaced (last resort: it is the
  //     OLD port, but a host that never went down still answers on it).
  add(pending.healthUrl);
  return urls;
}

/**
 * ASK THE HOST ITSELF: is it alive?
 *
 * This is the last question before a restore (see step 3b of
 * lib/watchdog.js). It answers:
 *
 *   'healthy'   -- a health route answered `{"ok":true}`, or an instance of the
 *                 NEW boot is clearly running: DO NOT RESTORE
 *   'unhealthy' -- every known URL was asked and none answered, and no instance
 *                 of the new boot is running: the restore may go ahead
 *   'unknown'   -- there was no URL to ask at all (no instance record, no
 *                 health URL): the caller waits one more round
 *
 * The instance record is checked as well as the ports, because a port in that
 * record can be the WRONG one (it may carry the configured port instead of the
 * one the server really listens on). The pid of the new boot is a harder fact
 * than a failed HTTP request, and "never restore a live host" is the rule that
 * matters here.
 *
 * @param {object} pending
 * @returns {Promise<{ state: 'healthy'|'unhealthy'|'unknown', detail: string|null }>}
 */
async function askHealth(pending) {
  const urls = healthCandidates(pending);
  for (const url of urls) {
    if (await healthOk(url)) return { state: 'healthy', detail: 'the health route answered: ' + url };
  }
  const record = readInstanceRecord(pending.portFile);
  if (record && record.pid && record.bootId !== pending.expectedBootId && isAlive(record.pid)) {
    return { state: 'healthy', detail: 'the instance of the new boot is running (pid ' + record.pid + ')' };
  }
  if (urls.length === 0) return { state: 'unknown', detail: null };
  return { state: 'unhealthy', detail: 'no health route answered (' + urls.length + ' asked), no live instance' };
}

/**
 * The instance record the plugin writes at boot (port, pid, boot id).
 *
 * @param {string} file
 * @returns {object|null}
 */
function readInstanceRecord(file) {
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Is that process still there?
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is an instance of the host alive?
 *
 * The NEW instance publishes its own port (the desktop app listens on a
 * random port, so the port of the old one is worthless). When there is no
 * record at all, the fallback URL of the host is asked.
 *
 * @param {object} pending
 * @returns {Promise<boolean>}
 */
async function probeAlive(pending) {
  const record = (() => {
    if (!pending.portFile) return null;
    try {
      return JSON.parse(fs.readFileSync(pending.portFile, 'utf8'));
    } catch {
      return null;
    }
  })();
  if (record && record.bootId && record.port && record.bootId !== pending.expectedBootId) {
    const url = 'http://127.0.0.1:' + record.port + (pending.healthPath || '/__dsh_autorestart/health');
    if (await healthOk(url)) return true;
  }
  if (pending.healthUrl) {
    if (await healthOk(pending.healthUrl)) return true;
  }
  return false;
}

/**
 * Run a command and report whether it worked.
 *
 * @param {{ file?: string, args?: string[] }|null} command
 * @returns {{ ok: boolean, error: string|null }}
 */
function runCommand(command) {
  if (!command || typeof command.file !== 'string' || command.file === '') {
    return { ok: false, error: 'there is no command to run' };
  }
  try {
    execFileSync(command.file, Array.isArray(command.args) ? command.args : [], {
      timeout: 10 * 60 * 1000,
      windowsHide: true,
      stdio: 'ignore',
    });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

/**
 * Start the host again (it must survive this process).
 *
 * @param {{ file?: string, args?: string[] }|null} command
 * @returns {{ ok: boolean, error: string|null }}
 */
function startAgain(command) {
  if (!command || typeof command.file !== 'string' || command.file === '') {
    return { ok: false, error: 'there is no command to start the host' };
  }
  try {
    const child = spawn(command.file, Array.isArray(command.args) ? command.args : [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

const args = process.argv.slice(2);
const stateDir = valueOf(args, '--state-dir') || process.env.DSH_WATCHDOG_STATE_DIR || '';
if (stateDir === '') {
  console.error('dsh-autorestart watchdog: no state directory (--state-dir)');
  process.exit(2);
}
const pending = readPending(stateDir);
if (!pending) {
  // Nothing to watch: the plugin decided on its own, or another watchdog is
  // already on it. The scheduling item still goes: a task that fires once and
  // then stays in the task scheduler is garbage.
  try {
    removeScheduleItem({ tier: 'scheduled-task', taskName: 'dsh-autorestart-watchdog' });
    removeScheduleItem({ tier: 'systemd-run', unitId: 'dsh-autorestart-watchdog' });
  } catch {
    // It was never there.
  }
  console.log('dsh-autorestart watchdog: no pending marker - nothing to watch');
  process.exit(0);
}
const lockFile = path.join(stateDir, LOCK_NAME);

const report = await runWatchdogFlow({
  pending,
  stateDir,
  deps: {
    probeAlive: () => probeAlive(pending),
    // THE LAST QUESTION BEFORE ANY RESTORE: ask the health route itself. A
    // host that answers must never be rolled back, even when it forgot to
    // write the ready marker.
    askHealth: () => askHealth(pending),
    runRestore: () => (pending.restoreCommand
      ? runCommand(pending.restoreCommand)
      : restoreFromSnapshot({ snapshotDir: pending.snapshotDir, profileDir: pending.profileDir })),
    runRelaunch: () => startAgain(pending.relaunchCommand),
    acquireLock: () => acquireLock(lockFile),
    releaseLock: () => releaseLock(lockFile),
    removeSchedule: () => {
      removeScheduleItem({
        tier: pending.tier,
        taskName: pending.taskName,
        unitId: pending.unitId,
        pidPath: pending.pidPath,
      });
    },
  },
});

console.log('dsh-autorestart watchdog: ' + report.result + ' (tier ' + report.tier + ')');
if (report.error) console.log('  ' + report.error);
process.exit(report.result === 'failed' ? 1 : 0);
