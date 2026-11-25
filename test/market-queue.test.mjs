/**
 * Regression tests for lib/market-queue.js.
 *
 * WHAT IS BEING PROTECTED: the market's queue lives in the browser, so the
 * server-side `busy` flag is false while an update waits. The market's own
 * NDJSON log is the only witness. The dangerous mistake is reading a FINISHED
 * update as a queued one — that would block every restart of the host for ever.
 * So the tests below pin down exactly when a package leaves the queue.
 *
 * The log lines used here are the real shapes the market writes (2026-11-25):
 *
 *   update-blocked  "dsh-mnemon: refused while agents are running — session-x"
 *   update-start    "dsh-mnemon -> dsh-mnemon@0.5.54 (profile desktop)"
 *   update          "dsh-mnemon -> dsh-mnemon@0.5.54 exit=0"
 *
 * ESM, node:test, no third-party dependencies.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MARKET_LOG_RELATIVE_PATH,
  MARKET_LOG_TAIL_BYTES,
  MARKET_QUEUE_STALE_MS,
  QUEUED_EVENTS,
  SETTLED_EVENTS,
  marketQueueDecision,
  parseMarketLogTail,
  readMarketLogTail,
} from '../lib/market-queue.js'

/** One log record, in the shape the market writes it. */
const record = (event, detail, at = '2026-11-25T01:00:35.032Z') =>
  JSON.stringify({ at, level: 'info', event, detail })

const BLOCKED = 'dsh-mnemon: refused while agents are running — session-534dee38-6259-4f81-8ff7-484c50c120fd'
const STARTED = 'dsh-mnemon -> dsh-mnemon@0.5.54 (profile desktop)'
const FINISHED = 'dsh-mnemon -> dsh-mnemon@0.5.54 exit=0'

test('the exported constants are the ones the queue reader promises', () => {
  assert.equal(MARKET_LOG_RELATIVE_PATH, '.dsh-market/log.ndjson')
  assert.equal(MARKET_LOG_TAIL_BYTES, 65536)
  assert.equal(MARKET_QUEUE_STALE_MS, 1800000)
  assert.deepEqual([...QUEUED_EVENTS], ['update-blocked', 'install-blocked', 'uninstall-blocked'])
  assert.deepEqual(
    [...SETTLED_EVENTS],
    ['update-start', 'update', 'install', 'hot-mount', 'update-refused', 'uninstall', 'restore'],
  )
})

test('a single update-blocked means the market is holding that package in its queue', () => {
  const parsed = parseMarketLogTail(record('update-blocked', BLOCKED) + '\n')
  assert.equal(parsed.queued.length, 1)
  assert.equal(parsed.queued[0].name, 'dsh-mnemon')
  assert.equal(parsed.queued[0].event, 'update-blocked')
  assert.equal(parsed.queued[0].at, Date.parse('2026-11-25T01:00:35.032Z'))
  assert.equal(parsed.newestQueuedAt, parsed.queued[0].at)

  const decision = marketQueueDecision(parsed.queued, { now: parsed.queued[0].at + 1000 })
  assert.equal(decision.blocking, true)
  assert.equal(decision.reason, 'queued')
  assert.equal(decision.packageName, 'dsh-mnemon')
  assert.equal(decision.waitedMs, 1000)
})

test('the queue runs: an update-start after the refusal empties the queue', () => {
  const text = [record('update-blocked', BLOCKED), record('update-start', STARTED)].join('\n')
  const parsed = parseMarketLogTail(text)
  assert.deepEqual(parsed.queued, [])
  assert.equal(parsed.newestQueuedAt, null)

  const decision = marketQueueDecision(parsed.queued, { now: Date.parse('2026-11-25T05:08:03.000Z') })
  assert.equal(decision.blocking, false)
  assert.equal(decision.reason, 'idle')
  assert.equal(decision.packageName, null)
  assert.equal(decision.waitedMs, 0)
})

test('the queue finished: an update after the refusal empties the queue', () => {
  const text = [record('update-blocked', BLOCKED), record('update', FINISHED)].join('\n')
  const parsed = parseMarketLogTail(text)
  assert.deepEqual(parsed.queued, [])

  const decision = marketQueueDecision(parsed.queued, { now: Date.parse('2026-11-25T05:08:17.000Z') })
  assert.equal(decision.blocking, false)
  assert.equal(decision.reason, 'idle')
})

test('one package finishing does not release the package that is still waiting', () => {
  const text = [
    record('update-blocked', BLOCKED, '2026-11-25T01:00:35.032Z'),
    record('update-blocked', 'dsh-other: refused while agents are running — session-x', '2026-11-25T01:00:36.000Z'),
    record('update', 'dsh-other -> dsh-other@1.0.0 exit=0', '2026-11-25T01:00:40.000Z'),
  ].join('\n')
  const parsed = parseMarketLogTail(text)
  assert.equal(parsed.queued.length, 1)
  assert.equal(parsed.queued[0].name, 'dsh-mnemon')

  // One minute after the refusal — still inside the stale bound, so it blocks.
  const decision = marketQueueDecision(parsed.queued, { now: Date.parse('2026-11-25T01:00:41.000Z') })
  assert.equal(decision.blocking, true)
  assert.equal(decision.reason, 'queued')
  assert.equal(decision.packageName, 'dsh-mnemon')
})

