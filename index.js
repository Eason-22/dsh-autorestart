/**
 * dsh-autorestart —cross-restart continuation for DeepSeek Harness.
 *
 * The plugin keeps a small durable checkpoint under `<DSH_HOME>/storages/dsh-autorestart/`
 * describing which sessions were in flight. After a host restart it:
 *   1. resumes the interrupted session's agent through `ctx.sessionController.resolveAgent`,
 *   2. re-arms a durable goal when the session had one (the goal round driver then
 *      starts the next round automatically), or
 *   3. injects one clearly-marked continuation prompt so the agent picks the work back up.
 *
 * It also registers tools the agent can call to request an idle-aware graceful restart
 * (`continuum_restart`), inspect the lifecycle (`continuum_status`) and cancel a pending
 * restart (`continuum_cancel_restart`).
 *
 * Deliberately dependency-free: only Node builtins and relative modules, so a
 * profile-installed bundle resolves without any `@deepseek-ai/*` package links.
 *
 * @module dsh-autorestart
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  beginBoot,
  cancelRestart,
  disarmedRecord,
  entryFor,
  handoffRecord,
  markIdle,
  markPendingResume,
  markRunning,
  parkedRecord,
  pruneSessions,
  readState,
  recoverableSessions,
  requestRestart,
  setContextOverflow,
  setDisarmedGoal,
  setGoal,
  setHandoff,
  setRecoveryOutcome,
  setPhase,
  stampResumedGoal,
  writeState,
} from './lib/checkpoint.js'
import {
  bootPlan,
  composeHandoff,
  contextOverflow,
  continuationPrompt,
  describeState,
  GOAL_BLOCK_REASONS,
  HANDOFF_DEFAULT_MAX_CHARS,
  restartDecision,
  restartGate,
  selectGoalDisarms,
} from './lib/lifecycle.js'
import {
  backupsRoot,
  clearRollbackReport,
  createBackup,
  readRollbackReport,
  ROLLBACK_REPORT_NAME,
} from './lib/backup.js'
import {
  buildCustomCommand,
  buildWatchScript,
  DEFAULT_ROLLBACK_TIMEOUT_MS,
  detectEnvironment,
  runCommandNow,
  scheduleDetachedRestart,
} from './lib/restart.js'
import {
  createGestureTickets,
  describeTicketReason,
} from './lib/ticket.js'
import {
  createSleepController,
  COUNTDOWN_CHOICES,
  DEFAULT_COUNTDOWN_SECONDS,
  detectShutdownPlan,
  planInvocation,
  runShutdown,
  snapCountdownChoice,
} from './lib/sleep.js'

/**
 * `@deepseek-ai/schemastery` resolves inside modules that live in the dsh installation,
 * but NOT from this bundle: a profile-installed bundle is a symlink into the user's
 * workspace, so Node resolves bare specifiers against the workspace realpath and never
 * finds the Host's `node_modules`. Load it dynamically, with the running installation
 * as an explicit fallback, so `Config` is still a real schema (and the tests, which run
 * under a plain `node`, still import this module).
 */
let schemastery
let schemasterySource = 'unresolved'
try {
  schemastery = (await import('@deepseek-ai/schemastery')).default
  schemasterySource = 'bare-specifier'
} catch {
  schemastery = undefined
}
if (schemastery === undefined) {
  for (const candidate of schemasteryCandidates()) {
    try {
      const loaded = await import(candidate)
      schemastery = loaded.default ?? loaded
      schemasterySource = candidate
      break
    } catch {}
  }
}

/** Absolute file URLs where the running dsh installation keeps schemastery. */
function schemasteryCandidates() {
  const rel = ['dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs']
  const out = []
  const push = (root) => {
    if (typeof root !== 'string' || root.trim() === '') return
    const file = path.join(root, ...rel)
    try {
      out.push(new URL(`file:///${file.replace(/\\/g, '/')}`).href)
    } catch {}
  }
  try {
    if (process.resourcesPath) {
      push(path.join(process.resourcesPath, 'app.asar'))
      push(path.join(process.resourcesPath, 'app.asar.unpacked'))
    }
  } catch {}
  for (const arg of process.argv.slice(1)) {
    if (typeof arg !== 'string') continue
    const index = arg.indexOf('app.asar')
    if (index < 0) continue
    push(arg.slice(0, index + 'app.asar'.length))
  }
  return [...new Set(out)]
}

/** Loader row id for this plugin. */
export const name = 'dsh-autorestart'

/** How many recovery batches (maxSessions sessions each) one boot may run. */
const RECOVERY_MAX_BATCHES = 5

/** Default pause between two recovery batches (ms). */
const DEFAULT_RECOVERY_BATCH_DELAY_MS = 1200

/** How many extra `resolveAgent` attempts one boot makes per session. */
const RESOLVE_RETRY_ATTEMPTS = 2

/** Default pause between two `resolveAgent` attempts (ms). */
const DEFAULT_RESUME_RETRY_DELAY_MS = 1000

/**
 * How long a session-title lookup stays cached (ms).
 *
 * The client polls the health route every 2s; the session list is read at
 * most every 5s so a poll storm never turns into a session-list storm.
 */
const SESSION_TITLE_CACHE_MS = 5000

/** Sleep for `ms`; never rejects. */
function delay(ms) {
  const wait = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0
  if (wait === 0) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(resolve, wait)
  })
}

/**
 * Hard dependencies. `sessionController` is declared as a dependency because a
 * session that is NOT live in this process can only be resumed through it
 * (`resolveAgent`) or, as a fallback, through `prompt` (which resumes the cold
 * session and admits the message in one step). It is still looked up
 * defensively so a composition that provides it late still resumes.
 */
export const inject = ['agents', 'goals', 'tools', 'timer', 'systemPrompt', 'sessionController']

/**
 * Validated loader row config. Exported so the Plugin Manager / config editor can show
 * the real schema and project defaults; `normalizeConfig` still re-applies the same
 * defaults for direct `apply()` calls in tests.
 *
 * Every key carries a one-sentence description, so the settings page explains what
 * each knob does instead of showing a bare name.
 *
 * Construction is guarded: a wrong/foreign schemastery fallback must never turn a
 * missing schema into a failed plugin activation, and the coarsened `schemasterySource`
 * is reported by the health route instead of an absolute install path.
 */
function buildConfigSchema() {
  if (schemastery === undefined) return undefined
  try {
    return schemastery.object({
      enabled: schemastery.boolean().default(true)
        .description('Master switch: when false the plugin loads but does nothing.'),
      stateFile: schemastery.string().default('')
        .description('Absolute path of the durable checkpoint file; empty means <DSH_HOME>/storages/dsh-autorestart/state.json.'),
      resumeOnBoot: schemastery.boolean().default(true)
        .description('Resume interrupted sessions automatically after the host starts again.'),
      recoveryDelayMs: schemastery.number().min(0).default(6000)
        .description('Milliseconds the plugin waits after boot before it recovers interrupted sessions.'),
      maxSessions: schemastery.number().step(1).min(1).default(4)
        .description('How many interrupted sessions one recovery pass resumes.'),
      maxResumeAttempts: schemastery.number().step(1).min(1).default(2)
        .description('How often a single session is retried before the recovery gives up on it.'),
      deferPollMs: schemastery.number().min(250).default(3000)
        .description('Milliseconds between two restart-gate checks.'),
      deferSoftMs: schemastery.number().min(0).default(300000)
        .description('Milliseconds after which a pending restart is announced as waiting for a long time.'),
      deferHardMs: schemastery.number().min(0).default(900000)
        .description('Milliseconds after which a pending restart gives up, unless forceRestartWhenBusy is enabled.'),
      deferPolicy: schemastery.union(['auto', 'wait']).default('auto')
        .description('How a pending restart treats a busy conversation: auto waits for it, wait blocks until every conversation is idle.'),
      // hard deadline only forces a restart over a running conversation when enabled
      forceRestartWhenBusy: schemastery.boolean().default(false)
        .description('Let the hard deadline restart the host even while a conversation is still running.'),
      restartMode: schemastery.union(['app', 'command']).default('app')
        .description('How the host is restarted: app relaunches the desktop app, command runs restartCommand.'),
      restartCommand: schemastery.string().default('')
        .description('Shell command used when restartMode is "command"; empty means there is no custom command.'),
      relaunchDelaySeconds: schemastery.number().min(0).default(2)
        .description('Seconds between the kill of the old host and the relaunch of the new one.'),
      // quiet window that must pass after the last conversation activity
      settleMs: schemastery.number().min(0).default(2000)
        .description('Milliseconds the host must stay quiet after the last conversation activity before a restart may fire.'),
      autoReloadPage: schemastery.boolean().default(true)
        .description('Reload the web page automatically when the host boot token changes.'),
      blockManualRestart: schemastery.boolean().default(true)
        .description('Block shell commands that would kill or relaunch DeepSeek Harness by hand.'),
      healthPath: schemastery.string().default('/__dsh_autorestart/health')
        .description('HTTP path of the read-only health route used by the client UI and by verification scripts.'),
      continuationText: schemastery.string().default('')
        .description('Custom text injected as the continuation message; empty means the built-in notice.'),
      // pause between two recovery batches (each batch resumes maxSessions sessions)
      recoveryBatchDelayMs: schemastery.number().min(0).default(1200)
        .description('Milliseconds between two recovery batches.'),
      // pause between two resolveAgent attempts inside one boot
      resumeRetryDelayMs: schemastery.number().min(0).default(1000)
        .description('Milliseconds between two resolveAgent attempts inside one boot.'),
      // pre-restart snapshot + automatic rollback when the host never comes back
      backupOnRestart: schemastery.boolean().default(true)
        .description('Take a snapshot of the profile before every restart, so a host that cannot boot again is rolled back automatically.'),
      // include the installed plugin tree in the snapshot (bigger, but it makes a
      // rollback of "a plugin upgrade broke the boot" possible)
      backupIncludePlugins: schemastery.boolean().default(true)
        .description('Include the installed plugin tree in that snapshot: about 117 MB and roughly 3 extra seconds, but it is what makes a rollback of a broken plugin upgrade possible.'),
      maxBackups: schemastery.number().step(1).min(1).default(2)
        .description('How many snapshots are kept; older ones are deleted automatically.'),
      rollbackTimeoutMs: schemastery.number().min(1000).default(90000)
        .description('Milliseconds the detached watcher waits for the relaunched host before it restores the snapshot.'),
      // graceful shutdown ("收工关机"): wait for every conversation, count down, then
      // switch the REAL host machine off (a WSL host shuts Windows down, not the distro)
      showSleepButton: schemastery.boolean().default(true)
        .description('是否在左侧栏最底部、设置按钮旁边显示「收工关机」按钮：关掉之后界面上不再有这个按钮，关机接口也不再被界面调用。'),
      // The countdown length is a DROPDOWN: a union of the offered choices
      // projects into an enum (the settings page renders a select, not a
      // number field). `loose()` keeps an old profile value from breaking
      // the boot — the value is snapped onto a choice in normalizeConfig.
      sleepCountdownSeconds: schemastery.union(COUNTDOWN_CHOICES.map((value) => schemastery.const(value)))
        .default(DEFAULT_COUNTDOWN_SECONDS)
        .loose()
        .description('收工关机的倒计时秒数（下拉框：0 / 10 / 20 / 30 / 60 秒，默认 20；0 表示不倒数、立即关机，但仍会先等所有会话收工）。'),
      // Who may switch the machine off? A union of the offered choices
      // projects into an enum (the settings page renders a select).
      sleepController: schemastery.union(['human', 'anyone']).default('human')
        .loose()
        .description('谁能触发「收工关机」：human（默认，只有页面里的按钮可以——脚本和 AI 既不能关机也不能取消）；anyone（任何人都可以，脚本直接 POST 就能武装或取消）。'),
      sleepCommand: schemastery.string().default('')
        .description('自定义关机命令：留空表示按系统自动识别（Windows / WSL / Linux / macOS），填了就用这条命令代替自动识别。'),
    })
  } catch (error) {
    schemasterySource = `construction-failed: ${String(error)}`
    return undefined
  }
}

export const Config = buildConfigSchema()

/** Every config key and its default; a partial row config is merged over this. */
const DEFAULTS = {
  enabled: true,
  stateFile: '',
  resumeOnBoot: true,
  recoveryDelayMs: 6000,
  maxSessions: 4,
  maxResumeAttempts: 2,
  deferPollMs: 3000,
  deferSoftMs: 300000,
  deferHardMs: 900000,
  deferPolicy: 'auto',
  // default false: never force a restart over a running conversation
  forceRestartWhenBusy: false,
  restartMode: 'app',
  restartCommand: '',
  relaunchDelaySeconds: 2,
  settleMs: 2000,
  autoReloadPage: true,
  blockManualRestart: true,
  healthPath: '/__dsh_autorestart/health',
  continuationText: '',
  // Pre-restart snapshot + automatic rollback. The plugin copies the profile
  // configuration (and, unless disabled, the installed plugin tree) before every
  // restart; when the relaunched host never answers its health route, the
  // detached watcher puts the snapshot back and launches the host again.
  backupOnRestart: true,
  backupIncludePlugins: true,
  maxBackups: 2,
  rollbackTimeoutMs: 90000,
  // Graceful shutdown ("收工关机"): the button at the foot of the left sidebar,
  // the countdown before the machine is switched off and the optional custom
  // shutdown command (empty = the host is detected automatically).
  showSleepButton: true,
  sleepCountdownSeconds: DEFAULT_COUNTDOWN_SECONDS,
  // Who may switch the machine off: only the page ('human') or anybody
  // ('anyone', so a script can drive it too).
  sleepController: 'human',
  sleepCommand: '',
}

/** Merge a loader row config over {@link DEFAULTS}, dropping wrong-typed values. */
function normalizeConfig(raw) {
  const config = { ...DEFAULTS }
  if (raw === null || typeof raw !== 'object') return config
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value === typeof DEFAULTS[key]) config[key] = value
  }
  // Optional recovery knobs: they are not part of the published default set,
  // so they only appear when the row config sets them.
  for (const key of ['recoveryBatchDelayMs', 'resumeRetryDelayMs']) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) config[key] = value
  }
  if (config.deferPolicy !== 'auto' && config.deferPolicy !== 'wait') config.deferPolicy = 'auto'
  if (config.restartMode !== 'app' && config.restartMode !== 'command') config.restartMode = 'app'
  const maxBackups = Number(config.maxBackups)
  config.maxBackups = Number.isFinite(maxBackups) && maxBackups >= 1 ? Math.trunc(maxBackups) : 2
  const rollbackTimeout = Number(config.rollbackTimeoutMs)
  config.rollbackTimeoutMs =
    Number.isFinite(rollbackTimeout) && rollbackTimeout >= 1000 ? Math.trunc(rollbackTimeout) : 90000
  // The countdown of the graceful shutdown is one of the offered choices: a
  // profile that still carries an old value (15, 45, …) is snapped onto the
  // nearest one instead of breaking, and 0 means "no countdown at all".
  config.sleepCountdownSeconds = snapCountdownChoice(config.sleepCountdownSeconds)
  // Who may drive the shutdown: only the page ('human') or anybody
  // ('anyone'). An old or broken profile value falls back to the safe one.
  if (config.sleepController !== 'human' && config.sleepController !== 'anyone') {
    config.sleepController = 'human'
  }
  if (typeof config.sleepCommand !== 'string') config.sleepCommand = ''
  if (typeof config.showSleepButton !== 'boolean') config.showSleepButton = true
  return config
}

/** Resolve the health-route path (shared by the route and the restart gate URL). */
function resolveHealthPath(config) {
  return typeof config.healthPath === 'string' && config.healthPath.startsWith('/')
    ? config.healthPath
    : '/__dsh_autorestart/health'
}

/**
 * Resolve the park-route path: a sibling of the health route, under the same
 * prefix (the health path without its last segment).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveParkPath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/park`
}

/**
 * Resolve the recovery-route path: a sibling of the health route, under the same
 * prefix (`POST /recover` retries the boot recovery for the pending sessions).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveRecoverPath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/recover`
}

/**
 * Resolve the handoff-route path: a sibling of the health route, under the same
 * prefix (`POST /handoff` hands an over-limit session off to a fresh session).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveHandoffPath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/handoff`
}

/**
 * Resolve the choice-route path: a sibling of the health route, under the same
 * prefix (`POST /choice` persists the one-time install choice of the user).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveChoicePath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/choice`
}

/**
 * Resolve the sleep-route path: a sibling of the health route, under the same
 * prefix (`GET /sleep` reports the state of the graceful sleep, `POST /sleep`
 * arms or cancels it).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveSleepPath(config) {
  const healthPath = resolveHealthPath(config)
  const index = healthPath.lastIndexOf('/')
  const prefix = index > 0 ? healthPath.slice(0, index) : '/__dsh_autorestart'
  return `${prefix}/sleep`
}

/**
 * The blocking sessions with the reason each one blocks: a session that is
 * held by an armed goal reports `goal-active` (that goal can be disarmed), a
 * goal whose round budget is spent reports `goal-exhausted`, and the original
 * busy reason is kept as `busyReason`.
 *
 * Never throws: a goal lookup must never break a status report.
 *
 * @param {object} runtime
 * @param {any} blockedBy
 * @returns {any[]}
 */
function goalAwareBlockingDetails(runtime, blockedBy) {
  const list = Array.isArray(blockedBy) ? blockedBy : []
  const reasons = new Map()
  try {
    const { disarms, reported } = selectGoalDisarms(list, {
      getGoal: (sessionId) => runtime.goalFor(sessionId),
      disarmedGoals: runtime.disarmedGoalRecords(),
      parkedGoals: runtime.parkedGoalRecords(),
    })
    for (const item of disarms) reasons.set(item.sessionId, GOAL_BLOCK_REASONS.ACTIVE)
    for (const item of reported) reasons.set(item.sessionId, item.reason)
  } catch {
    // A goal lookup must never break the status report.
  }
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry
    const reason = reasons.get(entry.sessionId)
    if (!reason) return entry
    return { ...entry, busyReason: entry.reason, reason }
  })
}

/**
 * The goal records this plugin keeps, in both shapes: the current disarmed-goal
 * records (`goalId` / `disarmedAt` / `resumedAt`, written by
 * `ctx.goals.disarm`) and the LEGACY parked-goal records written by the
 * previous pause-based build (`goalId` / `parkedAt` / `resumedAt`).
 *
 * The status field is still called `parkedGoals` so an older client keeps
 * working; `kind` tells the two shapes apart.
 *
 * @param {object} runtime
 * @returns {{sessionId: string, kind: 'disarmed'|'parked', goalId: string|null, disarmedAt: number|null, parkedAt: number|null, resumedAt: number|null, resumed: boolean}[]}
 */
