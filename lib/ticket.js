/**
 * One-time gesture tickets for the graceful shutdown.
 *
 * The button is a HUMAN control: the machine may only be switched off
 * after a real person clicked it. A shell process on the same machine can
 * of course POST to the route — that is the hole this module closes.
 *
 * The mechanism:
 *
 *   1. The host starts and generates a random secret (per host start, so a
 *      ticket of an earlier boot is worthless).
 *   2. Every served page gets a fresh ticket injected into it. The ticket
 *      is registered on the host side, signed with the secret, and expires
 *      after {@link TICKET_TTL_MS}.
 *   3. The browser remembers a real `pointerdown` (an event the page cannot
 *      fake: `isTrusted === true`) and sends the ticket plus that gesture's
 *      timestamp with the arm request.
 *   4. The host verifies the signature, that the ticket is known and unused,
 *      that it did not expire, that the gesture is fresh
 *      ({@link GESTURE_WINDOW_MS}) and that the request is not cross-site —
 *      and then it CONSUMES the ticket (one ticket, one arm).
 *
 * This raises the bar, it is NOT an absolute boundary: a local process
 * that can read the page (or the host's memory) can still forge a ticket.
 * `sleepHumanOnly: false` turns the whole mechanism off for the users who
 * really want an automated script.
 *
 * ESM only, Node builtins only. No DSH / npm imports.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** How long a ticket stays usable (ms). */
export const TICKET_TTL_MS = 60_000;

/** How long a real pointer gesture stays valid (ms). */
export const GESTURE_WINDOW_MS = 3_000;

/**
 * The machine-readable reasons of a refused request, with the Chinese
 * sentence the client shows.
 */
export const TICKET_REASONS = Object.freeze({
  'no-ticket': '这个请求没有带手势票据：收工关机只能由真人点按钮触发。',
  'bad-ticket': '手势票据不是本轮启动签发的（或者已被篡改），请刷新页面再试。',
  'expired-ticket': '手势票据已经过期（有效期 60 秒），请刷新页面再试。',
  'replayed-ticket': '这张手势票据已经用过了（一张页面只发一张），刷新页面就能再点一次。',
  'stale-gesture': '这次点击不是刚刚发生的真人手势，请在 3 秒内再点一次。',
  'cross-site': '请求来自别的站点，已被拒绝。',
});

/**
 * Sign a nonce with the host secret.
 *
 * @param {string} secret
 * @param {string} nonce
 * @returns {string} the hex signature
 */
function sign(secret, nonce) {
  return createHash('sha256').update(`${secret}:${nonce}`).digest('hex');
}

/**
 * Compare two hex signatures without leaking their length through time.
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function sameSignature(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left.length !== right.length || left.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Read one header value (case-insensitive, string or array).
 *
 * @param {object} headers
 * @param {string} name
 * @returns {string}
 */
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
    return typeof value === 'string' ? value : '';
  }
  return '';
}

/**
 * Whether the request looks like it came from another site.
 *
 * `Sec-Fetch-Site` is the browser's own word for it, and every current
 * browser sends it — so it decides when it is there. The `Origin` header is
 * the fallback for the rare client that does not send it: an origin that
 * names another host than the one the request went to is the same thing. A
 * request WITHOUT an origin (a shell script) is not cross-site — it is
 * refused for the missing ticket instead.
 *
 * @param {object} headers
 * @param {string} host the host the request was sent to
 * @returns {boolean}
 */
export function isCrossSiteRequest(headers, host) {
  const site = headerValue(headers, 'sec-fetch-site').toLowerCase();
  if (site !== '') return site === 'cross-site';
  const origin = headerValue(headers, 'origin');
  if (origin === '' || origin.toLowerCase() === 'null') return false;
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  if (typeof host !== 'string' || host === '') return false;
  return originHost !== host;
}

/**
 * Create the ticket store of one host start.
 *
 * @param {{ secret?: string, now?: () => number }} [options]
 * @returns {{
 *   issue: () => { ticket: string, issuedAt: number },
 *   verify: (input: { ticket?: string, gesture?: number|string, headers?: object, host?: string }) => { ok: boolean, reason?: string, issuedAt?: number },
 *   size: () => number,
 * }}
 */
export function createGestureTickets(options = {}) {
  const secret = typeof options.secret === 'string' && options.secret !== ''
    ? options.secret
    : randomBytes(32).toString('hex');
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  /** @type {Map<string, { issuedAt: number, used: boolean }>} */
  const tickets = new Map();

  /**
   * Register a fresh ticket and hand it to the page.
   *
   * @returns {{ ticket: string, issuedAt: number }}
   */
  const issue = () => {
    const issuedAt = now();
    const nonce = randomBytes(16).toString('hex');
    const ticket = `${nonce}.${sign(secret, nonce)}`;
    tickets.set(ticket, { issuedAt, used: false });
    // The store only ever holds the tickets of the last couple of minutes.
    for (const [key, entry] of tickets) {
      if (issuedAt - entry.issuedAt > TICKET_TTL_MS * 2) tickets.delete(key);
    }
    return { ticket, issuedAt };
  };

  /**
   * Verify a request and consume the ticket when it is good.
   *
   * A refused request does NOT consume the ticket: the user may simply try
   * again (the button is a toggle, a cancel needs no ticket).
   *
   * @param {{ ticket?: string, gesture?: number|string, headers?: object, host?: string }} input
   * @returns {{ ok: boolean, reason?: string, issuedAt?: number }}
   */
  const verify = (input = {}) => {
    const raw = typeof input.ticket === 'string' ? input.ticket.trim() : '';
    if (raw === '') return { ok: false, reason: 'no-ticket' };
    const dot = raw.indexOf('.');
    if (dot <= 0 || dot === raw.length - 1) return { ok: false, reason: 'bad-ticket' };
    const nonce = raw.slice(0, dot);
    if (!sameSignature(raw.slice(dot + 1), sign(secret, nonce))) {
      return { ok: false, reason: 'bad-ticket' };
    }
    const entry = tickets.get(raw);
    if (!entry) return { ok: false, reason: 'bad-ticket' };
    if (entry.used) return { ok: false, reason: 'replayed-ticket' };
    if (now() - entry.issuedAt > TICKET_TTL_MS) return { ok: false, reason: 'expired-ticket' };
    const gestureAt = Number(input.gesture);
    if (!Number.isFinite(gestureAt)) return { ok: false, reason: 'stale-gesture' };
    const age = now() - gestureAt;
    if (age < -1000 || age > GESTURE_WINDOW_MS) return { ok: false, reason: 'stale-gesture' };
    if (isCrossSiteRequest(input.headers, input.host)) return { ok: false, reason: 'cross-site' };
    // One ticket, one arm.
    entry.used = true;
    return { ok: true, issuedAt: entry.issuedAt };
  };

  return { issue, verify, size: () => tickets.size };
}

/**
 * The Chinese sentence of a refusal reason.
 *
 * @param {string} reason
 * @returns {string}
 */
export function describeTicketReason(reason) {
  const text = TICKET_REASONS[reason];
  return typeof text === 'string' ? text : '这个请求没有通过手势校验。';
}
