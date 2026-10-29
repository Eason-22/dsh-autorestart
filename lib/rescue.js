/**
 * dsh-autorestart — the rules of the rescue kit.
 *
 * The rescue kit ("自救包") has two halves: `scripts/restore-profile.cmd` puts a
 * profile snapshot back when the host does not come up any more, and
 * `scripts/drill-rescue.ps1` proves that it works — in an isolated directory.
 *
 * This module holds the RULES both halves obey, in a shape node can import and
 * test directly:
 *
 *   - which paths may be restored over (never a drive root, never a system
 *     directory, only a profile directory under `<home>/.dsh/profiles` or an
 *     explicitly named isolated directory),
 *   - which directory still looks like a DSH profile (even when it is broken),
 *   - which snapshot is the newest one that carries a manifest,
 *   - and what a restored profile has to look like before the kit may say
 *     "done".
 *
 * The PowerShell script implements the same rules on its own: a rescue kit that
 * needs node on the PATH is not a rescue kit. This module is the tested
 * reference, and the drill proves that the two agree.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The plugin the kit looks for inside a restored profile. */
export const PLUGIN_NAME = 'dsh-autorestart';

/** The manifest that marks a directory as a snapshot. */
export const MANIFEST_NAME = 'manifest.json';

/** The directory inside a snapshot that holds the configuration files. */
export const CONFIG_DIR = 'config';

/** The directory inside a snapshot that holds the installed plugin tree. */
export const PLUGINS_DIR = 'node_modules';

/** The marker that separates a profile from the evidence of a broken one. */
export const BROKEN_SUFFIX = '.broken-';

/**
 * The files that make a directory look like a DSH profile.
 *
 * A profile that is broken on purpose (that is the whole point of the kit) may
 * have a package.json that no longer parses. So a directory counts as a profile
 * when its package.json parses and carries a `dsh.profile` section, OR when it
 * still carries at least TWO of these three markers — that is how a profile
 * whose package.json was destroyed stays recognizable.
 */
export const PROFILE_MARKERS = Object.freeze(['package.json', 'cordis.patch.yml', PLUGINS_DIR]);

/**
 * The DSH home: where the profiles and the state live.
 *
 * The plugin resolves it the same way (`DSH_HOME`, otherwise `~/.dsh`).
 *
 * @param {{env?: object, home?: string}} [options]
 * @returns {string}
 */
export function dshHomeDir({ env = process.env, home = os.homedir() } = {}) {
  const explicit = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (explicit !== '') return normalizePath(explicit);
  return normalizePath(path.join(home, '.dsh'));
}

/**
 * The directory that holds every profile.
 *
 * @param {{env?: object, home?: string}} [options]
 * @returns {string}
 */
export function profilesRootDir(options = {}) {
  return normalizePath(path.join(dshHomeDir(options), 'profiles'));
}

/**
 * The directory the plugin keeps its durable state in.
 *
 * @param {{env?: object, home?: string}} [options]
 * @returns {string}
 */
export function stateDirDir(options = {}) {
  return normalizePath(path.join(dshHomeDir(options), 'storages', 'dsh-autorestart'));
}

/**
 * The directory that holds the snapshots.
 *
 * @param {{env?: object, home?: string}} [options]
 * @returns {string}
 */
export function backupsRootDir(options = {}) {
  return normalizePath(path.join(stateDirDir(options), 'backups'));
}

/**
 * A full path without a trailing separator.
 *
 * @param {string} target
 * @returns {string}
 */
export function normalizePath(target) {
  const raw = typeof target === 'string' ? target.trim() : '';
  if (raw === '') return '';
  let resolved = path.resolve(raw);
  // "C:\" keeps its separator (it is the root), anything longer loses it.
  if (resolved.length > 3) resolved = resolved.replace(/[\\/]+$/, '');
  return resolved;
}

/**
 * Whether `child` lies inside `parent` (and is not `parent` itself).
 *
 * Windows paths are compared case-insensitively.
 *
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
export function isInside(child, parent) {
  const c = normalizePath(child).toLowerCase();
  const p = normalizePath(parent).toLowerCase();
  if (c === '' || p === '') return false;
  if (c === p) return false;
  const prefix = p.endsWith('\\') || p.endsWith('/') ? p : p + path.sep;
  return c.startsWith(prefix);
}

/**
 * The directories that must never be restored over.
 *
 * The environment is asked first (`SystemRoot`, `ProgramFiles`, …); the system
 * drive is used as the fallback so the rule also holds on a machine whose
 * environment variables were stripped.
 *
 * @param {object} [env]
 * @returns {string[]}
 */
