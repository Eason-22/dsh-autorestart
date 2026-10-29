/**
 * Pre-restart backup + rollback primitives.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  backupsRoot,
  CONFIG_DIR,
  createBackup,
  listBackups,
  MANIFEST_NAME,
  PLUGINS_DIR,
  pruneBackups,
  readManifest,
  readRollbackReport,
  ROLLBACK_REPORT_NAME,
  restoreBackup,
  clearRollbackReport,
} from '../lib/backup.js';

/** A profile-looking tree and an empty backups directory. */
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-backup-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const profile = path.join(base, 'profile');
  fs.mkdirSync(path.join(profile, 'node_modules', 'demo-plugin', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8');
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"demo-profile"}\n', 'utf8');
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
  fs.writeFileSync(path.join(profile, 'node_modules', 'demo-plugin', 'package.json'), '{"name":"demo-plugin"}\n', 'utf8');
  fs.writeFileSync(path.join(profile, 'node_modules', 'demo-plugin', 'lib', 'index.js'), 'export default 1\n', 'utf8');
  const storage = path.join(base, 'storage');
  fs.mkdirSync(storage, { recursive: true });
  return { base, profile, storage, backups: backupsRoot(storage) };
}

test('a backup copies the configuration files and the plugin tree', async (t) => {
  const { profile, storage, backups } = fixture(t);
  const first = await createBackup({ profileDir: profile, backupsDir: backups, includePlugins: true, now: 1_000 });

  assert.equal(first.ok, true);
  assert.equal(first.includePlugins, true);
  assert.ok(first.dir && first.dir.startsWith(backups));
  assert.ok(fs.existsSync(path.join(first.dir, CONFIG_DIR, 'cordis.patch.yml')));
  assert.ok(fs.existsSync(path.join(first.dir, CONFIG_DIR, 'package.json')));
  assert.ok(fs.existsSync(path.join(first.dir, CONFIG_DIR, 'pnpm-lock.yaml')));
  assert.ok(fs.existsSync(path.join(first.dir, PLUGINS_DIR, 'demo-plugin', 'lib', 'index.js')));

  const manifest = readManifest(first.dir);
  assert.equal(manifest.includePlugins, true);
  assert.equal(manifest.at, 1_000);
  assert.ok(manifest.files.includes(path.join(CONFIG_DIR, 'cordis.patch.yml')));
  assert.ok(manifest.files.includes('node_modules'));
  assert.ok(manifest.bytes > 0);
  assert.ok(fs.existsSync(path.join(storage, 'backups', first.stamp, MANIFEST_NAME)));
});

test('includePlugins=false keeps the backup to the configuration files', async (t) => {
  const { profile, backups } = fixture(t);
  const backup = await createBackup({ profileDir: profile, backupsDir: backups, includePlugins: false, now: 2_000 });

  assert.equal(backup.ok, true);
  assert.equal(backup.includePlugins, false);
  assert.equal(fs.existsSync(path.join(backup.dir, PLUGINS_DIR)), false);
  assert.ok(fs.existsSync(path.join(backup.dir, CONFIG_DIR, 'cordis.patch.yml')));
  assert.equal(readManifest(backup.dir).includePlugins, false);
});

test('only the newest maxBackups snapshots are kept', async (t) => {
  const { profile, backups } = fixture(t);
  const stamps = [3_000, 4_000, 5_000, 6_000];
  for (const now of stamps) {
    const backup = await createBackup({ profileDir: profile, backupsDir: backups, includePlugins: false, maxBackups: 2, now });
    assert.equal(backup.ok, true);
  }

  const left = listBackups(backups).map((entry) => entry.name);
  assert.equal(left.length, 2, 'exactly two backups survive');
  const keptStamps = left.map((name) => {
    // The directory name is the ISO stamp with ':' and '.' replaced.
    return Date.parse(name.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));
  }).sort((a, b) => a - b);
  assert.deepEqual(keptStamps, [5_000, 6_000], 'the two newest snapshots are the ones kept');
});

test('pruneBackups removes only what exceeds the limit', (t) => {
  const { backups } = fixture(t);
  for (const name of ['2026-01-01T00-00-00-000Z', '2026-01-02T00-00-00-000Z', '2026-01-03T00-00-00-000Z']) {
    fs.mkdirSync(path.join(backups, name), { recursive: true });
  }
  const removed = pruneBackups(backups, 2);
  assert.deepEqual(removed, ['2026-01-01T00-00-00-000Z']);
  assert.deepEqual(listBackups(backups).map((entry) => entry.name), [
    '2026-01-03T00-00-00-000Z',
    '2026-01-02T00-00-00-000Z',
  ]);
});

test('restoreBackup puts the snapshot back over the live profile', async (t) => {
  const { profile, backups } = fixture(t);
  const backup = await createBackup({ profileDir: profile, backupsDir: backups, includePlugins: true, now: 7_000 });
  assert.equal(backup.ok, true);

  // Break the live profile the way a bad edit would.
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n', 'utf8');
  fs.rmSync(path.join(profile, 'node_modules', 'demo-plugin', 'lib', 'index.js'));

  const restored = restoreBackup({ backupDir: backup.dir, profileDir: profile });
  assert.equal(restored.ok, true);
  assert.ok(restored.restored.includes('cordis.patch.yml'));
  assert.equal(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), 'rows:\n  - id: demo\n');
  assert.ok(fs.existsSync(path.join(profile, 'node_modules', 'demo-plugin', 'lib', 'index.js')));
});

test('createBackup reports a missing profile instead of throwing', async () => {
  const result = await createBackup({ profileDir: path.join(os.tmpdir(), 'dsh-ar-does-not-exist-xyz'), backupsDir: path.join(os.tmpdir(), 'dsh-ar-b') });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /does not exist/);
});

test('the rollback report is read from disk, tolerating a BOM', (t) => {
  const { storage } = fixture(t);
  assert.equal(readRollbackReport(storage), null, 'no report yet');

  const report = {
    ok: false,
    at: '2026-10-25T12:00:00.000Z',
    waitedMs: 90000,
    rolledBack: true,
    backupDir: 'C:/x/backups/2026',
    crashLog: 'crash-2026-10-25.log',
    crashTail: 'phase: startup',
  };
  // Write it the way Windows PowerShell 5.1 would: with a BOM.
  fs.writeFileSync(path.join(storage, ROLLBACK_REPORT_NAME), '\uFEFF' + JSON.stringify(report), 'utf8');

  const parsed = readRollbackReport(storage);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.rolledBack, true);
  assert.equal(parsed.crashTail, 'phase: startup');

  assert.equal(clearRollbackReport(storage), true);
  assert.equal(readRollbackReport(storage), null);
});
