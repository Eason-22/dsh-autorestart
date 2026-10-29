/**
 * THE FOUR STAGES OF A RESTART — the tests behind the report
 * "I clicked restart and nothing happened for ten seconds".
 *
 * The plan of this file follows the complaint, not the code:
 *
 *   1. the first stage is VISIBLE at once (well under a second, from the state
 *      file and from the state route);
 *   2. the snapshot phase reports the bytes that were really copied, and they
 *      only ever grow;
 *   3. a cancel during the snapshot stops the copy, removes the half-written
 *      backup and keeps the host alive;
 *   4. once the host is restarting a cancel is REFUSED, with the reason;
 *   5. a slow copy says so (five minutes, or a minute without a byte) instead of
 *      pretending to be busy.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply, createRuntime, normalizeConfig, takePreRestartSnapshot } from '../index.js';
import { createBackup, listBackups } from '../lib/backup.js';
import { createEmptyState, readState, requestRestart, setRestartPhase, writeState } from '../lib/checkpoint.js';
import {
  describeRestartPhase,
  SLOW_STALL_MS,
  SLOW_TOTAL_MS,
} from '../lib/restart-phase.js';

/** A temporary directory, removed when the test ends. */
function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autorestart-phase-' + label + '-'));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a handle; the temp dir is not the assertion.
    }
  });
  return dir;
}

/** A profile with a plugin tree of `count` files (each `size` bytes). */
function makeProfile(root, { count = 60, size = 4096 } = {}) {
  const profile = path.join(root, 'profile');
  const modules = path.join(profile, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'plugins: []\n', 'utf8');
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(modules, 'plugin-' + index + '.js'), 'x'.repeat(size), 'utf8');
  }
  return profile;
}

/** The fake Cordis context: enough services for `apply()` to register routes. */
function fakeContext({ routes = [], tools = [] } = {}) {
  const services = {
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
      tapIndex: () => () => {},
    },
  };
  return {
    logger: Object.assign(() => undefined, { info: () => {}, warn: () => {}, error: () => {} }),
    fiber: { state: 2 },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    goals: { get: () => undefined, resume: () => {}, pause: () => {}, block: () => {} },
    tools: {
      register: (definition) => {
        tools.push(definition);
        return () => {};
      },
      guard: () => () => {},
    },
    get: (name) => services[name],
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    interval: () => () => {},
    timeout: () => () => {},
    provide: () => {},
    emit: () => {},
  };
}

