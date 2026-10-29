/**
 * dsh-autorestart — THE DIAGNOSTICS BEHIND "REPORT A PROBLEM".
 *
 * When something goes wrong, the user should be able to hand us the facts in
 * one click — without writing anything down by hand and without leaking
 * anything private.
 *
 * There is exactly ONE generator (`buildDiagnostics`): the host builds the
 * text, the browser copies it. Two generators would drift, and a drifted
 * diagnostic is worse than none.
 *
 * WHAT IS IN IT: the plugin version, the platform, whether this is the
 * desktop client, how the host was started (the mode AND the evidence the
 * verdict rests on), who supervises it, the restart mode, and the verdict of
 * the last restart (with the checks that failed).
 *
 * WHAT IS NEVER IN IT: the access token, a URL that carries a token, or any
 * secret. The generator only copies the fields it knows, so a token cannot
 * leak through a field nobody thought about — and everything that IS copied
 * goes through the redaction again.
 *
 * ESM only, Node builtins only.
 */

/** The mailbox that works when GitHub does not. */
export const SUPPORT_EMAIL = '252170229@qq.com'

/** Where the "new issue" page lives. */
export const ISSUE_URL_BASE = 'https://github.com/Eason-22/dsh-autorestart/issues/new'

/** The body of a pre-filled issue must stay short: URLs have a length limit. */
export const DIAGNOSTIC_BODY_LIMIT = 800

/**
 * The patterns that must never survive into a diagnostic.
 *
 * They cover the access token of the instance, the query parameters that
 * carry it, and the usual "key: value" secrets.
 */
