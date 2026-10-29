/**
 * THE FOUR STAGES OF A RESTART — and what the user is told during each one.
 *
 * WHY THIS FILE EXISTS (user report, 2026-10-29):
 *
 *   "I clicked 'restart in 0 seconds' and then nothing moved for ten-odd
 *   seconds. It was backing up 156 MB the whole time. I thought the button was
 *   dead, or that '0 seconds' was a lie, or that there was a bug."
 *
 * The restart really has four stages, and each one has to be VISIBLE at once,
 * because "the screen does nothing" is indistinguishable from "it is broken":
 *
 *   waiting      the gate is still waiting for the conversations to become idle
 *   snapshotting the pre-restart snapshot is being written (this is the long one)
 *   restarting   the host is about to exit; from here nothing can be cancelled
 *   back         the new host is up and the sessions continue
 *
 * TWO RULES that make the difference between "a progress report" and "a fake
 * progress bar":
 *
 *   1. Every number here comes from the real copy loop (`lib/backup.js`): the
 *      bytes that were actually written and the bytes there are to write. When
 *      there is no measurement yet, the text says nothing about progress
 *      instead of inventing it.
 *   2. A slow copy is SAID OUT LOUD (`slow: 'total'` after five minutes,
 *      `slow: 'stalled'` when the byte counter has not moved for a minute) —
 *      that is the opposite of pretending: the user learns that the disk is
 *      busy and that it is still working.
 *
 * Everything in this file is pure: it takes numbers and returns an object. The
 * host, the state route, the health route and the client all read the same
 * shape, so no two surfaces can disagree about what stage the restart is in.
 *
 * ESM only, Node builtins only (nothing here imports anything).
 */

/** The stages, in the order they happen. */
export const RESTART_PHASES = Object.freeze(['waiting', 'snapshotting', 'restarting', 'back']);

/** After this long the snapshot phase is reported as slow (5 minutes). */
export const SLOW_TOTAL_MS = 300000;

/** After this long without a byte of progress the snapshot is reported as stalled. */
export const SLOW_STALL_MS = 60000;

/** @param {unknown} value */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value */
function nonNegative(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.max(0, number);
}

/**
 * Is this one of the four stages?
 *
 * @param {unknown} phase
 * @returns {boolean}
 */
export function isRestartPhase(phase) {
  return typeof phase === 'string' && RESTART_PHASES.includes(phase);
}

/**
 * The stage that is shown, when the browser cannot show a progress line.
 *
 * @param {string} phase
 * @returns {boolean} whether the restart may still be called off
 */
export function isCancellable(phase) {
  // Once the host is shutting down, a cancel would be a lie: the snapshot is
  // already the rollback point and the process is on its way out.
  return phase === 'waiting' || phase === 'snapshotting';
}

/**
 * Why a cancel is refused at this stage (null when it is allowed).
 *
 * @param {string} phase
 * @returns {string|null}
 */
export function cancelRefusalReason(phase) {
  if (isCancellable(phase)) return null;
  if (phase === 'restarting') return 'the host is already restarting';
  if (phase === 'back') return 'the restart is already finished';
  return 'there is no restart to cancel';
}

/**
 * "1.2 MB" / "156 MB" — the size the user actually sees.
 *
 * Rounded on purpose: `153.7 MB` is noise, `154 MB` is a fact. Below one
 * megabyte the kilobyte value is used, so a small profile still shows motion.
 *
 * @param {number|null} bytes
 * @returns {string|null}
 */
export function formatBytes(bytes) {
  const value = nonNegative(bytes);
  if (value === null) return null;
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return Math.round(value / 1024) + ' KB';
  return Math.round((value / (1024 * 1024)) * 10) / 10 + ' MB';
}

/**
 * How long the rest of the copy will take, from the speed so far.
 *
 * It is only offered when there is something to base it on (real bytes, at
 * least a second of real copying and a total to compare with). The result is
 * capped at "a long time", so a copy that slowed to a crawl does not promise
 * "4 seconds left" for ten minutes.
 *
 * @param {{ bytes?: number|null, total?: number|null, elapsedMs?: number|null }} [progress]
 * @returns {number|null} seconds, or null when it cannot be estimated
 */