export function systemDirectories(env = process.env) {
  const out = [];
  const add = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim().replace(/[\\/]+$/, '');
    if (trimmed === '') return;
    out.push(trimmed);
  };
  add(env.SystemRoot);
  add(env.windir);
  add(env.ProgramFiles);
  add(env['ProgramFiles(x86)']);
  add(env.ProgramData);
  const drive = typeof env.SystemDrive === 'string' && env.SystemDrive.trim() !== '' ? env.SystemDrive.trim() : 'C:';
  add(drive + '\\Windows');
  add(drive + '\\Program Files');
  add(drive + '\\Program Files (x86)');
  add(drive + '\\ProgramData');
  add(drive + '\\$Recycle.Bin');
  add(drive + '\\System Volume Information');
  const seen = new Set();
  return out
    .map((entry) => normalizePath(entry))
    .filter((entry) => {
      if (entry === '' || seen.has(entry.toLowerCase())) return false;
      seen.add(entry.toLowerCase());
      return true;
    });
}

/**
 * Why a path may not be restored over — or an empty string when it may.
 *
 * @param {string} target
 * @param {{home?: string, env?: object}} [options]
 * @returns {string}
 */
export function forbiddenReason(target, { home = os.homedir(), env = process.env } = {}) {
  const dir = normalizePath(target);
  if (dir === '') return 'the target path is empty';
  if (/^[A-Za-z]:[\\/]?$/.test(dir)) return 'refusing to touch a drive root';
  const fsRoot = path.parse(dir).root;
  if (fsRoot !== '' && dir.toLowerCase() === fsRoot.toLowerCase()) {
    return 'refusing to touch a filesystem root';
  }
  const homeDir = normalizePath(home);
  if (homeDir !== '' && dir.toLowerCase() === homeDir.toLowerCase()) {
    return 'refusing to touch the home directory itself';
  }
  for (const system of systemDirectories(env)) {
    if (dir.toLowerCase() === system.toLowerCase() || isInside(dir, system)) {
      return 'refusing to touch the system directory ' + system;
    }
  }
  // Somebody else's profile: <Users>\<name>.
  const usersRoot = normalizePath(path.join(path.parse(homeDir).root, 'Users'));
  if (usersRoot !== '' && isInside(dir, usersRoot)) {
    if (path.dirname(dir).toLowerCase() === usersRoot.toLowerCase()) {
      return 'refusing to touch another user profile';
    }
  }
  return '';
}

/**
 * Whether a path may be restored over at all.
 *
 * Two ways to pass:
 *
 *   - `explicit` (the operator named the directory): any safe path is allowed,
 *     which is what the drill uses for its isolated directory;
 *   - no `explicit`: only a profile directory under `<home>/.dsh/profiles` is
 *     allowed, so a typo cannot turn into "restore over my Documents".
 *
 * @param {string} target
 * @param {{home?: string, env?: object, profilesRoot?: string, explicit?: boolean}} [options]
 * @returns {{ok: boolean, dir: string, scope: string, error: string}}
 */
export function checkProfileTarget(target, { home = os.homedir(), env = process.env, profilesRoot = '', explicit = false } = {}) {
  const dir = normalizePath(target);
  if (dir === '') {
    return { ok: false, dir: '', scope: '', error: 'no profile directory was given' };
  }
  const forbidden = forbiddenReason(dir, { home, env });
  if (forbidden !== '') {
    return { ok: false, dir, scope: '', error: forbidden };
  }
  if (explicit === true) {
    return { ok: true, dir, scope: 'explicit', error: '' };
  }
  const root = profilesRoot !== '' ? normalizePath(profilesRoot) : profilesRootDir({ env, home });
  if (!isInside(dir, root)) {
    return {
      ok: false,
      dir,
      scope: '',
      error: 'only a profile under ' + root + ' may be restored (this one is not: ' + dir + ')',
    };
  }
  return { ok: true, dir, scope: 'profiles-root', error: '' };
}

/**
 * Look at a directory and say what it looks like.
 *
 * @param {string} dir
 * @returns {{dir: string, kind: 'profile'|'broken-profile'|'not-a-profile', reason: string, markers: string[], packageJson: object|null}}
 */
