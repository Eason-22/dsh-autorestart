/**
 * WHAT A BACKUP LEAVES OUT — AND WHAT IT MUST KEEP (0.9.9, 2026-11-21).
 *
 * Two things stay out: `.git` (rebuildable history) and `.tmp*` scratch
 * directories. Everything else is copied, including a plugin's own
 * `node_modules` and its `data/`.
 *
 * WHY THAT LINE (user decision, 2026-11-21): an intermediate draft also left
 * out the dependencies and the running data, and one copy came out at 50.9 MB
 * instead of 939 MB — but the user rejected that as soon as the price was
 * stated: a restored plugin then needs `pnpm install`, and `dsh-codekg` has to
 * rebuild its graphs. A backup has to come back USABLE. So this file asserts
 * BOTH halves of the rule: the two exclusions really are left out, and the
 * dependencies/data really are still there.
 */

import './_tmp-guard.mjs'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BACKUP_SKIP_NAMES,
  BACKUP_SKIP_PREFIXES,
  createBackup,
  isSkippedFromBackup,
  LINKS_DIR,
  PLUGINS_DIR,
  readManifest,
} from '../lib/backup.js';

/** A profile whose one enabled plugin is a junction to a development tree. */
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-exclusion-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const profile = path.join(base, 'profile');
  fs.mkdirSync(path.join(profile, PLUGINS_DIR), { recursive: true });
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), 'rows:\n  - id: demo\n', 'utf8');
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'demo-profile', dsh: { profile: { bundles: ['demo-linked'] } } }),
    'utf8',
  );
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');

  // The development directory the plugin is linked from — a working checkout,
  // so it carries both the things a copy keeps and the two it leaves out.
  const dev = path.join(base, 'dev', 'demo-linked');
  fs.mkdirSync(path.join(dev, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dev, 'package.json'), '{"name":"demo-linked"}\n', 'utf8');
  fs.writeFileSync(path.join(dev, 'src', 'index.js'), 'export default 1\n', 'utf8');

  // KEPT: the dependencies of the plugin (a rollback must run without pnpm).
  fs.mkdirSync(path.join(dev, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(dev, 'node_modules', 'left-pad', 'index.js'), 'x'.repeat(4096), 'utf8');

  // KEPT: the data the plugin produced (codekg's graphs live here).
  fs.mkdirSync(path.join(dev, 'data', 'graphs'), { recursive: true });
  fs.writeFileSync(path.join(dev, 'data', 'graphs', 'g.json'), '{"n":1}', 'utf8');

  // LEFT OUT: scratch space.
  fs.mkdirSync(path.join(dev, '.tmp-task308'), { recursive: true });
  fs.writeFileSync(path.join(dev, '.tmp-task308', 'scratch.txt'), 'x'.repeat(2048), 'utf8');

  // LEFT OUT: the rebuildable history.
  fs.mkdirSync(path.join(dev, '.git', 'objects'), { recursive: true });
  fs.writeFileSync(path.join(dev, '.git', 'objects', 'blob'), 'x'.repeat(1024), 'utf8');

  fs.symlinkSync(dev, path.join(profile, PLUGINS_DIR, 'demo-linked'), 'junction');
  return { base, profile, dev, backups: path.join(base, 'storage', 'backups') };
}

test('isSkippedFromBackup: history and scratch only — dependencies and data are copied', () => {
  assert.deepEqual([...BACKUP_SKIP_NAMES], ['.git']);
  assert.deepEqual([...BACKUP_SKIP_PREFIXES], ['.tmp']);

  for (const name of ['.git', '.tmp', '.tmp-task308', '.tmp-rev310r2-r1']) {
    assert.equal(isSkippedFromBackup(name), true, `${name} must be skipped`);
  }
  // Everything a rollback needs to run must be copied.
  for (const name of ['node_modules', 'data', 'src', 'lib', 'dist', 'database', '.gitignore']) {
    assert.equal(isSkippedFromBackup(name), false, `${name} must be copied`);
  }
  assert.equal(isSkippedFromBackup(''), false);
  assert.equal(isSkippedFromBackup(null), false);
});

test('a linked plugin keeps its dependencies and its data, and loses only history + scratch', async (t) => {
  const { profile, backups } = fixture(t);
  const backup = await createBackup({
    slimBackup: false,
    profileDir: profile,
    backupsDir: backups,
    includePlugins: true,
    now: 1_000,
  });

  assert.equal(backup.ok, true);
  const copy = path.join(backup.dir, LINKS_DIR, 'demo-linked');

  // What a restore needs is there — including the two trees an earlier draft
  // excluded, because the user needs the copy to RUN after a rollback.
  assert.ok(fs.existsSync(path.join(copy, 'package.json')));
  assert.ok(fs.existsSync(path.join(copy, 'src', 'index.js')));
  assert.ok(fs.existsSync(path.join(copy, 'node_modules', 'left-pad', 'index.js')),
    'the plugin\'s dependencies must be in the copy');
  assert.ok(fs.existsSync(path.join(copy, 'data', 'graphs', 'g.json')),
    'the plugin\'s data must be in the copy');

  // The two exclusions are not.
  assert.equal(fs.existsSync(path.join(copy, '.git')), false, '.git must not be in the copy');
  assert.equal(fs.existsSync(path.join(copy, '.tmp-task308')), false, '.tmp* must not be in the copy');
});

test('the manifest names what was skipped — and only those two', async (t) => {
  const { profile, backups } = fixture(t);
  const backup = await createBackup({
    slimBackup: false,
    profileDir: profile,
    backupsDir: backups,
    includePlugins: true,
    now: 2_000,
  });

  const manifest = readManifest(backup.dir);
  assert.ok(Array.isArray(manifest.skipped), 'manifest.skipped must be an array');
  const names = manifest.skipped.map((entry) => entry.name).sort();
  assert.deepEqual(names, ['.git', '.tmp-task308'],
    'only history and scratch may be reported as skipped');

  const byName = new Map(manifest.skipped.map((entry) => [entry.name, entry]));
  for (const name of ['.git', '.tmp-task308']) {
    const entry = byName.get(name);
    assert.equal(entry.plugin, 'demo-linked');
    assert.ok(entry.files >= 1, `${name} must report at least one file`);
    assert.ok(entry.bytes >= 1, `${name} must report its bytes`);
  }
  // The counts are measurements, not guesses.
  assert.equal(byName.get('.tmp-task308').bytes, 2048);
  assert.equal(byName.get('.git').bytes, 1024);
});