function parkedGoalList(runtime) {
  const out = []
  const collect = (records, kind, atKey) => {
    for (const [sessionId, record] of Object.entries(records || {})) {
      if (!record || typeof record !== 'object') continue
      out.push({
        sessionId,
        kind,
        goalId: record.goalId != null ? String(record.goalId) : null,
        disarmedAt: kind === 'disarmed' && Number.isFinite(record.disarmedAt) ? record.disarmedAt : null,
        parkedAt: kind === 'parked' && Number.isFinite(record[atKey]) ? record[atKey] : null,
        resumedAt: record.resumedAt != null ? record.resumedAt : null,
        resumed: record.resumedAt != null,
      })
    }
  }
  collect(runtime.disarmedGoalRecords(), 'disarmed', 'disarmedAt')
  collect(runtime.parkedGoalRecords(), 'parked', 'parkedAt')
  return out
}

/**
 * The self-reported outcome of the last recovery attempt, per session, plus the
 * sessions that can still be recovered. Used by `continuum_status` and by the
 * `?state=1` route so a stuck recovery is visible without reading the log.
 *
 * @param {object} state
 * @returns {{sessionId: string, action: string|null, detail: string|null, pending: boolean, attempts: number, error: string|null}[]}
 */
function recoveryList(state) {
  const out = []
  try {
    const sessions = state && typeof state === 'object' && state.sessions && typeof state.sessions === 'object'
      ? state.sessions
      : {}
    for (const [sessionId, entry] of Object.entries(sessions)) {
      if (!entry || typeof entry !== 'object') continue
      if (entry.lastRecoveryAction == null && entry.pendingResume !== true) continue
      out.push({
        sessionId: typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : sessionId,
        action: entry.lastRecoveryAction != null ? String(entry.lastRecoveryAction) : null,
        detail: entry.lastRecoveryDetail != null ? String(entry.lastRecoveryDetail) : null,
        pending: entry.pendingResume === true,
        attempts: Number.isFinite(entry.resumeAttempts) ? entry.resumeAttempts : 0,
        error: entry.lastResumeError != null ? String(entry.lastResumeError) : null,
      })
    }
  } catch {}
  return out
}

/**
 * The per-session handoff / context-overflow diagnostics of the checkpoint.
 *
 * Both records are the durable "this session outgrew the model window" markers:
 * a handed-off session was replaced by a fresh one, an over-limit session is
 * refused by the automatic resume path. `recoverableSessions` skips both, so the
 * status has to report them from the raw entries or they would be invisible.
 *
 * @param {object} state
 * @param {{ limit?: number }} [options]
 * @returns {{sessionId: string, handedOffTo: string|null, handoffAt: number|null, carriedChars: number|null, handedOff: boolean, overContextLimit: boolean, contextOverflow: object|null, lastRecoveryAction: string|null, lastRecoveryDetail: string|null}[]}
 */
function diagnosticSessions(state, { limit = 50 } = {}) {
  const out = []
  try {
    const sessions = state && typeof state === 'object' && state.sessions && typeof state.sessions === 'object'
      ? state.sessions
      : {}
    for (const [sessionId, entry] of Object.entries(sessions)) {
      if (!entry || typeof entry !== 'object') continue
      const handoff = entry.handoff && typeof entry.handoff === 'object' ? entry.handoff : null
      const overflow = entry.contextOverflow && typeof entry.contextOverflow === 'object'
        && entry.contextOverflow.over === true
        ? entry.contextOverflow
        : null
      if (handoff === null && overflow === null) continue
      out.push({
        sessionId: typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : sessionId,
        handedOff: handoff !== null,
        handedOffTo: handoff && typeof handoff.handedOffTo === 'string' ? handoff.handedOffTo : null,
        handoffAt: handoff && Number.isFinite(handoff.handoffAt) ? handoff.handoffAt : null,
        carriedChars: handoff && Number.isFinite(handoff.carriedChars) ? handoff.carriedChars : null,
        overContextLimit: overflow !== null,
        contextOverflow: overflow === null ? null : {
          inputTokens: Number.isFinite(overflow.inputTokens) ? overflow.inputTokens : null,
          contextWindow: Number.isFinite(overflow.contextWindow) ? overflow.contextWindow : null,
          detail: typeof overflow.detail === 'string' ? overflow.detail : null,
          detectedAt: Number.isFinite(overflow.detectedAt) ? overflow.detectedAt : null,
        },
        lastRecoveryAction: entry.lastRecoveryAction != null ? String(entry.lastRecoveryAction) : null,
        lastRecoveryDetail: entry.lastRecoveryDetail != null ? String(entry.lastRecoveryDetail) : null,
      })
      if (out.length >= limit) break
    }
  } catch {}
  return out
}

/** Resolve the durable checkpoint path. */
function resolveStateFile(config) {
  if (typeof config.stateFile === 'string' && config.stateFile.trim() !== '') {
    return path.resolve(config.stateFile)
  }
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'dsh-autorestart', 'state.json')
}

/**
 * The directory the plugin owns its durable state in.
 *
 * It is the directory of the checkpoint file, so a custom `stateFile` moves the
 * whole state directory with it (the backups live next to it as well).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveStateDir(config) {
  return path.dirname(resolveStateFile(config))
}

/**
 * The file the DEGRADED choice path writes to.
 *
 * It is only used when the official `configEditor` service is unavailable: the
 * profile configuration stays the single source of truth, and this file is the
 * last-resort record of a choice the Host could not persist yet.
 */
const INSTALL_CHOICE_FILE = 'install-choice.json'

/**
 * Read the recorded install choice from the fallback file.
 *
 * @param {string} stateDir
 * @returns {{ includePlugins: boolean|null, showSleepButton: boolean|null }|null}
 */
function readInstallChoice(stateDir) {
  try {
    const raw = fs.readFileSync(path.join(stateDir, INSTALL_CHOICE_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      includePlugins: typeof parsed.includePlugins === 'boolean' ? parsed.includePlugins : null,
      showSleepButton: typeof parsed.showSleepButton === 'boolean' ? parsed.showSleepButton : null,
    }
  } catch {
    return null
  }
}

/**
 * Write the install choice into the fallback file.
 *
 * The file is written ADDITIVELY: a choice about the sleep button must not
 * erase the recorded backup scope (and the other way round).
 *
 * @param {string} stateDir
 * @param {{ includePlugins?: boolean, showSleepButton?: boolean }} values
 * @returns {string} the file that was written
 */
function writeInstallChoice(stateDir, values) {
  const file = path.join(stateDir, INSTALL_CHOICE_FILE)
  const current = readInstallChoice(stateDir) || { includePlugins: null, showSleepButton: null }
  const payload = {
    includePlugins: typeof values.includePlugins === 'boolean' ? values.includePlugins : current.includePlugins,
    showSleepButton: typeof values.showSleepButton === 'boolean' ? values.showSleepButton : current.showSleepButton,
    at: new Date().toISOString(),
  }
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
  return file
}

/**
 * Resolve the effective `backupIncludePlugins` value and where it came from.
 *
 * The profile row config always wins: it is the single source of truth (the
 * settings page and the one-time install prompt write the same key). Only when
 * the row config does not set the key at all does the degraded fallback file
 * get a say, and only when it does not exist does the built-in default apply.
 *
 * @param {object|null|undefined} rawConfig the loader row config, as received
 * @param {string} stateDir
 * @returns {{ includePlugins: boolean, source: 'config'|'fallback-file'|'default' }}
 */
export function resolveBackupIncludePlugins(rawConfig, stateDir) {
  if (rawConfig && typeof rawConfig === 'object'
    && Object.prototype.hasOwnProperty.call(rawConfig, 'backupIncludePlugins')
    && typeof rawConfig.backupIncludePlugins === 'boolean') {
    return { includePlugins: rawConfig.backupIncludePlugins, source: 'config' }
  }
  const fallback = typeof stateDir === 'string' && stateDir !== '' ? readInstallChoice(stateDir) : null
  if (fallback !== null && fallback.includePlugins !== null) {
    return { includePlugins: fallback.includePlugins, source: 'fallback-file' }
  }
  return { includePlugins: DEFAULTS.backupIncludePlugins, source: 'default' }
}

/**
 * Resolve the effective `showSleepButton` value and where it came from.
 *
 * The same rule as the backup scope: the profile row config wins, the degraded
 * fallback file fills the gap, and the built-in default applies when neither
 * says anything.
 *
 * @param {object|null|undefined} rawConfig the loader row config, as received
 * @param {string} stateDir
 * @returns {{ showSleepButton: boolean, source: 'config'|'fallback-file'|'default' }}
 */
export function resolveShowSleepButton(rawConfig, stateDir) {
  if (rawConfig && typeof rawConfig === 'object'
    && Object.prototype.hasOwnProperty.call(rawConfig, 'showSleepButton')
    && typeof rawConfig.showSleepButton === 'boolean') {
    return { showSleepButton: rawConfig.showSleepButton, source: 'config' }
  }
  const fallback = typeof stateDir === 'string' && stateDir !== '' ? readInstallChoice(stateDir) : null
  if (fallback !== null && fallback.showSleepButton !== null) {
    return { showSleepButton: fallback.showSleepButton, source: 'fallback-file' }
  }
  return { showSleepButton: DEFAULTS.showSleepButton, source: 'default' }
}

/**
 * Resolve the profile directory the running host was started from.
 *
 * The host process does NOT necessarily carry `DSH_PROFILE_DIR` / `DSH_PROFILE`
 * (those are injected into shell commands, not into the host environment), so this
 * walks four independent sources and reports which one answered:
 *
 *   1. `DSH_PROFILE_DIR` — the host exported it.
 *   2. `DSH_HOME` + `DSH_PROFILE`.
 *   3. `--profile <name>` / `--profile=<name>` on the host command line.
 *   4. the only profile whose `dsh.profile.bundles` lists this plugin.
 *
 * @returns {{ dir: string|null, source: string }}
 */
function resolveProfileDirDetailed() {
  const explicit = process.env.DSH_PROFILE_DIR
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const dir = path.resolve(explicit.trim())
    if (fs.existsSync(dir)) return { dir, source: 'DSH_PROFILE_DIR' }
  }
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : ''
  const profile = process.env.DSH_PROFILE && process.env.DSH_PROFILE.trim() !== ''
    ? process.env.DSH_PROFILE.trim()
    : ''
  if (home !== '' && profile !== '') {
    const dir = path.join(home, 'profiles', profile)
    if (fs.existsSync(dir)) return { dir, source: 'DSH_HOME/DSH_PROFILE' }
  }
  // The host may have been started with an explicit --profile flag instead.
  const argv = Array.isArray(process.argv) ? process.argv : []
  let fromArgv = ''
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '')
    if (arg === '--profile' && index + 1 < argv.length) fromArgv = String(argv[index + 1] ?? '')
    else if (arg.startsWith('--profile=')) fromArgv = arg.slice('--profile='.length)
  }
  const root = home !== '' ? home : path.join(os.homedir(), '.dsh')
  if (fromArgv.trim() !== '') {
    const dir = path.join(root, 'profiles', fromArgv.trim())
    if (fs.existsSync(dir)) return { dir, source: 'host --profile flag' }
  }
  // Last resort: the only profile that lists this plugin as a bundle.
  try {
    const profilesDir = path.join(root, 'profiles')
    const matches = []
    for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(profilesDir, entry.name)
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'))
        const bundles = manifest && manifest.dsh && manifest.dsh.profile
          && Array.isArray(manifest.dsh.profile.bundles)
          ? manifest.dsh.profile.bundles
          : []
        if (bundles.includes(name)) matches.push(candidate)
      } catch {}
    }
    if (matches.length === 1) return { dir: matches[0], source: 'profile bundles scan' }
  } catch {}
  return { dir: null, source: 'unknown' }
}

/** The profile directory, or null when it cannot be resolved. */
function resolveProfileDir() {
  return resolveProfileDirDetailed().dir
}

/**
 * The pre-restart snapshot: copy the profile into `<stateDir>/backups/<stamp>/`
 * and clear the rollback report an older boot may have left behind.
 *
 * This is the ONE backup entry of the plugin. EVERY restart mode takes its
 * snapshot through this function — the desktop app relaunch AND the custom
 * restart command — so a hosted host that is restarted by a command is just as
 * recoverable as the desktop app. The configuration files decide whether every
 * bundle loads, so a snapshot is what makes a "the host does not come back"
 * rollback possible at all.
 *
 * A failing backup never blocks the restart: the reason is logged and the
 * caller continues without a rollback point.
 *
 * @param {{
 *   config?: object,
 *   stateDir?: string,
 *   log?: { warn: Function },
 *   profile?: { dir?: string|null, source?: string },
 *   createBackup?: Function,
 * }} [options]
 * @returns {{ backup: object|null, profileDir: string|null, profile: { dir: string|null, source: string } }}
 */
export function takePreRestartSnapshot({
  config = {},
  stateDir = '',
  log = console,
  profile = null,
  createBackup: createBackupFn = createBackup,
} = {}) {
  const info = profile && typeof profile === 'object'
    ? { dir: profile.dir ?? null, source: profile.source ?? 'unknown' }
    : { dir: null, source: 'unknown' }
  const profileDir = typeof info.dir === 'string' && info.dir.trim() !== '' ? info.dir : null
  // The snapshot is optional: the operator can turn it off entirely.
  if (config.backupOnRestart !== true) return { backup: null, profileDir, profile: info }
  if (profileDir === null) {
    log.warn('no profile directory is known; skipping the pre-restart backup', { source: info.source })
    return { backup: null, profileDir: null, profile: info }
  }
  let backup = null
  try {
    backup = createBackupFn({
      profileDir,
      backupsDir: backupsRoot(stateDir),
      includePlugins: config.backupIncludePlugins !== false,
      maxBackups: config.maxBackups,
    })
  } catch (error) {
    // A backup that throws must not take the restart down with it.
    backup = { ok: false, error: String(error) }
  }
  if (backup && backup.ok === true) {
    log.warn('pre-restart backup written', {
      dir: backup.dir,
      bytes: backup.bytes,
      includePlugins: backup.includePlugins,
      pruned: backup.pruned,
      profileDirSource: info.source,
    })
    // A report from an older boot must not be mistaken for this one.
    clearRollbackReport(stateDir)
  } else {
    log.warn('the pre-restart backup failed; continuing without a rollback point', {
      error: backup && backup.error ? backup.error : 'unknown error',
    })
  }
  return { backup, profileDir, profile: info }
}

/** A logger that never throws and never requires a particular Cordis logger shape. */
function createLogger(ctx) {
  const logger = ctx.logger
  const pick = (level) => {
    if (logger && typeof logger[level] === 'function') return logger[level].bind(logger)
    if (typeof logger === 'function') {
      try {
        const scoped = logger('dsh-autorestart')
        if (scoped && typeof scoped[level] === 'function') return scoped[level].bind(scoped)
      } catch {}
      return (...parts) => logger('dsh-autorestart', ...parts)
    }
    return level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  }
  const emit = (level, parts) => {
    let message
    try {
      message = parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')
    } catch {
      message = parts.map(String).join(' ')
    }
    try {
      pick(level)(`[dsh-autorestart] ${message}`)
    } catch {}
  }
  return {
    info: (...parts) => emit('info', parts),
    warn: (...parts) => emit('warn', parts),
    error: (...parts) => emit('error', parts),
  }
}

/** Whether this agent is a root session (subagent sessions are not resumed on boot). */
function isRootAgent(ctx, agent) {
  try {
    const roots = ctx.agents.roots()
    if (!Array.isArray(roots)) return true
    return roots.includes(agent)
  } catch {
    return true
  }
}

/**
 * Resolve the official `configEditor` service, or null when it is unavailable.
 *
 * The service is optional: the plugin must load in a composition that does not
 * provide it, and the one-time install choice then falls back to a file.
 *
 * @param {object} ctx
 * @returns {any|null}
 */
function resolveConfigEditor(ctx) {
  try {
    if (ctx && ctx.configEditor && typeof ctx.configEditor.edit === 'function') return ctx.configEditor
  } catch {}
  try {
    if (ctx && typeof ctx.get === 'function') {
      const service = ctx.get('configEditor')
      if (service && typeof service.edit === 'function') return service
    }
  } catch {}
  return null
}

/**
 * Find this plugin's own row among the profile entries.
 *
 * The service hands out the LOADER's own entries, so the row id lives in
 * `entry.options.id` (the id the bundle layer inserts: `dsh-autorestart`).
 * A projected entry (the shape the settings UI shows) carries the same id as
 * `patchId` or `id`, so both are accepted as well.
 *
 * @param {any} editor the configEditor service
 * @returns {any|null} the entry, or null when this plugin has no row
 */
function findOwnEntry(editor) {
  let entries = []
  try {
    entries = typeof editor.entries === 'function' ? editor.entries() : []
  } catch {
    return null
  }
  if (!Array.isArray(entries)) return null
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const options = entry.options && typeof entry.options === 'object' ? entry.options : null
    const candidates = [
      options ? options.id : undefined,
      entry.patchId,
      entry.id,
    ]
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null) continue
      if (String(candidate) === name) return entry
    }
  }
  return null
}

/**
 * The plugin's whole runtime state.
 *
 * @param {object} ctx
 * @param {object} config the normalized config
 * @param {{
 *   backupChoiceSource?: string,
 *   env?: object,
 *   snapshot?: Function,
 *   runCommand?: Function,
 *   scheduleDetached?: Function,
 * }} [options] `env` replaces parts of the detected environment and the three
 *   functions replace the side-effecting primitives of the restart path. They
 *   exist so a restart can be exercised without spawning a process or touching
 *   the real profile; production never passes them.
 */