const SECRET_PATTERNS = Object.freeze([
  /([?&](?:token|access[_-]?token|api[_-]?key|apikey|secret|password|auth|authorization)=)[^&\s"'<>]+/gi,
  /("|')?(?:token|access[_-]?token|api[_-]?key|apikey|secret|password|authorization)("|')?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
])

/**
 * Remove anything that looks like a secret from a piece of text.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function redactSecrets(value) {
  let text = typeof value === 'string' ? value : String(value ?? '')
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '[redacted]')
  }
  return text
}

/**
 * Shorten a path: the last four segments are kept (the user name may stay),
 * everything before them is cut.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function truncatePath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  const parts = text.split(/[\\/]+/).filter((part) => part !== '')
  if (parts.length <= 4) return text
  return '…/' + parts.slice(-4).join('/')
}

/**
 * Cut a text to a length limit (the issue body has to stay short).
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function truncateBody(text, limit = DIAGNOSTIC_BODY_LIMIT) {
  const source = typeof text === 'string' ? text : ''
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.trunc(Number(limit)) : DIAGNOSTIC_BODY_LIMIT
  if (source.length <= max) return source
  return source.slice(0, Math.max(0, max - 1)) + '…'
}

/**
 * The pre-filled "new issue" URL.
 *
 * @param {string} base
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
export function buildIssueUrl(base, title, body) {
  const root = typeof base === 'string' && base.trim() !== '' ? base.trim() : ISSUE_URL_BASE
  const safeTitle = truncateBody(redactSecrets(title), 200)
  const safeBody = truncateBody(redactSecrets(body), DIAGNOSTIC_BODY_LIMIT)
  return root + '?title=' + encodeURIComponent(safeTitle) + '&body=' + encodeURIComponent(safeBody)
}

/**
 * The `mailto:` link (the fallback when there is no GitHub account).
 *
 * @param {string} email
 * @param {string} subject
 * @param {string} body
 * @returns {string}
 */
export function buildMailtoUrl(email, subject, body) {
  const to = typeof email === 'string' && email.trim() !== '' ? email.trim() : SUPPORT_EMAIL
  const safeSubject = truncateBody(redactSecrets(subject), 200)
  const safeBody = truncateBody(redactSecrets(body), DIAGNOSTIC_BODY_LIMIT)
  return 'mailto:' + to + '?subject=' + encodeURIComponent(safeSubject) + '&body=' + encodeURIComponent(safeBody)
}

/**
 * Read one field out of a payload, without ever throwing.
 *
 * @param {any} source
 * @param {string} key
 * @param {any} [fallback]
 * @returns {any}
 */
function field(source, key, fallback = '') {
  if (!source || typeof source !== 'object') return fallback
  const value = source[key]
  return value === undefined || value === null ? fallback : value
}

/**
 * The diagnostic text of this host.
 *
 * It is a PURE function of the payload: the same facts always produce the
 * same text, and nothing outside the fields listed below can ever end up in
 * it.
 *
 * @param {{
 *   version?: string,
 *   platform?: string,
 *   hostKind?: string,
 *   isDesktopApp?: boolean,
 *   startup?: { mode?: string, kind?: string, evidence?: string },
 *   supervisor?: { mode?: string, kind?: string },
 *   restartMode?: string,
 *   lastRestart?: { result?: string, failedChecks?: string[] },
 *   stateDir?: string,
 * }} [payload]
 * @returns {string}
 */
export function buildDiagnostics(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {}
  const startup = field(source, 'startup', {})
  const supervisor = field(source, 'supervisor', {})
  const lastRestart = field(source, 'lastRestart', {})
  const failedChecks = Array.isArray(field(lastRestart, 'failedChecks', []))
    ? field(lastRestart, 'failedChecks', []).map((check) => redactSecrets(String(check)))
    : []

  const lines = [
    '--- dsh-autorestart diagnostics ---',
    'plugin version: ' + redactSecrets(field(source, 'version', 'unknown')),
    'platform: ' + redactSecrets(field(source, 'platform', 'unknown')),
    'host kind: ' + redactSecrets(field(source, 'hostKind', 'unknown')),
    'desktop client: ' + (field(source, 'isDesktopApp', false) === true ? 'yes' : 'no'),
    'startup mode: ' + redactSecrets(field(startup, 'mode', 'unknown')),
    'startup evidence: ' + redactSecrets(field(startup, 'evidence', 'unknown')),
    'supervisor mode: ' + redactSecrets(field(supervisor, 'mode', 'unknown')),
    'supervisor kind: ' + redactSecrets(field(supervisor, 'kind', 'unknown')),
    'restart mode: ' + redactSecrets(field(source, 'restartMode', 'unknown')),
    'last restart result: ' + redactSecrets(field(lastRestart, 'result', 'unknown')),
    'last restart failed checks: ' + (failedChecks.length > 0 ? failedChecks.join(', ') : 'none'),
  ]
  // THE WATCHDOG: which tier this machine uses, and what the last run did.
  const watchdog = field(source, 'watchdog', {})
  const watchdogReport = field(watchdog, 'report', {})
  lines.push('watchdog tier: ' + redactSecrets(field(watchdog, 'tier', 'unknown')))
  lines.push('watchdog reason: ' + redactSecrets(field(watchdog, 'tierReason', 'unknown')))
  lines.push('watchdog available: ' + (field(watchdog, 'available', false) === true ? 'yes' : 'no'))
  lines.push('watchdog last result: ' + redactSecrets(field(watchdogReport, 'result', 'never ran')))
  lines.push('watchdog last tier: ' + redactSecrets(field(watchdogReport, 'tier', 'unknown')))
  // THE DISARM: did the host stand the watchdog down? A failed disarm leaves an
  // armed one behind (the 0.8.1 incident), so its outcome and the first error
  // belong in the text the user can hand to us.
  const disarm = field(source, 'watchdogDisarm', null)
  if (disarm && typeof disarm === 'object') {
    lines.push('watchdog disarm: ' + (field(disarm, 'ok', false) === true ? 'ok' : 'FAILED'))
    lines.push('watchdog disarm source: ' + redactSecrets(field(disarm, 'source', 'unknown')))
    lines.push('watchdog disarm attempts: ' + redactSecrets(String(field(disarm, 'attempts', 0))))
    lines.push('watchdog disarm pending left: ' + (field(disarm, 'pending', false) === true ? 'yes' : 'no'))
    const disarmError = field(disarm, 'error', null)
    if (disarmError && typeof disarmError === 'object') {
      lines.push('watchdog disarm error: '
        + redactSecrets(field(disarmError, 'name', 'error'))
        + ': ' + redactSecrets(field(disarmError, 'message', '')))
    }
  } else {
    lines.push('watchdog disarm: never ran')
  }
  const stateDir = truncatePath(field(source, 'stateDir', ''))
  if (stateDir !== '') lines.push('dsh home: ' + redactSecrets(stateDir))
  lines.push('--- end ---')
  return lines.join('\n')
}
