/**
 * dsh-autorestart — the ONE-TIME cleanup of the watchers that never left.
 *
 * The rollback watcher used to exit on its SUCCESS path before its own
 * self-delete, so every successful restart left a `restart-<n>-watch.ps1`
 * behind (MEASURED: 431 of them on the real machine). These tests cover the
 * migration that collects them - and, above all, the rule that it must NOT
 * touch anything on a machine that never had the plugin.
 *
 * Every deletion happens in a TEMPORARY directory: no test ever writes to,
 * or removes, a file of the real machine.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MIGRATION_RECORD_FILE,
  UNKNOWN_PREVIOUS_VERSION,
  WATCH_RESIDUE_MIGRATION_ID,
  WATCH_RESIDUE_MIN_AGE_MS,
  WATCH_RESIDUE_TARGET_VERSION,
  migrateWatchResidue,
  readMigrationRecord,
  writeMigrationRecord,
} from '../lib/watch-residue.js';

/** A body that looks like the watcher `buildWatchScript` writes. */
const WATCH_SCRIPT_BODY = [
  'param(',
  '  [string] $PortFile = ""',
  ')',
  '$ErrorActionPreference = "Stop"',
  'Start-Sleep -Seconds 4',
  '# dsh-autorestart: put the known-good copy back',
].join('\n');

/** A body that is NOT ours: same name, a user's own script. */
const FOREIGN_BODY = 'Write-Host "my own script"\n';

/**
 * A state directory with the given files (name → body), every one of them
 * backdated by `ageMs`.
 *
 * @param {Record<string, string>} files
 * @param {number} ageMs how old the files are
 * @returns {string} the directory
 */
function fixture(files, ageMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watch-residue-'));
  const now = Date.now();
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body, 'utf8');
    const at = new Date(now - ageMs);
    fs.utimesSync(file, at, at);
  }
  return dir;
}

/* ------------------------------------------------------------------ *
 * SCENARIO 1 — an upgrade: the watchers of the past are removed, and
 * the migration is recorded so it never runs twice.
 * ------------------------------------------------------------------ */
test('an upgrade removes the watchers of the past and records the migration', (t) => {
  const dir = fixture({
    'restart-4-watch.ps1': WATCH_SCRIPT_BODY,
    'restart-16-watch.ps1': WATCH_SCRIPT_BODY,
    // Same name, NOT our content: a user's own file — kept.
    'restart-99-watch.ps1': FOREIGN_BODY,
    // A file of another kind: never looked at.
    'restart-7.cmd': '@echo off\nrem dsh-autorestart\n',
    'notes.txt': 'hello',
  }, 30 * 60 * 1000);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = migrateWatchResidue(dir, {
    prevVersion: '0.9.13',
    currentVersion: WATCH_RESIDUE_TARGET_VERSION,
    migrations: {},
  });

  assert.equal(result.ran, true, 'the migration ran on the machine that had the plugin');
  assert.equal(result.removed, 2, 'the two watchers of ours are gone');
  assert.deepEqual(
    result.removedNames.sort(),
    ['restart-16-watch.ps1', 'restart-4-watch.ps1'],
    'exactly the two watchers of ours are reported as removed',
  );
  assert.equal(result.error, null);
  assert.equal(fs.existsSync(path.join(dir, 'restart-4-watch.ps1')), false, 'the file is really gone');
  assert.equal(fs.existsSync(path.join(dir, 'restart-16-watch.ps1')), false, 'the file is really gone');
  assert.equal(fs.existsSync(path.join(dir, 'restart-99-watch.ps1')), true, "a user's own file stays");
  assert.equal(fs.existsSync(path.join(dir, 'restart-7.cmd')), true, 'a file of another kind stays');
  assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), true, 'an unrelated file stays');

  // THE MARKER: after the migration the record says it ran, and says which
  // version this machine is on now.
  const written = writeMigrationRecord(dir, {
    lastSeenVersion: WATCH_RESIDUE_TARGET_VERSION,
    migrations: { [WATCH_RESIDUE_MIGRATION_ID]: true },
  });
  assert.equal(written.ok, true, 'the migration record is written');
  const record = readMigrationRecord(dir);
  assert.equal(record.existed, true);
  assert.equal(record.lastSeenVersion, WATCH_RESIDUE_TARGET_VERSION, 'the new version is recorded');
  assert.equal(record.migrations[WATCH_RESIDUE_MIGRATION_ID], true, 'the migration is recorded');
  assert.equal(record.error, null);

  // The second boot finds the marker and does NOTHING.
  const again = migrateWatchResidue(dir, {
    prevVersion: record.lastSeenVersion,
    currentVersion: WATCH_RESIDUE_TARGET_VERSION,
    migrations: record.migrations,
  });
  assert.equal(again.ran, false, 'the migration never runs twice');
  assert.equal(again.removed, 0);
  assert.match(String(again.skippedReason), /already-migrated/);
});