export function createRuntime(ctx, config, options = {}) {
  const log = createLogger(ctx)
  const env = {
    ...detectEnvironment(),
    ...(options.env && typeof options.env === 'object' ? options.env : {}),
  }
  // The ONE pre-restart snapshot entry: every restart mode uses it.
  const snapshotFn = typeof options.snapshot === 'function' ? options.snapshot : takePreRestartSnapshot
  const runCommandFn = typeof options.runCommand === 'function' ? options.runCommand : runCommandNow
  const scheduleDetachedFn = typeof options.scheduleDetached === 'function'
    ? options.scheduleDetached
    : scheduleDetachedRestart
  const stateFile = resolveStateFile(config)

  const loaded = readState(stateFile, Date.now())
  if (loaded.corrupt) {
    log.warn(`checkpoint ${stateFile} is unreadable (${loaded.error || 'parse error'}); starting from a fresh state`)
  } else if (loaded.repaired) {
    log.warn(`checkpoint ${stateFile} needed repair; unknown or invalid fields were dropped`)
  }
  let state = loaded.state
  const boot = beginBoot(state, { pid: process.pid, now: Date.now() })
  state = boot.state
  const bootId = state.bootId

  let pollTimer
  let recoverTimer
  let disposed = false
  let lastPersistError
  /**
   * The tool registrations that failed. A failed registration is recorded and
   * logged, never thrown: the plugin still loads and the other tools still work.
   */
  const toolErrors = []

  const persist = () => {
    try {
      writeState(stateFile, state, Date.now())
      lastPersistError = undefined
    } catch (error) {
      if (lastPersistError !== String(error)) {
        lastPersistError = String(error)
        log.warn(`could not write checkpoint ${stateFile}:`, String(error))
      }
    }
  }

  const stopPolling = () => {
    if (typeof pollTimer === 'function') {
      try {
        pollTimer()
      } catch {}
      pollTimer = undefined
    }
  }

  const startPolling = () => {
    if (pollTimer !== undefined) return
    pollTimer = ctx.interval(() => {
      try {
        tick()
      } catch (error) {
        log.warn('defer tick failed:', String(error))
      }
    }, Math.max(250, config.deferPollMs))
  }

  /** When the last conversation activity was observed; the settle window starts here. */
  let lastActivityAt = Date.now()

  /** Record conversation activity (any agent turn, session event or queued message). */
  const noteActivity = () => {
    lastActivityAt = Date.now()
  }

  /** Queued inbox messages an agent still has to process (nextTurn / nextStep). */
  const pendingInboxCount = (agent) => {
    let count = 0
    try {
      const inbox = agent && agent.inbox
      if (!inbox) return 0
      for (const key of ['nextTurn', 'nextStep']) {
        const queue = inbox[key]
        if (Array.isArray(queue) && queue.length > 0) count += queue.length
      }
      if (count === 0 && inbox.hasPending === true) count = 1
    } catch {}
    return count
  }

  /**
   * Every conversation that is still working, subagents and teammates included.
   * 'running' is a live turn; 'queued' is inbox work that has not started yet.
   */
  const busyAgents = () => {
    const out = []
    let agents = []
    try {
      agents = ctx.agents.list() || []
    } catch {
      agents = []
    }
    for (const agent of agents) {
      try {
        if (!agent || !agent.id) continue
        if (agent.status === 'running') out.push({ sessionId: String(agent.id), reason: 'running' })
        else if (pendingInboxCount(agent) > 0) out.push({ sessionId: String(agent.id), reason: 'queued' })
      } catch {}
    }
    return out
  }

  /**
   * The disarmed-goal records of the checkpoint: one entry per session whose
   * goal this plugin disarmed and has not re-armed yet.
   */
  const disarmedGoalRecords = () => (
    state.disarmedGoals && typeof state.disarmedGoals === 'object' ? state.disarmedGoals : {}
  )

  /**
   * The LEGACY (pause-based) parked-goal records of the checkpoint. They are
   * still read so a goal the previous build paused can be resumed once.
   */
  const parkedGoalRecords = () => (
    state.parkedGoals && typeof state.parkedGoals === 'object' ? state.parkedGoals : {}
  )

  /** The live agent of a session, or undefined when it is not attached. */
  const liveAgent = (sessionId) => {
    if (!sessionId) return undefined
    try {
      if (ctx.agents && typeof ctx.agents.get === 'function') {
        const agent = ctx.agents.get(sessionId)
        if (agent) return agent
      }
    } catch {}
    return undefined
  }

  /** The live goal of a session, or undefined when it has none. */
  const goalFor = (sessionId, agent) => {
    const target = agent || liveAgent(sessionId)
    if (!target) return undefined
    try {
      return ctx.goals.get(target)
    } catch {
      return undefined
    }
  }

  /**
   * Disarm the goal of one session so a pending restart can proceed.
   *
   * `ctx.goals.disarm(agent)` removes the process-local continuation authority
   * WITHOUT touching the durable goal: the goal stays `active`, the round that
   * is running right now still finishes normally (no turn is cancelled and
   * nothing is lost), but the goal round driver will not start another round.
   * That is what lets the session go idle so the restart can proceed; after the
   * boot the goal is re-armed through `ctx.goals.resume(...)`.
   *
   * Never throws: a failed disarm is reported instead of propagated, so it can
   * never break the restart gate.
   */
  const disarmGoal = (sessionId, agent) => {
    const target = agent || liveAgent(sessionId)
    if (!target) {
      return { sessionId, disarmed: false, reason: GOAL_BLOCK_REASONS.NO_AGENT, error: 'session-not-live' }
    }
    const goal = goalFor(sessionId, target)
    if (!goal || typeof goal !== 'object') return { sessionId, disarmed: false, reason: 'no-goal' }
    const goalId = goal.id == null ? null : String(goal.id)
    const { disarms, reported } = selectGoalDisarms([{ sessionId }], {
      getGoal: () => goal,
      disarmedGoals: disarmedGoalRecords(),
      parkedGoals: parkedGoalRecords(),
    })
    if (disarms.length === 0) {
      const reason = reported.length > 0 ? reported[0].reason : 'goal-not-disarmable'
      return { sessionId, disarmed: false, goalId, reason }
    }
    const goals = ctx.goals
    if (!goals || typeof goals.disarm !== 'function') {
      return { sessionId, disarmed: false, goalId, reason: 'disarm-unavailable', error: 'goals.disarm is not available' }
    }
    let outcome
    try {
      outcome = goals.disarm(target)
    } catch (error) {
      return { sessionId, disarmed: false, goalId, reason: 'disarm-failed', error: describeError(error) }
    }
    const onDisarmed = () => {
      setDisarmedGoal(state, sessionId, { goalId, disarmedAt: Date.now() })
      persist()
      log.info(`disarmed goal ${goalId} of session ${sessionId}; the running round still finishes and the goal is re-armed after the restart`)
    }
    if (outcome && typeof outcome.then === 'function') {
      outcome.then(onDisarmed, (error) => {
        log.warn(`could not disarm goal ${goalId} of session ${sessionId}:`, describeError(error))
      })
      return { sessionId, disarmed: true, goalId, reason: GOAL_BLOCK_REASONS.ACTIVE, pending: true }
    }
    onDisarmed()
    return { sessionId, disarmed: true, goalId, reason: GOAL_BLOCK_REASONS.ACTIVE }
  }

  /**
   * The live SESSION of a session id: the readable conversation surface
   * (`deriveMessages` / `requestHeader` / `requestContext` / `snapshotEvents`).
   * Falls back to the live agent's session when the sessions service is absent.
   */
  const liveSession = (sessionId) => {
    if (!sessionId) return undefined
    try {
      const sessions = ctx.get('sessions')
      if (sessions && typeof sessions.get === 'function') {
        const session = sessions.get(String(sessionId))
        if (session) return session
      }
    } catch {}
    const agent = liveAgent(sessionId)
    return agent && agent.session ? agent.session : undefined
  }

  /** Read the readable surface of one live session. Never throws. */
  const readSession = (sessionId) => {
    const session = liveSession(sessionId)
    if (!session) return { session: undefined, messages: undefined, header: undefined, requestContext: undefined, events: undefined }
    const read = (fn) => {
      try {
        return typeof session[fn] === 'function' ? session[fn]() : undefined
      } catch {
        return undefined
      }
    }
    return {
      session,
      messages: read('deriveMessages'),
      header: read('requestHeader'),
      requestContext: read('requestContext'),
      events: read('snapshotEvents'),
    }
  }

  /**
   * The context-overflow verdict of a session, from its LIVE surface only.
   *
   * Evidence: the newest assistant message `usage.inputTokens` versus the
   * session's `contextWindow`, or a recent turn / event that failed with a
   * context-window error. Unknown numbers never mean overflow, so an unknown
   * session keeps the normal resume path. Never throws.
   */
  const overflowFor = (sessionId) => {
    const unknown = { over: false, inputTokens: null, contextWindow: null, detail: null }
    try {
      const read = readSession(sessionId)
      if (!read.session) return unknown
      const info = read.requestContext
      const contextWindow = info && typeof info === 'object' && Number.isFinite(info.contextWindow) ? info.contextWindow : null
      return contextOverflow({ messages: read.messages, contextWindow, events: read.events })
    } catch {
      return unknown
    }
  }

  /**
   * Hand an over-limit session off to a fresh, usable session.
   *
   * A session whose conversation outgrew the model window can neither continue
   * nor be compacted: every request fails with "context window exceeds limit",
   * and the compaction request needs the same oversized context. The handoff
   * carries what still fits — the goal objective, the checkpoint reasons and a
   * bounded tail of the conversation — into a NEW live agent/session, then marks
   * the old session and disarms its goal so it stops issuing doomed requests.
   *
   * Nothing is created when the source cannot be read.
   *
   * @param {{ sessionId?: string, maxChars?: number, callerAgent?: object }} [options]
   * @returns {Promise<object>} `{ ok, sessionId, carriedChars, instruction }`
   */
  const handoff = async ({ sessionId, maxChars, callerAgent } = {}) => {
    const requested = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : null
    const sourceId = requested !== null ? requested : (callerAgent && callerAgent.id ? String(callerAgent.id) : null)
    if (sourceId === null) {
      return { ok: false, error: 'no-session', instruction: 'No source session: pass sessionId, or call this tool from the session that should be handed off.' }
    }
    const read = readSession(sourceId)
    if (!read.session) {
      return {
        ok: false,
        error: 'source-session-not-live',
        sourceSessionId: sourceId,
        instruction: `Session ${sourceId} is not live in this process, so its conversation cannot be read and no handoff was created.`,
      }
    }
    if (read.messages === undefined) {
      return {
        ok: false,
        error: 'source-unreadable',
        sourceSessionId: sourceId,
        instruction: `Session ${sourceId} did not expose its messages, so no handoff was created.`,
      }
    }
    const header = read.header
    const cwd = header && typeof header.cwd === 'string' && path.isAbsolute(header.cwd) ? header.cwd : null
    if (cwd === null) {
      return {
        ok: false,
        error: 'source-cwd-unknown',
        sourceSessionId: sourceId,
        instruction: `Session ${sourceId} has no absolute working directory in its header, so a new session could not be created for the handoff.`,
      }
    }

    const goal = goalFor(sourceId)
    const objective = goal && typeof goal === 'object'
      ? [goal.objective, goal.title, goal.description].find((value) => typeof value === 'string' && value.trim() !== '') ?? null
      : null
    const entry = state.sessions && state.sessions[sourceId] ? state.sessions[sourceId] : null
    const goalLabel = entry && entry.goal && entry.goal.goalId != null
      ? String(entry.goal.goalId)
      : (goal && goal.id != null ? String(goal.id) : null)
    const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : HANDOFF_DEFAULT_MAX_CHARS
    const composed = composeHandoff({
      sessionId: sourceId,
      objective,
      goalLabel,
      reasons: entry && Array.isArray(entry.reasons) ? entry.reasons : [],
      messages: read.messages,
      maxChars: budget,
    })

    const newSessionId = 'session-' + crypto.randomUUID()
    let created
    try {
      created = await ctx.agents.create({
        sessionId: newSessionId,
        meta: { cwd, parentSession: sourceId, createdAt: Date.now() },
      })
    } catch (error) {
      const detail = describeError(error)
      log.warn(`could not create the handoff session for ${sourceId}:`, detail)
      return {
        ok: false,
        error: 'create-failed',
        sourceSessionId: sourceId,
        detail,
        instruction: `The new session could not be created (${detail}); session ${sourceId} is unchanged.`,
      }
    }
    let newAgent = created && typeof created === 'object' ? (created.agent ?? created.handle ?? created) : undefined
    if (!newAgent || typeof newAgent.followup !== 'function' || newAgent.id === undefined) newAgent = liveAgent(newSessionId)
    if (!newAgent || typeof newAgent.followup !== 'function') {
      return {
        ok: false,
        error: 'handoff-agent-unavailable',
        sourceSessionId: sourceId,
        sessionId: newSessionId,
        instruction: `The new session ${newSessionId} exposes no agent to deliver the handoff text to; session ${sourceId} is unchanged.`,
      }
    }
    const continueId = newAgent.id === undefined || newAgent.id === null ? newSessionId : String(newAgent.id)
    try {
      newAgent.followup(createContinuationMessage(composed.text, {
        summary: 'handoff of a session that exceeded the model context window',
      }))
    } catch (error) {
      const detail = describeError(error)
      log.warn(`the handoff text was rejected for ${continueId}:`, detail)
      return {
        ok: false,
        error: 'deliver-failed',
        sourceSessionId: sourceId,
        sessionId: continueId,
        detail,
        instruction: `The handoff text could not be delivered to ${continueId} (${detail}); session ${sourceId} is unchanged.`,
      }
    }

    const at = Date.now()
    setHandoff(state, sourceId, { handedOffTo: continueId, handoffAt: at, carriedChars: composed.carriedChars })
    setRecoveryOutcome(state, sourceId, { action: 'handed-off', detail: `handed off to ${continueId}`, now: at })
    persist()

    // (e) the over-limit session must stop issuing doomed requests.
    let disarmedGoal = false
    try {
      const result = disarmGoal(sourceId, requested === null ? callerAgent : undefined)
      disarmedGoal = result.disarmed === true
    } catch (error) {
      log.warn(`could not disarm the goal of the handed-off session ${sourceId}:`, describeError(error))
    }
    log.info(`handed session ${sourceId} off to ${continueId} (${composed.carriedChars} characters carried)`)
    return {
      ok: true,
      sourceSessionId: sourceId,
      sessionId: continueId,
      carriedChars: composed.carriedChars,
      carriedTailChars: composed.tailChars,
      disarmedGoal,
      instruction: `Continue the work in the new session ${continueId}. The old session ${sourceId} is kept and marked as handed off: its goal is disarmed and it is never auto-resumed again.`,
    }
  }

  /**
   * Disarm the goals of the sessions that block the pending restart.
   *
   * A goal-driven session keeps its own agent busy (the goal round driver
   * starts the next round within milliseconds), so the restart gate would never
   * open. Disarming removes that authority: the CURRENT round finishes
   * normally, no new round starts, the session goes idle and the next poll sees
   * a quiet host. Goals are never paused and no turn is ever cancelled.
   */
  const disarmBlockingGoals = (busy) => {
    const restart = state.restart
    if (!restart) return { disarmed: [], reported: [] }
    if (restart.parkGoals === false) return { disarmed: [], reported: [], skipped: 'park-goals-disabled' }
    const list = Array.isArray(busy) ? busy : []
    if (list.length === 0) return { disarmed: [], reported: [] }
    const { disarms, reported } = selectGoalDisarms(list, {
      getGoal: (sessionId) => goalFor(sessionId),
      disarmedGoals: disarmedGoalRecords(),
      parkedGoals: parkedGoalRecords(),
    })
    const disarmed = []
    for (const item of disarms) {
      try {
        const result = disarmGoal(item.sessionId)
        if (result.disarmed) disarmed.push(result)
        else log.warn(`could not disarm the goal of session ${item.sessionId}: ${result.reason}${result.error ? ` (${result.error})` : ''}`)
      } catch (error) {
        log.warn(`disarming the goal of session ${item.sessionId} failed:`, describeError(error))
      }
    }
    return { disarmed, reported }
  }

  const anyAgentRunning = () => busyAgents().length > 0

  /** The two-layer restart gate: no busy conversation AND a quiet settle window. */
  const gate = () => restartGate(state, {
    busyAgents: busyAgents(),
    lastActivityAt,
    now: Date.now(),
    settleMs: config.settleMs,
  })

  /**
   * Cached session titles, used to label the blocking sessions in the
   * client's "pending restart" details panel.
   *
   * This is strictly best effort: the health route is a read-only probe that
   * must never fail, so a missing session controller, a rejected list call or
   * a session without a title simply means "no title" (the field is omitted).
   * The list is read at most every SESSION_TITLE_CACHE_MS, and the refresh
   * runs detached (the route handler is synchronous and never blocks on it).
   */
  const titleCache = { at: 0, titles: new Map(), inFlight: false }

  /** Store the titles of one session-list answer. Never throws. */
  const applySessionTitles = (payload) => {
    const items = payload && Array.isArray(payload.items)
      ? payload.items
      : (Array.isArray(payload) ? payload : [])
    const titles = new Map()
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const id = item.id === undefined || item.id === null ? '' : String(item.id)
      if (!id) continue
      const title = typeof item.title === 'string' ? item.title.trim() : ''
      if (title) titles.set(id, title)
    }
    titleCache.titles = titles
  }

  /** Kick off one session-list read. Never throws and never blocks the caller. */
  const refreshSessionTitles = () => {
    if (titleCache.inFlight) return
    titleCache.at = Date.now()
    let controller
    try {
      controller = ctx.get('sessionController')
    } catch {
      return
    }
    if (!controller || typeof controller.list !== 'function') return
    titleCache.inFlight = true
    const settle = (payload) => {
      titleCache.inFlight = false
      try {
        applySessionTitles(payload)
      } catch {
        // A malformed answer is ignored; the panel simply shows no title.
      }
    }
    let payload
    try {
      payload = controller.list({})
    } catch {
      titleCache.inFlight = false
      return
    }
    if (payload && typeof payload.then === 'function') {
      payload.then(settle, () => { titleCache.inFlight = false })
      return
    }
    settle(payload)
  }

  /** The cached title of one session, or undefined when it is unknown. */
  const sessionTitle = (sessionId) => {
    try {
      if (sessionId === undefined || sessionId === null) return undefined
      const id = String(sessionId)
      if (!id) return undefined
      if (Date.now() - titleCache.at >= SESSION_TITLE_CACHE_MS) refreshSessionTitles()
      const title = titleCache.titles.get(id)
      return title ? title : undefined
    } catch {
      return undefined
    }
  }

  const flushSessions = async () => {
    const sessions = ctx.get('sessions')
    if (!sessions || typeof sessions.flush !== 'function') {
      log.warn('sessions.flush is unavailable; the pre-restart durability flush is skipped')
      return
    }
    for (const agent of ctx.agents.list()) {
      try {
        await sessions.flush(agent.session)
      } catch (error) {
        log.warn(`sessions.flush failed for ${agent.id}:`, String(error))
      }
    }
  }

  /**
   * Release the continuation request of EVERY session that asked for the current
   * restart (cancel / give-up paths). Requests are coalesced into ONE restart, so
   * releasing only the last requester would leave the others pinned as pending.
   */
  const releaseRequesters = () => {
    const restart = state.restart
    if (!restart) return
    const ids = new Set()
    if (Array.isArray(restart.requesters)) {
      for (const requester of restart.requesters) {
        if (requester && typeof requester.sessionId === 'string' && requester.sessionId) ids.add(requester.sessionId)
      }
    }
    if (typeof restart.bySessionId === 'string' && restart.bySessionId) ids.add(restart.bySessionId)
    for (const sessionId of ids) {
      const entry = state.sessions ? state.sessions[sessionId] : undefined
      if (!entry) continue
      entry.pendingResume = false
      entry.interrupted = false
      markIdle(state, sessionId, { now: Date.now() })
    }
  }

  /** Roll back a scheduled restart: back off, and give up instead of looping forever. */
  const rollbackRestart = (reason) => {
    if (!state.restart) return
    state.restart.failedAttempts = (Number(state.restart.failedAttempts) || 0) + 1
    if (state.restart.failedAttempts >= 2) {
      log.error('restart could not be scheduled twice; cancelling the pending restart instead of retrying forever:', reason)
      releaseRequesters()
      cancelRestart(state, { now: Date.now() })
      persist()
      stopPolling()
      return
    }
    setPhase(state, 'deferred')
    if (state.restart.attempt > 0) state.restart.attempt -= 1
    // Back off before the next attempt: no tight retry loop on a broken scheduler.
    state.restart.notBefore = Date.now() + Math.max(5000, config.deferPollMs * 4)
    persist()
    startPolling()
    log.error('restart could not be scheduled; retrying once after a short backoff:', reason)
  }

  /**
   * Watchdog for a scheduled restart. If this process is still alive after the
   * helper's delay, the helper refused to kill (the idle gate denied it): roll back
   * to 'deferred' and poll again instead of leaving the phase stuck at 'restarting'.
   */
  const armGateWatchdog = () => {
    try {
      ctx.timeout(() => {
        if (disposed || !state.restart || state.phase !== 'restarting') return
        const aborts = (Number(state.restart.gateAborts) || 0) + 1
        state.restart.gateAborts = aborts
        if (state.restart.attempt > 0) state.restart.attempt -= 1
        setPhase(state, 'deferred')
        if (aborts > 20) {
          log.error('the detached helper aborted on the idle gate more than 20 times; the next attempt is scheduled UNGATED:', { gateAborts: aborts })
        } else {
          log.warn('the detached restart helper did not kill this process (idle gate denied); waiting for the next quiet window', { gateAborts: aborts })
        }
        persist()
        startPolling()
      }, Math.max(1000, (config.relaunchDelaySeconds + 20) * 1000))
    } catch (error) {
      log.warn('could not arm the restart gate watchdog:', String(error))
    }
  }

  /** The loopback URL the detached helper re-checks immediately before killing. */
  const restartGateUrl = () => {
    const port = runtime.webPort
    if (!Number.isFinite(port) || port <= 0) return null
    return 'http://127.0.0.1:' + port + resolveHealthPath(config) + '?gate=1'
  }

  /** The plain health URL the rollback watcher polls after the relaunch. */
  const restartHealthUrl = () => {
    const port = runtime.webPort
    if (!Number.isFinite(port) || port <= 0) return null
    return 'http://127.0.0.1:' + port + resolveHealthPath(config)
  }

  /** Execute the restart now; the detached helper survives our own death. */
  const executeRestart = async () => {
    stopPolling()
    if (!state.restart) return
    try {
      await flushSessions()
    } catch {}
    // Re-check the gate AFTER the flush and BEFORE anything is killed or scheduled:
    // another conversation may have started while the sessions were being written.
    // This re-check also protects the ungated fallback (>20 gate aborts) and the
    // forceRestartWhenBusy path: even when the detached helper cannot re-check the
    // gate itself, a busy conversation is never killed here.
    // Last chance to park a goal-driven session: without it the detached
    // helper would refuse to kill the process and the restart would wait.
    try {
      disarmBlockingGoals(busyAgents())
    } catch (error) {
      log.warn('could not disarm the goals of the blocking sessions:', String(error))
    }
    const verdict = gate()
    if (!verdict.allow) {
      log.info('restart deferred: a conversation is still active or the host is settling', {
        reason: verdict.reason,
        blockedBy: verdict.blockedBy,
        quietForMs: verdict.quietForMs,
      })
      persist()
      startPolling()
      return
    }
    setPhase(state, 'restarting')
    state.restart.attempt += 1
    persist()
    log.warn('executing graceful restart', { generation: state.generation, pid: process.pid })
    try {
      // How the host is restarted: the custom command, or the desktop app.
      const useCustomCommand = config.restartMode === 'command' && config.restartCommand.trim() !== ''
      const canRelaunchDesktop = Boolean(env.isDesktopApp && env.appExePath)
      if (!useCustomCommand && !canRelaunchDesktop) {
        // No restart method at all (the host is not the desktop app and there is
        // no custom command): nothing is restarted, so nothing is snapshotted
        // either — there is no rollback point for a restart that never happens.
        log.warn('no restart method available (not the desktop app and restartCommand is empty); leaving the checkpoint in place')
        rollbackRestart('no restart method available')
        return
      }

      // ONE snapshot for EVERY restart mode: the profile is copied BEFORE
      // anything is killed, no matter how the host is restarted. The desktop
      // app relaunch and the custom restart command share this single entry, so
      // a hosted host that is restarted by a command is just as recoverable as
      // the desktop app.
      const stateDir = path.dirname(stateFile)
      const snapshot = snapshotFn({
        config,
        stateDir,
        log,
        profile: resolveProfileDirDetailed(),
      })

      if (useCustomCommand) {
        const command = buildCustomCommand({
          template: config.restartCommand,
          pid: process.pid,
          ppid: process.ppid,
          appExePath: env.appExePath || '',
        })
        log.warn('running custom restart command:', command)
        // A failed snapshot never blocks the restart: the command runs anyway.
        const outcome = runCommandFn({ command })
        if (outcome && outcome.ok === false) rollbackRestart(outcome.error || 'custom command failed')
      } else {
        const aborts = Number(state.restart.gateAborts) || 0
        const url = aborts > 20 ? null : restartGateUrl()
        if (aborts > 20) {
          log.error('falling back to an UNGATED restart after repeated idle-gate aborts', { gateAborts: aborts })
        } else if (url === null) {
          log.warn('the web server port is unknown; scheduling an UNGATED restart (the helper cannot re-check the idle gate)')
        }
        // The snapshot was already taken above (the shared entry).
        const backup = snapshot && snapshot.backup ? snapshot.backup : null
        const profileDir = snapshot && snapshot.profileDir ? snapshot.profileDir : null
        const healthUrl = restartHealthUrl()
        const watchScriptPath = backup && backup.ok === true && healthUrl !== null && profileDir !== null
          ? path.join(stateDir, 'restart-' + state.generation + '-watch.ps1')
          : null
        const watchScript = watchScriptPath === null
          ? null
          : buildWatchScript({
            healthUrl,
            backupDir: backup.dir,
            profileDir,
            reportPath: path.join(stateDir, ROLLBACK_REPORT_NAME),
            appExePath: env.appExePath,
            timeoutMs: config.rollbackTimeoutMs,
            // Only a crash log written after this point belongs to this restart.
            since: new Date().toISOString(),
          })
        const result = scheduleDetachedFn({
          appExePath: env.appExePath,
          relaunchDelaySeconds: config.relaunchDelaySeconds,
          gateUrl: url,
          scriptPath: url === null ? null : path.join(stateDir, 'restart-' + state.generation + '.cmd'),
          watchScriptPath,
          watchScript,
        })
        log.warn('scheduled detached restart:', result)
        if (!result || result.ok !== true) rollbackRestart((result && result.error) || 'detached restart refused')
        else armGateWatchdog()
      }
    } catch (error) {
      rollbackRestart(String(error))
    }
  }

  /** One decision tick while a restart is pending. */
  const tick = () => {
    if (disposed) return
    if (!state.restart) {
      stopPolling()
      return
    }
    const now = Date.now()
    const busy = busyAgents()
    // A goal-driven session blocks the restart forever: park its goal BEFORE the
    // gate decides that it is blocked, so the next poll sees an idle session.
    if (busy.length > 0) {
      try {
        disarmBlockingGoals(busy)
      } catch (error) {
        log.warn('could not disarm the goals of the blocking sessions:', String(error))
      }
    }
    const decision = restartDecision(state, {
      anyAgentRunning: busy.length > 0,
      busyAgents: busy,
      lastActivityAt,
      settleMs: config.settleMs,
      now,
      softMs: config.deferSoftMs,
      hardMs: config.deferHardMs,
      policy: config.deferPolicy,
      forceRestartWhenBusy: config.forceRestartWhenBusy,
    })
    if (decision.log) log.info(decision.log)
    switch (decision.action) {
      case 'wait':
        return
      case 'warn': {
        if (!state.restart.softWarned) {
          state.restart.softWarned = true
          persist()
        }
        return
      }
      case 'restart':
      case 'force-restart': {
        void executeRestart()
        return
      }
      case 'give-up': {
        log.warn('giving up on the pending restart:', decision.reason)
        releaseRequesters()
        cancelRestart(state, { now })
        persist()
        stopPolling()
        return
      }
      default:
        return
    }
  }

  /**
   * Persist one or more user choices into the profile row of this plugin.
   *
   * The official `configEditor` service is the primary path: the choice goes
   * into the profile row of this plugin, so the settings page and the one-time
   * prompts read and write the same key (one source of truth). When the service
   * is unavailable the choice degrades to a file in the plugin's state
   * directory and a warning is logged, so the choice is never silently lost.
   *
   * @param {{ backupIncludePlugins?: boolean, showSleepButton?: boolean }} changes
   * @returns {Promise<{ applied: 'config'|'fallback-file' }>}
   */
  const persistConfigChoice = async (changes) => {
    // The profile row and the degraded fallback file use different key names for
    // the backup scope: the row carries the plugin's own key
    // (`backupIncludePlugins`), the file the short one (`includePlugins`).
    const wanted = {}
    const fallback = {}
    if (typeof changes.backupIncludePlugins === 'boolean') {
      wanted.backupIncludePlugins = changes.backupIncludePlugins
      fallback.includePlugins = changes.backupIncludePlugins
    }
    if (typeof changes.showSleepButton === 'boolean') {
      wanted.showSleepButton = changes.showSleepButton
      fallback.showSleepButton = changes.showSleepButton
    }
    const editor = resolveConfigEditor(ctx)
    if (editor !== null) {
      try {
        const entry = findOwnEntry(editor)
        if (entry !== null) {
          await editor.edit(entry, (current) => {
            const base = current && typeof current === 'object' ? { ...current } : {}
            return { ...base, ...wanted }
          })
          // The Loader reconciles the row, but the running instance must not
          // keep the old value until that happens.
          for (const [key, value] of Object.entries(wanted)) config[key] = value
          log.info(`the choice was written into the profile configuration: ${JSON.stringify(wanted)}`)
          return { applied: 'config' }
        }
        log.warn(`the configEditor service has no profile row for ${name}; the choice degrades to ${INSTALL_CHOICE_FILE}`)
      } catch (error) {
        log.warn(`could not write the choice into the profile configuration: ${describeError(error)}`)
      }
    } else {
      log.warn(`the configEditor service is unavailable; the choice degrades to ${INSTALL_CHOICE_FILE}`)
    }
    const file = path.join(path.dirname(stateFile), INSTALL_CHOICE_FILE)
    try {
      writeInstallChoice(path.dirname(stateFile), fallback)
    } catch (error) {
      throw new Error(`could not write the choice to ${file}: ${describeError(error)}`)
    }
    for (const [key, value] of Object.entries(wanted)) config[key] = value
    log.warn(`the choice was written to ${file} instead of the profile configuration`)
    return { applied: 'fallback-file' }
  }

  const runtime = {
    get state() {
      return state
    },
    get bootId() {
      return bootId
    },
    /**
     * Where the effective `backupIncludePlugins` value came from:
     * `config` (the profile row), `fallback-file` (the degraded path) or
     * `default` (nothing was ever chosen).
     */
    get backupChoiceSource() {
      return options.backupChoiceSource || 'default'
    },
    get isNewBoot() {
      return boot.isNewBoot
    },
    /**
     * Where the pre-restart backup will be taken from, and which source answered.
     * `dir` is null when no source could resolve it (the backup is then skipped).
     */
    get profileDir() {
      return resolveProfileDirDetailed()
    },
    /**
     * The rollback report the detached watcher left behind, or null.
     *
     * It means the previous restart never brought the host back and the snapshot
     * taken before that restart was restored. Read once per process: the next
     * restart clears it.
     */
    get lastRollback() {
      const report = readRollbackReport(path.dirname(stateFile))
      if (!report || report.ok !== false) return null
      const tail = typeof report.crashTail === 'string' ? report.crashTail : ''
      return {
        at: typeof report.at === 'string' ? report.at : null,
        waitedMs: Number.isFinite(report.waitedMs) ? report.waitedMs : null,
        rolledBack: report.rolledBack === true,
        backupDir: typeof report.backupDir === 'string' ? report.backupDir : null,
        crashLog: typeof report.crashLog === 'string' ? report.crashLog : null,
        crashTail: tail.length > 4000 ? tail.slice(-4000) : tail,
      }
    },
    env,
    stateFile,
    log,
    persist,
    /**
     * The one-time page tickets of this host start: the page gets one with
     * every page load, and the host spends it when the button is used.
     */
    sleepTickets: typeof options.sleepTickets === 'object' && options.sleepTickets !== null
      ? options.sleepTickets
      : createGestureTickets(),
    /**
     * Persist one or more user choices into the profile row of this plugin.
     *
     * @param {{ backupIncludePlugins?: boolean, showSleepButton?: boolean }} changes
     * @returns {Promise<{ applied: 'config'|'fallback-file' }>}
     */
    applyConfigChoice: (changes) => persistConfigChoice(changes),
    /**
     * Persist the user's one-time install choice: whether the pre-restart
     * backup also snapshots the installed plugin tree.
     *
     * @param {boolean} includePlugins
     * @returns {Promise<{ applied: 'config'|'fallback-file', includePlugins: boolean }>}
     */
    async applyBackupChoice(includePlugins) {
      const result = await persistConfigChoice({ backupIncludePlugins: includePlugins === true })
      return { applied: result.applied, includePlugins: includePlugins === true }
    },
    /**
     * Persist whether the graceful-sleep button is shown in the main UI.
     *
     * @param {boolean} showSleepButton
     * @returns {Promise<{ applied: 'config'|'fallback-file', showSleepButton: boolean }>}
     */
    async applySleepButtonChoice(showSleepButton) {
      const result = await persistConfigChoice({ showSleepButton: showSleepButton === true })
      return { applied: result.applied, showSleepButton: showSleepButton === true }
    },
    toolErrors,
    startPolling,
    stopPolling,
    tick,
    anyAgentRunning,
    executeRestart,
    flushSessions,
    releaseRequesters,
    markDisposed: () => {
      disposed = true
    },
    noteActivity,
    busyAgents,
    gate,
    sessionTitle,
    disarmGoal,
    disarmBlockingGoals,
    disarmedGoalRecords,
    parkedGoalRecords,
    goalFor,
    handoffRecord: (sessionId) => handoffRecord(state, sessionId),
    overflowFor,
    readSession,
    handoff,
    boot,
    /**
     * Re-run the boot recovery for the still-pending sessions, right now.
     *
     * This is the retry path behind `continuum_recover_now` and the POST
     * `/recover` route: a session whose agent was not live yet, or whose
     * `goals.resume` failed, can be retried without waiting for the next boot.
     * Every attempt reports its own action/detail, exactly like the boot pass.
     *
     * @param {string} [sessionId] one session, or every pending session
     * @param {{ force?: boolean }} [options] `force` re-opens one explicit session
     *   (clearing a stale over-limit record and the attempt counter) before retrying
     * @returns {Promise<object[]>} one outcome per attempted session
     */
    async recoverNow(sessionId, { force = false } = {}) {
      const target = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : null
      if (force === true && target !== null) {
        const entry = state.sessions && state.sessions[target] ? state.sessions[target] : null
        if (entry) {
          // An explicit retry re-checks the live evidence, so a stale record must
          // not keep the session out of recovery, and the attempt counter resets.
          entry.pendingResume = true
          entry.interrupted = true
          entry.pendingSince = Date.now()
          entry.resumeAttempts = 0
          entry.lastResumeError = null
          setContextOverflow(state, target, { over: false })
          // Clear the durable "never resume again" marker directly: calling the
          // handoff writer here would CREATE one (and clear pendingResume again).
          entry.handoff = null
          runtime.persist()
          log.info(`forced recovery for ${target}: cleared stale over-limit/handoff marks and the attempt counter`)
        }
      }
      const pending = recoverableSessions(state, {}).filter((entry) => (
        target === null ? true : String(entry.sessionId) === target
      ))
      if (pending.length === 0 && target !== null) {
        return [{ sessionId: target, action: 'nothing', detail: 'no-pending-recovery' }]
      }
      const results = []
      for (const entry of pending) {
        try {
          results.push(await recoverSession(ctx, runtime, entry, config))
        } catch (error) {
          const detail = describeError(error)
          setRecoveryOutcome(state, entry.sessionId, { action: 'prompt-failed', detail })
          results.push({ sessionId: entry.sessionId, action: 'prompt-failed', detail })
        }
      }
      try {
        runtime.persist()
      } catch {}
      return results
    },
  }
  return runtime
}

