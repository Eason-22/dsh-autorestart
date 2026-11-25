/**
 * dsh-autorestart — the ONE-TIME cleanup of the watchers that never left.
 *
 * WHY THIS EXISTS (2026-11-24):
 *
 * The rollback watcher used to exit on its SUCCESS path (`if ($decided -or
 * $healthy) { exit 0 }`) BEFORE its own self-delete, so every successful
 * restart left a `restart-<n>-watch.ps1` behind. MEASURED on the real
 * machine: 431 of them. The watcher itself is fixed now, so no NEW file is
 * left behind — but the files of the past are still on disk, and the
 * "leftover files = 0" release check keeps failing on them.
 *
 * THE ONE RULE THAT MATTERS: this runs on a machine that HAD the plugin
 * before, and on NOTHING else. A fresh installation never wrote a watcher,
 * so there is nothing of its own to clean — and a cleanup that runs where
 * it has no business is a bug, not a tidy-up.
 *
 * WHY A SEPARATE FILE FOR THE RECORD: the checkpoint (`lib/checkpoint.js`)
 * keeps a WHITELIST of top-level fields and drops everything else, so a
 * `lastSeenVersion` / `migrations` pair cannot live there without changing
 * that module. This module therefore keeps its own small record file in
 * the state directory: `restart-migrations.json`, holding exactly
 * `{ lastSeenVersion, migrations }`.
 *
 * TWO RULES THIS MODULE FOLLOWS:
 *
 *   1. IT NEVER THROWS. A cleanup that breaks the boot is worse than a
 *      leftover file. Every failure is reported in `error`.
 *   2. IT ONLY REMOVES WHAT IT KNOWS: the name `restart-<digits>-watch.ps1`
 *      AND content that is ours (`looksLikeWatchScript`), AND a file that
 *      was last written at least `WATCH_RESIDUE_MIN_AGE_MS` ago.
 *
 * ESM only, Node builtins only.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { compareSemver } from './semver.js';
import {
  looksLikeWatchScript,
  WATCH_HELPER_PATTERN,
  WATCH_MIN_AGE_MS,
} from './restart.js';

/** The id of this one-time migration, and the key it is recorded under. */
export const WATCH_RESIDUE_MIGRATION_ID = 'watch-residue-1.0.0';

/** The version the residue was collected in. */
export const WATCH_RESIDUE_TARGET_VERSION = '1.0.0';

/**
 * The minimum age of a watcher before this migration may remove it.
 *
 * The same floor the sweep uses ({@link WATCH_MIN_AGE_MS}, ten minutes): the
 * watcher of a restart that is happening RIGHT NOW must never be pulled from
 * under the running process.
 */
export const WATCH_RESIDUE_MIN_AGE_MS = WATCH_MIN_AGE_MS;

/**
 * THE VERSION OF A BUILD THAT NEVER RECORDED ONE.
 *
 * The builds before 1.0.0 did not write `lastSeenVersion` into the record,
 * so an upgrading machine has no recorded version at all. It is NOT a fresh
 * installation though — the caller tells the two apart by the checkpoint
 * that is already there. For the migration the only thing that matters is
 * "older than 1.0.0", and `0.0.0` is older than everything.
 */
export const UNKNOWN_PREVIOUS_VERSION = '0.0.0';

/** The file the record lives in, inside the plugin's state directory. */
export const MIGRATION_RECORD_FILE = 'restart-migrations.json';

/** The text of any thrown value, for the `error` field. */
function errorText(value) {
  if (value && typeof value.message === 'string' && value.message !== '') return value.message;
  return String(value);
}

/**
 * Read the migration record of a state directory.
 *
 * A directory that has no record yet is NOT an error: that is what a fresh
 * installation looks like, and what a machine that upgrades from a build
 * that never wrote one looks like.
 *
 * @param {string} stateDir
 * @returns {{ lastSeenVersion: string|null, migrations: Record<string, boolean>, existed: boolean, error: string|null }}
 */
export function readMigrationRecord(stateDir) {
  const result = { lastSeenVersion: null, migrations: {}, existed: false, error: null };
  const dir = typeof stateDir === 'string' ? stateDir : '';
  if (dir === '') {
    result.error = 'no state directory';
    return result;
  }
  const file = path.join(dir, MIGRATION_RECORD_FILE);
  try {
    if (!existsSync(file)) return result;
    result.existed = true;
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object') return result;
    if (typeof parsed.lastSeenVersion === 'string' && parsed.lastSeenVersion.trim() !== '') {
      result.lastSeenVersion = parsed.lastSeenVersion.trim();
    }
    if (parsed.migrations && typeof parsed.migrations === 'object') {
      for (const [key, value] of Object.entries(parsed.migrations)) {
        if (value === true) result.migrations[key] = true;
      }
    }
  } catch (error) {
    result.error = errorText(error);
  }
  return result;
}

/**
 * Write the migration record of a state directory.
 *
 * The file is written WITHOUT a BOM, because the plugin reads it back with
 * a strict `JSON.parse`.
 *
 * @param {string} stateDir
 * @param {{ lastSeenVersion?: string|null, migrations?: Record<string, boolean> }} [record]
 * @returns {{ ok: boolean, error: string|null }}
 */