/* ------------------------------------------------------------------ *
 * SCENARIO 2 — a fresh installation: NOT ONE FILE IS DELETED, even
 * when the directory is full of watchers.
 * ------------------------------------------------------------------ */
test('a fresh installation deletes nothing at all', (t) => {
  const dir = fixture({
    'restart-4-watch.ps1': WATCH_SCRIPT_BODY,
    'restart-16-watch.ps1': WATCH_SCRIPT_BODY,
  }, 30 * 60 * 1000);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = migrateWatchResidue(dir, {
    prevVersion: null,
    currentVersion: WATCH_RESIDUE_TARGET_VERSION,
    migrations: {},
  });

  assert.equal(result.ran, false, 'the migration does not run on a fresh installation');
  assert.equal(result.removed, 0, 'not one file is deleted');
  assert.match(String(result.skippedReason), /fresh-install/);
  assert.equal(result.error, null);
  assert.equal(
    fs.existsSync(path.join(dir, 'restart-4-watch.ps1')),
    true,
    'the file stays: a fresh installation never wrote a watcher',
  );
  assert.equal(fs.existsSync(path.join(dir, 'restart-16-watch.ps1')), true, 'the file stays');
});

/* ------------------------------------------------------------------ *
 * SCENARIO 3 — a watcher written FIVE MINUTES ago is kept: it may
 * still be the live one of a restart that is happening right now.
 * ------------------------------------------------------------------ */
test('a watcher written five minutes ago is kept', (t) => {
  const dir = fixture({
    'restart-4-watch.ps1': WATCH_SCRIPT_BODY,
  }, 5 * 60 * 1000);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = migrateWatchResidue(dir, {
    prevVersion: '0.9.13',
    currentVersion: WATCH_RESIDUE_TARGET_VERSION,
    migrations: {},
  });

  assert.equal(result.ran, true, 'the migration ran');
  assert.equal(result.removed, 0, 'the watcher of the last ten minutes is not removed');
  assert.deepEqual(result.kept, ['restart-4-watch.ps1'], 'it is reported as kept');
  assert.equal(result.error, null);
  assert.equal(
    fs.existsSync(path.join(dir, 'restart-4-watch.ps1')),
    true,
    'the watcher of a restart that may be running right now stays',
  );
});

/* ------------------------------------------------------------------ *
 * The rules around the judgement itself.
 * ------------------------------------------------------------------ */

test('a machine that is already on the current version is left alone', (t) => {
  const dir = fixture({ 'restart-4-watch.ps1': WATCH_SCRIPT_BODY }, 30 * 60 * 1000);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = migrateWatchResidue(dir, {
    prevVersion: WATCH_RESIDUE_TARGET_VERSION,
    currentVersion: WATCH_RESIDUE_TARGET_VERSION,
    migrations: {},
  });

  assert.equal(result.ran, false);
  assert.equal(result.removed, 0);
  assert.match(String(result.skippedReason), /not-older-than-current/);
  assert.equal(fs.existsSync(path.join(dir, 'restart-4-watch.ps1')), true);
});

test('the thresholds are the ones the fix is built on', () => {
  assert.equal(WATCH_RESIDUE_MIGRATION_ID, 'watch-residue-1.0.0', 'the id of the migration');
  assert.equal(WATCH_RESIDUE_TARGET_VERSION, '1.0.0', 'the version it was collected in');
  assert.equal(WATCH_RESIDUE_MIN_AGE_MS, 10 * 60 * 1000, 'TEN MINUTES of protection');
  assert.equal(UNKNOWN_PREVIOUS_VERSION, '0.0.0', 'a build that never recorded its version');
});

test('the migration never throws, whatever the state directory is', () => {
  const missing = migrateWatchResidue(path.join(os.tmpdir(), 'dsh-no-such-dir-' + Date.now()), {
    prevVersion: '0.9.13',
    currentVersion: WATCH_RESIDUE_TARGET_VERSION,
    migrations: {},
  });
  assert.equal(missing.ran, false);
  assert.equal(missing.removed, 0);
  assert.equal(missing.error, null, 'a directory that does not exist is not a failure');
  assert.match(String(missing.skippedReason), /no-state-directory/);

  const empty = migrateWatchResidue('', {
    prevVersion: '0.9.13',
    currentVersion: WATCH_RESIDUE_TARGET_VERSION,
    migrations: {},
  });
  assert.equal(empty.ran, false);
  assert.equal(empty.error, null);
});

test('a broken record is reported, never thrown', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watch-record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, MIGRATION_RECORD_FILE), '{ this is not json', 'utf8');

  const record = readMigrationRecord(dir);
  assert.equal(record.existed, true);
  assert.equal(record.lastSeenVersion, null);
  assert.notEqual(record.error, null, 'the broken record is reported');
  assert.equal(record.migrations[WATCH_RESIDUE_MIGRATION_ID], undefined);
});