/**
 * Build the continuation message handed to `agent.followup`.
 *
 * This mirrors the shipped `createUserMessage` shape (`{id, role:'user', content, source}`,
 * frozen) without importing `@deepseek-ai/dsh-llm`, which a profile-installed bundle
 * cannot resolve. The `continuum` source kind keeps it distinguishable from a human
 * message: it is NOT human authority.
 *
 * @param {string} text
 * @param {{ summary?: string }} [options] one-line label of what this notice is
 * @returns {object} a frozen user message
 */
function createContinuationMessage(text, { summary } = {}) {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({
      kind: 'continuum',
      form: 'notice',
      summary: typeof summary === 'string' && summary.trim() !== ''
        ? summary.trim()
        : 'automatic continuation after a DeepSeek Harness restart',
    }),
  })
}

/**
 * Render an error-ish value (a thrown exception, a `{ code, message }` payload or
 * a plain string) as one short diagnostic string.
 * @param {unknown} value
 * @returns {string}
 */
function describeError(value) {
  if (value === null || value === undefined) return 'unknown error'
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const code = typeof value.code === 'string' && value.code !== '' ? value.code : null
    const message = typeof value.message === 'string' && value.message !== '' ? value.message : null
    if (code && message) return `${code}: ${message}`
    if (code) return code
    if (message) return message
  }
  try {
    return String(value)
  } catch {
    return 'unknown error'
  }
}

/**
 * Record the self-reported outcome of one recovery attempt for a session.
 *
 * Every return path of `recoverSession` calls this: a recovery that did nothing
 * must say WHY it did nothing, otherwise a stuck session is invisible in
 * `continuum_status` and in the `?state=1` route.
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {string} action short action label (`resume-disarmed-goal`, …)
 * @param {string|null} [detail] short human-readable reason
 */
function noteRecovery(state, sessionId, action, detail = null) {
  try {
    setRecoveryOutcome(state, sessionId, { action, detail: detail == null ? null : String(detail) })
  } catch {}
}

/**
 * Decide what a session needs after a restart and do exactly that.
 * At-most-once per boot: the resume attempt is persisted before any side effect.
 */
