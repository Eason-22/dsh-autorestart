/**
 * The shutdown PLAN on the POSIX side — computed, never executed.
 *
 * The facts this pins down:
 *
 *   - a plain Linux host shuts THAT Linux down: no Windows command is allowed
 *     anywhere in the plan (not in the fallbacks either);
 *   - inside WSL the plan shuts the whole WINDOWS machine down (not the WSL
 *     distribution), and it says so in the label the user reads;
 *   - a machine without a way to shut down reports `command: null` and
 *     executes NOTHING;
 *   - nothing here ever starts a real process: the spawner is injected and
 *     only counts.
 *
 * The user decided that the real power-off is NOT tested here: a scheduled
 * task that really powers the machine off would end every session on it, and
 * the plan layer is where the risk actually lives.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { WSL_SHUTDOWN_EXE } from '../lib/host-kind.js';
import { detectShutdownPlan, planInvocation, runShutdown } from '../lib/sleep.js';

/** The Windows commands that must never appear in a POSIX plan. */
const WINDOWS_COMMANDS = ['shutdown.exe', 'powershell.exe', 'cmd.exe'];

/**
 * A spawner that only counts. It never starts anything.
 *
 * @returns {{ calls: Array<{ command: string, args: string[] }>, spawn: Function }}
 */
function countingSpawner() {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args: Array.isArray(args) ? args.slice() : [] });
    // A child that never answers: the code must not get here.
    return { on() { return this }, once() { return this }, unref() { return this } };
  };
  return { calls, spawn };
}

/**
 * Assert that a plan carries no Windows command at all.
 *
 * @param {object} plan
 */
function assertNoWindowsCommand(plan) {
  const commands = [plan.command, ...plan.fallbacks.map((entry) => entry.command)].filter(Boolean);
  for (const command of commands) {
    for (const windows of WINDOWS_COMMANDS) {
      assert.ok(
        !command.includes(windows),
        'a POSIX plan must not carry the Windows command ' + windows + ' (got ' + command + ')',
      );
    }
  }
  const argumentLists = [plan.args, ...plan.fallbacks.map((entry) => entry.args)];
  for (const args of argumentLists) {
    assert.ok(!args.includes('/s'), 'a POSIX plan must not carry the Windows argument /s');
    assert.ok(!args.includes('/f'), 'a POSIX plan must not carry the Windows argument /f');
  }
}

test('a plain Linux host shuts THAT Linux down - and no Windows command is anywhere', () => {
  const plan = detectShutdownPlan({
    platform: 'linux',
    env: {},
    readFile: () => '',
    exists: () => false,
  });
  assert.equal(plan.kind, 'linux');
  assert.equal(plan.command, 'systemctl');
  assert.deepEqual(plan.args, ['poweroff']);
  assert.equal(plan.fallbacks.length, 1);
  assert.equal(plan.fallbacks[0].command, 'shutdown');
  assert.deepEqual(plan.fallbacks[0].args, ['-h', 'now']);
  assert.match(plan.label, /Linux/);
  assertNoWindowsCommand(plan);
});

test('inside WSL the plan shuts the whole WINDOWS machine down - and says so', () => {
  const plan = detectShutdownPlan({
    platform: 'linux',
    // WSL exports this into every process: the strongest evidence there is.
    env: { WSL_DISTRO_NAME: 'Ubuntu-22.04' },
    readFile: () => '',
    exists: () => false,
  });
  assert.equal(plan.kind, 'wsl');
  // The label is what the user reads in the settings: it must name the truth.
  assert.match(plan.label, /关掉整台 Windows/);
  assert.equal(plan.suspect, false);
  // The Windows binary, reached through the mounted C: drive.
  assert.equal(plan.command, WSL_SHUTDOWN_EXE);
  assert.deepEqual(plan.args, ['/s', '/f', '/t', '0']);
  // And the two ways to reach the same thing.
  const fallbackCommands = plan.fallbacks.map((entry) => entry.command);
  assert.ok(fallbackCommands.includes('powershell.exe'));
  assert.ok(fallbackCommands.includes('cmd.exe'));
});

test('a Linux that only LOOKS like WSL says so instead of pretending', () => {
  const plan = detectShutdownPlan({
    platform: 'linux',
    env: {},
    readFile: () => 'Linux version 6.6.0-generic',
    // The mounted Windows binary is the ONLY evidence there is.
    exists: (file) => file === WSL_SHUTDOWN_EXE,
  });
  assert.equal(plan.kind, 'wsl');
  assert.equal(plan.suspect, true, 'only the mounted drive points at WSL');
  assert.match(plan.label, /疑似 WSL/);
  assert.match(plan.label, /关掉整台 Windows/);
});

test('a machine without a way to shut down says so and executes NOTHING', async () => {
  const plan = detectShutdownPlan({ platform: 'freebsd', env: {} });
  assert.equal(plan.kind, 'unsupported');
  assert.equal(plan.command, null);
  assert.deepEqual(plan.args, []);
  assert.deepEqual(plan.fallbacks, []);

  const spawner = countingSpawner();
  const result = await runShutdown(plan, { spawn: spawner.spawn });
  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.command, null);
  assert.equal(result.error, 'no-shutdown-command');
  assert.equal(spawner.calls.length, 0, 'the spawner must not be called at all');
});

test('nothing in this plan ever starts a real process', async () => {
  const plans = [
    detectShutdownPlan({ platform: 'linux', env: {}, readFile: () => '', exists: () => false }),
    detectShutdownPlan({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu-22.04' }, readFile: () => '', exists: () => false }),
    detectShutdownPlan({ platform: 'win32' }),
    detectShutdownPlan({ platform: 'darwin' }),
    detectShutdownPlan({ platform: 'freebsd' }),
  ];
  for (const plan of plans) {
    const spawner = countingSpawner();
    const result = await runShutdown(plan, { spawn: spawner.spawn, dryRun: true });
    assert.equal(result.executed, false, 'the dry run must not execute anything');
    assert.equal(spawner.calls.length, 0, 'the spawner of ' + plan.kind + ' must stay at zero');
  }
});

test('the custom command wins over the detected one - on POSIX through /bin/sh', () => {
  const plan = detectShutdownPlan({ platform: 'linux', env: {}, readFile: () => '', exists: () => false });
  const overridden = planInvocation(plan, { sleepCommand: 'poweroff -h now', platform: 'linux' });
  assert.equal(overridden.overridden, true);
  assert.equal(overridden.command, '/bin/sh');
  assert.deepEqual(overridden.args, ['-c', 'poweroff -h now']);
  assert.equal(overridden.source, 'sleepCommand');
  // The detected plan is still there for the record.
  assert.equal(overridden.detectedCommand, undefined);
  assert.equal(overridden.kind, 'linux');
});

test('the Windows plan is the Windows one (the contrast)', () => {
  const plan = detectShutdownPlan({ platform: 'win32' });
  assert.equal(plan.kind, 'windows');
  assert.equal(plan.command, 'shutdown.exe');
  assert.deepEqual(plan.args, ['/s', '/f', '/t', '0']);
  assert.match(plan.label, /Windows/);
});
