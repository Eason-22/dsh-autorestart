/**
 * dsh-autorestart — pre-restart backups.
 *
 * A restart can leave the host unable to boot: the profile configuration is what
 * decides whether every installed bundle loads, and the host's own rescue path
 * rewrites exactly those files when a boot fails. So the restart helper keeps a
 * snapshot of the profile (its configuration files, and — when enabled — the
 * installed plugin tree) and can put it back when the host does not come up.
 *
 * Everything here is synchronous and bounded: a backup is taken right before the
 * detached restart is scheduled, and only the newest `maxBackups` snapshots are
 * kept (older ones are removed so the disk never grows without a limit).
 *
 * The restore path used by the detached helper lives in the generated PowerShell
 * watcher (lib/restart.js); `restoreBackup` here is the same operation for tests
 * and for a manual recovery from inside the host.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The profile files that decide whether the host can boot. */
export const CONFIG_FILES = Object.freeze(['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml']);

/** The directory inside one backup that holds the configuration files. */
export const CONFIG_DIR = 'config';

/** The directory inside one backup that holds the installed plugin tree. */
export const PLUGINS_DIR = 'node_modules';

/** The manifest written into every backup. */
export const MANIFEST_NAME = 'manifest.json';

/** How many backups are kept by default. */
export const DEFAULT_MAX_BACKUPS = 2;

/** The report the detached helper writes when it rolls a backup back. */
export const ROLLBACK_REPORT_NAME = 'last-rollback.json';

/**
 * A filesystem-safe timestamp for a backup directory name.
 *
 * @param {number} [now]
 * @returns {string}
 */
export function backupStamp(now = Date.now()) {
  const date = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now());
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * The backups directory that belongs to a state directory.
 *
 * @param {string} stateDir
 * @returns {string}
 */
export function backupsRoot(stateDir) {
  return path.join(String(stateDir ?? ''), 'backups');
}

/** Recursively measure a directory; never throws. */
function directorySize(target) {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      const nested = directorySize(child);
      bytes += nested.bytes;
      files += nested.files;
      continue;
    }
    try {
      bytes += fs.statSync(child).size;
      files += 1;
    } catch {
      // A file that vanished between readdir and stat is simply not counted.
    }
  }
  return { bytes, files };
}

/**
 * Copy one entry (file or directory) into a destination directory.
 *
 * @returns {boolean} whether anything was copied
 */
