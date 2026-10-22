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
import os from 'node:os'
import path from 'node:path'

import {
  beginBoot,
  cancelRestart,
  markIdle,
  markPendingResume,
  markRunning,
  pruneSessions,
  readState,
  recoverableSessions,
  requestRestart,
  setGoal,
  setPhase,
  writeState,
} from './lib/checkpoint.js'
import { bootPlan, continuationPrompt, describeState, restartDecision, restartGate } from './lib/lifecycle.js'
import {
  buildCustomCommand,
  detectEnvironment,
  runCommandNow,
  scheduleDetachedRestart,
} from './lib/restart.js'

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
 * Hard dependencies. `sessionController` is read optionally (`ctx.get`) so the plugin
 * also loads in compositions without the web session controller; it simply cannot
 * resume agents there.
 */
export const inject = ['agents', 'goals', 'tools', 'timer', 'systemPrompt']

/**
 * Validated loader row config. Exported so the Plugin Manager / config editor can show
 * the real schema and project defaults; `normalizeConfig` still re-applies the same
 * defaults for direct `apply()` calls in tests.
 *
 * Construction is guarded: a wrong/foreign schemastery fallback must never turn a
 * missing schema into a failed plugin activation, and the coarsened `schemasterySource`
 * is reported by the health route instead of an absolute install path.
 */