/** A response object good enough for the JSON routes. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = String(body ?? '');
    },
  };
}

// (1) THE FIRST STAGE IS IMMEDIATE -------------------------------------------------

test('the click makes phase="waiting" readable at once (well under a second)', async (t) => {
  const dir = tempDir(t, 'waiting');
  const stateFile = path.join(dir, 'state.json');
  const routes = [];
  const tools = [];
  apply(fakeContext({ routes, tools }), { stateFile, enabled: true, recoveryDelayMs: 0 });

  const restartTool = tools.find((definition) => (definition.name || '').includes('restart'))
  assert.ok(restartTool, 'the restart tool is registered')

  const started = Date.now()
  restartTool.execute({ reason: 'the phase test', resume: true }, { agent: { id: 'sess-phase' } })
  const elapsed = Date.now() - started

  // The checkpoint on disk carries the stage: the interface polls the state
  // route, which reads exactly this file, so "on disk" IS "on screen".
  const read = readState(stateFile, Date.now())
  assert.equal(read.existed, true)
  assert.ok(read.state.restartPhase, 'the stage was written by the click itself')
  assert.equal(read.state.restartPhase.phase, 'waiting')
  assert.ok(elapsed < 1000, 'the stage was written in ' + elapsed + ' ms')

  // And the state route (the surface the pill polls) reports it the same way.
  const health = routes.find((route) => route.path === '/__dsh_autorestart/health')
  const response = fakeResponse()
  health.handler({ url: '/__dsh_autorestart/health?state=1', socket: { remoteAddress: '127.0.0.1' } }, response)
  const payload = JSON.parse(response.body)
  assert.equal(payload.restartPhase.phase, 'waiting')
  assert.equal(payload.restartPhase.cancellable, true)
  assert.equal(payload.restartPhase.cancelReason, null)
  assert.match(payload.restartPhase.text.zh, /正在等待所有会话空闲/)
  assert.match(payload.restartPhase.text.en, /Waiting for every conversation/)
})

// (2) THE PROGRESS IS REAL ---------------------------------------------------------

test('the snapshot reports the real bytes, and they only grow', async (t) => {
  const root = tempDir(t, 'progress');
  const profile = makeProfile(root)
  const backups = path.join(root, 'backups')
  const samples = []
  const result = await createBackup({
    profileDir: profile,
    backupsDir: backups,
    includePlugins: true,
    now: 1_700_000_000_000,
    onProgress: (progress) => samples.push({ ...progress }),
  })
  assert.equal(result.ok, true)
  assert.ok(samples.length >= 2, 'the copy reported progress ' + samples.length + ' time(s)')

  // The numbers are the files that really landed, not an animation.
  let previous = -1
  for (const sample of samples) {
    assert.ok(sample.bytes >= previous, 'the byte counter never went backwards (' + previous + ' -> ' + sample.bytes + ')')
    previous = sample.bytes
  }
  const last = samples[samples.length - 1]
  assert.ok(last.bytes > 0, 'some bytes were copied')
  assert.equal(last.bytes, result.bytes, 'the last report equals what the backup wrote')
  // The denominator was measured before the copy, so a percentage is honest.
  assert.ok(result.totalBytes >= result.bytes, 'the total is at least what was copied')
  assert.ok(result.fileCount >= 60, 'the plugin files were counted')
  assert.ok(last.total >= last.bytes)
})

// (3) A CANCEL DURING THE SNAPSHOT -------------------------------------------------

test('a cancel during the snapshot stops the copy and leaves no half-written backup', async (t) => {
  const root = tempDir(t, 'cancel');
  const profile = makeProfile(root, { count: 80 });
  const backups = path.join(root, 'backups');
  let copied = 0
  const result = await createBackup({
    profileDir: profile,
    backupsDir: backups,
    includePlugins: true,
    now: 1_700_000_000_100,
    onProgress: () => {
      copied += 1
    },
    // "The user pressed cancel" after the second progress report.
    shouldCancel: () => copied >= 2,
  })
  assert.equal(result.cancelled, true)
  assert.equal(result.ok, false)
  // NOTHING is left behind: no half snapshot that looks restorable.
  assert.equal(result.dir, null)
  const leftovers = fs.existsSync(backups) ? listBackups(backups) : []
  assert.deepEqual(leftovers, [], 'no backup directory survived the cancel')
})

test('a cancelled snapshot never turns into a restart (the host stays up)', async (t) => {
  const root = tempDir(t, 'cancel-host');
  const profile = makeProfile(root, { count: 40 });
  const commands = []
  const stateFile = path.join(root, 'state.json')
  const ctx = fakeContext()
  const config = normalizeConfig({
    stateFile,
    restartMode: 'command',
    restartCommand: 'restart-the-host',
    settleMs: 0,
    restartGraceMs: 0,
    backupOnRestart: true,
    backupIncludePlugins: true,
  })
  const runtime = createRuntime(ctx, config, {
    env: { isDesktopApp: false, appExePath: null },
    // The real snapshot entry, with a cancel that fires immediately: exactly
    // what a click in the middle of the copy looks like.
    snapshot: (options) => takePreRestartSnapshot({ ...options, profile: { dir: profile, source: 'test' }, shouldCancel: () => true }),
    runCommand: async ({ command }) => {
      commands.push(command)
      return { ok: true, command, exitCode: 0, timedOut: false }
    },
    launchWatcher: () => ({ ok: true, method: 'test', error: null }),
    armWatchdog: () => ({ ok: false, tier: 'none', reason: 'the test arms nothing' }),
    probeInstance: async () => ({ ok: true, reason: 'unused' }),
  })
  requestRestart(runtime.state, { reason: 'phase test', bySessionId: 'sess-cancel' })
  await runtime.executeRestart()

  assert.deepEqual(commands, [], 'the restart command was NOT run')
  assert.equal(runtime.state.restart, null, 'the cancelled request was withdrawn, not retried')
  assert.ok(!runtime.state.restartPhase, 'the stage was cleared (no spinner left behind)')
  // The checkpoint on disk agrees: nothing was left armed for a restart.
  const onDisk = readState(stateFile, Date.now())
  assert.equal(onDisk.state.restart, null)
  assert.equal(onDisk.state.restartPhase, null)
})

// (4) A CANCEL AFTER THE HOST IS GOING DOWN IS REFUSED -----------------------------

test('a cancel in the "restarting" stage is refused, with the reason', async (t) => {
  const dir = tempDir(t, 'refused');
  const stateFile = path.join(dir, 'state.json');
  // A checkpoint of THIS process (the boot therefore is not a new one): the
  // stage under test is the one that was written, not the "back" of a boot.
  const state = createEmptyState(Date.now())
  state.bootPid = process.pid
  state.bootId = 'the-current-boot'
  setRestartPhase(state, { phase: 'restarting', now: Date.now() })
  writeState(stateFile, state)

  const routes = [];
  apply(fakeContext({ routes }), { stateFile, enabled: true, recoveryDelayMs: 0 });

  const cancel = routes.find((route) => route.path === '/__dsh_autorestart/cancel')
  assert.ok(cancel, 'the cancel route is registered')
  const response = fakeResponse()
  const request = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    on: (event, handler) => {
      if (event === 'data') handler(JSON.stringify({ sessionId: 'sess-late', scope: 'mine' }))
      if (event === 'end') handler()
    },
  }
  cancel.handler(request, response)
  await new Promise((resolve) => { setTimeout(resolve, 50) })

  assert.equal(response.statusCode, 409, 'the refusal is an explicit 409, not a silent no')
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, false)
  assert.equal(payload.cancelled, false)
  assert.equal(payload.reason, 'not-cancellable')
  assert.equal(payload.stage, 'restarting')
  assert.match(payload.error, /already restarting/)
})

// (5) A SLOW COPY SAYS SO ------------------------------------------------------------

test('a slow copy is reported as slow instead of pretending to be busy', () => {
  const startedAt = 1_700_000_000_000
  // Five minutes in, still copying.
  const slowTotal = describeRestartPhase({
    phase: 'snapshotting',
    startedAt,
    at: startedAt + 1000,
    progress: { files: 900, bytes: 80 * 1024 * 1024, total: 156 * 1024 * 1024, filesTotal: 2000, at: startedAt + SLOW_TOTAL_MS - 5000 },
    now: startedAt + SLOW_TOTAL_MS,
  })
  assert.equal(slowTotal.slow, 'total')
  // The slow branch names the SAME subject as the card: it is the DSH pre-restart
  // backup that is slow, never a nameless "backup".
  assert.match(slowTotal.text.zh, /DSH 重启前备份比预期慢（可能磁盘很忙），还在继续/)
  assert.doesNotMatch(slowTotal.text.zh, /正在备份/, 'no bare "正在备份" in the slow line either')
  assert.match(slowTotal.text.en, /DSH pre-restart backup/)
  assert.match(slowTotal.text.en, /slower than expected/)

  // The byte counter has not moved for a minute.
  const stalled = describeRestartPhase({
    phase: 'snapshotting',
    startedAt,
    at: startedAt + 1000,
    progress: { files: 10, bytes: 2 * 1024 * 1024, total: 156 * 1024 * 1024, filesTotal: 2000, at: startedAt + 2000 },
    now: startedAt + 2000 + SLOW_STALL_MS,
  })
  assert.equal(stalled.slow, 'stalled')
  assert.match(stalled.text.zh, /DSH 重启前备份比预期慢/)
  assert.doesNotMatch(stalled.text.zh, /正在备份/)

  // A healthy copy shows the measured bytes and an estimate — and no slow line.
  const healthy = describeRestartPhase({
    phase: 'snapshotting',
    startedAt,
    at: startedAt + 1000,
    progress: { files: 400, bytes: 78 * 1024 * 1024, total: 156 * 1024 * 1024, filesTotal: 2000, at: startedAt + 9900 },
    now: startedAt + 10000,
  })
  assert.equal(healthy.slow, null)
  assert.equal(healthy.progress.percent, 50)
  // THE ONE VOICE: the settings page and the tooltip say what the card says —
  // "DSH 重启前备份中" — and never the nameless "正在备份".
  assert.match(healthy.text.zh, /DSH 重启前备份中/)
  assert.doesNotMatch(healthy.text.zh, /正在备份/)
  assert.match(healthy.text.zh, /已完成 78 MB/)
  assert.match(healthy.text.en, /Backing up before DSH restart/)
  assert.doesNotMatch(healthy.text.en, /configuration and the plugins/)
  assert.match(healthy.text.en, /78 MB done/)
  assert.ok(healthy.estimateSeconds !== null && healthy.estimateSeconds > 0)

  // Before the first measurement the text claims no number at all.
  const waiting = describeRestartPhase({ phase: 'snapshotting', startedAt, now: startedAt + 10 })
  assert.equal(waiting.progress, null)
  assert.equal(waiting.estimateSeconds, null)
  assert.doesNotMatch(waiting.text.zh, /预计/)
  assert.match(waiting.text.zh, /^DSH 重启前备份中…$/, 'the sentence says what it is, then stops')
  assert.doesNotMatch(waiting.text.zh, /正在备份/)
})
