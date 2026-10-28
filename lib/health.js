/**
 * dsh-autorestart — "is the new host really up?".
 *
 * A restart is only successful when the NEW instance answers its health route.
 * The old instance's answer proves nothing: the old instance may still be
 * running (the restart command did nothing), or it may answer on a port the
 * new instance does not use (the desktop app listens on a random port).
 *
 * So the confirmation is built from two facts:
 *
 *   1. the INSTANCE RECORD (lib/access.js) of the new instance — it carries a
 *      boot id that is different from the one of the instance that is being
 *      replaced, and the port the new instance really listens on;
 *   2. the health route of THAT port.
 *
 * The wait is bounded: when the new instance does not answer in time the
 * caller gets a REASON, never a silent success.
 *
 * ESM only, Node builtins only. No DSH / npm imports.
 */

import http from 'node:http';
import { URL } from 'node:url';

import { readAccessRecordFile } from './access.js';

/** How long one health request may take before it counts as "no answer". */
export const DEFAULT_HEALTH_TIMEOUT_MS = 5000;

/** How long the new instance may take to come up at all. */
export const DEFAULT_INSTANCE_WAIT_MS = 90000;

/** How often the instance record is read while waiting. */
export const DEFAULT_INSTANCE_POLL_MS = 1000;

/** @param {unknown} value */
function errorText(value) {
  if (value && typeof value.message === 'string' && value.message) return value.message;
  return String(value);
}

/**
 * Sleep for a while. Never rejects.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * One plain HTTP GET, answered with the parsed JSON body.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, status: number, body: any, error: string|null }>}
 */
function httpGetJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let request;
    try {
      request = http.get(url, { timeout: timeoutMs }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
          const status = Number(response.statusCode) || 0;
          finish({
            ok: status >= 200 && status < 300 && body !== null && body.ok === true,
            status,
            body,
            error: status >= 200 && status < 300
              ? (body !== null && body.ok === true ? null : 'the health route did not answer ok')
              : 'the health route answered with status ' + status,
          });
        });
        response.on('error', (error) => {
          finish({ ok: false, status: 0, body: null, error: errorText(error) });
        });
      });
    } catch (error) {
      finish({ ok: false, status: 0, body: null, error: errorText(error) });
      return;
    }
    request.on('timeout', () => {
      try {
        request.destroy();
      } catch {
        /* nothing else to do */
      }
      finish({ ok: false, status: 0, body: null, error: 'the health request timed out' });
    });
    request.on('error', (error) => {
      finish({ ok: false, status: 0, body: null, error: errorText(error) });
    });
  });
}

/**
 * Ask one health route whether the host behind it is alive.
 *
 * @param {{ url?: string, timeoutMs?: number, requestImpl?: Function }} [options]
 * @returns {Promise<{ ok: boolean, status: number, error: string|null }>}
 */
export function probeHealth({ url = '', timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS, requestImpl = null } = {}) {
  const target = typeof url === 'string' ? url.trim() : '';
  if (target === '') {
    return Promise.resolve({ ok: false, status: 0, error: 'probeHealth requires a url' });
  }
  const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.trunc(Number(timeoutMs))
    : DEFAULT_HEALTH_TIMEOUT_MS;
  const request = typeof requestImpl === 'function' ? requestImpl : httpGetJson;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, status: 0, error: 'the health request timed out after ' + budget + 'ms' });
    }, budget);
    Promise.resolve()
      .then(() => request(target, budget))
      .then((response) => {
        clearTimeout(timer);
        const status = Number(response && response.status) || 0;
        if (response && response.ok === true) {
          finish({ ok: true, status: status || 200, error: null });
          return;
        }
        finish({
          ok: false,
          status,
          error: (response && response.error) || 'the health route did not answer ok',
        });
      })
      .catch((error) => {
        clearTimeout(timer);
        finish({ ok: false, status: 0, error: errorText(error) });
      });
  });
}

/**
 * The health URL of one port on the loopback interface.
 *
 * @param {number|string} port
 * @param {string} healthPath
 * @returns {string}
 */
export function healthUrlForPort(port, healthPath) {
  const number = Number(port);
  if (!Number.isFinite(number) || number <= 0) return '';
  const path = typeof healthPath === 'string' && healthPath.startsWith('/')
    ? healthPath
    : '/__dsh_autorestart/health';
  return 'http://127.0.0.1:' + Math.trunc(number) + path;
}

/**
 * Wait until the instance that replaced `expectedBootId` answers its health
 * route.
 *
 * The instance record is the only source of the new port: the desktop app
 * listens on a random port, so the port of the old instance is meaningless.
 *
 * @param {{
 *   accessFile?: string,
 *   expectedBootId?: string|null,
 *   healthPath?: string,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   probe?: Function,
 *   readRecord?: Function,
 *   now?: Function,
 *   sleep?: Function,
 * }} [options]
 * @returns {Promise<{ ok: boolean, bootId: string|null, port: number|null, url: string|null, reason: string }>}
 */
export async function waitForHealthyInstance({
  accessFile = '',
  expectedBootId = null,
  healthPath = '/__dsh_autorestart/health',
  timeoutMs = DEFAULT_INSTANCE_WAIT_MS,
  intervalMs = DEFAULT_INSTANCE_POLL_MS,
  probe = probeHealth,
  readRecord = readAccessRecordFile,
  now = () => Date.now(),
  sleep: sleepFn = sleep,
} = {}) {
  const file = typeof accessFile === 'string' ? accessFile.trim() : '';
  const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.trunc(Number(timeoutMs))
    : DEFAULT_INSTANCE_WAIT_MS;
  const step = Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0
    ? Math.trunc(Number(intervalMs))
    : DEFAULT_INSTANCE_POLL_MS;
  const expected = typeof expectedBootId === 'string' && expectedBootId !== '' ? expectedBootId : null;
  const deadline = now() + budget;
  let lastReason = 'the new instance did not come up in time';

  if (file === '') {
    return { ok: false, bootId: null, port: null, url: null, reason: 'waitForHealthyInstance requires the instance record' };
  }

  while (now() < deadline) {
    const read = readRecord(file);
    const record = read && read.ok === true ? read.record : null;
    const bootId = record && typeof record.bootId === 'string' ? record.bootId : null;
    const port = record && Number.isFinite(Number(record.port)) ? Number(record.port) : null;
    const isNewInstance = bootId !== null && (expected === null || bootId !== expected);
    if (isNewInstance && port !== null && port > 0) {
      const url = healthUrlForPort(port, healthPath);
      const answer = await probe({ url, timeoutMs: DEFAULT_HEALTH_TIMEOUT_MS });
      if (answer && answer.ok === true) {
        return { ok: true, bootId, port, url, reason: 'the new instance answered its health route' };
      }
      lastReason = (answer && answer.error) || 'the new instance did not answer its health route';
    } else if (record === null) {
      lastReason = 'the instance record is not readable yet';
    } else if (!isNewInstance) {
      lastReason = 'the instance that answers is still the one that is being replaced';
    } else {
      lastReason = 'the new instance did not publish its port yet';
    }
    await sleepFn(step);
  }
  return { ok: false, bootId: null, port: null, url: null, reason: lastReason };
}

/**
 * The token of an access URL, or null.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function tokenOf(url) {
  const text = typeof url === 'string' ? url.trim() : '';
  if (text === '') return null;
  try {
    const parsed = new URL(text);
    return parsed.searchParams.get('token');
  } catch {
    return null;
  }
}