function buildConfigSchema() {
  if (schemastery === undefined) return undefined
  try {
    return schemastery.object({
      enabled: schemastery.boolean().default(true),
      stateFile: schemastery.string().default(''),
      resumeOnBoot: schemastery.boolean().default(true),
      recoveryDelayMs: schemastery.number().min(0).default(6000),
      maxSessions: schemastery.number().step(1).min(1).default(4),
      maxResumeAttempts: schemastery.number().step(1).min(1).default(2),
      deferPollMs: schemastery.number().min(250).default(3000),
      deferSoftMs: schemastery.number().min(0).default(300000),
      deferHardMs: schemastery.number().min(0).default(900000),
      deferPolicy: schemastery.union(['auto', 'wait']).default('auto'),
      // hard deadline only forces a restart over a running conversation when enabled
      forceRestartWhenBusy: schemastery.boolean().default(false),
      restartMode: schemastery.union(['app', 'command']).default('app'),
      restartCommand: schemastery.string().default(''),
      relaunchDelaySeconds: schemastery.number().min(0).default(2),
      // quiet window that must pass after the last conversation activity
      settleMs: schemastery.number().min(0).default(2000),
      autoReloadPage: schemastery.boolean().default(true),
      blockManualRestart: schemastery.boolean().default(true),
      healthPath: schemastery.string().default('/__dsh_autorestart/health'),
      continuationText: schemastery.string().default(''),
      // pause between two recovery batches (each batch resumes maxSessions sessions)
      recoveryBatchDelayMs: schemastery.number().min(0).default(1200),
      // pause between two resolveAgent attempts inside one boot
      resumeRetryDelayMs: schemastery.number().min(0).default(1000),
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
  return config
}

/** Resolve the health-route path (shared by the route and the restart gate URL). */
function resolveHealthPath(config) {
  return typeof config.healthPath === 'string' && config.healthPath.startsWith('/')
    ? config.healthPath
    : '/__dsh_autorestart/health'
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

/** The plugin's whole runtime state. */
function createRuntime(ctx, config) {
  const log = createLogger(ctx)
  const env = detectEnvironment()
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
      if (config.restartMode === 'command' && config.restartCommand.trim() !== '') {
        const command = buildCustomCommand({
          template: config.restartCommand,
          pid: process.pid,
          ppid: process.ppid,
          appExePath: env.appExePath || '',
        })
        log.warn('running custom restart command:', command)
        const outcome = runCommandNow({ command })
        if (outcome && outcome.ok === false) rollbackRestart(outcome.error || 'custom command failed')
      } else if (env.isDesktopApp && env.appExePath) {
        const aborts = Number(state.restart.gateAborts) || 0
        const url = aborts > 20 ? null : restartGateUrl()
        if (aborts > 20) {
          log.error('falling back to an UNGATED restart after repeated idle-gate aborts', { gateAborts: aborts })
        } else if (url === null) {
          log.warn('the web server port is unknown; scheduling an UNGATED restart (the helper cannot re-check the idle gate)')
        }
        const result = scheduleDetachedRestart({
          appExePath: env.appExePath,
          relaunchDelaySeconds: config.relaunchDelaySeconds,
          gateUrl: url,
          scriptPath: url === null ? null : path.join(path.dirname(stateFile), 'restart-' + state.generation + '.cmd'),
        })
        log.warn('scheduled detached restart:', result)
        if (!result || result.ok !== true) rollbackRestart((result && result.error) || 'detached restart refused')
        else armGateWatchdog()
      } else {
        log.warn('no restart method available (not the desktop app and restartCommand is empty); leaving the checkpoint in place')
        rollbackRestart('no restart method available')
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

  const runtime = {
    get state() {
      return state
    },
    get bootId() {
      return bootId
    },
    get isNewBoot() {
      return boot.isNewBoot
    },
    env,
    stateFile,
    log,
    persist,
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
    boot,
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
 * @returns {object} a frozen user message
 */
function createContinuationMessage(text) {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({
      kind: 'continuum',
      form: 'notice',
      summary: 'automatic continuation after a DeepSeek Harness restart',
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
    runtime.persist()
    log.info(`giving up on session ${sessionId}: resume attempts exhausted`, { lastResumeError: entry.lastResumeError })
    return { sessionId, action: 'skip', error: entry.lastResumeError }
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
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.resolveAgent !== 'function') {
      log.warn('sessionController is unavailable; cannot resume', sessionId)
      return { sessionId, action: 'unavailable' }
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
      // Keep pendingResume: the session stays recoverable on a later boot, but the
      // failure is now visible in continuum_status instead of vanishing.
      entry.lastResumeError = lastError
      runtime.persist()
      log.warn(`could not resume ${sessionId}:`, lastError)
      return { sessionId, action: 'failed', error: lastError }
    }
    agent = result && result.agent
  }
  if (!agent) {
    entry.lastResumeError = 'resolveAgent returned no agent'
    runtime.persist()
    return { sessionId, action: 'failed', error: entry.lastResumeError }
  }

  let goal
  try {
    goal = ctx.goals.get(agent)
  } catch (error) {
    log.warn(`goals.get failed for ${sessionId}:`, String(error))
  }

  if (
    goal
    && goal.phase === 'active'
    && goal.activation === 'disarmed'
    && goal.roundsStarted < goal.maxGoalRounds
  ) {
    try {
      ctx.goals.resume(agent, { id: goal.id, revision: goal.revision })
      entry.pendingResume = false
      entry.running = false
      entry.interrupted = false
      entry.lastResumeError = null
      entry.goal = { goalId: goal.id, goalRevision: goal.revision + 1, phase: 'active' }
      runtime.persist()
      log.info(`re-armed goal ${goal.id} for session ${sessionId}; the goal round driver continues the work`)
      return { sessionId, action: 'rearm-goal', goalId: goal.id }
    } catch (error) {
      log.warn(`goals.resume failed for ${sessionId}:`, String(error))
    }
  }

  if (!entry.pendingResume && !entry.interrupted) {
    return { sessionId, action: 'nothing' }
  }

  // Inject exactly one continuation message through the live agent's inbox. The
  // Remote-facing `sessionController.prompt` is NOT usable here: its in-process
  // signature is `prompt(request, signal)` and it hardcodes a human `user` source.
  if (typeof agent.followup !== 'function') {
    log.warn('the resumed agent exposes no followup(); cannot inject the continuation prompt')
    return { sessionId, action: 'unavailable' }
  }
  const text = continuationPrompt(entry, {
    reason: (Array.isArray(entry.reasons) && entry.reasons[entry.reasons.length - 1]) || 'host restart',
    override: config.continuationText,
  })
  try {
    agent.followup(createContinuationMessage(text))
  } catch (error) {
    log.warn(`continuation message rejected for ${sessionId}:`, String(error))
    return { sessionId, action: 'prompt-failed' }
  }
  entry.pendingResume = false
  entry.running = false
  entry.interrupted = false
  entry.lastResumeError = null
  runtime.persist()
  log.info(`queued a continuation message for session ${sessionId}`)
  return { sessionId, action: 'prompt-continuation' }
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

  const tool = (definition) => {
    try {
      ctx.tools.register(definition)
    } catch (error) {
      log.warn(`could not register tool ${definition?.name}:`, String(error))
    }
  }

  const textOutput = (schema, render) => ({ schema, render })

  tool({
    name: 'continuum_restart',
    description:
      'Ask DeepSeek Harness to restart gracefully: the restart waits until EVERY conversation is idle '
      + '(no running turn and no queued inbox work, other sessions, subagents and teammates included) and '
      + 'the host has been quiet for settleMs (default 2000 ms); a hard deadline only forces it when '
      + 'forceRestartWhenBusy is enabled, otherwise the restart keeps waiting for the other conversations. '
      + 'Other conversations are never killed mid-turn: the detached helper re-checks this idle gate '
      + 'over loopback immediately before it kills the process. After the restart this '
      + 'plugin resumes this session and continues the work automatically. Write your final message '
      + 'in this turn, then stop calling tools — the restart fires as soon as the turn goes idle. '
      + 'Use it only when a restart is genuinely required (for example to load an installed plugin update).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'Why the restart is needed; recorded in the checkpoint and shown in the log.' },
        resume: { type: 'boolean', description: 'Resume this session after the restart (default true).' },
        defer_seconds: { type: 'number', description: 'Optional extra seconds to wait before the first idle check.' },
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
      requestRestart(state, {
        reason: typeof args.reason === 'string' && args.reason.trim() !== '' ? args.reason.trim() : 'agent requested restart',
        bySessionId: sessionId,
        resume,
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
      log.info('restart requested', { generation: state.generation, sessionId, resume })
      return {
        accepted: true,
        generation: state.generation,
        phase: state.phase,
        willResume: resume && Boolean(sessionId),
        note: 'The restart runs at the next safe point (all agents idle). Keep this reply short; the session resumes afterwards.',
      }
    },
  })

  tool({
    name: 'continuum_status',
    description:
      'Report the dsh-autorestart lifecycle: whether a restart is pending, which sessions were '
      + 'checkpointed as interrupted or continuation-pending, the resolved state-file path, and the '
      + 'detected restart environment. Read-only.',
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
        blockedBy: verdict.blockedBy,
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
              sessions: recoverableSessions(state, { limit: 50 }).map((entry) => ({
                ...entry,
                // Diagnostics: the last resolveAgent failure for this session (null when healthy).
                lastResumeError: entry.lastResumeError ?? null,
              })),
            }
          : {}),
      }
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
 * The system-prompt section that makes the restart policy discoverable to every agent:
 * call `continuum_restart` instead of killing the app by hand. This is a real Host hook,
 * so it applies without touching any AGENTS.md.
 */
const AUTORESTART_PROMPT = [
  '## Restart policy (dsh-autorestart)',
  '- When DeepSeek Harness itself must restart (for example to load an installed or updated plugin bundle), do NOT kill or relaunch the app yourself with pwsh/taskkill/Stop-Process/npm scripts. A hard guard blocks such commands anyway (denials mention `blockManualRestart`).',
  '- Call the `continuum_restart` tool instead (optional arguments: `reason`, `resume`, `defer_seconds`). It waits until every conversation is idle (no running turn, no queued inbox work) AND the host has been quiet for `settleMs` (default 2000 ms); the detached helper re-checks that gate immediately before killing, so other conversations are never killed mid-turn. It then relaunches the app, and after boot this plugin resumes the session and continues the work automatically.',
  '- Persist anything the next turn needs before restarting (workspace files, `todo_write`, goal state); do not rely on in-memory state.',
  '- Inspect the lifecycle with `continuum_status`; cancel a pending restart with `continuum_cancel_restart`.',
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
    tools.guard((exec) => {
      const hit = detectManualRestart(exec, { webPort: runtime.webPort ?? 0 })
      if (hit === null) return undefined
      runtime.manualRestartBlocks += 1
      runtime.log.warn(`blocked a manual DSH restart attempt (${hit}) through tool "${exec.name}"; steering the agent to continuum_restart`)
      return MANUAL_RESTART_DENIAL
    })
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

/** Expose a tiny read-only health route for humans and verification scripts. */
function registerHealthRoute(ctx, runtime, config) {
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
          // without one is sent exactly as the gate produced it.
          const blockedBy = (Array.isArray(verdict.blockedBy) ? verdict.blockedBy : []).map((entry) => {
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
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const runtime = createRuntime(ctx, config)
  const log = runtime.log

  log.info('activated', {
    stateFile: runtime.stateFile,
    isNewBoot: runtime.isNewBoot,
    phase: runtime.state.phase,
    pid: process.pid,
    desktopApp: runtime.env.isDesktopApp,
    appExePath: runtime.env.appExePath,
    configSchema: Config !== undefined,
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
  registerHealthRoute(ctx, runtime, config)

  ctx.effect(() => () => {
    runtime.markDisposed()
    runtime.stopPolling()
    persistSafely(runtime)
  }, 'dsh-autorestart lifecycle')
}

export { DEFAULTS, normalizeConfig, resolveStateFile }