async function recoverSession(ctx, runtime, entry, config) {
  const log = runtime.log
  const state = runtime.state
  const sessionId = entry.sessionId
  const attemptCap = Number.isFinite(config.maxResumeAttempts) ? config.maxResumeAttempts : 2
  if (entry.resumeAttempts >= attemptCap) {
    // Retry budget exhausted: stop treating this session as recoverable so a
    // broken session can never make every boot retry forever. The failure stays
    // visible in continuum_status instead of being dropped silently.
    entry.pendingResume = false
    entry.interrupted = false
    entry.lastResumeError = entry.lastResumeError || 'resume attempts exhausted'
    noteRecovery(state, sessionId, 'nothing', 'resume-attempts-exhausted')
    runtime.persist()
    log.info(`giving up on session ${sessionId}: resume attempts exhausted`, { lastResumeError: entry.lastResumeError })
    return { sessionId, action: 'nothing', detail: 'resume-attempts-exhausted', error: entry.lastResumeError }
  }

  // CONTEXT-OVERFLOW GUARD. A session whose conversation outgrew the model window
  // can neither continue nor be compacted (the compaction request needs the same
  // oversized context): every request to it fails with "context window exceeds
  // limit". Re-arming its goal or queueing a continuation message into it can
  // therefore only fail, so the guard runs BEFORE the goal re-arm and before the
  // disarm decision. Evidence: a verdict an earlier pass already recorded, or the
  // LIVE session (the newest assistant message's `usage.inputTokens` versus the
  // session's `contextWindow`, or a recent context-window failure). Unknown
  // numbers never block the normal path.
  const recordedOverflow = entry.contextOverflow && entry.contextOverflow.over === true
    ? entry.contextOverflow
    : null
  // The LIVE session is authoritative. A record is only a fallback for a session
  // this process cannot read at all; a record whose evidence no longer holds (for
  // example a false positive from an older detector) is cleared instead of
  // keeping the session out of recovery forever.
  let liveReadable = false
  try {
    const read = runtime.readSession(sessionId)
    liveReadable = Boolean(read && read.session)
  } catch {
    liveReadable = false
  }
  let overflow = null
  if (liveReadable) {
    try {
      overflow = runtime.overflowFor(sessionId)
    } catch {
      overflow = null
    }
    if ((!overflow || overflow.over !== true) && recordedOverflow !== null) {
      setContextOverflow(state, sessionId, { over: false })
      runtime.persist()
      log.info(`cleared a stale over-limit record for ${sessionId}: the live session is not over the window`)
    }
  } else if (recordedOverflow !== null) {
    overflow = {
      over: true,
      inputTokens: Number.isFinite(recordedOverflow.inputTokens) ? recordedOverflow.inputTokens : null,
      contextWindow: Number.isFinite(recordedOverflow.contextWindow) ? recordedOverflow.contextWindow : null,
      detail: typeof recordedOverflow.detail === 'string' && recordedOverflow.detail !== ''
        ? recordedOverflow.detail
        : 'the session is over the model context window (recorded by an earlier recovery)',
    }
  }
  if (overflow && overflow.over === true) {
    const detail = typeof overflow.detail === 'string' && overflow.detail !== ''
      ? overflow.detail
      : 'the session is over the model context window'
    setContextOverflow(state, sessionId, {
      over: true,
      inputTokens: overflow.inputTokens,
      contextWindow: overflow.contextWindow,
      detail,
      detectedAt: Date.now(),
    })
    // Out of the automatic resume path for good: the goal is NOT re-armed, no
    // continuation message is queued, and `recoverableSessions` skips an
    // over-limit entry from now on. The recovery attempt is still reported.
    entry.pendingResume = false
    entry.interrupted = false
    noteRecovery(state, sessionId, 'context-overflow', detail)
    runtime.persist()
    log.warn(`session ${sessionId} is over the model context window and is NOT re-armed: hand it off with continuum_handoff`, { detail })
    return { sessionId, action: 'context-overflow', detail, overContextLimit: true }
  }

  // Persist the attempt BEFORE any side effect, so a crash cannot double-resume and
  // a failing resume still counts against the budget.
  entry.resumeAttempts += 1
  entry.lastResumeAt = Date.now()
  runtime.persist()

  let agent
  try {
    agent = ctx.agents.get(sessionId)
  } catch {
    agent = undefined
  }

  if (agent === undefined) {
    // Resolve the controller defensively: the declared dependency first, then the
    // optional lookup (a late-provided service still resumes this way).
    let controller = null
    let controllerPath = 'none'
    try {
      if (ctx.sessionController && typeof ctx.sessionController === 'object') {
        controller = ctx.sessionController
        controllerPath = 'inject'
      }
    } catch {}
    if (controller === null) {
      try {
        const viaGet = ctx.get('sessionController')
        if (viaGet && typeof viaGet === 'object') {
          controller = viaGet
          controllerPath = 'get'
        }
      } catch {}
    }
    const canResolve = Boolean(controller) && typeof controller.resolveAgent === 'function'
    const canPrompt = Boolean(controller) && typeof controller.prompt === 'function'

    // Fallback: the controller prompt RESUMES a cold session and admits the
    // message in one step, so it can replace resolveAgent + followup entirely.
    if (!canResolve) {
      if (canPrompt) {
        const text = continuationPrompt(entry, {
          reason: (Array.isArray(entry.reasons) && entry.reasons[entry.reasons.length - 1]) || 'host restart',
          override: config.continuationText,
        })
        try {
          await controller.prompt({
            requestId: crypto.randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          })
          entry.pendingResume = false
          entry.running = false
          entry.interrupted = false
          entry.lastResumeError = null
          noteRecovery(state, sessionId, 'resume-via-prompt', `sessionController.prompt (${controllerPath})`)
          runtime.persist()
          log.info(`resumed ${sessionId} through sessionController.prompt (${controllerPath})`)
          return { sessionId, action: 'resume-via-prompt', detail: `sessionController.prompt (${controllerPath})`, controllerPath }
        } catch (error) {
          const detail = describeError(error)
          entry.lastResumeError = detail
          noteRecovery(state, sessionId, 'prompt-failed', detail)
          runtime.persist()
          log.warn(`sessionController.prompt failed for ${sessionId}:`, detail)
          return { sessionId, action: 'prompt-failed', detail, error: detail, controllerPath }
        }
      }
      const detail = controller === null
        ? 'the session controller is not reachable (neither the declared inject nor ctx.get returned it)'
        : 'the session controller exposes neither resolveAgent nor prompt'
      log.warn('sessionController is unavailable; cannot resume', sessionId, detail)
      noteRecovery(state, sessionId, 'session-controller-unavailable', detail)
      runtime.persist()
      return { sessionId, action: 'session-controller-unavailable', detail, controllerPath }
    }
    // A freshly reloaded profile can expose the live agent a moment after the
    // state file was written, so a THROWN error is retried inside the same boot
    // (up to RESOLVE_RETRY_ATTEMPTS extra attempts).
    // A returned `{ error }` is the controller's STABLE answer (the session is
    // gone): it is final and is NOT retried, so one boot makes exactly ONE
    // persistent attempt per session and `resumeAttempts` grows once per boot.
    let result
    let lastError = null
    let thrown = false
    const retries = RESOLVE_RETRY_ATTEMPTS
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        result = await controller.resolveAgent(sessionId)
        lastError = result && result.error ? describeError(result.error) : null
        thrown = false
      } catch (error) {
        result = undefined
        lastError = describeError(error)
        thrown = true
      }
      if (!lastError) break
      if (!thrown) break
      if (attempt < retries) {
        log.warn(`resolveAgent failed for ${sessionId} (attempt ${attempt + 1}); retrying:`, lastError)
        await recoveryDelay(config.resumeRetryDelayMs)
      }
    }
    if (lastError) {
      // Keep pendingResume: the session stays recoverable on a later boot (or a
      // later continuum_recover_now retry), but the failure is visible instead of
      // vanishing.
      entry.lastResumeError = lastError
      noteRecovery(state, sessionId, 'agent-not-live', lastError)
      runtime.persist()
      log.warn(`could not resume ${sessionId}:`, lastError)
      return { sessionId, action: 'agent-not-live', detail: lastError, error: lastError }
    }
    agent = result && result.agent
    if (agent) {
      noteRecovery(state, sessionId, 'resume-via-resolve-agent', `sessionController.resolveAgent (${controllerPath})`)
      runtime.persist()
    }
  }
  if (!agent) {
    entry.lastResumeError = 'resolveAgent returned no agent'
    noteRecovery(state, sessionId, 'agent-not-live', entry.lastResumeError)
    runtime.persist()
    return { sessionId, action: 'agent-not-live', detail: entry.lastResumeError, error: entry.lastResumeError }
  }

  let goal
  let goalLookupError = null
  try {
    goal = ctx.goals.get(agent)
  } catch (error) {
    goalLookupError = describeError(error)
    log.warn(`goals.get failed for ${sessionId}:`, goalLookupError)
  }
  if (!goal || typeof goal !== 'object') {
    goal = undefined
    if (goalLookupError === null) goalLookupError = 'goals.get returned no goal'
  }

  const disarmed = disarmedRecord(state, sessionId)
  const legacyParked = parkedRecord(state, sessionId)
  let resumeError = null
  let resumeAction = null

  // (1) The goal THIS plugin disarmed before the restart: it is still durably
  // `active` and only its activation is `disarmed`, so re-arming it with its
  // current revision lets the goal round driver continue the work.
  if (goal && disarmed && goal.phase === 'active' && goal.activation === 'disarmed' && disarmed.goalId === goal.id) {
    resumeAction = 'resume-disarmed-goal'
  }

  // (2) The goal the PREVIOUS (pause-based) build PAUSED: we paused it, so we may
  // resume it. A goal the USER paused has no record and must stay paused.
  if (resumeAction === null && goal && legacyParked && goal.phase === 'paused' && legacyParked.goalId === goal.id) {
    resumeAction = 'resume-paused-goal'
  }

  // (3) The already proven boot path: an active goal whose continuation authority
  // is gone is re-armed (the host may have disarmed it on shutdown).
  if (
    resumeAction === null
    && goal
    && goal.phase === 'active'
    && goal.activation === 'disarmed'
    && goal.roundsStarted < goal.maxGoalRounds
  ) {
    resumeAction = 'rearm-goal'
  }

  if (resumeAction !== null) {
    try {
      ctx.goals.resume(agent, { id: goal.id, revision: goal.revision })
      // The goal is armed again: stamp the record(s) of this session with the
      // resume timestamp, so the status shows the goal as resumed (the record is
      // reporting only — it never decides whether a goal may be disarmed).
      stampResumedGoal(state, sessionId, { resumedAt: Date.now() })
      entry.pendingResume = false
      entry.running = false
      entry.interrupted = false
      entry.lastResumeError = null
      entry.goal = { goalId: goal.id, goalRevision: goal.revision + 1, phase: 'active' }
      noteRecovery(state, sessionId, resumeAction, `goal ${goal.id} is armed again`)
      runtime.persist()
      log.info(`${resumeAction}: goal ${goal.id} of session ${sessionId} is armed again; the goal round driver continues the work`)
      return { sessionId, action: resumeAction, goalId: goal.id, detail: `goal ${goal.id} is armed again` }
    } catch (error) {
      // Stale revision or an exhausted round budget: fall back to the
      // continuation message and KEEP the record, so a later boot (or a manual
      // continuum_recover_now retry) can try to resume the goal again.
      resumeError = describeError(error)
      entry.lastResumeError = resumeError
      log.warn(`could not resume goal ${goal.id} of ${sessionId} (${resumeAction}):`, resumeError)
    }
  }

  if (!entry.pendingResume && !entry.interrupted) {
    if (resumeError) {
      entry.lastResumeError = resumeError
      noteRecovery(state, sessionId, resumeAction || 'nothing', `resume failed: ${resumeError}`)
      runtime.persist()
      return { sessionId, action: resumeAction || 'nothing', detail: `resume failed: ${resumeError}`, error: resumeError }
    }
    noteRecovery(state, sessionId, resumeAction || 'nothing', resumeAction ? 'goal handled, session not pending' : 'session-not-pending')
    runtime.persist()
    return { sessionId, action: resumeAction || 'nothing', detail: 'session-not-pending' }
  }

  // A failed goal lookup is not a reason to skip the session: the continuation
  // message still makes progress, and the reason is recorded for the operator.
  let pendingAction = 'prompt-continuation'
  let pendingDetail = resumeError ? `goal resume failed: ${resumeError}` : 'continuation message queued'
  if (goal === undefined) {
    pendingAction = 'goal-lookup-failed'
    pendingDetail = `${goalLookupError || 'goals.get returned no goal'}; continuation message queued`
  }

  // Inject exactly one continuation message through the live agent's inbox. The
  // Remote-facing `sessionController.prompt` is NOT usable here: its in-process
  // signature is `prompt(request, signal)` and it hardcodes a human `user` source.
  if (typeof agent.followup !== 'function') {
    log.warn('the resumed agent exposes no followup(); cannot inject the continuation prompt')
    noteRecovery(state, sessionId, 'prompt-failed', 'the agent exposes no followup()')
    runtime.persist()
    return { sessionId, action: 'prompt-failed', detail: 'the agent exposes no followup()' }
  }
  const text = continuationPrompt(entry, {
    reason: (Array.isArray(entry.reasons) && entry.reasons[entry.reasons.length - 1]) || 'host restart',
    override: config.continuationText,
  })
  try {
    agent.followup(createContinuationMessage(text))
  } catch (error) {
    const detail = describeError(error)
    log.warn(`continuation message rejected for ${sessionId}:`, detail)
    noteRecovery(state, sessionId, 'prompt-failed', detail)
    runtime.persist()
    return { sessionId, action: 'prompt-failed', detail }
  }
  entry.pendingResume = false
  entry.running = false
  entry.interrupted = false
  entry.lastResumeError = resumeError
  noteRecovery(state, sessionId, pendingAction, pendingDetail)
  runtime.persist()
  log.info(`queued a continuation message for session ${sessionId}`)
  return { sessionId, action: pendingAction, detail: pendingDetail }
}

/** The boot recovery pass. Runs once per host boot, bounded and idempotent. */
async function recoverAfterRestart(ctx, runtime, config) {
  const log = runtime.log
  const state = runtime.state
  const plan = bootPlan(state, { resumeOnBoot: config.resumeOnBoot, limit: config.maxSessions })
  if (!plan.recover) {
    setPhase(state, 'idle')
    // A restart that was requested before the last shutdown has been consumed by
    // this boot; never leave a stale pending restart behind.
    if (state.restart) cancelRestart(state, { now: Date.now() })
    persistSafely(runtime)
    log.info('no interrupted work to recover')
    return { recovered: [], phase: 'idle' }
  }
  setPhase(state, 'recovering')
  persistSafely(runtime)
  log.info('recovering after restart:', {
    generation: state.generation,
    sessions: plan.sessions.map((entry) => entry.sessionId),
    restartWasPending: plan.restartWasPending,
  })

  // Recover in batches of `maxSessions` and keep going until nothing recoverable
  // is left: one coalesced restart can leave more pending sessions than a single
  // batch, and every requester must be woken in THIS boot, not the next one.
  const results = []
  const batchSize = Math.max(1, Number.isFinite(config.maxSessions) ? Math.trunc(config.maxSessions) : 4)
  const maxBatches = 5
  const batchDelayMs = Number.isFinite(config.recoveryBatchDelayMs) ? config.recoveryBatchDelayMs : 1200
  const attempted = new Set()
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const pending = recoverableSessions(state, {})
      .filter((entry) => !attempted.has(entry.sessionId))
      .slice(0, batchSize)
    if (pending.length === 0) break
    if (batch > 0) {
      log.info('recovery batch', { batch: batch + 1, sessions: pending.map((entry) => entry.sessionId) })
    }
    for (const entry of pending) {
      attempted.add(entry.sessionId)
      try {
        results.push(await recoverSession(ctx, runtime, entry, config))
      } catch (error) {
        log.warn(`recovery failed for ${entry.sessionId}:`, String(error))
        results.push({ sessionId: entry.sessionId, action: 'threw' })
      }
    }
    // Pause between batches so the resumed turns can start before the next wave.
    if (batch + 1 < maxBatches && recoverableSessions(state, {}).some((entry) => !attempted.has(entry.sessionId))) {
      await recoveryDelay(batchDelayMs)
    }
  }

  if (state.restart) {
    cancelRestart(state, { now: Date.now() })
  }
  setPhase(state, 'running')
  // Never cap away recoverable work: keep every pending entry, only expire
  // finished ones by age so an unfinished backlog still recovers next boot.
  pruneSessions(state, {
    maxSessions: Infinity,
    now: Date.now(),
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  })
  const leftover = recoverableSessions(state, {})
  if (leftover.length > 0) {
    log.warn('recovery left sessions pending after the batch cap; they stay checkpointed for the next boot', {
      pending: leftover.map((entry) => entry.sessionId),
      batches: maxBatches,
      maxSessions: config.maxSessions,
    })
  }
  persistSafely(runtime)
  log.info('recovery finished:', results)
  return { recovered: results, phase: 'running' }
}

/** Promise-based pause used by boot recovery (batching + resolveAgent retries). */
function recoveryDelay(ms) {
  const wait = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (wait === 0) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(resolve, wait)
  })
}

/** Persist without letting a checkpoint failure escape into the boot path. */
function persistSafely(runtime) {
  try {
    runtime.persist()
  } catch {}
}

