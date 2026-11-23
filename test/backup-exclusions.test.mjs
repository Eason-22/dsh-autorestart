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
  COMPARE_SKIP_NAMES,
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

test('isSkippedFromBackup: source is copied, everything rebuildable is skipped', () => {
  // WHAT THE BACKUP IS FOR: undoing a broken SOURCE edit. A dependency tree comes
  // back with `pnpm install`, a plugin's `data/` is rebuilt when it next runs, and
  // `.git` is rebuildable from the remote — none of them is something an edit can
  // break, so none of them belongs in every pre-restart copy.
  assert.deepEqual([...BACKUP_SKIP_NAMES], ['.git', 'node_modules', 'data']);
  assert.deepEqual([...COMPARE_SKIP_NAMES], [...BACKUP_SKIP_NAMES],
    'the comparison and the copy must leave out exactly the same names');
  assert.deepEqual([...BACKUP_SKIP_PREFIXES], ['.tmp']);

  for (const name of ['.git', 'node_modules', 'data', '.tmp', '.tmp-task308', '.tmp-rev310r2-r1']) {
    assert.equal(isSkippedFromBackup(name), true, `${name} must be skipped`);
  }
  // The source itself — the only thing an edit can break — is copied.
  for (const name of ['src', 'lib', 'dist', 'assets', 'locale', 'docs', 'database', '.gitignore', 'index.js', 'package.json']) {
    assert.equal(isSkippedFromBackup(name), false, `${name} must be copied`);
  }
  assert.equal(isSkippedFromBackup(''), false);
  assert.equal(isSkippedFromBackup(null), false);
});

test('a linked plugin keeps its SOURCE and loses its dependencies, its data, its history and its scratch', async (t) => {
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

  // What a rollback needs is the source (and the manifest that says how to
  // start it) — that is the only thing an edit can break.
  assert.ok(fs.existsSync(path.join(copy, 'package.json')));
  assert.ok(fs.existsSync(path.join(copy, 'src', 'index.js')));

  // The rebuildable trees are NOT in the copy: a dependency tree comes back with
  // `pnpm install`, `data/` is rebuilt by the plugin itself, and `.git` comes
  // back from the remote.
  assert.equal(fs.existsSync(path.join(copy, 'node_modules', 'left-pad', 'index.js')), false,
    'dependencies are rebuildable and must not be in the copy');
  assert.equal(fs.existsSync(path.join(copy, 'data', 'graphs', 'g.json')), false,
    'the plugin\'s data is rebuilt by the plugin and must not be in the copy');
  assert.equal(fs.existsSync(path.join(copy, '.git')), false, '.git must not be in the copy');
  assert.equal(fs.existsSync(path.join(copy, '.tmp-task308')), false, '.tmp* must not be in the copy');
});

test('the manifest names what was skipped — dependencies, data, history and scratch', async (t) => {
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
  assert.deepEqual(names, ['.git', '.tmp-task308', 'data', 'node_modules'],
    'every exclusion is reported, none is silent');

  const byName = new Map(manifest.skipped.map((entry) => [entry.name, entry]));
  for (const name of ['.git', '.tmp-task308', 'data', 'node_modules']) {
    const entry = byName.get(name);
    assert.equal(entry.plugin, 'demo-linked');
    assert.ok(entry.files >= 1, `${name} must report at least one file`);
    assert.ok(entry.bytes >= 1, `${name} must report its bytes`);
  }
  // The counts are measurements, not guesses.
  assert.equal(byName.get('.tmp-task308').bytes, 2048);
  assert.equal(byName.get('.git').bytes, 1024);
});