export function inspectProfileDir(dir) {
  const base = normalizePath(dir);
  const markers = [];
  const pkgPath = path.join(base, 'package.json');
  const hasPackageJson = fs.existsSync(pkgPath);
  if (hasPackageJson) markers.push('package.json');
  if (fs.existsSync(path.join(base, 'cordis.patch.yml'))) markers.push('cordis.patch.yml');
  if (fs.existsSync(path.join(base, PLUGINS_DIR))) markers.push(PLUGINS_DIR);

  const base_result = { dir: base, kind: 'not-a-profile', reason: '', markers, packageJson: null };
  if (hasPackageJson) {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && parsed.dsh && parsed.dsh.profile) {
      return { ...base_result, kind: 'profile', reason: 'the profile package.json carries a dsh.profile section', packageJson: parsed };
    }
    if (markers.length >= 2) {
      return {
        ...base_result,
        kind: 'broken-profile',
        reason: 'the profile is broken (its package.json does not identify a profile), but the profile files are still there',
        packageJson: parsed,
      };
    }
    return {
      ...base_result,
      reason: 'the package.json does not carry a dsh.profile section, and nothing else marks this as a profile',
      packageJson: parsed,
    };
  }
  if (markers.length > 0) {
    return {
      ...base_result,
      kind: 'broken-profile',
      reason: 'the profile is broken (its package.json is missing), but the profile files are still there',
    };
  }
  return { ...base_result, reason: 'there is no package.json here — this does not look like a DSH profile' };
}

/**
 * Read one snapshot manifest.
 *
 * @param {string} dir
 * @returns {object|null}
 */
export function readSnapshotManifest(dir) {
  try {
    let text = fs.readFileSync(path.join(normalizePath(dir), MANIFEST_NAME), 'utf8');
    // Windows PowerShell writes UTF-8 files with a BOM; JSON.parse rejects it.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The newest snapshot that carries a manifest.
 *
 * A directory without a manifest is not a snapshot (it may be a half-written
 * copy), so it is skipped. The newest is decided by the manifest's own `at`
 * stamp; the directory name breaks a tie.
 *
 * @param {string} backupsDir
 * @returns {{ok: boolean, dir: string, name: string, manifest: object|null, candidates: Array<{name: string, dir: string, at: number|null}>, error: string}}
 */
export function selectSnapshot(backupsDir) {
  const root = normalizePath(backupsDir);
  const out = { ok: false, dir: '', name: '', manifest: null, candidates: [], error: '' };
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    out.error = 'the backups directory cannot be read: ' + root;
    return out;
  }
  const candidates = [];
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    const manifest = readSnapshotManifest(dir);
    if (!manifest) continue;
    const at = Number(manifest.at);
    candidates.push({ name: entry.name, dir, manifest, at: Number.isFinite(at) ? at : null });
  }
  candidates.sort((a, b) => {
    const left = a.at === null ? -Infinity : a.at;
    const right = b.at === null ? -Infinity : b.at;
    if (left !== right) return right > left ? 1 : -1;
    return b.name.localeCompare(a.name);
  });
  out.candidates = candidates.map((entry) => ({ name: entry.name, dir: entry.dir, at: entry.at }));
  if (candidates.length === 0) {
    out.error = 'there is no snapshot with a manifest under ' + root;
    return out;
  }
  const best = candidates[0];
  out.ok = true;
  out.dir = best.dir;
  out.name = best.name;
  out.manifest = best.manifest;
  return out;
}

/**
 * The name of the directory the broken profile is kept in.
 *
 * @param {string} profileDir
 * @param {number} [at]
 * @returns {string}
 */
export function brokenDirName(profileDir, at = Date.now()) {
  return normalizePath(profileDir) + BROKEN_SUFFIX + localStamp(at);
}

/**
 * A filesystem-safe local timestamp (`20261029-155530`).
 *
 * @param {number} at
 * @returns {string}
 */
export function localStamp(at = Date.now()) {
  const date = new Date(Number(at));
  const pad = (value) => String(value).padStart(2, '0');
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

/**
 * A human timestamp (`2026-10-29 15:55`).
 *
 * @param {number} at
 * @returns {string}
 */
export function localDisplay(at = Date.now()) {
  const date = new Date(Number(at));
  const pad = (value) => String(value).padStart(2, '0');
  return (
    String(date.getFullYear()) +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes())
  );
}

/**
 * What a snapshot says about itself, in words.
 *
 * @param {object|null} manifest
 * @returns {{at: number|null, display: string, includePlugins: boolean}}
 */