/** Register the model-facing lifecycle tools. */
function registerTools(ctx, runtime, config) {
  const log = runtime.log

  /**
   * Register one tool.
   *
   * The disposer returned by `ctx.tools.register` is handed to `ctx.effect`, so
   * the HOST owns it: when the plugin row is disabled (or the plugin is
   * hot-reloaded) the fiber disposes the effect and the tool is unregistered
   * together with the HTTP routes. Registering it bare would leave the tools of
   * the OLD instance registered (and the new instance's registration would fail
   * as a duplicate), so the host could serve the tools of an instance whose
   * routes are already gone.
   *
   * A failed registration is recorded in `runtime.toolErrors` and logged; it is
   * never thrown, so one broken tool can never stop the plugin from loading.
   */
  const tool = (definition) => {
    const name = definition && definition.name ? String(definition.name) : null
    try {
      ctx.effect(
        () => ctx.tools.register(definition),
        `dsh-autorestart: tool ${name ?? 'unknown'}`,
      )
    } catch (error) {
      runtime.toolErrors.push({ tool: name, error: describeError(error) })
      log.warn(`could not register tool ${name}:`, String(error))
    }
  }

  const textOutput = (schema, render) => ({ schema, render })

  /**
   * The blocking sessions with the reason each one blocks: a session that is
   * held by an armed goal reports `goal-active`, a goal whose round budget is
   * used up reports `goal-exhausted`, and the original busy reason is kept as
   * `busyReason`.
   */
  const blockingDetails = (blockedBy) => goalAwareBlockingDetails(runtime, blockedBy)

  /** The goals this plugin parked, with the outcome of the resume. */
  const parkedGoalDetails = () => parkedGoalList(runtime)

  tool({
    name: 'continuum_restart',
    description:
      'Ask DeepSeek Harness to restart gracefully: the restart waits until EVERY conversation is idle '
      + '(no running turn and no queued inbox work, other sessions, subagents and teammates included) and '
      + 'the host has been quiet for settleMs (default 2000 ms); a hard deadline only forces it when '
      + 'forceRestartWhenBusy is enabled, otherwise the restart keeps waiting for the other conversations. '
      + 'Other conversations are never killed mid-turn: the detached helper re-checks this idle gate '
      + 'over loopback immediately before it kills the process. After the restart this '
      + 'plugin resumes this session and continues the work automatically. A goal-driven session is '
      + 'DISARMED before the restart (pass parkGoals:false to turn that off): disarming only removes the '
      + 'process-local continuation authority, so the round that is running right now still finishes normally '
      + '(no turn is cancelled and nothing is lost), no new round starts, and after the restart the goal is '
      + 're-armed and continues. A goal whose round budget is spent cannot be continued and is reported '
      + 'instead. Write your final message '
      + 'in this turn, then stop calling tools — the restart fires as soon as the turn goes idle. '
      + 'Use it only when a restart is genuinely required (for example to load an installed plugin update).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'Why the restart is needed; recorded in the checkpoint and shown in the log.' },
        resume: { type: 'boolean', description: 'Resume this session after the restart (default true).' },
        defer_seconds: { type: 'number', description: 'Optional extra seconds to wait before the first idle check.' },
        parkGoals: { type: 'boolean', description: 'Disarm the goal of a goal-driven session before the restart (default true). Disarming keeps the durable goal active and lets the current round finish; after the restart the goal is re-armed and continues. With false no goal is disarmed, so a goal-driven session may keep the restart waiting.' },
      },
    },
    output: textOutput(
      {
        type: 'object',
        additionalProperties: false,
        required: ['accepted', 'generation', 'phase', 'willResume'],
        properties: {
          accepted: { type: 'boolean' },
          generation: { type: 'integer' },
          phase: { type: 'string' },
          willResume: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    ),
    execute(args = {}, exec) {
      const state = runtime.state
      const now = Date.now()
      const agent = exec && exec.agent
      const sessionId = agent && agent.id ? String(agent.id) : undefined
      const resume = args.resume !== false
      const parkGoals = args.parkGoals !== false
      requestRestart(state, {
        reason: typeof args.reason === 'string' && args.reason.trim() !== '' ? args.reason.trim() : 'agent requested restart',
        bySessionId: sessionId,
        resume,
        parkGoals,
        now,
      })
      if (sessionId && resume) {
        markPendingResume(state, {
          sessionId,
          reason: 'agent-requested restart',
          goalId: state.sessions[sessionId] && state.sessions[sessionId].goal ? state.sessions[sessionId].goal.goalId : undefined,
          now,
        })
      }
      if (typeof args.defer_seconds === 'number' && Number.isFinite(args.defer_seconds) && args.defer_seconds > 0) {
        state.restart.requestedAt = now + Math.min(args.defer_seconds, 3600) * 1000
      }
      runtime.persist()
      runtime.startPolling()
      log.info('restart requested', { generation: state.generation, sessionId, resume, parkGoals })
      return {
        accepted: true,
        generation: state.generation,
        phase: state.phase,
        willResume: resume && Boolean(sessionId),
        note: parkGoals
          ? 'The restart runs at the next safe point (all agents idle). Keep this reply short; the session resumes afterwards.'
          : 'The restart runs at the next safe point (all agents idle), but no goal is parked: a goal-driven session keeps its own agent busy and may therefore keep the restart waiting.',
      }
    },
  })

  tool({
    name: 'continuum_status',
    description:
      'Report the dsh-autorestart lifecycle: whether a restart is pending, which sessions were '
      + 'checkpointed as interrupted or continuation-pending, why each blocking session blocks '
      + '("goal-active" = an armed goal keeps it busy, "goal-exhausted" = its goal can no longer be '
      + 'resumed), the goals this plugin disarmed, the last recovery action/detail per session, '
      + 'whether a session was handed off to a fresh session (target session id and time) or is over '
      + 'the model context window (such a session is never auto-resumed), whether the pre-restart '
      + 'backup also snapshots the installed plugins (backupIncludePlugins), the '
      + 'resolved state-file path, and the detected restart environment. Read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_sessions: { type: 'boolean', description: 'Include the per-session checkpoint entries (default true).' },
      },
    },
    output: textOutput(
      {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'summary'],
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          stateFile: { type: 'string' },
          phase: { type: 'string' },
          generation: { type: 'integer' },
          pendingRestart: { type: 'boolean' },
          gateAllow: { type: 'boolean' },
          quietForMs: { type: 'number' },
          blockedBy: { type: 'array', items: { type: 'object' } },
          parkedGoals: { type: 'array', items: { type: 'object' } },
          recovery: { type: 'array', items: { type: 'object' } },
          handoffs: { type: 'array', items: { type: 'object' } },
          profileDir: { type: 'string' },
          profileDirSource: { type: 'string' },
          backupIncludePlugins: { type: 'boolean' },
          lastRollback: { type: 'object' },
          environment: { type: 'object' },
          sessions: { type: 'array', items: { type: 'object' } },
        },
      },
      (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ),
    execute(args = {}) {
      const state = runtime.state
      const includeSessions = args.include_sessions !== false
      const verdict = runtime.gate()
      return {
        ok: true,
        summary: describeState(state),
        stateFile: runtime.stateFile,
        phase: state.phase,
        generation: state.generation,
        pendingRestart: state.restart !== null,
        gateAllow: verdict.allow,
        quietForMs: Math.round(verdict.quietForMs),
        blockedBy: blockingDetails(verdict.blockedBy),
        parkedGoals: parkedGoalDetails(),
        recovery: recoveryList(state),
        handoffs: diagnosticSessions(state),
        // Where the pre-restart backup comes from (null dir = it would be skipped).
        profileDirSource: runtime.profileDir.source,
        ...(runtime.profileDir.dir ? { profileDir: runtime.profileDir.dir } : {}),
        // Whether the pre-restart backup also snapshots the installed plugins.
        backupIncludePlugins: config.backupIncludePlugins !== false,
        // Present only when the previous restart had to be rolled back.
        ...(runtime.lastRollback ? { lastRollback: runtime.lastRollback } : {}),
        environment: {
          platform: runtime.env.platform,
          isDesktopApp: runtime.env.isDesktopApp,
          appExePath: runtime.env.appExePath,
          pid: runtime.env.pid,
          ppid: runtime.env.ppid,
          restartMode: config.restartMode,
        },
        ...(includeSessions
          ? {
              sessions: [
                ...recoverableSessions(state, { limit: 50 }).map((entry) => ({
                  ...entry,
                  // Diagnostics: the last resolveAgent failure for this session (null when healthy).
                  lastResumeError: entry.lastResumeError ?? null,
                  handedOff: false,
                  overContextLimit: false,
                })),
                // A handed-off or over-limit session is out of the automatic resume
                // path, so it is listed here instead of vanishing from the report.
                ...diagnosticSessions(state, { limit: 50 }),
              ],
            }
          : {}),
      }
    },
  })

  tool({
    name: 'continuum_park_goal',
    description:
      'Disarm the durable goal of a session so a pending restart can proceed: a goal-driven '
      + 'session keeps its own agent busy forever (the goal round driver starts the next round '
      + 'immediately), so the restart would wait forever behind it. Disarming only removes the '
      + 'process-local continuation authority: the goal stays active, the round that is running '
      + 'right now still finishes normally (no turn is cancelled and nothing is lost), and no new '
      + 'round starts. After the next restart the goal is re-armed automatically and continues. '
      + 'Without a sessionId the goal of the calling session is disarmed. A goal whose round budget '
      + 'is spent can never be continued, so it is reported instead of disarmed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'The session whose goal should be disarmed (default: the calling session).' },
      },
    },
    output: textOutput(
      {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'disarmed'],
        properties: {
          ok: { type: 'boolean' },
          disarmed: { type: 'boolean' },
          sessionId: { type: 'string' },
          goalId: { type: 'string' },
          reason: { type: 'string' },
          error: { type: 'string' },
        },
      },
      (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    ),
    execute(args = {}, exec) {
      const agent = exec && exec.agent
      const callerId = agent && agent.id ? String(agent.id) : undefined
      const requested = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
      const sessionId = requested !== '' ? requested : callerId
      if (!sessionId) {
        return { ok: false, disarmed: false, reason: 'no-session' }
      }
      const result = runtime.disarmGoal(sessionId, sessionId === callerId ? agent : undefined)
      const payload = {
        ok: true,
        disarmed: result.disarmed === true,
        sessionId,
        reason: result.reason,
      }
      if (result.goalId !== undefined && result.goalId !== null) payload.goalId = String(result.goalId)
      if (result.error) payload.error = String(result.error)
      return payload
    },
  })

  tool({
    name: 'continuum_recover_now',
    description:
      'Retry the post-restart recovery RIGHT NOW instead of waiting for the next restart. Use it when '
      + 'a session is still stuck after a restart: its goal has not been re-armed yet, or its agent was '
      + 'not live when the boot recovery ran. Optional sessionId retries one session; without one every '
      + 'pending session is retried. Returns, per session, the action that was taken (for example '
      + '"resume-disarmed-goal", "resume-paused-goal", "rearm-goal", "prompt-continuation", '
      + '"agent-not-live", "goal-lookup-failed", "nothing") and a short detail.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'Retry only this session (default: every pending session).' },
        force: {
          type: 'boolean',
          description: 'Re-open this explicit session before retrying: clears a stale over-limit / handoff mark and resets the attempt counter.',
        },
      },
    },
    output: textOutput(
      {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'results'],
        properties: {
          ok: { type: 'boolean' },
          results: { type: 'array', items: { type: 'object' } },
        },
      },
      (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ),
    async execute(args = {}) {
      const requested = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
      const results = await runtime.recoverNow(requested !== '' ? requested : undefined, { force: args.force === true })
      return { ok: true, results }
    },
  })

  tool({
    name: 'continuum_handoff',
    description:
      'Hand a session whose conversation exceeded the model context window off to a FRESH session. '
      + 'Such a session is dead: every request to it fails with "context window exceeds limit", and '
      + 'compacting it needs the same oversized context. The handoff carries the goal objective, the '
      + 'recorded checkpoint reasons and a bounded tail of the conversation (default 20000 characters, '
      + '`maxChars`) into a new live session in the same working directory, marks the old session as '
      + 'handed off (so it is never auto-resumed again) and disarms its goal. The old session and its '
      + 'conversation are kept, untouched. Without `sessionId` the calling session is handed off. It '
      + 'reports the new session id, how many characters were carried, and what the human should do.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'The over-limit session to hand off (default: the calling session).' },
        maxChars: { type: 'number', description: 'Character budget of the carried conversation tail (default 20000).' },
      },
    },
    output: textOutput(
      {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          sourceSessionId: { type: 'string' },
          carriedChars: { type: 'number' },
          carriedTailChars: { type: 'number' },
          disarmedGoal: { type: 'boolean' },
          error: { type: 'string' },
          detail: { type: 'string' },
          instruction: { type: 'string' },
        },
      },
      (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ),
    async execute(args = {}, exec) {
      const agent = exec && exec.agent
      const requested = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
      return runtime.handoff({
        sessionId: requested !== '' ? requested : undefined,
        maxChars: typeof args.maxChars === 'number' && Number.isFinite(args.maxChars) && args.maxChars > 0
          ? args.maxChars
          : undefined,
        callerAgent: agent,
      })
    },
  })

  tool({
    name: 'continuum_cancel_restart',
    description: 'Cancel a restart previously requested through continuum_restart. Does nothing when no restart is pending.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'Optional note recorded in the log.' },
      },
    },
    output: textOutput(
      {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'cancelled'],
        properties: {
          ok: { type: 'boolean' },
          cancelled: { type: 'boolean' },
          phase: { type: 'string' },
        },
      },
      (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    ),
    execute(args = {}) {
      const state = runtime.state
      const hadPending = state.restart !== null
      runtime.releaseRequesters()
      cancelRestart(state, { now: Date.now() })
      runtime.stopPolling()
      runtime.persist()
      if (hadPending) log.info('pending restart cancelled:', typeof args.reason === 'string' ? args.reason : '(no reason)')
      return { ok: true, cancelled: hadPending, phase: state.phase }
    },
  })
}

/**
 * Inject a tiny boot-token heartbeat into the served index. A `dsh web` page keeps its
 * WebSocket after the host process dies; when the backend comes back with a new
 * `bootId`, the page reloads itself instead of staying frozen on a dead connection.
 *
 * @param {string} html
 * @param {string} bootId
 * @param {string} routePath
 * @returns {string}
 */
function injectPageHeartbeat(html, bootId, routePath) {
  if (typeof html !== 'string') return html
  if (html.includes('data-dsh-autorestart-heartbeat')) return html
  const script = [
    '<script data-dsh-autorestart-heartbeat>',
    `window.__DSH_AUTORESTART_BOOT__=${JSON.stringify(bootId)};`,
    '(function(){try{var boot=window.__DSH_AUTORESTART_BOOT__;if(!boot)return;',
    'var t=setInterval(function(){fetch(',
    JSON.stringify(routePath),
    ",{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(j){",
    'if(!j||!j.bootId)return;if(j.bootId!==boot){clearInterval(t);location.reload();}}).catch(function(){});',
    '},4000);}catch(e){}})();',
    '</script>',
  ].join('')
  return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`
}

/**
 * Inject the one-time page ticket into the served index.
 *
 * The ticket is the proof that a request comes from a page this host
 * served: a shell script on the same machine cannot read it out of the
 * page, so it cannot drive the shutdown in the `human` mode.
 *
 * @param {string} html
 * @param {{ ticket: string, issuedAt: number }} grant
 * @returns {string}
 */
function injectSleepTicket(html, grant) {
  if (typeof html !== 'string') return html
  if (html.includes('data-dsh-autorestart-sleep-ticket')) return html
  if (!grant || typeof grant.ticket !== 'string' || grant.ticket === '') return html
  const script = [
    '<script data-dsh-autorestart-sleep-ticket>',
    `window.__DSH_SLEEP_TICKET__=${JSON.stringify({ ticket: grant.ticket, issuedAt: grant.issuedAt })};`,
    '</script>',
  ].join('')
  return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`
}

/**
 * The system-prompt section that makes the restart policy discoverable to every agent:
 * call `continuum_restart` instead of killing the app by hand. This is a real Host hook,
 * so it applies without touching any AGENTS.md.
 */
const AUTORESTART_PROMPT = [
  '## Restart policy (dsh-autorestart)',
  '- When DeepSeek Harness itself must restart (for example to load an installed or updated plugin bundle), do NOT kill or relaunch the app yourself with pwsh/taskkill/Stop-Process/npm scripts. A hard guard blocks such commands anyway (denials mention `blockManualRestart`).',
  '- Call the `continuum_restart` tool instead (optional arguments: `reason`, `resume`, `defer_seconds`, `parkGoals`). It waits until every conversation is idle (no running turn, no queued inbox work) AND the host has been quiet for `settleMs` (default 2000 ms); the detached helper re-checks that gate immediately before killing, so other conversations are never killed mid-turn. It then relaunches the app, and after boot this plugin resumes the session and continues the work automatically.',
  '- A goal-driven session is DISARMED automatically before the restart (its current round still finishes, nothing is lost), because such a session would otherwise keep the restart waiting forever: disarming only removes the process-local continuation authority, so no new round starts and the session goes idle. After the restart the goal is re-armed and continues. A goal whose round budget is spent cannot be continued and is reported instead. You can disarm your own goal on demand with `continuum_park_goal`, and retry a stuck recovery with `continuum_recover_now`.',
  '- Persist anything the next turn needs before restarting (workspace files, `todo_write`, goal state); do not rely on in-memory state.',
  '- Inspect the lifecycle with `continuum_status`; cancel a pending restart with `continuum_cancel_restart`.',
  '- A session whose context exceeds the model window can be handed off to a fresh session with `continuum_handoff` (it carries the goal objective, the recorded reasons and a bounded tail of the conversation); this plugin refuses to auto-resume such a session, so hand it off instead of retrying it.',
  '- For multi-turn objectives prefer a durable goal (`create_goal`): after a restart the plugin re-arms it and the goal round driver keeps producing rounds. No goal is required for restart continuation — without one the plugin injects a single continuation message that continues the work in a fresh turn.',
].join('\n')

/** Register the restart-policy section in the global system prompt. */
function registerSystemPrompt(ctx, runtime) {
  let systemPrompt
  try {
    systemPrompt = ctx.get('systemPrompt')
  } catch {
    systemPrompt = undefined
  }
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    runtime.log.warn('systemPrompt.section is unavailable; the restart policy will not be advertised to agents')
    return false
  }
  let order = 1000
  try {
    if (typeof systemPrompt.getSectionOrder === 'function') {
      const base = systemPrompt.getSectionOrder('HARNESS_IDENTITY')
      if (Number.isFinite(base)) order = base + 1
    }
  } catch {}
  try {
    ctx.effect(
      () => systemPrompt.section({
        name: 'dsh-autorestart:restart-policy',
        order,
        interpolate: false,
        text: AUTORESTART_PROMPT,
      }),
      'dsh-autorestart: system prompt section',
    )
    runtime.systemPrompt = true
    return true
  } catch (error) {
    runtime.log.warn('could not register the system prompt section:', String(error))
    return false
  }
}

/**
 * Tools whose parsed arguments can carry a shell command or runnable code. Kept narrow
 * on purpose: a file write or a web request mentioning "taskkill" must never be blocked.
 */
const COMMAND_TOOL_PATTERN = /(pwsh|powershell|bash|shell|terminal|run_code|code|exec|subprocess|command|script|workflow)/i

