/**
 * THE WATCHDOG FLOW — the same for every tier.
 *
 * The rules that matter:
 *
 *   - a host that comes up late is NOT a dead host (ask again);
 *   - a host that is alive is never rolled back under (no double start);
 *   - exactly ONE restore at a time (the lock);
 *   - at most ONE restore and ONE start (then it stops and says 'failed').
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPending,
  clearPending,
  readPending,
  readReport,
  readReady,
  reportPath,
  runWatchdogFlow,
  writePending,
  writeReady,
  writeReport,
} from '../lib/watchdog.js';

/** A directory of its own for every test. */
function tempDir(name) {
  const dir = path.join(os.tmpdir(), 'dsh-watchdog-test-' + name + '-' + process.pid + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The dependencies of a run, with everything stubbed out.
 *
 * @param {object} options
 */
function deps(options = {}) {
  const state = { restores: 0, relaunches: 0, released: 0, removed: 0 };
  const clock = { now: options.now ?? 0 };
  const base = {
    state,
    clock,
    sleep: async (ms) => { clock.now += ms; },
    now: () => clock.now,
    pollMs: 1000,
    readReady: () => options.ready === true,
    isWithdrawn: () => options.withdrawn === true,
    probeAlive: async () => options.alive === true,
    runRestore: () => { state.restores += 1; return options.restore ?? { ok: true }; },
    runRelaunch: () => { state.relaunches += 1; return options.relaunch ?? { ok: true }; },
    acquireLock: () => options.locked !== true,
    releaseLock: () => { state.released += 1; },
    removeSchedule: () => { state.removed += 1; },
    writeReport: () => {},
  };
  return base;
}

test('a host that comes up means: no restore at all', async () => {
  const dir = tempDir('not-needed');
  const d = deps({ ready: true });
  const pending = buildPending({ tier: 'systemd-run', tierReason: 'because', timeoutMs: 5000 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'not-needed');
  assert.equal(d.state.restores, 0);
  assert.equal(d.state.relaunches, 0);
  assert.equal(report.tier, 'systemd-run', 'the report says which tier was used');
  assert.equal(report.tierReason, 'because', 'and why');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a host that comes up late is asked again, and not restored', async () => {
  const dir = tempDir('late');
  const d = deps({});
  // The ready marker appears only DURING the second look (after the first
  // wait ran out): a slow host is not a dead host.
  d.readReady = () => d.clock.now >= 6000;
  const pending = buildPending({ timeoutMs: 5000, recheckMs: 1000 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'not-needed');
  assert.equal(report.rechecked, true, 'it asked again');
  assert.equal(d.state.restores, 0, 'a slow host is not a dead host');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a host that never comes up is restored and started again', async () => {
  const dir = tempDir('recovered');
  const d = deps({ alive: false });
  let readyAfter = false;
  d.runRelaunch = () => { d.state.relaunches += 1; readyAfter = true; return { ok: true }; };
  d.readReady = () => readyAfter;
  const pending = buildPending({ timeoutMs: 2000, recheckMs: 1000, readyTimeoutMs: 5000 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'recovered');
  assert.equal(report.restored, true);
  assert.equal(report.relaunched, true);
  assert.equal(d.state.restores, 1);
  assert.equal(d.state.relaunches, 1);
  assert.equal(d.state.released, 1, 'the lock is given back');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a host that stays down is restored ONCE and then it stops', async () => {
  const dir = tempDir('failed');
  const d = deps({ alive: false });
  const pending = buildPending({ timeoutMs: 2000, recheckMs: 1000, readyTimeoutMs: 3000 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'failed');
  assert.equal(d.state.restores, 1, 'exactly one restore');
  assert.equal(d.state.relaunches, 1, 'exactly one start');
  assert.ok(report.error, 'the report says why');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a live instance is never rolled back under', async () => {
  const dir = tempDir('alive');
  const d = deps({ alive: true });
  const pending = buildPending({ timeoutMs: 2000, recheckMs: 1000 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'abandoned');
  assert.equal(d.state.restores, 0, 'no double start');
  assert.match(String(report.error), /alive/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a rollback that is already running wins: the watchdog stands down', async () => {
  const dir = tempDir('locked');
  const d = deps({ alive: false, locked: true });
  const pending = buildPending({ timeoutMs: 2000, recheckMs: 1000 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'abandoned');
  assert.equal(d.state.restores, 0);
  assert.match(String(report.error), /another rollback/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a plugin that decided on its own makes the watchdog stand down', async () => {
  const dir = tempDir('decided');
  const d = deps({ withdrawn: true });
  const pending = buildPending({ timeoutMs: 2000, recheckMs: 1000 });
  const report = await runWatchdogFlow({ pending, stateDir: dir, deps: d });
  assert.equal(report.result, 'decided');
  assert.equal(d.state.restores, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the scheduling item and the pending marker go, the report stays', async () => {
  const dir = tempDir('cleanup');
  writePending(dir, buildPending({ tier: 'scheduled-task' }));
  const d = deps({ ready: true });
  d.writeReport = (report) => writeReport(dir, report);
  const report = await runWatchdogFlow({ pending: buildPending({}), stateDir: dir, deps: d });
  assert.equal(d.state.removed, 1, 'the scheduling item is removed');
  assert.equal(readPending(dir), null, 'the pending marker is gone');
  assert.ok(fs.existsSync(reportPath(dir)), 'the report is kept');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the markers live where they belong', () => {
  const dir = tempDir('markers');
  writePending(dir, buildPending({ tier: 'detached-process' }));
  assert.equal(readPending(dir).tier, 'detached-process');
  writeReady(dir, { bootId: 'b1', port: 1234 });
  assert.equal(readReady(dir).port, 1234);
  clearPending(dir);
  assert.equal(readPending(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