export function writeMigrationRecord(stateDir, { lastSeenVersion = null, migrations = {} } = {}) {
  const dir = typeof stateDir === 'string' ? stateDir : '';
  if (dir === '') return { ok: false, error: 'no state directory' };
  try {
    mkdirSync(dir, { recursive: true });
    const payload = {
      lastSeenVersion: typeof lastSeenVersion === 'string' && lastSeenVersion.trim() !== ''
        ? lastSeenVersion.trim()
        : null,
      migrations: { ...migrations },
    };
    writeFileSync(
      path.join(dir, MIGRATION_RECORD_FILE),
      JSON.stringify(payload, null, 2) + '\n',
      'utf8',
    );
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/**
 * Remove the watchers that the builds before 1.0.0 left behind.
 *
 * The rules, in the order they are checked:
 *
 *   1. NO PREVIOUS VERSION → nothing happens. `ran` is false, `removed` is
 *      0, and NOT ONE FILE IS TOUCHED. This is the fresh installation, and
 *      the judgement is made on the RECORD - never on "are there leftover
 *      files in the directory" (that would trigger on a fresh install too).
 *   2. THE MIGRATION IS ALREADY RECORDED → nothing happens (`ran` false).
 *   3. THE PREVIOUS VERSION IS NOT OLDER THAN THE CURRENT ONE → nothing
 *      happens (`ran` false).
 *   4. Otherwise the directory is scanned: a file is removed only when its
 *      name matches {@link WATCH_HELPER_PATTERN}, its content is ours
 *      (`looksLikeWatchScript`), and it was last written at least
 *      `minAgeMs` ago.
 *
 * Nothing here throws: a failure is caught and reported.
 *
 * @param {string} dir the plugin's state directory
 * @param {{
 *   prevVersion?: string|null,
 *   currentVersion?: string,
 *   migrations?: Record<string, boolean>,
 *   now?: number,
 *   minAgeMs?: number,
 * }} [options]
 * @returns {{
 *   ran: boolean, removed: number, removedNames: string[], kept: string[],
 *   scanned: number, skippedReason: string|null, error: string|null,
 * }}
 */
export function migrateWatchResidue(dir, {
  prevVersion = null,
  currentVersion = WATCH_RESIDUE_TARGET_VERSION,
  migrations = {},
  now = Date.now(),
  minAgeMs = WATCH_RESIDUE_MIN_AGE_MS,
} = {}) {
  const result = {
    ran: false,
    removed: 0,
    removedNames: [],
    kept: [],
    scanned: 0,
    skippedReason: null,
    error: null,
  };
  try {
    // 1. A FRESH INSTALLATION: there is no previous version, so there is
    // nothing of ours to clean. NOT ONE FILE IS TOUCHED.
    if (typeof prevVersion !== 'string' || prevVersion.trim() === '') {
      result.skippedReason = 'fresh-install: no previous version was ever recorded';
      return result;
    }
    // 2. ALREADY DONE: the marker is there.
    if (migrations && typeof migrations === 'object' && migrations[WATCH_RESIDUE_MIGRATION_ID] === true) {
      result.skippedReason = 'already-migrated: ' + WATCH_RESIDUE_MIGRATION_ID + ' is recorded';
      return result;
    }
    // 3. NOT OLDER: there is nothing to collect.
    const order = compareSemver(prevVersion, currentVersion);
    if (order === null) {
      result.skippedReason = 'unknown-previous-version: ' + prevVersion + ' is not a version';
      return result;
    }
    if (order >= 0) {
      result.skippedReason = 'not-older-than-current: ' + prevVersion + ' is not older than ' + currentVersion;
      return result;
    }
    // 4. THE MIGRATION ITSELF.
    const folder = typeof dir === 'string' ? dir : '';
    if (folder === '') {
      result.skippedReason = 'no-state-directory';
      return result;
    }
    let names = [];
    try {
      names = readdirSync(folder);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        result.skippedReason = 'no-state-directory';
        return result;
      }
      throw error;
    }
    result.ran = true;
    for (const name of names) {
      if (!WATCH_HELPER_PATTERN.test(name)) continue;
      result.scanned += 1;
      const file = path.join(folder, name);
      try {
        const stat = statSync(file);
        if (!stat.isFile()) {
          result.kept.push(name);
          continue;
        }
        // Never touch a file that was just written: the watcher may still be
        // running, waiting for the new instance or rolling the snapshot back.
        if (minAgeMs > 0 && now - stat.mtimeMs < minAgeMs) {
          result.kept.push(name);
          continue;
        }
        if (!looksLikeWatchScript(readFileSync(file, 'utf8'))) {
          result.kept.push(name);
          continue;
        }
        unlinkSync(file);
        result.removed += 1;
        result.removedNames.push(name);
      } catch (error) {
        result.kept.push(name);
        result.error = errorText(error);
      }
    }
    return result;
  } catch (error) {
    // A cleanup that breaks the boot is worse than a leftover file.
    result.ran = false;
    result.skippedReason = 'error';
    result.error = errorText(error);
    return result;
  }
}