function copyEntry(source, destination) {
  try {
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      fs.cpSync(source, destination, { recursive: true, force: true });
      return true;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep only the newest `maxBackups` backup directories.
 *
 * @param {string} backupsDir
 * @param {number} [maxBackups]
 * @returns {string[]} the names that were removed
 */
export function pruneBackups(backupsDir, maxBackups = DEFAULT_MAX_BACKUPS) {
  const limit = Number.isFinite(Number(maxBackups)) && Number(maxBackups) >= 1
    ? Math.trunc(Number(maxBackups))
    : DEFAULT_MAX_BACKUPS;
  let names;
  try {
    names = fs.readdirSync(backupsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names.slice(0, Math.max(0, names.length - limit))) {
    const target = path.join(backupsDir, name);
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // A backup that cannot be removed must not fail the restart.
    }
  }
  return removed;
}

/**
 * List the backups, newest first.
 *
 * @param {string} backupsDir
 * @returns {Array<{name: string, dir: string, at: number|null, bytes: number|null, includePlugins: boolean}>}
 */
export function listBackups(backupsDir) {
  let names;
  try {
    names = fs.readdirSync(backupsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort().reverse()) {
    const dir = path.join(backupsDir, name);
    const manifest = readManifest(dir);
    out.push({
      name,
      dir,
      at: manifest && Number.isFinite(manifest.at) ? manifest.at : null,
      bytes: manifest && Number.isFinite(manifest.bytes) ? manifest.bytes : null,
      includePlugins: Boolean(manifest && manifest.includePlugins === true),
    });
  }
  return out;
}

/**
 * Read one backup manifest.
 *
 * @param {string} backupDir
 * @returns {object|null}
 */
export function readManifest(backupDir) {
  try {
    const text = fs.readFileSync(path.join(String(backupDir ?? ''), MANIFEST_NAME), 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Take one backup of the profile.
 *
 * `includePlugins` copies the whole installed plugin tree, which is what makes a
 * rollback of "a plugin upgrade broke the boot" actually possible; without it only
 * the configuration files are copied.
 *
 * Never throws: a backup that cannot be written is reported as `{ ok: false }` so
 * the caller can decide whether the restart may still proceed.
 *
 * @param {{
 *   profileDir: string,
 *   backupsDir: string,
 *   includePlugins?: boolean,
 *   maxBackups?: number,
 *   now?: number,
 * }} options
 * @returns {{ ok: boolean, dir: string|null, stamp: string|null, bytes: number, files: string[], includePlugins: boolean, pruned: string[], error: string|null }}
 */
export function createBackup({
  profileDir,
  backupsDir,
  includePlugins = true,
  maxBackups = DEFAULT_MAX_BACKUPS,
  now = Date.now(),
} = {}) {
  const profile = typeof profileDir === 'string' ? profileDir.trim() : '';
  const root = typeof backupsDir === 'string' ? backupsDir.trim() : '';
  const base = {
    ok: false,
    dir: null,
    stamp: null,
    bytes: 0,
    files: [],
    includePlugins: includePlugins === true,
    pruned: [],
    error: null,
  };
  if (profile === '') return { ...base, error: 'createBackup requires profileDir' };
  if (root === '') return { ...base, error: 'createBackup requires backupsDir' };
  if (!fs.existsSync(profile)) return { ...base, error: 'the profile directory does not exist' };

  const stamp = backupStamp(now);
  const dir = path.join(root, stamp);
  const files = [];
  let bytes = 0;
  try {
    fs.mkdirSync(path.join(dir, CONFIG_DIR), { recursive: true });
  } catch (error) {
    return { ...base, stamp, error: 'could not create the backup directory: ' + (error && error.message ? error.message : String(error)) };
  }

  for (const name of CONFIG_FILES) {
    const source = path.join(profile, name);
    if (!fs.existsSync(source)) continue;
    if (copyEntry(source, path.join(dir, CONFIG_DIR, name))) {
      files.push(path.join(CONFIG_DIR, name));
      try {
        bytes += fs.statSync(path.join(dir, CONFIG_DIR, name)).size;
      } catch {
        // Size reporting is advisory only.
      }
    }
  }

  if (includePlugins === true) {
    const source = path.join(profile, PLUGINS_DIR);
    if (fs.existsSync(source) && copyEntry(source, path.join(dir, PLUGINS_DIR))) {
      files.push(PLUGINS_DIR);
      bytes += directorySize(path.join(dir, PLUGINS_DIR)).bytes;
    }
  }

  const manifest = {
    stamp,
    at: Number(now),
    profileDir: profile,
    includePlugins: includePlugins === true,
    files,
    bytes,
  };
  try {
    fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');
  } catch (error) {
    return { ...base, stamp, files, bytes, error: 'could not write the backup manifest: ' + (error && error.message ? error.message : String(error)) };
  }

  const pruned = pruneBackups(root, maxBackups);
  return { ...base, ok: true, dir, stamp, bytes, files, pruned };
}

/**
 * Put a backup back over the live profile.
 *
 * The configuration files are copied over the existing ones; the plugin tree is
 * copied with `force` so the snapshot wins file by file. The caller decides what
 * to do with the host afterwards (the detached helper relaunches it).
 *
 * @param {{ backupDir: string, profileDir: string }} options
 * @returns {{ ok: boolean, restored: string[], error: string|null }}
 */
export function restoreBackup({ backupDir, profileDir } = {}) {
  const backup = typeof backupDir === 'string' ? backupDir.trim() : '';
  const profile = typeof profileDir === 'string' ? profileDir.trim() : '';
  const restored = [];
  if (backup === '') return { ok: false, restored, error: 'restoreBackup requires backupDir' };
  if (profile === '') return { ok: false, restored, error: 'restoreBackup requires profileDir' };
  if (!fs.existsSync(backup)) return { ok: false, restored, error: 'the backup directory does not exist' };

  const configDir = path.join(backup, CONFIG_DIR);
  if (fs.existsSync(configDir)) {
    for (const name of CONFIG_FILES) {
      const source = path.join(configDir, name);
      if (!fs.existsSync(source)) continue;
      if (copyEntry(source, path.join(profile, name))) restored.push(name);
    }
  }
  const plugins = path.join(backup, PLUGINS_DIR);
  if (fs.existsSync(plugins) && copyEntry(plugins, path.join(profile, PLUGINS_DIR))) {
    restored.push(PLUGINS_DIR);
  }
  if (restored.length === 0) {
    return { ok: false, restored, error: 'the backup holds nothing that could be restored' };
  }
  return { ok: true, restored, error: null };
}

/**
 * Read the report the detached helper writes after a rolled-back boot.
 *
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readRollbackReport(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return null;
  try {
    let text = fs.readFileSync(path.join(dir, ROLLBACK_REPORT_NAME), 'utf8');
    // Windows PowerShell 5.1 writes UTF-8 files with a BOM; JSON.parse rejects it.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Remove the rollback report once it has been reported.
 *
 * @param {string} stateDir
 * @returns {boolean} whether a report was removed
 */
export function clearRollbackReport(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return false;
  try {
    fs.rmSync(path.join(dir, ROLLBACK_REPORT_NAME), { force: true });
    return true;
  } catch {
    return false;
  }
}