export function describeSnapshot(manifest) {
  const out = { at: null, display: 'an unknown time', includePlugins: false };
  if (!manifest || typeof manifest !== 'object') return out;
  const at = Number(manifest.at);
  if (Number.isFinite(at)) {
    out.at = at;
    out.display = localDisplay(at);
  }
  if (typeof manifest.atLocal === 'string' && manifest.atLocal.trim() !== '') {
    out.display = manifest.atLocal.trim().replace('T', ' ').slice(0, 16);
  }
  out.includePlugins = manifest.includePlugins === true;
  return out;
}

/**
 * Read a restored profile back and say whether it is whole.
 *
 * Three checks:
 *
 *   1. `package.json` parses;
 *   2. `dsh.profile.bundles` has content;
 *   3. the version of the plugin can be read — skipped (not failed) when the
 *      profile simply does not have that plugin installed.
 *
 * @param {string} dir
 * @param {{pluginName?: string}} [options]
 * @returns {{ok: boolean, checks: Array<{id: string, label: string, status: 'passed'|'failed'|'skipped', detail: string}>, error: string, version: string}}
 */
export function validateRestoredProfile(dir, { pluginName = PLUGIN_NAME } = {}) {
  const base = normalizePath(dir);
  const checks = [];

  const pkgPath = path.join(base, 'package.json');
  let parsed = null;
  let parseError = '';
  if (!fs.existsSync(pkgPath)) {
    checks.push({ id: 'package-json', label: 'package.json can be parsed', status: 'failed', detail: 'package.json is missing' });
  } else {
    try {
      parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (error) {
      parseError = error && error.message ? error.message : String(error);
      parsed = null;
    }
    checks.push({
      id: 'package-json',
      label: 'package.json can be parsed',
      status: parsed && typeof parsed === 'object' ? 'passed' : 'failed',
      detail: parsed && typeof parsed === 'object' ? '' : 'not valid JSON: ' + parseError,
    });
  }

  const bundles =
    parsed && parsed.dsh && parsed.dsh.profile && Array.isArray(parsed.dsh.profile.bundles)
      ? parsed.dsh.profile.bundles
      : null;
  checks.push({
    id: 'bundles',
    label: 'dsh.profile.bundles has content',
    status: bundles && bundles.length > 0 ? 'passed' : 'failed',
    detail: bundles ? bundles.length + ' bundle(s)' : 'dsh.profile.bundles is missing or empty',
  });

  const pluginPkgPath = path.join(base, PLUGINS_DIR, pluginName, 'package.json');
  let version = '';
  if (!fs.existsSync(pluginPkgPath)) {
    checks.push({
      id: 'plugin-version',
      label: 'the version of ' + pluginName + ' can be read',
      status: 'skipped',
      detail: pluginName + ' is not installed in this profile (there is nothing to read)',
    });
  } else {
    try {
      const pluginPkg = JSON.parse(fs.readFileSync(pluginPkgPath, 'utf8'));
      version = pluginPkg && typeof pluginPkg.version === 'string' ? pluginPkg.version.trim() : '';
    } catch {
      version = '';
    }
    checks.push({
      id: 'plugin-version',
      label: 'the version of ' + pluginName + ' can be read',
      status: version !== '' ? 'passed' : 'failed',
      detail: version !== '' ? version : 'the version number cannot be read',
    });
  }

  const failed = checks.filter((check) => check.status === 'failed');
  return {
    ok: failed.length === 0,
    checks,
    error: failed.map((check) => check.label).join('; '),
    version,
  };
}

/**
 * Whether a snapshot holds a real profile.
 *
 * The kit never writes something into a profile directory that is not a DSH
 * profile, so the snapshot has to carry one.
 *
 * @param {string} snapshotDir
 * @returns {{ok: boolean, reason: string, profile: object|null}}
 */
export function inspectSnapshotProfile(snapshotDir) {
  const pkgPath = path.join(normalizePath(snapshotDir), CONFIG_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { ok: false, reason: 'the snapshot has no ' + CONFIG_DIR + '/package.json', profile: null };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      reason: 'the snapshot\'s package.json is not valid JSON: ' + (error && error.message ? error.message : String(error)),
      profile: null,
    };
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.dsh || !parsed.dsh.profile) {
    return { ok: false, reason: "the snapshot's package.json has no dsh.profile section", profile: null };
  }
  return { ok: true, reason: 'the snapshot holds a DSH profile', profile: parsed };
}
