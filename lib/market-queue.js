/**
 * dsh-autorestart — "is the plugin market holding an update in its queue?".
 *
 * THE PROBLEM: the market refuses to install while an agent is running and puts
 * the operation into a queue that lives in the BROWSER. Until the session goes
 * idle the browser keeps that request, and the market's own server-side status
 * route (`GET /dsh-market/status`, see lib/market-probe.js) reports `busy:false`
 * — the SERVER is idle, the QUEUE is not. Restarting the host in that window
 * drops the queued operation on the floor.
 *
 * THE ONLY WITNESS: the market's own persistent NDJSON log
 * (`<profileDir>/.dsh-market/log.ndjson`), one JSON object per line:
 *
 *   {"at":"2026-11-25T01:00:35.032Z","level":"warn","event":"update-blocked",
 *    "detail":"dsh-mnemon: refused while agents are running — session-534dee38"}
 *
 * The log records the refusal (`update-blocked`, `install-blocked`,
 * `uninstall-blocked`) and later the moment the queue actually runs
 * (`update-start`, `update`, `install`, `hot-mount`, ...). So a package whose
 * LAST known event is a refusal is still waiting, and a package whose last
 * known event is a settlement has left the queue. Events the market writes for
 * other reasons (`region`, `toggle`, `update-repair`, ...) change nothing.
 *
 * FAIL OPEN: every failure mode here means "we cannot see", and a probe that
 * cannot see must NEVER hold a restart hostage — the same rule lib/market-probe.js
 * follows. A missing log, an unreadable log, a line we cannot parse: all of
 * them answer "nothing is queued", and the restart proceeds exactly as it did
 * before this module existed.
 *
 * THE PATH IS NOT DEFAULTED: the caller passes the file in, so this module
 * never mentions a machine-specific profile directory.
 *
 * ESM only, Node builtins only.
 */

import fs from 'node:fs'

/**
 * Where the market keeps its own log, RELATIVE to the profile directory.
 *
 * The caller joins this onto the profile directory it already knows; this
 * module deliberately has no default path of its own.
 */
export const MARKET_LOG_RELATIVE_PATH = '.dsh-market/log.ndjson'

/**
 * How many bytes of the log's tail are read (64 KiB).
 *
 * WHY A TAIL AND NOT THE WHOLE FILE: the log grows for the lifetime of the
 * profile, and only the last few events decide whether something is queued.
 * A bounded tail keeps the read cheap no matter how old the profile is.
 */
export const MARKET_LOG_TAIL_BYTES = 65536

/**
 * How long a refusal may keep the restart waiting before it counts as stale
 * (30 minutes).
 *
 * WHY IT IS BOUNDED: a queue entry that never settles would otherwise block
 * every restart for ever. Half an hour of waiting is already longer than any
 * real install takes, so past that bound the entry is treated as abandoned.
 */
export const MARKET_QUEUE_STALE_MS = 1800000

/**
 * Events that mean "this operation is WAITING for the session to go idle".
 *
 * `update-blocked` is the one the market writes when an agent is running; the
 * other two are the same refusal for install and uninstall.
 */
export const QUEUED_EVENTS = Object.freeze([
  'update-blocked',
  'install-blocked',
  'uninstall-blocked',
])

/**
 * Events that mean "this operation RAN (or gave up)".
 *
 * `update-start` is when the queue actually starts running the operation;
 * `update` / `install` / `uninstall` are the completions; `hot-mount` and
 * `restore` are the plugin-manager steps that follow a successful install.
 */
export const SETTLED_EVENTS = Object.freeze([
  'update-start',
  'update',
  'install',
  'hot-mount',
  'update-refused',
  'uninstall',
  'restore',
])

const QUEUED_EVENT_SET = new Set(QUEUED_EVENTS)
const SETTLED_EVENT_SET = new Set(SETTLED_EVENTS)

/**
 * A package-shaped token at the START of a detail: `dsh-mnemon`,
 * `@scope/dsh-thing`, `dsh-mnemon` inside `dsh-mnemon@1.2.3`.
 *
 * The token deliberately stops at `@` and at `#`, so the version and the commit
 * are not part of the name.
 */
