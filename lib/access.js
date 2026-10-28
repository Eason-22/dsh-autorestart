/**
 * dsh-autorestart — the instance record: how the running host can be reached.
 *
 * TWO facts make this file necessary:
 *
 *   1. The web server of the desktop app listens on a RANDOM port (`--port 0`),
 *      so the port of the PREVIOUS instance is worthless for the next one. The
 *      port of the new instance is only known to the new instance itself — so
 *      the new instance has to publish it, and the rollback watcher has to read
 *      it instead of guessing.
 *   2. The boot token of `dsh web` is created PER PROCESS. After a restart the
 *      old access link answers 401, so the user is locked out of their own
 *      interface until somebody hands them the new link. The new instance knows
 *      its own link (the host's connection service signs it), so the new
 *      instance writes it down — into a file only the user can read.
 *
 * The record is ONE small JSON file in the state directory:
 *
 *   { "bootId": "…", "pid": 1234, "port": 55537, "url": "http://…/?token=…",
 *     "token": "…", "at": 1730000000000 }
 *
 * `bootId` is what tells "the new instance" from "the old one": the plugin
 * generates a new one on every boot, so a watcher can wait for the change
 * instead of guessing from a port.
 *
 * The file holds a SECRET (the boot token), so it is written with the
 * restrictive mode 0600. On POSIX that is enforced by the kernel; on Windows
 * the mode is advisory, so the file inherits the ACL of the (per-user) state
 * directory — which is why the token is never written anywhere else in
 * readable form.
 *
 * ESM only, Node builtins only. No DSH / npm imports.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The name of the instance record inside the state directory. */
export const ACCESS_FILE_NAME = 'access.json';

/** The mode the instance record is written with: readable by its owner only. */
export const ACCESS_FILE_MODE = 0o600;

/** @param {unknown} value */
function errorText(value) {
  if (value && typeof value.message === 'string' && value.message) return value.message;
  return String(value);
}

/**
 * The path of the instance record that belongs to a state directory.
 *
 * @param {string} stateDir
 * @returns {string}
 */
export function accessFilePath(stateDir) {
  return path.join(String(stateDir ?? ''), ACCESS_FILE_NAME);
}

/**
 * The access link of the running instance, with its boot token when the host's
 * connection service can sign one.
 *
 * The connection service is optional: a host that does not provide it still
 * gets the plain origin, so the record is always written.
 *
 * @param {{ origin?: string, connection?: any }} options
 * @returns {{ url: string|null, token: string|null }}
 */
export function resolveAccessUrl({ origin = '', connection = null } = {}) {
  const base = typeof origin === 'string' ? origin.trim().replace(/\/+$/, '') : '';
  if (base === '') return { url: null, token: null };
  let url = base + '/';
  let token = null;
  try {
    if (connection && typeof connection.authenticatedUrl === 'function') {
      const signed = connection.authenticatedUrl(base);
      if (typeof signed === 'string' && signed.trim() !== '') {
        url = signed.trim();
        try {
          const parsed = new URL(url);
          token = parsed.searchParams.get('token');
        } catch {
          token = null;
        }
      }
    }
  } catch {
    // A connection service that throws must not cost us the plain origin.
    url = base + '/';
    token = null;
  }
  return { url, token };
}

/**
 * Write the instance record.
 *
 * The write is atomic (a temporary file + a rename), so a reader never sees a
 * half-written record, and the mode is restricted to the owner.
 *
 * @param {{
 *   stateDir?: string,
 *   bootId?: string|null,
 *   pid?: number|null,
 *   port?: number|null,
 *   url?: string|null,
 *   token?: string|null,
 *   now?: number,
 * }} [options]
 * @returns {{ ok: boolean, path: string|null, record: object|null, error: string|null }}
 */
export function writeAccessRecord({
  stateDir = '',
  bootId = null,
  pid = null,
  port = null,
  url = null,
  token = null,
  now = Date.now(),
} = {}) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') {
    return { ok: false, path: null, record: null, error: 'writeAccessRecord requires stateDir' };
  }
  const file = accessFilePath(dir);
  const record = {
    bootId: typeof bootId === 'string' && bootId !== '' ? bootId : null,
    pid: Number.isFinite(Number(pid)) ? Number(pid) : null,
    port: Number.isFinite(Number(port)) ? Number(port) : null,
    url: typeof url === 'string' && url !== '' ? url : null,
    token: typeof token === 'string' && token !== '' ? token : null,
    at: Number.isFinite(Number(now)) ? Number(now) : Date.now(),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', {
      encoding: 'utf8',
      mode: ACCESS_FILE_MODE,
    });
    // `writeFileSync` only applies the mode when it CREATES the file, so the
    // permission is set explicitly as well (and after the rename, because the
    // rename keeps the mode of the source anyway).
    try {
      fs.chmodSync(temporary, ACCESS_FILE_MODE);
    } catch {
      /* the mode is advisory on some platforms */
    }
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, ACCESS_FILE_MODE);
    } catch {
      /* the mode is advisory on some platforms */
    }
    return { ok: true, path: file, record, error: null };
  } catch (error) {
    return { ok: false, path: file, record, error: 'could not write the instance record: ' + errorText(error) };
  }
}

/**
 * Read the instance record from a file path.
 *
 * @param {string} file
 * @returns {{ ok: boolean, record: object|null, error: string|null }}
 */
export function readAccessRecordFile(file) {
  const target = typeof file === 'string' ? file.trim() : '';
  if (target === '') return { ok: false, record: null, error: 'readAccessRecordFile requires a path' };
  try {
    const text = fs.readFileSync(target, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) {
      const parsed = JSON.parse(text.slice(1));
      return { ok: true, record: parsed && typeof parsed === 'object' ? parsed : null, error: null };
    }
    const parsed = JSON.parse(text);
    return { ok: true, record: parsed && typeof parsed === 'object' ? parsed : null, error: null };
  } catch (error) {
    return { ok: false, record: null, error: errorText(error) };
  }
}

/**
 * Read the instance record of a state directory.
 *
 * @param {string} stateDir
 * @returns {{ ok: boolean, record: object|null, error: string|null }}
 */
export function readAccessRecord(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return { ok: false, record: null, error: 'readAccessRecord requires stateDir' };
  return readAccessRecordFile(accessFilePath(dir));
}

/**
 * Remove the instance record (used when a restart is armed, so a stale record
 * of a dead instance is never mistaken for a live one).
 *
 * @param {string} stateDir
 * @returns {boolean} whether a record was removed
 */
export function clearAccessRecord(stateDir) {
  const dir = typeof stateDir === 'string' ? stateDir.trim() : '';
  if (dir === '') return false;
  try {
    fs.rmSync(accessFilePath(dir), { force: true });
    return true;
  } catch {
    return false;
  }
}