test('a broken line is skipped, counted, and never thrown', () => {
  const text = [
    record('update-blocked', BLOCKED),
    '{oops',
    '',
    '   ',
    record('update-start', STARTED),
  ].join('\n')
  const parsed = parseMarketLogTail(text)
  // Three non-empty lines were looked at; one of them could not be parsed.
  assert.equal(parsed.lines, 3)
  assert.equal(parsed.malformed, 1)
  // The broken line did not stop the parser: the package still left the queue.
  assert.deepEqual(parsed.queued, [])
})

test('a queue entry that is older than the stale bound stops blocking', () => {
  const parsed = parseMarketLogTail(record('update-blocked', BLOCKED) + '\n')
  const at = Date.parse('2026-11-25T01:00:35.032Z')
  const decision = marketQueueDecision(parsed.queued, { now: at + MARKET_QUEUE_STALE_MS + 1 })
  assert.equal(decision.blocking, false)
  assert.equal(decision.reason, 'stale')
  assert.equal(decision.waitedMs, MARKET_QUEUE_STALE_MS + 1)
})

test('a queue entry that is still fresh blocks', () => {
  const parsed = parseMarketLogTail(record('update-blocked', BLOCKED) + '\n')
  const at = Date.parse('2026-11-25T01:00:35.032Z')
  const decision = marketQueueDecision(parsed.queued, { now: at + 1000 })
  assert.equal(decision.blocking, true)
  assert.equal(decision.reason, 'queued')
  assert.equal(decision.packageName, 'dsh-mnemon')
  assert.equal(decision.waitedMs, 1000)
})

test('an empty log means nothing is queued', () => {
  const parsed = parseMarketLogTail('')
  assert.equal(parsed.lines, 0)
  assert.equal(parsed.malformed, 0)
  assert.deepEqual(parsed.queued, [])
  assert.equal(parsed.newestQueuedAt, null)

  const decision = marketQueueDecision(parsed.queued)
  assert.equal(decision.blocking, false)
  assert.equal(decision.reason, 'idle')
  assert.equal(decision.packageName, null)
  assert.equal(decision.waitedMs, 0)
})

test('a detail without a ": " still yields the package name', () => {
  // The completion shape has no colon at all: the name is the first token.
  const parsed = parseMarketLogTail(record('update-blocked', 'dsh-mnemon -> dsh-mnemon@0.5.54 (profile desktop)') + '\n')
  assert.equal(parsed.queued.length, 1)
  assert.equal(parsed.queued[0].name, 'dsh-mnemon')

  // And a detail that is not package-shaped at all must not throw.
  const odd = parseMarketLogTail(record('update-blocked', '!!! ???') + '\n')
  assert.equal(odd.queued.length, 1)
  assert.equal(typeof odd.queued[0].name, 'string')
})

test('a scoped package keeps its scope', () => {
  const parsed = parseMarketLogTail(
    record('update-blocked', '@michengai/dsh-archive-manager: refused while agents are running — session-x') + '\n',
  )
  assert.equal(parsed.queued[0].name, '@michengai/dsh-archive-manager')
})

test('an event the market writes for another reason does not change the queue', () => {
  const text = [
    record('update-blocked', BLOCKED),
    record('toggle', 'dsh-mnemon: on ok=true'),
    record('region', 'dsh-mnemon: resolved HEAD through an available china route'),
  ].join('\n')
  const parsed = parseMarketLogTail(text)
  assert.equal(parsed.queued.length, 1)
  assert.equal(parsed.queued[0].event, 'update-blocked')
})

test('readMarketLogTail answers an empty string for a file that is not there', () => {
  const missing = path.join(os.tmpdir(), 'dsh-market-queue-missing-' + process.pid + '.ndjson')
  assert.equal(readMarketLogTail(missing), '')
  assert.equal(readMarketLogTail(''), '')
})

test('readMarketLogTail reads the file, and a truncated tail drops its half-read first line', () => {
  const file = path.join(os.tmpdir(), 'dsh-market-queue-tail-' + process.pid + '.ndjson')
  fs.writeFileSync(file, 'A\nB\nC\n')
  try {
    // The whole file fits: no line is incomplete, so nothing is dropped.
    assert.equal(readMarketLogTail(file), 'A\nB\nC\n')
    // The window cuts into the file, so the chunk's first line cannot be
    // trusted (it may be a fragment): the tail starts after the first newline.
    assert.equal(readMarketLogTail(file, { maxBytes: 4 }), 'C\n')
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('the parser survives a log it has never seen: real shapes, no exceptions', () => {
  const text = [
    record('region', 'no region on record; network check chose china'),
    record('install', 'dsh-lazy-tools: the host\'s own replay activated it; adopted instead of mounting a second copy'),
    record('install', 'github:Chsw-CC/dsh-lazy-tools#9c2eb7a4597046d1e0374664d5059aa7acd870c8 exit=0 hot=true'),
    record('hot-mount', 'cc-safety-net: live'),
    record('update-blocked', 'cc-safety-net: refused while agents are running — session-x'),
  ].join('\n')
  const parsed = parseMarketLogTail(text)
  assert.equal(parsed.malformed, 0)
  assert.equal(parsed.queued.length, 1)
  assert.equal(parsed.queued[0].name, 'cc-safety-net')
})