const PACKAGE_TOKEN = /^(@?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?)/

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** A trimmed string field, or ''. */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The epoch milliseconds of a log record's `at` field, or null.
 *
 * The market writes an ISO timestamp; a record without a readable one is still
 * a valid record, it just cannot be aged.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function epochMsOf(value) {
  if (isFiniteNumber(value)) return value
  const text = textOf(value)
  if (text === '') return null
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Drop a trailing `@<version>` from a package name.
 *
 * WHY: the market names the same plugin in two ways — `dsh-mnemon` in a
 * refusal and `dsh-mnemon@0.5.54` in a completion. Without this the two would
 * be two different packages and a settled plugin would look queued for ever.
 * A leading `@scope` is left alone (the `@` of a scope is at index 0).
 *
 * @param {string} name
 * @returns {string}
 */
function stripVersion(name) {
  const at = name.lastIndexOf('@')
  return at > 0 ? name.slice(0, at) : name
}

/**
 * The package a log line is about.
 *
 * TWO SHAPES, ONE PACKAGE — this is the whole trick of the module:
 *
 *   "dsh-mnemon: refused while agents are running — session-x"   (a refusal)
 *   "dsh-mnemon -> dsh-mnemon@0.5.54 exit=0"                    (a completion)
 *
 * The refusal carries the name before a `": "`, the completion does not have
 * one at all. Falling back to "the whole detail" would give the two shapes
 * DIFFERENT names — the same plugin would then never leave the queue, and a
 * finished update would block every restart. So the fallback takes the first
 * package-shaped TOKEN instead, which makes both shapes resolve to one name.
 *
 * @param {unknown} detail
 * @returns {string} the package name, or '' when the detail has none
 */
function packageNameOf(detail) {
  const text = textOf(detail)
  if (text === '') return ''
  // "<name>: <reason>" — the market's shape for a refusal and for a note.
  const colon = text.indexOf(': ')
  if (colon > 0) {
    const head = text.slice(0, colon).trim()
    // A package name is ONE token. "removed 4 dirs from x: y" is a sentence
    // that happens to contain a colon, not a package, so the prefix is only
    // accepted when it carries no whitespace.
    if (head !== '' && !/\s/.test(head)) return stripVersion(head)
  }
  // "<name> -> <name@version> (profile x)" / "<name>@<version> exit=0"
  const token = text.match(PACKAGE_TOKEN)
  if (token) {
    let name = token[0]
    // "github:owner/repo#sha" — the scheme word is not the package, the source
    // behind it is. Only a source-looking tail is treated that way, so a
    // package that merely ends in a colon keeps its own name.
    if (text[name.length] === ':') {
      const rest = text.slice(name.length + 1)
      if (/[\/@]/.test(rest)) {
        const source = rest.match(PACKAGE_TOKEN)
        if (source) name = source[0]
      }
    }
    return stripVersion(name.replace(/#.*$/, ''))
  }
  // Nothing package-shaped at all: keep a bounded slice so the key is at least
  // stable from one line to the next.
  return text.slice(0, 60)
}

/**
 * Read the market's log and decide which packages are still waiting.
 *
 * Pure: it only reads the text it is given, so a caller can run it on every
 * tick without any side effect.
 *
 * WHAT `lines` AND `malformed` COUNT: `lines` is every non-empty line the
 * parser looked at, `malformed` is the subset it could not read as a JSON
 * object. A BLANK line is not malformed: an NDJSON file ends with a newline,
 * so the last element of a split is always empty.
 *
 * @param {string} text the tail of the market's log
 * @returns {{ lines: number, malformed: number, queued: Array<{ name: string, at: number|null, event: string }>, newestQueuedAt: number|null }}
 */
export function parseMarketLogTail(text) {
  const source = typeof text === 'string' ? text : ''
  let lines = 0
  let malformed = 0
  // One entry per package: the LAST event the market wrote about it.
  const state = new Map()

  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    lines += 1
    let record = null
    try {
      record = JSON.parse(line)
    } catch {
      record = null
    }
    if (!isObject(record)) {
      malformed += 1
      continue
    }
    const event = textOf(record.event)
    const queuedEvent = QUEUED_EVENT_SET.has(event)
    const settledEvent = SETTLED_EVENT_SET.has(event)
    // An event the market writes for another reason says nothing about the
    // queue, so it must NOT change the state of its package.
    if (!queuedEvent && !settledEvent) continue
    const name = packageNameOf(record.detail)
    if (name === '') continue
    state.set(name, { name, at: epochMsOf(record.at), event, queued: queuedEvent })
  }

  const queued = []
  let newestQueuedAt = null
  // The packages appear in the order the log mentions them.
  for (const entry of state.values()) {
    if (entry.queued !== true) continue
    queued.push({ name: entry.name, at: entry.at, event: entry.event })
    if (entry.at !== null && (newestQueuedAt === null || entry.at > newestQueuedAt)) {
      newestQueuedAt = entry.at
    }
  }

  return { lines, malformed, queued, newestQueuedAt }
}

/**
 * Turn the queue into a decision.
 *
 * Pure: it only reads the queue and the clock.
 *
 *   - an empty queue is `idle` — nothing is waiting;
 *   - a queue entry older than `staleAfterMs` (or one we cannot age) is
 *     `stale` — it is not going to block anything for ever;
 *   - anything else is `queued` and DOES block, with the package that has been
 *     waiting the longest as the name.
 *
 * @param {Array<{ name?: string, at?: number|string|null, event?: string }>} queued
 * @param {{ now?: number, staleAfterMs?: number }} [options]
 * @returns {{ blocking: boolean, reason: 'idle'|'stale'|'queued', packageName: string|null, waitedMs: number }}
 */
export function marketQueueDecision(queued, { now = Date.now(), staleAfterMs = MARKET_QUEUE_STALE_MS } = {}) {
  const entries = Array.isArray(queued) ? queued.filter(isObject) : []
  if (entries.length === 0) {
    return { blocking: false, reason: 'idle', packageName: null, waitedMs: 0 }
  }
  const at = isFiniteNumber(now) ? now : Date.now()
  const staleAfter = isFiniteNumber(staleAfterMs) && staleAfterMs >= 0 ? staleAfterMs : MARKET_QUEUE_STALE_MS

  // The newest entry is the one that decides: it is the queue's head.
  let newest = null
  let newestAt = null
  for (const entry of entries) {
    const stamp = epochMsOf(entry.at)
    if (newest === null || (stamp !== null && (newestAt === null || stamp > newestAt))) {
      newest = entry
      newestAt = stamp
    }
  }
  const packageName = textOf(newest === null ? '' : newest.name) || null
  if (newestAt === null) {
    // A queue entry we cannot age is not a reason to hold the host hostage.
    return { blocking: false, reason: 'stale', packageName, waitedMs: 0 }
  }
  const waitedMs = Math.max(0, at - newestAt)
  if (waitedMs > staleAfter) {
    return { blocking: false, reason: 'stale', packageName, waitedMs }
  }
  return { blocking: true, reason: 'queued', packageName, waitedMs }
}

/**
 * Read the TAIL of the market's log.
 *
 * NEVER THROWS: a missing file, a directory, a permission error — all of them
 * answer with an empty string, which the parser reads as "nothing is queued".
 * A reader that cannot see must never hold a restart hostage.
 *
 * WHY THE FIRST LINE IS DROPPED ONLY WHEN THE FILE WAS TRUNCATED: a tail read
 * starts in the middle of a line, so that first line is a fragment and not a
 * record — it is dropped, and the text starts after the first newline. When the
 * whole file fits into the window no line is incomplete, so nothing is dropped.
 *
 * @param {string} file the log file the caller resolved
 * @param {{ maxBytes?: number }} [options]
 * @returns {string}
 */
export function readMarketLogTail(file, { maxBytes = MARKET_LOG_TAIL_BYTES } = {}) {
  const target = textOf(file)
  if (target === '') return ''
  const limit = isFiniteNumber(maxBytes) && maxBytes > 0 ? Math.trunc(maxBytes) : MARKET_LOG_TAIL_BYTES
  let fd = null
  try {
    fd = fs.openSync(target, 'r')
    const size = fs.fstatSync(fd).size
    if (size <= 0) return ''
    const start = Math.max(0, size - limit)
    const length = size - start
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const chunk = fs.readSync(fd, buffer, read, length - read, start + read)
      if (chunk <= 0) break
      read += chunk
    }
    let text = buffer.subarray(0, read).toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      text = newline === -1 ? '' : text.slice(newline + 1)
    }
    return text
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // A handle that cannot be closed is not worth failing the read over.
      }
    }
  }
}