export function estimateRemainingSeconds({ bytes = null, total = null, elapsedMs = null } = {}) {
  const done = nonNegative(bytes);
  const all = nonNegative(total);
  const elapsed = nonNegative(elapsedMs);
  if (done === null || all === null || elapsed === null) return null;
  if (done <= 0 || all <= 0 || elapsed < 1000) return null;
  if (done >= all) return 0;
  const perByte = elapsed / done;
  const seconds = Math.ceil((all - done) * perByte / 1000);
  if (!Number.isFinite(seconds)) return null;
  return Math.min(Math.max(0, seconds), 3600);
}

/**
 * The stage, as the interface shows it.
 *
 * @param {{
 *   phase?: string,
 *   startedAt?: number|null,
 *   at?: number|null,
 *   progress?: { files?: number|null, bytes?: number|null, total?: number|null, filesTotal?: number|null, at?: number|null }|null,
 *   blocking?: number|null,
 *   now?: number,
 * }} [options]
 * @returns {{
 *   phase: string,
 *   startedAt: number|null,
 *   at: number|null,
 *   elapsedMs: number|null,
 *   progress: { files: number|null, total: number|null, filesTotal: number|null, bytes: number|null, percent: number|null, ageMs: number|null, at: number|null }|null,
 *   slow: 'total'|'stalled'|null,
 *   cancellable: boolean,
 *   cancelReason: string|null,
 *   estimateSeconds: number|null,
 *   blocking: number|null,
 *   text: { zh: string, en: string },
 * }}
 */