/** Anything that can end the DSH process or start a replacement one. */
const KILL_VERB_PATTERN = /\b(taskkill|stop-process|pkill|kill|shutdown|restart-computer|stop-computer|terminate|kill-port)\b|process\.kill|\.kill\(|\bwmic\b[^\n]*\bdelete\b|\bschtasks\b/i

/** The desktop application this plugin restarts (also the wildcard/loose process-name forms). */
const APP_NAME_PATTERN = /deepseek[\s_-]?harness|deep[\W_]{0,4}harness/i

/** A generic DeepSeek process selector next to a kill verb. */
const DEEPSEEK_PATTERN = /\bdeepseek\b/i

/** Operating-system shutdown/reboot forms that always take DSH down with them. */
const OS_SHUTDOWN_PATTERN = /\bshutdown\b[^\n]*?(?:\/r|\/s|\/p|-r|-s|-h)\b|\b(?:restart-computer|stop-computer)\b/i

/** Returned to the model when the guard denies a manual restart. */
const MANUAL_RESTART_DENIAL = [
  'Blocked by dsh-autorestart: shutting down or relaunching DeepSeek Harness by hand is disabled by the',
  'plugin\'s restart policy. Use the `continuum_restart` tool instead: it waits until every agent is',
  'idle, relaunches the app through a detached helper, and resumes this session afterwards.',
  'If a manual restart is genuinely required, set `blockManualRestart: false` in the dsh-autorestart',
  'row config (or ask the user to do it).',
].join(' ')

/** Recursively collect string leaves from parsed tool arguments. */
function collectArgumentStrings(value, out = [], depth = 0) {
  if (value === null || value === undefined) return out
  if (typeof value === 'string') {
    if (value.length > 0 && value.length <= 200_000) out.push(value)
    return out
  }
  if (depth >= 4) return out
  if (Array.isArray(value)) {
    for (const item of value) collectArgumentStrings(item, out, depth + 1)
    return out
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectArgumentStrings(item, out, depth + 1)
  }
  return out
}

/**
 * Decide whether one pending tool call would manually stop or relaunch DSH.
 *
 * @param {{ name?: string, arguments?: unknown } | null | undefined} exec
 * @param {{ pid?: number, ppid?: number }} [options]
 * @returns {string | null} a short hit description, or null when the call is fine
 */
export function detectManualRestart(exec, { pid = process.pid, ppid = process.ppid, webPort = 0 } = {}) {
  if (!exec || typeof exec.name !== 'string') return null
  if (!COMMAND_TOOL_PATTERN.test(exec.name)) return null
  const pidRe = pid > 0 ? new RegExp(`(^|[^0-9])${pid}([^0-9]|$)`) : null
  const ppidRe = ppid > 0 ? new RegExp(`(^|[^0-9])${ppid}([^0-9]|$)`) : null
  const portRe = webPort > 0 ? new RegExp(`(^|[^0-9])${webPort}([^0-9]|$)`) : null
  for (const text of collectArgumentStrings(exec.arguments)) {
    if (OS_SHUTDOWN_PATTERN.test(text)) return 'operating-system shutdown/reboot would take DSH down'
    if (!KILL_VERB_PATTERN.test(text)) continue
    if (portRe !== null && /\bkill-?port\b/i.test(text) && portRe.test(text)) {
      return 'port-kill of the DSH web server'
    }
    if (APP_NAME_PATTERN.test(text)) return 'process kill/relaunch command naming DeepSeek Harness'
    if (DEEPSEEK_PATTERN.test(text)) return 'process kill command selecting a DeepSeek process'
    if (/\bschtasks\b/i.test(text) && /\/(run|create)\b/i.test(text) && /\b(dsh|deepseek|autorestart)\b/i.test(text)) {
      return 'scheduled-task restart of DSH'
    }
    if (pidRe !== null && pidRe.test(text)) return 'process kill command naming the current DSH host pid'
    if (ppidRe !== null && ppidRe.test(text)) return 'process kill command naming the parent app pid'
  }
  return null
}

/**
 * Register a global tool guard: a model that tries to restart DSH with a shell command is
 * stopped before dispatch and told to use `continuum_restart`. This is the hard complement
 * to the advisory system-prompt section.
 */
function registerManualRestartGuard(ctx, runtime, config) {
  runtime.manualRestartBlocks = 0
  if (config.blockManualRestart === false) {
    runtime.log.info('manual-restart guard is disabled by config')
    return
  }
  const tools = ctx.tools
  if (!tools || typeof tools.guard !== 'function') {
    runtime.log.warn('tools.guard is unavailable; manual DSH restarts are only discouraged by prompt, not blocked')
    return
  }
  try {
    // The disposer is owned by the fiber (like the tools and the routes), so a
    // re-applied plugin never leaves a guard of an old instance behind.
    ctx.effect(
      () => tools.guard((exec) => {
        const hit = detectManualRestart(exec, { webPort: runtime.webPort ?? 0 })
        if (hit === null) return undefined
        runtime.manualRestartBlocks += 1
        runtime.log.warn(`blocked a manual DSH restart attempt (${hit}) through tool "${exec.name}"; steering the agent to continuum_restart`)
        return MANUAL_RESTART_DENIAL
      }),
      'dsh-autorestart: manual-restart guard',
    )
  } catch (error) {
    runtime.log.warn('could not register the manual-restart guard:', String(error))
  }
}

/**
 * Is this request admitted by the host's connection service, i.e. is it an
 * authenticated browser request? A hosted `dsh web` deployment reaches the
 * health route from a remote browser, so a loopback-only check would refuse
 * the pending-restart marker the UI polls for. When the connection service is
 * missing the previous loopback-only behaviour is kept, and the check never
 * throws.
 *
 * @param {unknown} ctx - the plugin context.
 * @param {unknown} req - the incoming request.
 * @returns {boolean} true when the request may proceed.
 */
function admittedByConnection(ctx, req) {
  try {
    let connection
    try {
      if (ctx && ctx.connection && typeof ctx.connection.requestRejection === 'function') {
        connection = ctx.connection
      }
    } catch {}
    if (!connection) {
      try {
        if (ctx && typeof ctx.get === 'function') {
          const service = ctx.get('connection')
          if (service && typeof service.requestRejection === 'function') connection = service
        }
      } catch {}
    }
    if (!connection) return false
    // `requestRejection` inspects the request headers and answers a refusal
    // status (401/403), or nothing at all when the request may proceed.
    const rejection = connection.requestRejection(req)
    return rejection === undefined || rejection === null
  } catch {
    return false
  }
}

/**
 * Read a small JSON request body. Never throws: an unreadable or malformed
 * body simply becomes an empty object.
 *
 * @param {any} req
 * @param {number} [maxBytes]
 * @returns {Promise<object>}
 */
function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    if (!req || typeof req.on !== 'function') {
      resolve({})
      return
    }
    let size = 0
    let settled = false
    const chunks = []
    const finish = (text) => {
      if (settled) return
      settled = true
      try {
        const raw = String(text || '').trim()
        if (raw === '') {
          resolve({})
          return
        }
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        resolve({})
      }
    }
    req.on('data', (chunk) => {
      size += typeof chunk === 'string' ? chunk.length : (chunk && chunk.length ? chunk.length : 0)
      if (size > maxBytes) {
        finish('')
        return
      }
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
    })
    req.on('end', () => finish(chunks.join('')))
    req.on('error', () => finish(''))
  })
}

/**
 * The ids of the sessions that currently block a pending restart.
 *
 * @param {object} runtime
 * @returns {string[]}
 */
function blockingSessionIds(runtime) {
  const ids = []
  try {
    const verdict = runtime.gate()
    const blockedBy = Array.isArray(verdict.blockedBy) ? verdict.blockedBy : []
    for (const entry of blockedBy) {
      if (!entry || typeof entry !== 'object') continue
      const id = entry.sessionId == null ? '' : String(entry.sessionId)
      if (id && !ids.includes(id)) ids.push(id)
    }
  } catch {}
  return ids
}

/**
 * Build the POST route that disarms the goal of a session.
 *
 * It uses the same authentication rule as the health route (loopback OR a
 * request the connection service admits) and answers JSON only.
 */
function buildParkRoute(ctx, runtime, config) {
  const routePath = resolveParkPath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      if (!req || req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      void readJsonBody(req).then((payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        const restart = body.restart === true
        // Without a session id every session that blocks a pending restart is
        // parked, so the restart can proceed.
        const targets = sessionId !== '' ? [sessionId] : blockingSessionIds(runtime)
        const disarmed = []
        const reported = []
        for (const target of targets) {
          try {
            const result = runtime.disarmGoal(target)
            if (result.disarmed) disarmed.push(result)
            else reported.push(result)
          } catch (error) {
            reported.push({ sessionId: target, disarmed: false, reason: 'disarm-failed', error: describeError(error) })
          }
        }
        if (restart && sessionId !== '') {
          // The session becomes a requester of the pending restart: the restart
          // proceeds and the session continues afterwards.
          requestRestart(runtime.state, {
            reason: 'disarm route requested a restart',
            bySessionId: sessionId,
            resume: true,
            now: Date.now(),
          })
          runtime.persist()
          runtime.startPolling()
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({
          ok: true,
          disarmed,
          reported,
          pendingRestart: runtime.state.restart !== null,
          restartRequested: restart === true && sessionId !== '',
        }))
      }).catch((error) => {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: describeError(error) }))
      })
    },
  }
}

/**
 * Build the POST `/recover` route: retry the post-restart recovery for the
 * still-pending sessions right now.
 *
 * It is the sibling of the `/park` route next to the health route and uses the
 * same authentication rule (loopback OR a request the connection service
 * admits). Body: `{ "sessionId"?: string }`; without one every pending session
 * is retried. The answer reports, per session, the recovery action and detail.
 */
function buildRecoverRoute(ctx, runtime, config) {
  const routePath = resolveRecoverPath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      if (!req || req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      void readJsonBody(req).then(async (payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        const results = await runtime.recoverNow(sessionId !== '' ? sessionId : undefined, { force: body.force === true })
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ ok: true, results }))
      }).catch((error) => {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: describeError(error) }))
      })
    },
  }
}

/**
 * Build the POST `/handoff` route: hand an over-limit session off to a fresh
 * session (the same operation as the `continuum_handoff` tool).
 *
 * It sits next to the health route and uses the same authentication rule
 * (loopback OR a request the connection service admits). Body:
 * `{ "sessionId"?: string, "maxChars"?: number }`; without a session id the
 * request is refused, because a route call has no calling session to default to.
 * The answer reports the new session id and the number of carried characters.
 */
function buildHandoffRoute(ctx, runtime, config) {
  const routePath = resolveHandoffPath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      if (!req || req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      void readJsonBody(req).then(async (payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (sessionId === '') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({
            ok: false,
            error: 'no-session',
            instruction: 'Pass { "sessionId": "<id>" }: this route has no calling session to default to.',
          }))
          return
        }
        const result = await runtime.handoff({
          sessionId,
          maxChars: typeof body.maxChars === 'number' && Number.isFinite(body.maxChars) && body.maxChars > 0
            ? body.maxChars
            : undefined,
        })
        res.statusCode = result && result.ok === true ? 200 : 400
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({
          ok: result && result.ok === true,
          sessionId: result ? result.sessionId : undefined,
          sourceSessionId: result ? result.sourceSessionId : sessionId,
          carriedChars: result ? result.carriedChars : undefined,
          error: result ? result.error : 'handoff-failed',
          instruction: result ? result.instruction : undefined,
        }))
      }).catch((error) => {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: describeError(error) }))
      })
    },
  }
}

/**
 * Build the POST `/choice` route: persist the one-time install choice of the
 * user (whether the pre-restart backup also snapshots the installed plugins)
 * and the answer to the one-time question whether the graceful-sleep button is
 * shown.
 *
 * It sits next to the health route and uses the same authentication rule
 * (loopback OR a request the connection service admits). Body:
 * `{ "includePlugins"?: boolean, "showSleepButton"?: boolean }` — at least one
 * of the two keys must be present, and a key that IS present must be a
 * boolean. Anything else is refused with a 400 and NOTHING is written.
 *
 * The answer is `{ ok: true, applied: 'config' | 'fallback-file', ... }`:
 * `applied` says where the choice landed — the profile configuration (the
 * official path) or the degraded fallback file. Only the keys that were asked
 * for are echoed back.
 */
function buildChoiceRoute(ctx, runtime, config) {
  const routePath = resolveChoicePath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      if (!req || req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      void readJsonBody(req).then(async (payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const hasInclude = Object.prototype.hasOwnProperty.call(body, 'includePlugins')
        const hasShow = Object.prototype.hasOwnProperty.call(body, 'showSleepButton')
        if (!hasInclude && !hasShow) {
          // Neither key was asked for: there is nothing to persist.
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ok: false,
            error: 'no-choice',
            instruction: 'Send { "includePlugins": true | false } and/or { "showSleepButton": true | false }.',
          }))
          return
        }
        if (hasInclude && typeof body.includePlugins !== 'boolean') {
          // Nothing is written for a malformed choice: the caller's answer
          // must not change the profile configuration.
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ok: false,
            error: 'includePlugins-must-be-boolean',
            instruction: 'Send { "includePlugins": true | false }.',
          }))
          return
        }
        if (hasShow && typeof body.showSleepButton !== 'boolean') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ok: false,
            error: 'showSleepButton-must-be-boolean',
            instruction: 'Send { "showSleepButton": true | false }.',
          }))
          return
        }
        const changes = {}
        // The route field is `includePlugins`, the configuration key is
        // `backupIncludePlugins` (the profile row keeps the plugin's own name).
        if (hasInclude) changes.backupIncludePlugins = body.includePlugins === true
        if (hasShow) changes.showSleepButton = body.showSleepButton === true
        const result = await runtime.applyConfigChoice(changes)
        const answer = { ok: true, applied: result.applied }
        if (hasInclude) answer.includePlugins = body.includePlugins === true
        if (hasShow) answer.showSleepButton = body.showSleepButton === true
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(answer))
      }).catch((error) => {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: describeError(error) }))
      })
    },
  }
}

/**
 * Is the graceful sleep a dry run?
 *
 * With `DSH_AUTORESTART_SLEEP_DRYRUN=1` the plugin reports the command it
 * WOULD run and never runs it. That is what makes the feature testable on a
 * live machine.
 *
 * @returns {boolean}
 */
function sleepDryRun() {
  return process.env.DSH_AUTORESTART_SLEEP_DRYRUN === '1'
}

/**
 * The gate of the graceful sleep: the ONE question is "is any conversation
 * still working?".
 *
 * It is deliberately NOT the restart gate: that one also demands a quiet
 * settle window, and a settle window longer than the countdown would push the
 * power-off back by whole countdown periods (every restart of the countdown
 * would also claim that somebody started working again, which is not what
 * happened). The sleep feature counts down on screen itself, so it only needs
 * the busy check — and it keeps `settleMs` out of the picture entirely.
 *
 * The restart gate itself is untouched: the restart feature keeps its quiet
 * window exactly as it was.
 *
 * @param {object} runtime
 * @returns {{ allow: boolean, reason: 'busy'|'quiet', blockedBy: any[] }}
 */
function sleepGate(runtime) {
  let busy = []
  try {
    busy = runtime.busyAgents()
  } catch {
    busy = []
  }
  const list = Array.isArray(busy) ? busy : []
  if (list.length > 0) return { allow: false, reason: 'busy', blockedBy: list }
  return { allow: true, reason: 'quiet', blockedBy: [] }
}

/**
 * The FINAL plan of the graceful sleep: what will really be executed, and how
 * the host describes itself in the status JSON.
 *
 * Two rules:
 *   1. `supported` follows the plan that will be executed, NOT the detected
 *      one: a machine whose platform could not be detected is still perfectly
 *      usable when the operator configured a command of their own.
 *   2. the reported `kind`/`label` belong to that same plan, so the status
 *      never says "this machine has no reliable way to switch off" while a
 *      command is about to run.
 *
 * @param {object} plan the detected plan
 * @param {object} config
 * @returns {object} the effective plan
 */
function effectiveSleepPlan(plan, config) {
  const invocation = planInvocation(plan, {
    sleepCommand: config.sleepCommand,
    platform: plan.platform,
  })
  const custom = invocation.source === 'sleepCommand'
  const detectedKind = typeof plan.kind === 'string' ? plan.kind : 'unsupported'
  const detected = detectedKind !== 'unsupported'
  const command = typeof invocation.command === 'string' && invocation.command !== '' ? invocation.command : null
  const label = custom
    ? (detected ? `执行你指定的关机命令（${plan.label}）` : '执行你指定的关机命令')
    : plan.label
  const kind = custom
    // A custom command on a platform we could not classify: the machine is
    // real, the mechanism is the operator's own — it is NOT "unsupported".
    ? (detected ? detectedKind : 'custom')
    : detectedKind
  return {
    ...invocation,
    kind,
    label,
    // The short phrase the countdown message talks about.
    shortLabel: custom ? '执行你指定的关机命令' : plan.label,
    // The final plan decides whether the feature may run at all.
    supported: command !== null,
  }
}

/**
 * Build the graceful-sleep service: the detected host plan plus the state
 * machine that waits for the conversations, counts down and switches the
 * machine off.
 *
 * The busy check is the runtime's own `busyAgents()`, so the sleep feature and
 * the restart feature agree on what "every conversation is idle" means. The
 * gate itself is the sleep-specific one (no settle window): the sleep feature
 * counts down on screen itself.
 *
 * `options.sleepNow` and `options.sleepSpawn` replace the clock and the
 * process spawner, so the whole flow can be driven without waiting and
 * without ever touching the machine. Production never passes them.
 *
 * @param {object} ctx
 * @param {object} runtime
 * @param {object} config
 * @param {{ sleepNow?: () => number, sleepSpawn?: Function }} [options]
 * @returns {{ plan: object, controller: object, invocation: () => object }}
 */
function createSleepService(ctx, runtime, config, options = {}) {
  const plan = detectShutdownPlan({ platform: process.platform, env: process.env })
  // The configured command (if any) replaces the detected one; the final plan
  // is what decides whether the feature may run and what the UI is told.
  const invocation = () => effectiveSleepPlan(plan, config)
  const gate = () => sleepGate(runtime)
  const final = invocation()
  const now = typeof options.sleepNow === 'function' ? options.sleepNow : () => Date.now()
  const spawn = typeof options.sleepSpawn === 'function' ? options.sleepSpawn : undefined
  const controller = createSleepController({
    now,
    busyAgents: () => runtime.busyAgents(),
    gate,
    titleOf: (sessionId) => runtime.sessionTitle(sessionId),
    countdownSeconds: config.sleepCountdownSeconds,
    hostLabel: final.shortLabel,
    supported: final.supported,
    log: runtime.log,
    // The timer belongs to the plugin: `ctx.interval` is disposed with it.
    setInterval: (fn, ms) => ctx.interval(fn, ms),
    clearInterval: (handle) => {
      try {
        if (typeof handle === 'function') handle()
      } catch {}
    },
    shutdown: () => runShutdown(invocation(), {
      spawn,
      dryRun: sleepDryRun(),
      log: runtime.log,
      // The gate is checked ONE more time right before the machine is closed —
      // with the SAME sleep gate (a busy conversation still stops it).
      gate,
    }),
  })
  return { plan, controller, invocation }
}

/**
 * The state of the graceful sleep, in the shape the client renders it.
 *
 * @param {{ plan: object, controller: object, invocation: () => object }} sleep
 * @param {object} config
 * @param {object} runtime
 * @param {string} [ticket] the ticket the calling page holds (if any)
 * @returns {object}
 */
