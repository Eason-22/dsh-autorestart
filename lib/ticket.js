/**
 * One-time page tickets for the graceful shutdown.
 *
 * In the `human` mode only the page may switch the machine off (and only the
 * page may take a running countdown back). The proof is a ticket the host
 * injects into the page it serves: a shell script on the same machine cannot
 * read it, so it cannot arm anything.
 *
 * The rules:
 *
 *   - the ticket is signed with a secret that lives only in this host start,
 *     so a ticket of an earlier boot is worthless;
 *   - it is good for 60 seconds and for ONE request — arm or cancel;
 *   - `check` looks at a ticket without spending it (the status route uses it
 *     to answer "could this page arm the machine?"), `consume` spends it.
 *
 * ESM only, Node builtins only. No DSH / npm imports.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** How long a ticket stays usable (ms). */
export const TICKET_TTL_MS = 60_000;

/** The reasons a request can be refused, in the order they are checked. */
export const TICKET_REASONS = Object.freeze([
  'no-ticket',
  'bad-ticket',
  'expired-ticket',
  'replayed-ticket',
]);

/**
 * The Chinese sentence of a refusal reason.
 *
 * @param {string} reason
 * @returns {string}
 */
export function describeTicketReason(reason) {
  const sentences = {
    'no-ticket': '这个请求没有带页面票据：在「只有我能点」模式下，只有页面里的按钮能动它。',
    'bad-ticket': '页面票据不是本轮启动签发的（或者已经被篡改），请刷新页面再试。',
    'expired-ticket': '页面票据已经过期（有效期 60 秒），请刷新页面再试。',
    'replayed-ticket': '这张页面票据已经用过了，请刷新页面再试。',
  };
  const sentence = sentences[reason];
  return typeof sentence === 'string' ? sentence : '这个请求没有通过页面票据校验。';
}

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
 * Create the ticket store of one host start.
 *
 * @param {{ secret?: string, now?: () => number }} [options]
 * @returns {{
 *   issue: () => { ticket: string, issuedAt: number },
 *   check: (ticket: string) => { ok: boolean, reason?: string },
 *   consume: (ticket: string) => { ok: boolean, reason?: string },
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
   * Look at a ticket WITHOUT spending it.
   *
   * @param {string} ticket
   * @returns {{ ok: boolean, reason?: string }}
   */
  const check = (ticket) => {
    if (typeof ticket !== 'string' || ticket === '') return { ok: false, reason: 'no-ticket' };
    const dot = ticket.indexOf('.');
    if (dot <= 0 || dot === ticket.length - 1) return { ok: false, reason: 'bad-ticket' };
    const nonce = ticket.slice(0, dot);
    if (!sameSignature(ticket.slice(dot + 1), sign(secret, nonce))) {
      return { ok: false, reason: 'bad-ticket' };
    }
    const entry = tickets.get(ticket);
    if (!entry) return { ok: false, reason: 'bad-ticket' };
    if (entry.used) return { ok: false, reason: 'replayed-ticket' };
    if (now() - entry.issuedAt > TICKET_TTL_MS) return { ok: false, reason: 'expired-ticket' };
    return { ok: true };
  };

  /**
   * Look at a ticket and SPEND it (one ticket, one request).
   *
   * @param {string} ticket
   * @returns {{ ok: boolean, reason?: string }}
   */
  const consume = (ticket) => {
    const verdict = check(ticket);
    if (verdict.ok !== true) return verdict;
    const entry = tickets.get(ticket);
    if (entry) entry.used = true;
    return { ok: true };
  };

  return { issue, check, consume, size: () => tickets.size };
}