export function describeRestartPhase({
  phase = 'idle',
  startedAt = null,
  at = null,
  progress = null,
  blocking = null,
  snapshotBytes = null,
  reason = null,
  now = Date.now(),
} = {}) {
  const stage = isRestartPhase(phase) ? phase : 'idle';
  const started = finiteNumber(startedAt);
  const moment = finiteNumber(at);
  const clock = finiteNumber(now) ?? Date.now();
  const elapsedMs = started === null ? null : Math.max(0, clock - started);

  let measured = null;
  if (progress && typeof progress === 'object') {
    const bytes = nonNegative(progress.bytes);
    const total = nonNegative(progress.total);
    const files = nonNegative(progress.files);
    const filesTotal = nonNegative(progress.filesTotal);
    const measuredAt = finiteNumber(progress.at);
    const percent = bytes !== null && total !== null && total > 0
      ? Math.min(100, Math.round((bytes / total) * 100))
      : null;
    measured = {
      files,
      total,
      filesTotal,
      bytes,
      percent,
      // The age of the measurement: a counter that stopped moving is what
      // "stalled" means, and it is measured from the last update, not invented.
      ageMs: measuredAt === null ? null : Math.max(0, clock - measuredAt),
      at: measuredAt,
    };
  }

  let slow = null;
  if (stage === 'snapshotting') {
    if (elapsedMs !== null && elapsedMs >= SLOW_TOTAL_MS) slow = 'total';
    else if (measured !== null && measured.ageMs !== null && measured.ageMs >= SLOW_STALL_MS) slow = 'stalled';
  }

  const seconds = estimateRemainingSeconds({
    bytes: measured === null ? null : measured.bytes,
    total: measured === null ? null : measured.total,
    elapsedMs,
  });

  const estimateSeconds = stage === 'snapshotting' ? seconds : null;
  const done = measured === null ? null : formatBytes(measured.bytes);
  // HOW MANY TASKS STILL HOLD THE GATE. The centred overlay says
  // "还有 N 个会话" as a number of its own, so the count travels as a NUMBER
  // and not only inside the sentence: a surface that has room for two words
  // must not have to parse the long text.
  //
  // NULL means "the caller did not say", which is not the same as zero:
  // Number(null) is 0, and a stage that was never given a count must not
  // pretend the gate is free.
  const blockingCount = blocking === null || blocking === undefined || blocking === ''
    ? null
    : nonNegative(blocking);

  let text;
  if (stage === 'waiting') {
    const count = blockingCount;
    const suffixZh = count && count > 0 ? '（还有 ' + count + ' 个会话在忙）' : '';
    const suffixEn = count && count > 0 ? ' (' + count + (count === 1 ? ' conversation' : ' conversations') + ' busy)' : '';
    text = {
      zh: '正在等待所有会话空闲…' + suffixZh,
      en: 'Waiting for every conversation to be idle…' + suffixEn,
    };
  } else if (stage === 'snapshotting') {
    // ONE VOICE (user report, 2026-10-29): "正在备份" did not say WHAT was being
    // backed up — the card says "DSH 重启前备份中", and this sentence (the
    // settings page and the tooltip) says the same words, so no surface can
    // disagree about what is running.
    //
    // The numbers appear ONLY when they were measured: "预计 X 秒" needs a real
    // speed behind it, and "已完成 Y MB" a real byte count. With nothing
    // measured yet the sentence claims nothing at all.
    const measuredZh = [];
    const measuredEn = [];
    if (estimateSeconds !== null) {
      measuredZh.push('预计 ' + estimateSeconds + ' 秒');
      measuredEn.push('about ' + estimateSeconds + 's');
    }
    if (done !== null) {
      measuredZh.push('已完成 ' + done);
      measuredEn.push(done + ' done');
    }
    const detailZh = measuredZh.length === 0 ? '' : '（' + measuredZh.join('，') + '）';
    const detailEn = measuredEn.length === 0 ? '' : ' (' + measuredEn.join(', ') + ')';
    text = {
      zh: 'DSH 重启前备份中' + detailZh + '…',
      en: 'Backing up before DSH restart' + detailEn + '…',
    };
    if (slow !== null) {
      // Still the same subject when it is slow: the user must know WHICH backup
      // is slow, not only that "the backup" is.
      text = {
        zh: 'DSH 重启前备份比预期慢（可能磁盘很忙），还在继续…' + (done === null ? '' : '（已完成 ' + done + '）'),
        en: 'The DSH pre-restart backup is slower than expected (the disk may be busy); it is still running…'
          + (done === null ? '' : ' (' + done + ' done)'),
      };
    }
  } else if (stage === 'restarting') {
    text = {
      zh: '正在重启，稍后自动继续…',
      en: 'Restarting; the work continues by itself in a moment…',
    };
  } else if (stage === 'back') {
    text = {
      zh: '已回来，接着干',
      en: 'Back — carrying on where we left off',
    };
  } else {
    text = { zh: '', en: '' };
  }

  return {
    phase: stage,
    startedAt: started,
    at: moment,
    elapsedMs,
    progress: measured,
    slow,
    cancellable: isCancellable(stage),
    cancelReason: cancelRefusalReason(stage),
    estimateSeconds,
    // The number of tasks the gate still waits for, on its own: the centred
    // overlay prints it, and a surface with room for two words must not have
    // to parse the long sentence of `text`.
    blocking: blockingCount,
    // HOW BIG THE PRE-RESTART BACKUP IS (bytes). It is reported on EVERY stage
    // of the restart, not only while the copy runs, so a card that appears a
    // moment late can still say "backup done (92 KB)" instead of nothing.
    // null means "nothing was measured", which is NOT the same as zero bytes:
    // Number(null) is 0, and a receipt for a 0-byte backup would be a lie.
    snapshotBytes: snapshotBytes === null || snapshotBytes === undefined || snapshotBytes === ''
      ? null
      : nonNegative(snapshotBytes),
    // WHY the stage is what it is: "deferred: conversation-active" says the
    // restart went back to waiting, which is what a reader needs to tell a
    // postponed restart from a running one.
    reason: typeof reason === 'string' && reason !== '' ? reason : null,
    text,
  };
}