function sleepStatusPayload(sleep, config, runtime, ticket) {
  const status = sleep.controller.status()
  const invocation = sleep.invocation()
  return {
    ok: true,
    phase: status.phase,
    armed: status.armed,
    showSleepButton: config.showSleepButton !== false,
    countdownSeconds: status.countdownSeconds,
    /**
     * Who may drive the shutdown: 'human' (only the page) or 'anyone'.
     */
    controller: config.sleepController === 'anyone' ? 'anyone' : 'human',
    /**
     * Whether the page that asked holds a usable ticket. The check does NOT
     * spend it — it only answers "could this page drive the shutdown?".
     */
    ticketReady: runtime && runtime.sleepTickets
      ? runtime.sleepTickets.check(ticket).ok === true
      : false,
    remainingMs: status.remainingMs,
    blockers: status.blockers,
    host: {
      platform: invocation.platform || process.platform,
      kind: invocation.kind,
      label: invocation.label,
      source: invocation.source,
      // Machine-readable: the host was only recognized as WSL because the
      // Windows drive is mounted (a hint, not a proof). The UI and the tests
      // read this instead of guessing from the Chinese label.
      suspect: invocation.suspect === true,
    },
    dryRun: sleepDryRun(),
    message: status.message,
    lastRun: status.lastRun,
  }
}

/**
 * Build the `/sleep` route: `GET` reports the state of the graceful sleep,
 * `POST` arms or cancels it.
 *
 * It sits next to the health route and uses the same authentication rule
 * (loopback OR a request the connection service admits). Body:
 * `{ "action": "arm" | "cancel" }`; anything else is refused with a 400.
 */
function buildSleepRoute(ctx, runtime, config, sleep) {
  const routePath = resolveSleepPath(config)
  return {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      const answer = (payload, status = 200) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
      }
      const method = req && typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
      const headers = req && req.headers && typeof req.headers === 'object' ? req.headers : {}
      const pageTicket = typeof headers['x-dsh-sleep-ticket'] === 'string' ? headers['x-dsh-sleep-ticket'] : ''
      if (method === 'GET') {
        answer(sleepStatusPayload(sleep, config, runtime, pageTicket))
        return
      }
      if (method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('allow', 'GET, POST')
        res.end('{"ok":false,"error":"method-not-allowed"}')
        return
      }
      void readJsonBody(req).then((payload) => {
        const body = payload && typeof payload === 'object' ? payload : {}
        const action = typeof body.action === 'string' ? body.action.trim() : ''
        if (action !== 'arm' && action !== 'cancel') {
          answer({
            ok: false,
            error: 'unknown-action',
            instruction: 'Send { "action": "arm" | "cancel" }.',
          }, 400)
          return
        }
        // In the 'human' mode only the page may drive the shutdown: BOTH
        // arming and cancelling need the one-time ticket the host injected
        // into that page. A shell script (or an agent) can therefore neither
        // switch the machine off nor take a running countdown back.
        if (config.sleepController !== 'anyone') {
          const verdict = runtime.sleepTickets.consume(pageTicket)
          if (verdict.ok !== true) {
            const reason = typeof verdict.reason === 'string' ? verdict.reason : 'no-ticket'
            answer({
              ok: false,
              error: 'page-ticket-required',
              reason,
              message: describeTicketReason(reason),
              controller: 'human',
            }, 403)
            return
          }
        }
        if (action === 'arm') {
          sleep.controller.arm()
        } else {
          sleep.controller.cancel()
        }
        answer(sleepStatusPayload(sleep, config, runtime))
      }).catch((error) => {
        answer({ ok: false, error: describeError(error) }, 400)
      })
    },
  }
}

/** Expose a tiny read-only health route for humans and verification scripts. */
function registerHealthRoute(ctx, runtime, config, sleep) {
  const routePath = typeof config.healthPath === 'string' && config.healthPath.startsWith('/')
    ? config.healthPath
    : '/__dsh_autorestart/health'
  const route = {
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      const remote = req && req.socket ? req.socket.remoteAddress : undefined
      const loopback = remote === undefined
        || remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
      if (!loopback && !admittedByConnection(ctx, req)) {
        res.statusCode = 403
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"ok":false,"error":"loopback-only"}')
        return
      }
      const state = runtime.state
      if (typeof req.url === 'string' && req.url.includes('gate=1')) {
        // The detached restart helper asks this immediately before it kills anything.
        const verdict = runtime.gate()
        let agentCount = 0
        try {
          agentCount = ctx.agents.list().length
        } catch {}
        const gateBody = JSON.stringify({
          ok: true,
          allowRestart: verdict.allow,
          gate: {
            allow: verdict.allow,
            reason: verdict.reason,
            blockedBy: verdict.blockedBy,
            quietForMs: verdict.quietForMs,
          },
          phase: state.phase,
          generation: state.generation,
          pendingRestart: state.restart !== null,
          settleMs: config.settleMs,
          busyCount: verdict.blockedBy.length,
          agentCount,
        })
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(gateBody)
        return
      }
      if (typeof req.url === 'string' && req.url.includes('state=1')) {
        // A client UI polls this to show a "pending restart" banner for a session.
        // Read-only: it never mutates the checkpoint and never fails the request.
        let stateBody
        try {
          const live = runtime.state
          const restart = live.restart
          const pendingRestart = restart !== null
          const waiters = []
          const seen = new Set()
          const addWaiter = (value) => {
            if (value === null || value === undefined) return
            const id = String(value)
            if (!id || seen.has(id)) return
            seen.add(id)
            waiters.push(id)
          }
          if (restart && typeof restart === 'object') {
            if (Array.isArray(restart.requesters)) {
              for (const requester of restart.requesters) {
                if (!requester || typeof requester !== 'object') continue
                addWaiter(requester.sessionId)
              }
            }
            addWaiter(restart.bySessionId)
          }
          if (pendingRestart && live.sessions && typeof live.sessions === 'object') {
            for (const [sessionId, entry] of Object.entries(live.sessions)) {
              if (!entry || typeof entry !== 'object') continue
              if (entry.pendingResume !== true) continue
              addWaiter(typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : sessionId)
            }
          }
          const verdict = runtime.gate()
          // Best effort: label the blocking sessions with their titles when the
          // session controller knows them. The title is optional, so an entry
          // without one is sent exactly as the gate produced it. The goal
          // reason (`goal-active` / `goal-exhausted`) is attached as well, so
          // the client can tell a goal-driven blocker from a busy session.
          const blockedBy = goalAwareBlockingDetails(runtime, verdict.blockedBy).map((entry) => {
            if (!entry || typeof entry !== 'object') return entry
            const title = runtime.sessionTitle(entry.sessionId)
            return title ? { ...entry, title } : entry
          })
          stateBody = JSON.stringify({
            ok: true,
            pendingRestart,
            phase: live.phase,
            generation: live.generation,
            waiters,
            blockedBy,
            allowRestart: verdict.allow === true,
            quietForMs: typeof verdict.quietForMs === 'number' ? verdict.quietForMs : 0,
            settleMs: config.settleMs,
            updatedAt: live.updatedAt,
            // The park route, so the client never has to guess the prefix, and
            // the goals this plugin already disarmed (they are re-armed after
            // the restart).
            parkUrl: resolveParkPath(config),
            recoverUrl: resolveRecoverPath(config),
            // The route that persists the one-time install choice, plus the
            // value that is effective right now.
            choiceUrl: resolveChoicePath(config),
            backupIncludePlugins: config.backupIncludePlugins !== false,
            parkedGoals: parkedGoalList(runtime),
            recovery: recoveryList(live),
          })
        } catch {
          // The banner must never break the health route: fall back to "no restart".
          stateBody = JSON.stringify({
            ok: true,
            pendingRestart: false,
            waiters: [],
            blockedBy: [],
            allowRestart: false,
            quietForMs: 0,
            parkUrl: resolveParkPath(config),
            recoverUrl: resolveRecoverPath(config),
            choiceUrl: resolveChoicePath(config),
            backupIncludePlugins: config.backupIncludePlugins !== false,
            parkedGoals: [],
            recovery: [],
          })
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(stateBody)
        return
      }
      const probeIndex = typeof req.url === 'string' && req.url.includes('probeIndex=1')
      const body = JSON.stringify({
        ok: true,
        plugin: name,
        bootId: runtime.bootId,
        pid: process.pid,
        phase: state.phase,
        generation: state.generation,
        pendingRestart: state.restart !== null,
        updatedAt: state.updatedAt,
        pageHeartbeat: runtime.pageHeartbeat === true,
        systemPrompt: runtime.systemPrompt === true,
        manualRestartBlocks: runtime.manualRestartBlocks ?? 0,
        indexTaps: runtime.indexTaps ?? 0,
        configSchema: Config !== undefined,
        schemastery: Config === undefined
          ? (schemastery === undefined ? 'unresolved' : 'construction-failed')
          : (schemasterySource === 'bare-specifier' ? 'bare' : 'asar-fallback'),
        ...(probeIndex
          ? {
            probeIndex: injectPageHeartbeat(
              '<html><head></head><body>probe</body></html>',
              runtime.bootId,
              routePath,
            ),
          }
          : {}),
      })
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(body)
    },
  }

  const attempt = (target) => {
    let webServer
    try {
      webServer = target.get('webServer')
    } catch {
      return false
    }
    if (!webServer || typeof webServer.register !== 'function') return false
    const parkRoute = buildParkRoute(ctx, runtime, config)
    const recoverRoute = buildRecoverRoute(ctx, runtime, config)
    const handoffRoute = buildHandoffRoute(ctx, runtime, config)
    const choiceRoute = buildChoiceRoute(ctx, runtime, config)
    const sleepRoute = sleep ? buildSleepRoute(ctx, runtime, config, sleep) : null
    try {
      const origin = typeof webServer.getOrigin === 'function' ? String(webServer.getOrigin()) : ''
      const portMatch = /:(\d+)\/?$/.exec(origin)
      if (portMatch) runtime.webPort = Number(portMatch[1])
    } catch {}
    try {
      target.effect(() => webServer.register(route), 'dsh-autorestart: health route')
    } catch (error) {
      // A duplicate registration means another load of this plugin already owns it.
      runtime.log.warn('could not register the health route:', String(error))
    }
    try {
      target.effect(() => webServer.register(parkRoute), 'dsh-autorestart: park route')
    } catch (error) {
      runtime.log.warn('could not register the park route:', String(error))
    }
    try {
      target.effect(() => webServer.register(recoverRoute), 'dsh-autorestart: recover route')
    } catch (error) {
      runtime.log.warn('could not register the recover route:', String(error))
    }
    try {
      target.effect(() => webServer.register(handoffRoute), 'dsh-autorestart: handoff route')
    } catch (error) {
      runtime.log.warn('could not register the handoff route:', String(error))
    }
    try {
      target.effect(() => webServer.register(choiceRoute), 'dsh-autorestart: choice route')
    } catch (error) {
      runtime.log.warn('could not register the choice route:', String(error))
    }
    if (sleepRoute !== null) {
      try {
        target.effect(() => webServer.register(sleepRoute), 'dsh-autorestart: sleep route')
      } catch (error) {
        runtime.log.warn('could not register the sleep route:', String(error))
      }
    }
    if (typeof webServer.tapIndex === 'function') {
      // The page ticket: every page load gets a fresh one, so only the page
      // itself can drive the shutdown in the 'human' mode.
      try {
        target.effect(
          () => webServer.tapIndex((html) => {
            runtime.indexTaps = (runtime.indexTaps ?? 0) + 1
            return injectSleepTicket(html, runtime.sleepTickets.issue())
          }),
          'dsh-autorestart: sleep page ticket',
        )
        runtime.sleepTicketTap = true
      } catch (error) {
        runtime.log.warn('could not inject the sleep page ticket:', String(error))
      }
    }
    if (config.autoReloadPage !== false && typeof webServer.tapIndex === 'function') {
      try {
        target.effect(
          () => webServer.tapIndex((html) => {
            runtime.indexTaps = (runtime.indexTaps ?? 0) + 1
            return injectPageHeartbeat(html, runtime.bootId, routePath)
          }),
          'dsh-autorestart: page heartbeat',
        )
        runtime.pageHeartbeat = true
      } catch (error) {
        runtime.log.warn('could not inject the page heartbeat:', String(error))
      }
    }
    return true
  }

  if (attempt(ctx)) return
  // At boot this plugin may activate before the webserver row: retry briefly instead
  // of silently giving up (that is exactly how a boot-time 404 happened once).
  let tries = 0
  let stop
  stop = ctx.interval(() => {
    tries += 1
    if (attempt(ctx) || tries >= 30) {
      try {
        stop()
      } catch {}
    }
  }, 2000)
}

/** Wire event listeners that keep the checkpoint current. */
function trackAgents(ctx, runtime, config) {
  const log = runtime.log
  const state = runtime.state

  ctx.on('agent/status', ({ agent, status }) => {
    try {
      runtime.noteActivity()
      if (!agent || !agent.id) return
      if (!isRootAgent(ctx, agent)) return
      const now = Date.now()
      if (status === 'running') {
        const existing = state.sessions[String(agent.id)]
        markRunning(state, {
          sessionId: String(agent.id),
          reason: 'turn',
          goalId: existing && existing.goal ? existing.goal.goalId : undefined,
          now,
        })
      } else {
        markIdle(state, String(agent.id), { now })
      }
      runtime.persist()
    } catch (error) {
      log.warn('checkpoint update failed:', String(error))
    }
  })

  // Any session event or newly queued inbox message restarts the settle window.
  ctx.on('session/event', () => {
    try {
      runtime.noteActivity()
    } catch {}
  })

  ctx.on('agent/inbox/inserted', () => {
    try {
      runtime.noteActivity()
    } catch {}
  })

  ctx.on('goal/changed', ({ agent, change }) => {
    try {
      if (!agent || !agent.id || !change || !change.goal) return
      if (!isRootAgent(ctx, agent)) return
      setGoal(state, String(agent.id), {
        goalId: change.goal.id,
        goalRevision: change.goal.revision,
        phase: change.goal.phase,
        now: Date.now(),
      })
      runtime.persist()
    } catch (error) {
      log.warn('goal checkpoint update failed:', String(error))
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    try {
      if (!agent || !agent.id) return
      if (!isRootAgent(ctx, agent)) return
      const entry = state.sessions[String(agent.id)]
      if (entry && entry.running) {
        // An agent that disappears mid-turn is an interruption worth resuming later.
        entry.running = false
        entry.interrupted = true
        entry.pendingResume = true
        entry.pendingSince = Date.now()
        runtime.persist()
      }
    } catch {}
  })

  // Seed the checkpoint with agents that were already running at activation (hot
  // reload or late mount), so an unexpected restart can still recover them.
  try {
    const now = Date.now()
    let seeded = 0
    for (const agent of ctx.agents.list()) {
      if (!agent || !agent.id) continue
      if (!isRootAgent(ctx, agent)) continue
      if (agent.status !== 'running') continue
      const existing = state.sessions[String(agent.id)]
      if (existing && (existing.pendingResume || existing.interrupted)) continue
      markRunning(state, { sessionId: String(agent.id), reason: 'turn', now })
      seeded += 1
    }
    if (seeded > 0) {
      runtime.persist()
      log.info(`seeded ${seeded} running session(s) into the checkpoint`)
    }
  } catch {}
}

/**
 * Plugin entry point.
 * @param ctx - Cordis plugin context.
 * @param rawConfig - the loader row config (merged over the built-in defaults).
 * @param {{
 *   sleepNow?: () => number,
 *   sleepSpawn?: Function,
 * }} [options] - the injectable primitives of the graceful sleep: they replace
 *   the clock and the process spawner, so the whole flow can be driven without
 *   waiting and without ever touching the machine. Production never passes them.
 */
export function apply(ctx, rawConfig, options = {}) {
  const config = normalizeConfig(rawConfig)
  // The one-time install choice lives in the profile row config (the single
  // source of truth). Only when the row does not set the key at all does the
  // degraded fallback file get a say.
  const stateDir = resolveStateDir(config)
  const choice = resolveBackupIncludePlugins(rawConfig, stateDir)
  config.backupIncludePlugins = choice.includePlugins
  // The same rule for the graceful-sleep button: the profile row decides, the
  // fallback file fills the gap, the built-in default applies otherwise.
  const sleepChoice = resolveShowSleepButton(rawConfig, stateDir)
  config.showSleepButton = sleepChoice.showSleepButton
  const runtime = createRuntime(ctx, config, {
    backupChoiceSource: choice.source,
    // The one-time page tickets of this host start. Production creates them
    // here; a test may bring its own (with a clock it controls).
    sleepTickets: options.sleepTickets,
  })
  const log = runtime.log
  // The graceful sleep: the host plan and the state machine that waits for the
  // conversations, counts down and switches the machine off.
  const sleep = createSleepService(ctx, runtime, config, options)

  log.info('activated', {
    stateFile: runtime.stateFile,
    isNewBoot: runtime.isNewBoot,
    phase: runtime.state.phase,
    pid: process.pid,
    desktopApp: runtime.env.isDesktopApp,
    appExePath: runtime.env.appExePath,
    configSchema: Config !== undefined,
    backupIncludePlugins: config.backupIncludePlugins,
    backupChoiceSource: choice.source,
    showSleepButton: config.showSleepButton,
    sleepChoiceSource: sleepChoice.source,
    // The FINAL plan: what the sleep feature would really do.
    sleepHost: sleep.invocation().kind,
    sleepSource: sleep.invocation().source,
    sleepSupported: sleep.invocation().supported,
  })
  if (Config === undefined) {
    log.warn('Config schema is unavailable in this build (schemastery could not be loaded); configuration still works through cordis.patch.yml and the built-in defaults')
  }

  if (!config.enabled) {
    log.info('plugin is disabled by config')
    return
  }

  // Record this boot in the checkpoint even when there is nothing to recover.
  persistSafely(runtime)

  trackAgents(ctx, runtime, config)

  // The boot recovery pass is the plugin's primary boot duty, so it is scheduled
  // BEFORE the auxiliary timers (the health-route registration retry below): a
  // fallback registered later must never shadow or postpone the recovery pass.
  if (runtime.isNewBoot && config.resumeOnBoot) {
    runtime.recoverTimer = ctx.timeout(() => {
      recoverAfterRestart(ctx, runtime, config).catch((error) => {
        log.warn('boot recovery failed:', String(error))
      })
    }, Math.max(0, config.recoveryDelayMs))
  }

  registerTools(ctx, runtime, config)
  registerManualRestartGuard(ctx, runtime, config)
  registerSystemPrompt(ctx, runtime)
  registerHealthRoute(ctx, runtime, config, sleep)

  ctx.effect(() => () => {
    runtime.markDisposed()
    runtime.stopPolling()
    // The countdown timer belongs to the plugin: it must not survive it.
    sleep.controller.dispose()
    persistSafely(runtime)
  }, 'dsh-autorestart lifecycle')
}

export {
  DEFAULTS,
  normalizeConfig,
  resolveStateFile,
  resolveStateDir,
  resolveChoicePath,
  resolveSleepPath,
}
