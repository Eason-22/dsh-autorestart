/**
 * dsh-autorestart browser half: a compact "pending restart" pill and a
 * matching dot in the left sidebar session row.
 *
 * Classic script loaded by dsh-client-modules via `window.__ModuleLoader__.load`.
 * No JSX, no build step. Two surfaces read the Host's loopback-only health
 * route (`GET /__dsh_autorestart/health?state=1`):
 *
 *   - the pill in the composer tool row (`conversation.input.left` slot);
 *   - an 8px dot in the leading 16px state cell of a left-sidebar session row
 *     (`sidebar.session.row.leading` slot).
 *
 * Both are visible only for the session that is actually queued for the
 * restart (the session id must appear in the route's `waiters` list), and both
 * read ONE shared poller: the route is fetched once every 2s no matter how
 * many surfaces are mounted.
 *
 * Two upgrades on top of the plain marker:
 *
 *   1. an "imminent" pulse: when the restart is pending AND the Host's idle
 *      gate is open (`allowRestart`), the dot of both surfaces breathes. One
 *      shared `@keyframes` rule is injected into the document head (guarded by
 *      an id, removed when the last subscriber leaves) and applied through the
 *      `animation` style property, so it never changes the layout. Users who
 *      ask for reduced motion never see it;
 *   2. a click-to-open details panel: the pill is a keyboard-operable
 *      button that reveals why the restart is still pending, which sessions
 *      block it (by title when the Host provided one) and how long this
 *      session has been waiting.
 *
 * Goal-aware states on top of that:
 *
 *   - a blocker whose reason is `goal-active` is a session whose armed goal
 *     keeps driving rounds by itself, so it holds the restart on its own.
 *     The pill shows that state and offers a button which parks that goal
 *     and asks for the restart immediately (`POST <parkUrl>` with
 *     `{ sessionId, restart: true }`);
 *   - a blocker whose reason is `goal-exhausted` cannot be parked at all
 *     (the round budget of its goal is used up), so the pill explains that
 *     and offers no button for it;
 *   - the Host also reports the goals it already parked (`parkedGoals`): the
 *     pill says how many were parked and that they continue automatically
 *     after the restart, and the details panel lists them.
 *
 * Everything here is side-effect free until `apply(ctx)` runs: no timers, no
 * fetches, no DOM access at module scope.
 *
 * The graceful-shutdown ("sleep") half adds three more surfaces:
 *
 *   - the shutdown BUTTON at the foot of the left sidebar, beside the
 *     Settings row (`sidebar.footer.action` slot): a moon icon and the label
 *     "收工关机". That slot is a ROOT slot, so the button is there even when
 *     no conversation is open. It renders NOTHING at all when the Host says
 *     the button must not be shown, so no empty space is left behind;
 *   - the COUNTDOWN CARD in the shell's overlay layer (`shell.overlay`
 *     slot): a FLOATING rounded card with a very big number, a hand drawn
 *     whale (inline SVG + CSS keyframes, no image and no other plugin) and
 *     one funny line per second — plus a "算了，别关" button that cancels
 *     the shutdown. The card NEVER covers the interface: it sits in a corner,
 *     it lets every click through (only the cancel button takes clicks), so
 *     the conversation stays readable and the sidebar stays usable while the
 *     machine counts down. While the sessions are still working, a small
 *     corner card takes the place of the countdown card, so nothing is
 *     covered up;
 *   - the SECOND install question: the first install asks about the backup
 *     scope, and only after that answer was persisted does it ask whether the
 *     shutdown button should stay.
 *
 * All of them read the Host's `GET/POST {prefix}/sleep` route and share ONE
 * poller with the same 2s cadence as the pending-restart store.
 */

/* ------------------------------------------------------------------ *
 * The pure half of the graceful-shutdown ("sleep") feature.
 *
 * This file is a CLASSIC script: the client module loader evaluates a
 * plugin bundle as a same-origin external classic script, so the ESM
 * `export` keyword is NOT available here. The four pure helpers are
 * therefore published in the two places a test can reach them:
 *
 *   1. as NAMED properties of this module's exports — the client module
 *      system materializes `factory(require) -> exports`, so the exports
 *      object carries `pickSleepCaption`, `shouldShowSleepButton`,
 *      `buildChoiceBody` and `formatRemainingMs`;
 *   2. on the global namespace `globalThis.__dshAutorestartClient`, which
 *      exists as soon as this file is evaluated (no factory call needed).
 *
 * The copy lives in the two dictionaries below and is mirrored verbatim in
 * locale/zh.json + locale/en.json (same words, same keys).
 * ------------------------------------------------------------------ */

/**
 * The browser-side record of the "keep the sleep button?" answer.
 *
 * The question is asked exactly once (on the first install), so the key is
 * written as soon as the user answers — or closes the prompt.
 */
const SLEEP_BUTTON_KEY = 'dsh-autorestart:sleep-button-v1'

/**
 * The longest countdown the settings page offers (60 seconds).
 *
 * The first twenty seconds have a line each; every second above that uses
 * the generic fallback line, so no offered length ever shows a blank.
 */
const SLEEP_MAX_COUNTDOWN_SECONDS = 60

/** The countdown length the settings page offers (a dropdown). */
const SLEEP_COUNTDOWN_CHOICES = Object.freeze([0, 10, 20, 30, 60])

/** The countdown length used when the Host did not report one. */
const SLEEP_DEFAULT_COUNTDOWN_SECONDS = 20

/** How long the note of a finished rehearsal stays on screen (ms). */
const SLEEP_DRY_RUN_NOTICE_MS = 8_000

/** How long a real pointer gesture stays valid (ms); the host uses the same window. */
const SLEEP_GESTURE_WINDOW_MS = 3_000

/**
 * The reasons that mean: this page has no usable gesture ticket.
 *
 * The ticket lives in the page (the host injects it into the HTML it
 * serves), so a page that was opened before the plugin was updated has
 * none. There is deliberately NO route that hands out a ticket — that
 * would let any script arm the machine again — so the only way out is a
 * restart of DSH.
 */
const SLEEP_STALE_TICKET_REASONS = ['no-ticket', 'bad-ticket', 'expired-ticket', 'replayed-ticket']

const ZH = {
  label: '待重启',
  busyPrefix: ' · 被 ',
  busySuffix: ' 个会话占用',
  idle: ' · 空闲后自动重启',
  goalActive: ' · 被某个会话自动续跑的 goal 占着',
  goalExhausted: ' · 某个会话的 goal 轮次额度已用完，无法续跑',
  parkedGoals: ' · 已停泊 {n} 个 goal，重启后自动继续',
  parkButton: '停泊并重启',
  parkButtonAria: '停泊该会话的 goal，并立即请求重启',
  parkBusy: '停泊中…',
  parkError: '停泊失败：{message}',
  tooltip: '等待其他会话空闲后自动重启；重启后会自动继续本会话进度',
  tooltipBusy: '等待其他会话空闲后自动重启（计数含“排队但还没开始”的任务）；重启后本会话会自动继续进度',
  tooltipWithError: '等待其他会话空闲后自动重启；重启后本会话会自动继续进度。{message}',
  dotAria: '待重启',
  panelHeading: '待重启',
  panelStateBusy: '等待其他会话空闲后重启',
  panelStateIdle: '等待空闲窗口后重启',
  panelStateGoalActive: '等待其他会话停泊它自动续跑的 goal',
  panelStateGoalExhausted: '等待其他会话的 goal（轮次额度已用完）',
  panelBlockedTitle: '占用会话：{title}',
  panelBlockedGeneric: '有一个会话正在运行',
  panelGoalActiveLine: '占用会话「{title}」：goal 正在自动续跑（goal-active）',
  panelGoalExhaustedLine: '占用会话「{title}」：goal 轮次额度已用完，无法继续（goal-exhausted）',
  panelParkedTitle: '已停泊的 goal（重启后自动继续）：',
  panelParkedGoal: '会话 {session} · {goal}',
  panelWaiting: '已等待 {duration}',
  panelResume: '重启后本会话会自动继续进度',
  durationSeconds: '{n} 秒',
  durationMinutes: '{n} 分 {m} 秒',
  durationHours: '{n} 小时 {m} 分',
  // The one-time install prompt (the choice is asked exactly once).
  // "Backup" is the verb and BOTH options share the "configuration" base:
  // the plugins are an ADDITION to the configuration, never a rival of it.
  backupChoiceTitle: '重启前自动备份：要不要把已安装的插件也一起备份？',
  backupChoiceBody: '每次重启前会快照当前配置，万一重启后起不来就能自动回退。',
  backupChoiceWithPlugins: '配置 + 已安装插件',
  backupChoiceWithPluginsHint: '多约 3 秒、约 117 MB；插件把启动搞坏时也能回退。',
  backupChoiceConfigOnly: '只备份配置',
  backupChoiceConfigOnlyHint: '瞬间完成、约 66 KB；插件问题无法回退，需要手动重装。',
  backupChoiceFootnote: '以后可在 设置 → 插件 → dsh-autorestart 修改',
  backupChoicePickPrimary: '用这个',
  backupChoicePickSecondary: '只备份配置',
  backupChoiceRecommended: '推荐',
  backupChoiceDismissAria: '关闭这个一次性提示',
  backupChoiceError: '保存失败：{message}',
  // The graceful-shutdown (sleep) surfaces: the button at the foot of the
  // left sidebar, the floating countdown card, the waiting card and the
  // second install question.
  'sleep.button.label': '收工关机',
  'sleep.button.cancel': '取消关机',
  'sleep.button.aria': '收工关机：等所有会话收工后关机',
  'sleep.button.title': '等所有会话收工，再倒数 {n} 秒关机',
  'sleep.button.titleImmediate': '等所有会话收工后立即关机（不倒数）',
  'sleep.button.busy': '准备中…',
  'sleep.error': '没能联系上关机服务：{message}',
  'sleep.refused': '这次点击没有被接受：{message}',
  'sleep.gestureMissing': '请用鼠标（或触控笔）直接点一下这个按钮：只有真实的点击才算数。',
  'sleep.ticketHint': '插件刚更新过，重启一次 DSH 后可用这个按钮。',
  'sleep.dryRun.title': '试运行：不会真的关机',
  'sleep.dryRun.body': '彩排结束，本来会执行这条命令（真的什么都没执行）：',
  'sleep.dryRun.close': '知道了',
  'sleep.countdown.caption.20': '鲸鱼娘开始收网了',
  'sleep.countdown.caption.19': '备份已经替你打包好',
  'sleep.countdown.caption.18': '没说完的话，再讲一句',
  'sleep.countdown.caption.17': '大家都在慢慢安静下来',
  'sleep.countdown.caption.16': '最后再巡一圈房间',
  'sleep.countdown.caption.15': '海面开始变暗了',
  'sleep.countdown.caption.14': '灯一盏一盏熄了',
  'sleep.countdown.caption.13': '房间已经安静下来',
  'sleep.countdown.caption.12': '还有一小会儿',
  'sleep.countdown.caption.11': '再看一眼屏幕吧',
  'sleep.countdown.caption.10': '鲸鱼娘在数最后几秒',
  'sleep.countdown.caption.9': '灯已经关了一半',
  'sleep.countdown.caption.8': '声音越来越小',
  'sleep.countdown.caption.7': '马上就到道别的时候了',
  'sleep.countdown.caption.6': '最后一口海水',
  'sleep.countdown.caption.5': '晚风越来越轻',
  'sleep.countdown.caption.4': '说声晚安吧',
  'sleep.countdown.caption.3': '真的只剩三秒啦',
  'sleep.countdown.caption.2': '还来得及说声再见',
  'sleep.countdown.caption.1': '晚安 🌙',
  'sleep.countdown.caption.default': '晚安 🌙',
  'sleep.countdown.remaining': '还剩 {n} 秒',
  'sleep.countdown.cancel': '算了，别关',
  'sleep.countdown.goodNight': '晚安 🌙',
  'sleep.countdown.hint': '再过 {n} 秒就关机，点「算了，别关」可以留下。',
  'sleep.waiting.title': '还在等大家收工',
  'sleep.waiting.body': '等这些会话忙完，就轮到关机啦：',
  'sleep.waiting.count': '还有 {n} 个会话在干活',
  'sleep.waiting.blocker': '· {title}',
  'sleep.waiting.none': '（正在确认还有谁在忙）',
  'sleep.waiting.cancel': '不关了',
  'sleep.shuttingDown.title': '晚安 🌙',
  'sleep.shuttingDown.body': '正在关机，鲸鱼娘把灯关好了。',
  'sleep.shuttingDown.dryRun': '试运行：不会真的关机（本来会执行 {command}）',
  'sleep.shuttingDown.dismiss': '关掉这个提示',
  'sleep.choice.title': '收工关机按钮要不要留着？',
  'sleep.choice.body': '它待在左侧栏最底部、设置按钮旁边：点一下就等所有会话收工，倒数几秒后关机。',
  'sleep.choice.keep': '留着（推荐）',
  'sleep.choice.keepCta': '留着',
  'sleep.choice.keepHint': '左侧栏底部多一个月亮按钮，一键收工关机。',
  'sleep.choice.hide': '不要这个按钮',
  'sleep.choice.hideCta': '不要',
  'sleep.choice.hideHint': '界面保持原样；以后想用，再从设置里打开。',
  'sleep.choice.footnote': '以后可在 设置 → 插件 → dsh-autorestart 修改',
  'sleep.choice.diagramLabel': '按钮出现在左侧栏最底部、设置按钮旁边',
  'sleep.choice.error': '保存失败：{message}',
}

const EN = {
  label: 'Pending restart',
  busyPrefix: ' · blocked by ',
  busySuffix: ' session(s)',
  idle: ' · restarts once idle',
  goalActive: ' · held by a self-continuing goal',
  goalExhausted: ' · a goal ran out of rounds',
  parkedGoals: ' · {n} goal(s) parked, they continue after the restart',
  parkButton: 'Park & restart',
  parkButtonAria: 'Park that session goal and request the restart now',
  parkBusy: 'Parking…',
  parkError: 'Park failed: {message}',
  tooltip:
    'Waits for the other sessions to become idle, then restarts automatically; this session resumes its progress after the restart.',
  tooltipBusy:
    'Waits for the other sessions to become idle, then restarts automatically (the count includes work that is queued but not started yet); this session resumes its progress after the restart.',
  tooltipWithError:
    'Waits for the other sessions to become idle, then restarts automatically; this session resumes its progress after the restart. {message}',
  dotAria: 'Pending restart',
  panelHeading: 'Pending restart',
  panelStateBusy: 'Waiting for the other sessions to become idle',
  panelStateIdle: 'Waiting for the idle window',
  panelStateGoalActive: 'Waiting for the other sessions to park their self-continuing goal',
  panelStateGoalExhausted: 'Waiting for the other sessions\' goal (its round budget is used up)',
  panelBlockedTitle: 'Blocking session: {title}',
  panelBlockedGeneric: 'One session is running',
  panelGoalActiveLine: 'Blocking session "{title}": the goal keeps driving rounds by itself (goal-active)',
  panelGoalExhaustedLine: 'Blocking session "{title}": the goal ran out of rounds and cannot continue (goal-exhausted)',
  panelParkedTitle: 'Parked goals (they continue after the restart):',
  panelParkedGoal: 'session {session} · {goal}',
  panelWaiting: 'Waiting for {duration}',
  panelResume: 'This session resumes its progress automatically after the restart.',
  durationSeconds: '{n}s',
  durationMinutes: '{n}m {m}s',
  durationHours: '{n}h {m}m',
  // The one-time install prompt (the choice is asked exactly once).
  // "Backup" is the verb and BOTH options share the "configuration" base:
  // the plugins are an ADDITION to the configuration, never a rival of it.
  backupChoiceTitle: 'Automatic pre-restart backup: include the installed plugins too?',
  backupChoiceBody: 'A snapshot of the current configuration is taken before every restart, so a host that fails to come back can be rolled back automatically.',
  backupChoiceWithPlugins: 'Configuration + installed plugins',
  backupChoiceWithPluginsHint: 'About 3 seconds and 117 MB more; a plugin that breaks the boot can be rolled back too.',
  backupChoiceConfigOnly: 'Configuration only',
  backupChoiceConfigOnlyHint: 'Instant, about 66 KB; plugin problems cannot be rolled back and need a manual reinstall.',
  backupChoiceFootnote: 'You can change this later in Settings → Plugins → dsh-autorestart',
  backupChoicePickPrimary: 'Use this',
  backupChoicePickSecondary: 'Configuration only',
  backupChoiceRecommended: 'Recommended',
  backupChoiceDismissAria: 'Close this one-time prompt',
  backupChoiceError: 'Could not save the choice: {message}',
  // The graceful-shutdown (sleep) surfaces: the button at the foot of the
  // left sidebar, the floating countdown card, the waiting card and the
  // second install question.
  'sleep.button.label': 'Shut down',
  'sleep.button.cancel': 'Cancel the shutdown',
  'sleep.button.aria': 'Graceful shutdown: wait for every session to finish, then power off',
  'sleep.button.title': 'Waits for every session to finish, counts down {n} seconds, then powers off',
  'sleep.button.titleImmediate': 'Waits for every session to finish, then powers off right away (no countdown)',
  'sleep.button.busy': 'Getting ready…',
  'sleep.error': 'Could not reach the sleep service: {message}',
  'sleep.refused': 'This click was not accepted: {message}',
  'sleep.gestureMissing': 'Click the button with the mouse (or a stylus): only a real click counts.',
  'sleep.ticketHint': 'The plugin was just updated; restart DSH once and this button works again.',
  'sleep.dryRun.title': 'Dry run: the machine stays on',
  'sleep.dryRun.body': 'The rehearsal is over. This is the command it WOULD have run (nothing was executed):',
  'sleep.dryRun.close': 'Got it',
  'sleep.countdown.caption.20': 'The whale is casting her net',
  'sleep.countdown.caption.19': 'Your backup is already packed',
  'sleep.countdown.caption.18': 'One unfinished thought, one more',
  'sleep.countdown.caption.17': 'Everyone is quieting down',
  'sleep.countdown.caption.16': 'One last lap around the room',
  'sleep.countdown.caption.15': 'The sea is going dark',
  'sleep.countdown.caption.14': 'One light at a time goes out',
  'sleep.countdown.caption.13': 'The room has gone quiet',
  'sleep.countdown.caption.12': 'A little bit left',
  'sleep.countdown.caption.11': 'One last look at the screen',
  'sleep.countdown.caption.10': 'The whale counts the last seconds',
  'sleep.countdown.caption.9': 'Half the lights are out',
  'sleep.countdown.caption.8': 'The voices get quieter',
  'sleep.countdown.caption.7': 'The goodbyes are close',
  'sleep.countdown.caption.6': 'One last sip of the sea',
  'sleep.countdown.caption.5': 'The night wind gets lighter',
  'sleep.countdown.caption.4': 'Say good night',
  'sleep.countdown.caption.3': 'Three seconds, really',
  'sleep.countdown.caption.2': 'Time for one last goodbye',
  'sleep.countdown.caption.1': 'Good night 🌙',
  'sleep.countdown.caption.default': 'Good night 🌙',
  'sleep.countdown.remaining': '{n} seconds left',
  'sleep.countdown.cancel': 'Never mind, keep it on',
  'sleep.countdown.goodNight': 'Good night 🌙',
  'sleep.countdown.hint': 'Powering off in {n} seconds — pick "Never mind, keep it on" to stay.',
  'sleep.waiting.title': 'Waiting for everyone to finish',
  'sleep.waiting.body': 'Once these sessions are done, the machine powers off:',
  'sleep.waiting.count': '{n} session(s) still working',
  'sleep.waiting.blocker': '· {title}',
  'sleep.waiting.none': '(checking who is still busy)',
  'sleep.waiting.cancel': 'Keep it on',
  'sleep.shuttingDown.title': 'Good night 🌙',
  'sleep.shuttingDown.body': 'Powering off — the whale turned off the lights.',
  'sleep.shuttingDown.dryRun': 'Dry run: nothing will really be powered off (it would have run {command})',
  'sleep.shuttingDown.dismiss': 'Close this notice',
  'sleep.choice.title': 'Keep the graceful shutdown button?',
  'sleep.choice.body': 'It lives at the very bottom of the left sidebar, next to the Settings button: one click waits for every session to finish, counts down and powers the machine off.',
  'sleep.choice.keep': 'Keep it (recommended)',
  'sleep.choice.keepCta': 'Keep it',
  'sleep.choice.keepHint': 'One moon button at the bottom of the left sidebar: one click to shut down gracefully.',
  'sleep.choice.hide': 'No button, thanks',
  'sleep.choice.hideCta': 'No button',
  'sleep.choice.hideHint': 'The interface stays as it is; turn it on again in the settings whenever you want it.',
  'sleep.choice.footnote': 'You can change this later in Settings → Plugins → dsh-autorestart',
  'sleep.choice.diagramLabel': 'The button sits at the bottom of the left sidebar, next to Settings',
  'sleep.choice.error': 'Could not save the choice: {message}',
}

/**
 * Read one translated string out of whatever the caller handed over.
 *
 * The caller may pass a translator function (the DSH locale binding), a
 * dictionary table (flat or nested) or a language code ('zh' / 'en'). A
 * translator that answers with the key itself has no entry: the built-in
 * dictionary is the fallback, so the copy is never hard-coded in a
 * component.
 *
 * @param {Function|object|string} locale
 * @param {string} key
 * @returns {string}
 */
function lookupSleepText(locale, key) {
  if (typeof locale === 'function') {
    try {
      const value = locale(key)
      if (typeof value === 'string' && value !== '' && value !== key) return value
    } catch {
      // A broken translator must not break the surface.
    }
  }
  if (locale && typeof locale === 'object') {
    const direct = locale[key]
    if (typeof direct === 'string' && direct !== '') return direct
    const path = key.split('.')
    let node = locale
    for (const part of path) {
      if (!node || typeof node !== 'object') {
        node = undefined
        break
      }
      node = node[part]
    }
    if (typeof node === 'string' && node !== '') return node
  }
  if (typeof locale === 'string' && locale.toLowerCase().startsWith('en')) {
    const english = EN[key]
    if (typeof english === 'string' && english !== '') return english
  }
  const chinese = ZH[key]
  if (typeof chinese === 'string' && chinese !== '') return chinese
  return key
}

/**
 * The countdown caption of one second.
 *
 * The first twenty seconds have their own line each, so the caption rotates
 * while the number counts down. A LONGER countdown (30 or 60 seconds, both
 * offered in the settings) falls back to one generic line that carries the
 * remaining seconds, so every second of every offered length has a text.
 * Seconds outside the countdown (0, or more than the longest offered
 * countdown) use the "good night" line.
 *
 * @param {number} remainingSeconds
 * @param {Function|object|string} [locale] a translator, a dictionary or a language code
 * @returns {string}
 */
function pickSleepCaption(remainingSeconds, locale) {
  const raw = Number(remainingSeconds)
  const seconds = Number.isFinite(raw) ? Math.ceil(raw) : 0
  if (seconds >= 1 && seconds <= 20) {
    return lookupSleepText(locale, 'sleep.countdown.caption.' + seconds)
  }
  if (seconds > 20 && seconds <= SLEEP_MAX_COUNTDOWN_SECONDS) {
    return lookupSleepText(locale, 'sleep.countdown.remaining').replace(/\{n\}/g, String(seconds))
  }
  return lookupSleepText(locale, 'sleep.countdown.caption.default')
}

/**
 * Whether the graceful-shutdown button may be shown.
 *
 * The Host's truth wins: an explicit `showSleepButton: false` or an
 * unsupported host hides the button (no placeholder, no space). An unknown
 * status does not forbid it — the caller decides with the local record
 * then.
 *
 * @param {object|null|undefined} status the Host's sleep status
 * @returns {boolean}
 */
function shouldShowSleepButton(status) {
  if (!status || typeof status !== 'object') return true
  if (status.showSleepButton === false) return false
  if (status.phase === 'unsupported') return false
  const host = status.host
  if (host && typeof host === 'object' && host.kind === 'unsupported') return false
  return true
}

/**
 * The body of the `POST {prefix}/choice` request.
 *
 * Only the answers that were really given are sent, so the two questions
 * can also be answered one at a time.
 *
 * @param {{ includePlugins?: boolean, showSleepButton?: boolean }} [options]
 * @returns {{ includePlugins?: boolean, showSleepButton?: boolean }}
 */
function buildChoiceBody(options) {
  const source = options && typeof options === 'object' ? options : {}
  const body = {}
  if (typeof source.includePlugins === 'boolean') body.includePlugins = source.includePlugins
  if (typeof source.showSleepButton === 'boolean') body.showSleepButton = source.showSleepButton
  return body
}

/**
 * The whole seconds a countdown still has to run.
 *
 * Rounded UP, so a countdown that has 400 ms left still shows "1" and the
 * number never skips a second.
 *
 * @param {number} ms
 * @returns {number}
 */
function formatRemainingMs(ms) {
  const raw = Number(ms)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.ceil(raw / 1000)
}

/**
 * The named exports of this module.
 *
 * The client module system materializes `factory(require) -> exports`, so
 * these four helpers ARE the module's exports; they are mirrored on
 * `globalThis.__dshAutorestartClient` for the tests that evaluate the file
 * without a loader.
 */
const SLEEP_EXPORTS = {
  pickSleepCaption,
  shouldShowSleepButton,
  buildChoiceBody,
  formatRemainingMs,
}

if (typeof globalThis !== 'undefined' && globalThis !== null) {
  try {
    globalThis.__dshAutorestartClient = Object.assign(globalThis.__dshAutorestartClient || {}, SLEEP_EXPORTS)
  } catch {
    // A frozen global must not break the plugin.
  }
}

// The loader call is guarded so this file can also be evaluated outside a
// browser (the tests read the exports above without a loader).
const moduleLoader = typeof window !== 'undefined' && window.__ModuleLoader__ ? window.__ModuleLoader__ : null
if (moduleLoader) moduleLoader.load({
  id: 'dsh-autorestart',
  factory: function (require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const NS = 'dshAutorestart'
    const HEALTH_URL = '/__dsh_autorestart/health?state=1'
    // The route prefix is derived from the health URL, so the park route is
    // never spelled out twice: the health path without its last segment.
    // The Host sends the authoritative `parkUrl` in the state payload; this
    // is only the fallback for an older Host.
    const ROUTE_PREFIX = HEALTH_URL.split('?')[0].replace(/\/[^/]*$/, '')
    const DEFAULT_PARK_URL = ROUTE_PREFIX + '/park'
    // The route that persists the one-time install choice.
    const DEFAULT_CHOICE_URL = ROUTE_PREFIX + '/choice'
    // The browser-side record of the one-time install choice. The prompt is
    // shown only while this key is missing, so it is asked exactly once.
    const BACKUP_CHOICE_KEY = 'dsh-autorestart:backup-choice-v1'
    const POLL_MS = 2000
    // The brand accent (blue-purple). The pending-restart marker is a brand
    // signal, not a warning: no warning/yellow token is used here.
    const BRAND = 'var(--dsw-alias-brand-primary, #5b8def)'

    // The shared "imminent restart" pulse. The keyframes live in ONE <style>
    // element so the two surfaces (pill dot + sidebar dot) never animate with
    // two different rules.
    const PULSE_STYLE_ID = 'dsh-autorestart-pulse'
    const PULSE_ANIMATION_NAME = 'dsh-autorestart-pulse'
    const PULSE_ANIMATION = PULSE_ANIMATION_NAME + ' 1.8s ease-in-out infinite'
    // Only `transform` and `opacity` are animated: the dot must not resize and
    // must never push the composer row around.
    const PULSE_CSS = [
      '@keyframes ' + PULSE_ANIMATION_NAME + ' {',
      '  0%, 100% { transform: scale(1); opacity: 1; }',
      '  50% { transform: scale(1.5); opacity: 0.55; }',
      '}',
    ].join('\n')

    // Bound during `apply`. The slots are registered without a locale
    // namespace, so the components read the translator through this
    // factory-scoped handle instead of a standard `t` prop.
    let translate = null

    /**
     * ONE shared poller, shared by every surface that shows the pending
     * restart state (the composer pill and the sidebar session-row dot).
     *
     * The store lives at factory scope, so the first subscriber starts ONE
     * 2s interval plus an immediate fetch, and the last one to leave clears
     * the interval and aborts the in-flight request. A failed fetch keeps the
     * last known value, so a transient error never blanks a live marker.
     */
    const stateStore = {
      info: null,
      listeners: new Set(),
      timer: null,
      inFlight: false,
      controller: null,
      // When the pending state was FIRST observed, so the details panel can
      // say how long this session has been waiting.
      pendingSince: null,
    }

    function notifyListeners() {
      stateStore.listeners.forEach((listener) => {
        try {
          listener(stateStore.info)
        } catch {
          // One broken listener must not stop the others.
        }
      })
    }

    async function pollOnce() {
      if (stateStore.inFlight) return
      stateStore.inFlight = true
      try {
        const response = await fetch(HEALTH_URL, {
          cache: 'no-store',
          signal: stateStore.controller ? stateStore.controller.signal : undefined,
        })
        if (!response.ok) return
        const body = await response.json()
        if (!body || typeof body !== 'object') return
        stateStore.info = body
        if (body.pendingRestart === true) {
          if (stateStore.pendingSince === null) stateStore.pendingSince = Date.now()
        } else {
          stateStore.pendingSince = null
        }
        notifyListeners()
      } catch {
        // Ignored on purpose: the marker must never break the composer or the
        // sidebar. The last known value is kept.
      } finally {
        stateStore.inFlight = false
      }
    }

    /**
     * Adds a listener and starts the shared poll when it is the first one.
     * Returns the unsubscribe callback, which stops the shared poll when the
     * last listener leaves.
     */
    function subscribe(listener) {
      stateStore.listeners.add(listener)
      if (stateStore.listeners.size === 1) {
        stateStore.controller = new AbortController()
        pollOnce()
        stateStore.timer = setInterval(pollOnce, POLL_MS)
      }
      return () => {
        stateStore.listeners.delete(listener)
        if (stateStore.listeners.size === 0) {
          if (stateStore.timer !== null) {
            clearInterval(stateStore.timer)
            stateStore.timer = null
          }
          if (stateStore.controller) {
            stateStore.controller.abort()
            stateStore.controller = null
          }
          // The last subscriber left: the shared keyframes rule goes away too.
          removePulseStyle()
        }
      }
    }

    /**
     * Hook-like reader for the shared state: returns the current info and
     * re-renders the caller whenever the shared poll lands a new value.
     */
    function useSharedInfo(enabled) {
      const active = enabled !== false
      const [info, setInfo] = useState(stateStore.info)
      useEffect(() => {
        if (!active) return undefined
        setInfo(stateStore.info)
        return subscribe(setInfo)
      }, [active])
      return info
    }

    /**
     * Inject the shared pulse keyframes exactly once. The id keeps a second
     * injection from duplicating the rule, and the element is removed again
     * when the last subscriber leaves.
     */
    function ensurePulseStyle() {
      if (typeof document === 'undefined' || !document.head) return
      try {
        if (document.getElementById(PULSE_STYLE_ID)) return
        const style = document.createElement('style')
        style.id = PULSE_STYLE_ID
        style.textContent = PULSE_CSS
        document.head.appendChild(style)
      } catch {
        // Without the rule the dot simply does not pulse; nothing else breaks.
      }
    }

    /** Remove the shared pulse keyframes (the last subscriber left). */
    function removePulseStyle() {
      if (typeof document === 'undefined') return
      try {
        const node = document.getElementById(PULSE_STYLE_ID)
        if (node && node.parentNode) node.parentNode.removeChild(node)
      } catch {
        // Nothing to clean up.
      }
    }

    /** True when the user asked the OS to reduce motion. */
    function prefersReducedMotion() {
      try {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
      } catch {
        return false
      }
    }

    /** The dot style, with the pulse applied when the restart is imminent. */
    function dotStyle(base, pulsing) {
      if (!pulsing) return base
      return {
        ...base,
        animation: PULSE_ANIMATION,
        transformOrigin: 'center',
      }
    }

    /**
     * Fill `{name}` placeholders in a locale template. The locale API is not
     * assumed to interpolate, so the panel does it itself.
     */
    function fill(template, vars) {
      if (typeof template !== 'string') return ''
      return template.replace(/\{(\w+)\}/g, (match, name) => (
        vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
      ))
    }

    /** How long the pending restart has been waiting, as a locale string. */
    function formatWaiting(ms, t) {
      const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000))
      if (totalSeconds < 60) return fill(t('durationSeconds'), { n: totalSeconds })
      const minutes = Math.floor(totalSeconds / 60)
      if (minutes < 60) return fill(t('durationMinutes'), { n: minutes, m: totalSeconds % 60 })
      const hours = Math.floor(minutes / 60)
      return fill(t('durationHours'), { n: hours, m: minutes % 60 })
    }

    /**
     * The park route to POST to: the one the Host sent with the state payload,
     * or the one derived from the health path when the Host is older.
     */
    function parkUrlFor(info) {
      const sent = info && typeof info.parkUrl === 'string' ? info.parkUrl.trim() : ''
      if (sent.startsWith('/')) return sent
      return DEFAULT_PARK_URL
    }

    /**
     * The route that persists the one-time install choice: the one the Host
     * sent with the state payload, or the one derived from the health path.
     */
    function choiceUrlFor(info) {
      const sent = info && typeof info.choiceUrl === 'string' ? info.choiceUrl.trim() : ''
      if (sent.startsWith('/')) return sent
      return DEFAULT_CHOICE_URL
    }

    /**
     * Whether the one-time install prompt may be shown.
     *
     * It may be shown only while the browser has no record of a choice yet,
     * i.e. while `localStorage['dsh-autorestart:backup-choice-v1']` is
     * missing. A browser without a usable localStorage answers "no": the
     * prompt must not come back on every reload there.
     */
    function backupChoicePending() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return false
        return window.localStorage.getItem(BACKUP_CHOICE_KEY) === null
      } catch {
        return false
      }
    }

    /**
     * Record the one-time choice in the browser.
     *
     * The key is written as soon as the user picks an option (or closes the
     * prompt), so the question is asked exactly once.
     */
    function writeBackupChoice(value) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return false
        window.localStorage.setItem(BACKUP_CHOICE_KEY, String(value))
        return true
      } catch {
        return false
      }
    }

    /** A short, human readable description of a failed request. */
    function describeError(error) {
      if (!error) return 'unknown error'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    // The pill sits in the composer tool row, so it must fit the toolbar
    // height (~22px) and never push that row around: `flex: 'none'` plus a
    // fixed height, and the text is clipped with an ellipsis instead of
    // wrapping. No absolute/fixed positioning, no negative margins. The
    // border stays neutral; only the dot carries the brand accent.
    const PILL_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      flex: 'none',
      gap: 6,
      height: 22,
      boxSizing: 'border-box',
      maxWidth: '100%',
      padding: '0 8px',
      borderRadius: 999,
      fontSize: 12,
      lineHeight: '20px',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      color: 'var(--dsw-alias-label-secondary, inherit)',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
      cursor: 'pointer',
    }

    // The wrapper is the pill's anchor: it is the only element that may
    // position absolutely (the details panel), so it stays `relative` while
    // the pill itself keeps its inline layout.
    const WRAPPER_STYLE = {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      flex: 'none',
      maxWidth: '100%',
    }

    const DOT_STYLE = {
      display: 'inline-block',
      width: 6,
      height: 6,
      borderRadius: '50%',
      flexShrink: 0,
      background: BRAND,
    }

    // The 8px brand dot that occupies the leading 16px state cell of a
    // sidebar session row. `margin: 0 auto` centers it in that cell; it is
    // icon-only, so the full text lives in the `title` tooltip.
    const SIDEBAR_DOT_STYLE = {
      display: 'block',
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: BRAND,
      margin: '0 auto',
      flex: 'none',
      boxSizing: 'border-box',
    }

    // The label + status text is one clipped line inside the pill.
    const TEXT_STYLE = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    // The details panel: anchored to the wrapper, above the pill, left
    // aligned. It uses the host theme tokens (background / border / label
    // color) so it follows the app theme.
    const PANEL_STYLE = {
      position: 'absolute',
      bottom: '100%',
      left: 0,
      zIndex: 30,
      minWidth: 260,
      maxWidth: 320,
      marginBottom: 6,
      padding: '8px 10px',
      borderRadius: 8,
      fontSize: 12,
      lineHeight: '18px',
      textAlign: 'left',
      whiteSpace: 'normal',
      color: 'var(--dsw-alias-label-primary, inherit)',
      background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, #fff))',
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
      boxShadow: '0 6px 16px rgba(0, 0, 0, 0.16)',
      cursor: 'default',
    }

    const PANEL_HEADING_STYLE = {
      fontWeight: 600,
      marginBottom: 4,
    }

    const PANEL_LINE_STYLE = {
      margin: '1px 0',
    }

    const PANEL_MUTED_STYLE = {
      margin: '4px 0 0',
      opacity: 0.75,
    }

    // The park button lives inside the pill and reuses the pill's own button
    // look (same tokens, same border, same radius), only smaller so the pill
    // stays a one-line chip. It is inline (no absolute/fixed positioning, no
    // negative margins) and never becomes a second element in the slot.
    const PARK_BUTTON_STYLE = {
      ...PILL_STYLE,
      height: 18,
      padding: '0 6px',
      fontSize: 11,
      lineHeight: '16px',
      gap: 4,
    }

    // The park button while its request is in flight.
    const PARK_BUTTON_BUSY_STYLE = {
      ...PARK_BUTTON_STYLE,
      cursor: 'default',
      opacity: 0.6,
    }

    // The short "N goals parked" line inside the pill.
    const PARKED_LINE_STYLE = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      opacity: 0.75,
    }

    // The inline error line of the details panel.
    const PANEL_ERROR_STYLE = {
      margin: '2px 0',
      fontWeight: 600,
      color: 'var(--dsw-alias-danger, #d14343)',
    }

    // The one-time install prompt. It is NOT a modal: it is an ordinary block
    // in the composer dock, so the input box stays usable and nothing is
    // blocked. It never disappears on its own.
    //
    // The look follows the established DSH plugin styling: one 14px/600
    // heading, a muted subtitle, two selectable rows (a name + a note on the
    // left, the action on the right) and a muted footnote. The primary option
    // carries a "recommended" pill and a solid button; the secondary one is
    // outlined. Only theme tokens are used, so light and dark themes both
    // work.
    const CHOICE_STYLE_ID = 'dsh-autorestart-choice'
    const CHOICE_CSS = [
      '.dsh-autorestart-choice{',
      '  display:flex;',
      '  flex-direction:column;',
      '  gap:8px;',
      '  width:min(560px,94vw);',
      '  max-width:100%;',
      '  box-sizing:border-box;',
      '  margin:0 0 6px;',
      '  padding:16px 18px;',
      '  border:1px solid var(--dsw-alias-border-l1);',
      '  border-radius:12px;',
      '  background:var(--dsw-alias-bg-layer-1);',
      '  box-shadow:0 8px 24px color-mix(in srgb, var(--dsw-alias-bg-mask-3) 20%, transparent);',
      '  color:var(--dsw-alias-label-secondary);',
      '  font-size:13px;',
      '  line-height:18px;',
      '}',
      '.dsh-autorestart-choice h3{',
      '  margin:0;',
      '  font-size:14px;',
      '  font-weight:600;',
      '  line-height:20px;',
      '  color:var(--dsw-alias-label-primary);',
      '}',
      '.dsh-autorestart-choice p{margin:0;}',
      '.dsh-autorestart-choice__head{',
      '  display:flex;',
      '  align-items:flex-start;',
      '  justify-content:space-between;',
      '  gap:10px;',
      '}',
      '.dsh-autorestart-choice__subtitle{',
      '  font-size:12.5px;',
      '  line-height:18px;',
      '  color:var(--dsw-alias-label-secondary);',
      '}',
      '.dsh-autorestart-choice__options{',
      '  display:flex;',
      '  flex-direction:column;',
      '  gap:10px;',
      '}',
      '.dsh-autorestart-choice__row{',
      '  display:flex;',
      '  align-items:center;',
      '  justify-content:space-between;',
      '  gap:10px;',
      '  padding:10px 12px;',
      '  border:1px solid transparent;',
      '  border-radius:10px;',
      '  cursor:pointer;',
      '  transition:background-color .14s,border-color .14s;',
      '}',
      '.dsh-autorestart-choice__row:hover,',
      '.dsh-autorestart-choice__row:focus-within{',
      '  border-color:var(--dsw-alias-border-l1);',
      '  background:var(--dsw-alias-bg-layer-2, color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent));',
      '}',
      '.dsh-autorestart-choice__row:focus-visible{',
      '  outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
      '  outline-offset:2px;',
      '}',
      '.dsh-autorestart-choice__text{flex:1 1 auto;min-width:0;}',
      '.dsh-autorestart-choice__title{',
      '  display:flex;',
      '  align-items:center;',
      '  gap:6px;',
      '  min-width:0;',
      '}',
      '.dsh-autorestart-choice__name{',
      '  font-size:13px;',
      '  font-weight:600;',
      '  line-height:18px;',
      '  color:var(--dsw-alias-label-primary);',
      '}',
      '.dsh-autorestart-choice__hint{',
      '  display:block;',
      '  margin-top:2px;',
      '  font-size:12px;',
      '  line-height:17px;',
      '  color:var(--dsw-alias-label-secondary);',
      '}',
      '.dsh-autorestart-choice__badge{',
      '  flex:none;',
      '  display:inline-block;',
      '  padding:1px 7px;',
      '  border-radius:999px;',
      '  font-size:11px;',
      '  font-weight:600;',
      '  line-height:16px;',
      '  color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
      '  background:color-mix(in srgb, var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe)) 12%, transparent);',
      '}',
      '.dsh-autorestart-choice__cta{',
      '  flex:none;',
      '  min-width:28px;',
      '  min-height:28px;',
      '  padding:4px 12px;',
      '  border-radius:8px;',
      '  font:inherit;',
      '  font-size:12.5px;',
      '  font-weight:600;',
      '  line-height:18px;',
      '  cursor:pointer;',
      '  transition:background-color .14s,border-color .14s,color .14s;',
      '}',
      '.dsh-autorestart-choice__cta:focus-visible{',
      '  outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
      '  outline-offset:2px;',
      '}',
      '.dsh-autorestart-choice__cta--primary{',
      '  border:1px solid transparent;',
      '  background:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
      '  color:var(--dsw-alias-bg-layer-1,#fff);',
      '}',
      '.dsh-autorestart-choice__cta--secondary{',
      '  border:1px solid var(--dsw-alias-border-l1);',
      '  background:transparent;',
      '  color:var(--dsw-alias-label-primary);',
      '}',
      '.dsh-autorestart-choice__cta--secondary:hover{',
      '  border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
      '  color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
      '}',
      '.dsh-autorestart-choice__close{',
      '  flex:none;',
      '  width:28px;',
      '  height:28px;',
      '  padding:0;',
      '  border:1px solid transparent;',
      '  border-radius:8px;',
      '  background:transparent;',
      '  color:var(--dsw-alias-label-secondary);',
      '  font:inherit;',
      '  font-size:16px;',
      '  line-height:1;',
      '  cursor:pointer;',
      '  transition:background-color .14s;',
      '}',
      '.dsh-autorestart-choice__close:hover{',
      '  background:var(--dsw-alias-bg-layer-2, color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent));',
      '}',
      '.dsh-autorestart-choice__close:focus-visible{',
      '  outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
      '  outline-offset:2px;',
      '}',
      '.dsh-autorestart-choice__footnote{',
      '  margin-top:10px;',
      '  padding-top:10px;',
      '  border-top:1px solid var(--dsw-alias-border-l1);',
      '  font-size:11px;',
      '  line-height:16px;',
      '  color:var(--dsw-alias-label-secondary);',
      '}',
      '.dsh-autorestart-choice__diagram{margin:2px 0 10px;}',
      '.dsh-autorestart-choice__diagram__art{',
      '  width:100%;',
      '  max-width:260px;',
      '  height:auto;',
      '  display:block;',
      '}',
      '@media (max-width:1023px){',
      '  .dsh-autorestart-choice{width:calc(100vw - 32px);}',
      '}',
      '@media (max-width:640px){',
      '  .dsh-autorestart-choice__row{flex-direction:column;align-items:stretch;}',
      '  .dsh-autorestart-choice__cta{width:100%;}',
      '}',
    ].join('\n')

    /**
     * One compact pill in the composer tool row, visible only while THIS
     * session is waiting for a pending restart. Clicking it (or pressing
     * Enter / Space) opens the details panel. Single root element.
     */
    function RestartPill(props) {
      const sessionId = props && props.sessionId !== undefined ? props.sessionId : null
      const hasSession = sessionId !== null && sessionId !== ''
      const info = useSharedInfo(hasSession)
      // The session id of the goal that is currently being parked, or null.
      const [parking, setParking] = useState(null)
      // The message of the last failed park request (the Host's own message).
      // It is shown in the pill's tooltip: the pill has no details panel.
      const [parkError, setParkError] = useState('')
      const t = translate ?? ((name) => name)

      const pending = Boolean(info && info.pendingRestart === true)
      // The restart is imminent: the Host's idle gate is open, so the restart
      // happens as soon as this poll cycle ends.
      const pulsing = pending && Boolean(info.allowRestart === true) && !prefersReducedMotion()

      // A park error never outlives the pending state.
      useEffect(() => {
        if (!pending) {
          setParkError('')
          setParking(null)
        }
      }, [pending])

      if (!info || info.pendingRestart !== true) return null

      const waiters = Array.isArray(info.waiters) ? info.waiters : []
      const key = String(sessionId)
      const waiting = waiters.some((waiter) => String(waiter) === key)
      if (!waiting) return null

      const blockedBy = Array.isArray(info.blockedBy) ? info.blockedBy : []
      // One entry per SESSION: a conversation that is running *and* still has
      // queued work is one conversation, so the pill never counts it twice.
      const seenSessions = new Set()
      const others = blockedBy.filter((entry) => {
        if (!entry) return false
        const id = String(entry.sessionId)
        if (id === key || seenSessions.has(id)) return false
        seenSessions.add(id)
        return true
      })
      // A goal-driven blocker: an armed goal that keeps driving rounds by
      // itself (`goal-active`, parkable) or a goal whose round budget is used
      // up (`goal-exhausted`, not parkable at all).
      const goalActive = others.filter((entry) => String(entry.reason) === 'goal-active')
      const goalExhausted = others.filter((entry) => String(entry.reason) === 'goal-exhausted')
      const otherBusy = others.length - goalActive.length - goalExhausted.length

      const status = goalActive.length > 0
        ? t('goalActive')
        : goalExhausted.length > 0
          ? t('goalExhausted')
          : otherBusy > 0
            ? `${t('busyPrefix')}${otherBusy}${t('busySuffix')}`
            : t('idle')

      if (pulsing) ensurePulseStyle()

      /**
       * Park the goal of one blocking session and ask for the restart now.
       *
       * The Host parks that goal (so the session stops driving rounds) and
       * makes this session a requester of the pending restart. The shared
       * poll picks the new state up on its next tick.
       *
       * Never throws: a refused request (403) or a conflict (409) shows the
       * Host's own message as an inline error line instead.
       */
      const parkAndRestart = async (targetSessionId) => {
        if (parking) return
        setParking(targetSessionId)
        setParkError('')
        try {
          const response = await fetch(parkUrlFor(info), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: targetSessionId, restart: true }),
          })
          let body = null
          try {
            body = await response.json()
          } catch {
            body = null
          }
          if (!response.ok) {
            const message = body && typeof body === 'object'
              ? (body.error || body.message || '')
              : ''
            setParkError(fill(t('parkError'), { message: message || String(response.status) }))
            return
          }
          if (body && Array.isArray(body.reported)) {
            const reported = body.reported.find(
              (entry) => entry && String(entry.sessionId) === String(targetSessionId),
            )
            if (reported) {
              setParkError(fill(t('parkError'), { message: String(reported.reason || 'not-parked') }))
            }
          }
        } catch (error) {
          setParkError(fill(t('parkError'), { message: describeError(error) }))
        } finally {
          setParking(null)
        }
      }

      return h(
        'div',
        {
          style: WRAPPER_STYLE,
          role: 'status',
          'aria-live': 'polite',
        },
        h(
          'div',
          {
            style: PILL_STYLE,
            title: parkError
              ? fill(t('tooltipWithError'), { message: parkError })
              : (otherBusy > 0 ? t('tooltipBusy') : t('tooltip')),
          },
          h('span', { style: dotStyle(DOT_STYLE, pulsing), 'aria-hidden': 'true' }),
          h('span', { style: TEXT_STYLE }, h('b', null, t('label')), status),
          // One park button per goal-driven blocker that can be parked. It
          // lives inside the pill, so the slot still has a single root.
          goalActive.map((entry, index) => {
            const target = String(entry.sessionId)
            const busy = parking === target
            const onParkClick = (event) => {
              if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
              void parkAndRestart(target)
            }
            const onParkKeyDown = (event) => {
              if (!event) return
              const pressed = event.key
              if (pressed === 'Enter' || pressed === ' ' || pressed === 'Spacebar') {
                if (typeof event.stopPropagation === 'function') event.stopPropagation()
              }
            }
            return h(
              'button',
              {
                key: 'park-' + index,
                type: 'button',
                style: busy ? PARK_BUTTON_BUSY_STYLE : PARK_BUTTON_STYLE,
                title: t('parkButtonAria'),
                'aria-label': t('parkButtonAria'),
                disabled: parking !== null,
                onClick: onParkClick,
                onKeyDown: onParkKeyDown,
              },
              busy ? t('parkBusy') : t('parkButton'),
            )
          }),
        ),
      )
    }

    /**
     * The brand dot in the leading 16px state cell of a left-sidebar session
     * row, visible only while THAT session is waiting for a pending restart.
     * Icon-only: the full explanation is the `title` tooltip. Single root
     * element.
     */
    function RestartDot(props) {
      const sessionId = props && props.sessionId !== undefined ? props.sessionId : null
      const hasSession = sessionId !== null && sessionId !== ''
      const info = useSharedInfo(hasSession)

      if (!info || info.pendingRestart !== true) return null

      const waiters = Array.isArray(info.waiters) ? info.waiters : []
      const key = String(sessionId)
      const waiting = waiters.some((waiter) => String(waiter) === key)
      if (!waiting) return null

      const t = translate ?? ((name) => name)
      const pulsing = info.allowRestart === true && !prefersReducedMotion()
      if (pulsing) ensurePulseStyle()

      return h('span', {
        style: dotStyle(SIDEBAR_DOT_STYLE, pulsing),
        title: t('tooltip'),
        role: 'status',
        'aria-live': 'polite',
        'aria-label': t('dotAria'),
      })
    }

    /**
     * Inject the prompt styles exactly once. The id keeps a second injection
     * from duplicating the rule.
     */
    function ensureChoiceStyle() {
      if (typeof document === 'undefined' || !document.head) return
      try {
        if (document.getElementById(CHOICE_STYLE_ID)) return
        const style = document.createElement('style')
        style.id = CHOICE_STYLE_ID
        style.textContent = CHOICE_CSS
        document.head.appendChild(style)
      } catch {
        // Without the stylesheet the prompt is still readable, just plainer.
      }
    }

    /**
     * The one-time install prompt.
     *
     * It asks TWO questions, one after the other:
     *
     *   1. should the pre-restart backup also snapshot the installed plugin
     *      tree? (the first question — its behaviour is unchanged);
     *   2. should the graceful-shutdown button stay at the foot of the left
     *      sidebar?
     *
     * The first answer is persisted BEFORE the second question appears: the
     * two questions are never stacked on top of each other, and the second
     * one only shows up after the first one really reached the Host.
     *
     * "Backup" is the verb and BOTH options share the "configuration" base:
     * the plugins are an addition to the configuration, never a rival of it.
     *
     * It is deliberately NOT a modal: it is an ordinary block in the composer
     * dock (`role="status"`), so the input box stays usable, nothing is
     * blocked, and it never disappears on its own — it stays until the user
     * picks an option or closes it. It is keyboard reachable (focusable, Esc
     * closes it) and adapts to a narrow window.
     *
     * The answer goes to the Host, which writes it into the profile
     * configuration (the same key the settings page edits).
     */
    function BackupChoicePanel() {
      const info = useSharedInfo(true)
      // 'backup' is the first question, 'sleep' the second one, 'persisting'
      // the short moment in between (the first answer is on its way to the
      // Host) and 'done' when there is nothing left to ask.
      //
      // The two questions are judged SEPARATELY: an installation that already
      // answered the backup question still has to be asked about the shutdown
      // button (that is how the arrow sketch ever reaches a user who
      // installed the plugin before this question existed).
      const [step, setStep] = useState(
        backupChoicePending() ? 'backup' : (sleepChoicePending() ? 'sleep' : 'done'),
      )
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const t = translate ?? ((name) => name)

      /**
       * Hand the FIRST answer to the Host.
       *
       * The browser records the choice FIRST (so the question is never asked
       * twice) and then posts it to the Host, which persists it in the
       * profile configuration. The SECOND question only appears once that
       * answer really left the browser.
       */
      const choose = (includePlugins) => {
        if (busy) return
        setBusy(true)
        setError('')
        writeBackupChoice(includePlugins ? 'plugins' : 'config-only')
        setStep('persisting')
        void (async () => {
          let failed = false
          try {
            const response = await fetch(choiceUrlFor(info), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(buildChoiceBody({ includePlugins })),
            })
            if (!response.ok) {
              failed = true
              setError(fill(t('backupChoiceError'), { message: String(response.status) }))
            }
          } catch (failure) {
            failed = true
            setError(fill(t('backupChoiceError'), { message: describeError(failure) }))
          } finally {
            setBusy(false)
            if (failed) {
              // The answer did not reach the Host: the first question stays
              // on screen with the reason, so it can be answered again.
              setStep('backup')
              return
            }
            // The first answer is persisted: the second question may follow.
            setStep(sleepChoicePending() ? 'sleep' : 'done')
          }
        })()
      }

      /**
       * Hand the SECOND answer to the Host: should the shutdown button stay?
       */
      const chooseSleep = (showSleepButton) => {
        if (busy) return
        setBusy(true)
        setError('')
        writeSleepChoice(showSleepButton ? 'keep' : 'hide')
        void (async () => {
          try {
            const response = await fetch(choiceUrlFor(info), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(buildChoiceBody({ showSleepButton })),
            })
            if (!response.ok) {
              setError(fill(t('sleep.choice.error'), { message: String(response.status) }))
              setStep('sleep')
              return
            }
          } catch (failure) {
            setError(fill(t('sleep.choice.error'), { message: describeError(failure) }))
            setStep('sleep')
            return
          } finally {
            setBusy(false)
          }
          setStep('done')
        })()
      }

      /**
       * Close the FIRST question without answering: the default (the
       * configuration AND the installed plugins) stays in place, the question
       * is not asked again — and the second one is not asked either, because
       * closing the prompt means "do not ask me again".
       */
      const dismissBackup = () => {
        if (busy) return
        writeBackupChoice('dismissed')
        writeSleepChoice('dismissed')
        setStep('done')
      }

      /**
       * Close the SECOND question without answering: the button stays (the
       * default) and the question is not asked again.
       */
      const dismissSleep = () => {
        if (busy) return
        writeSleepChoice('dismissed')
        setStep('done')
      }

      /** Esc closes the prompt (the panel itself is focusable). */
      const onKeyDown = (event) => {
        if (!event) return
        if (event.key === 'Escape' || event.key === 'Esc') {
          if (step === 'sleep') dismissSleep()
          else dismissBackup()
        }
      }

      if (step === 'done' || step === 'persisting') return null
      ensureChoiceStyle()

      /**
       * One option row.
       *
       * The WHOLE row is the click target (and it is focusable, with the
       * radio semantics of a one-of-two choice), while the right side carries
       * the concrete action. The primary row wears a "recommended" pill and a
       * solid button; the secondary one an outlined button.
       */
      const optionRow = (key, name, hint, cta, variant, recommended, pick, dataAttribute) => {
        const onRowClick = () => pick()
        const onRowKeyDown = (event) => {
          if (!event) return
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            if (typeof event.preventDefault === 'function') event.preventDefault()
            pick()
          }
        }
        // The button inside the row must not trigger the row a second time.
        const onCtaClick = (event) => {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
          pick()
        }
        return h(
          'div',
          {
            key,
            className: 'dsh-autorestart-choice__row',
            role: 'radio',
            'aria-checked': 'false',
            'aria-label': name,
            tabIndex: busy ? -1 : 0,
            [dataAttribute]: key,
            onClick: onRowClick,
            onKeyDown: onRowKeyDown,
          },
          h(
            'div',
            { className: 'dsh-autorestart-choice__text' },
            h(
              'span',
              { className: 'dsh-autorestart-choice__title' },
              recommended
                ? h('span', { className: 'dsh-autorestart-choice__badge' }, t('backupChoiceRecommended'))
                : null,
              h('span', { className: 'dsh-autorestart-choice__name' }, name),
            ),
            h('span', { className: 'dsh-autorestart-choice__hint' }, hint),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-autorestart-choice__cta dsh-autorestart-choice__cta--' + variant,
              [dataAttribute]: key,
              'aria-label': cta,
              title: cta,
              disabled: busy,
              onClick: onCtaClick,
            },
            cta,
          ),
        )
      }

      // The FIRST question: the backup scope (its behaviour is unchanged).
      if (step === 'backup') {
        return h(
          'div',
          {
            className: 'dsh-autorestart-choice',
            role: 'status',
            'aria-live': 'polite',
            tabIndex: 0,
            onKeyDown,
            'data-dsh-autorestart-backup-choice': 'true',
            'data-dsh-autorestart-choice-step': 'backup',
          },
          h(
            'div',
            { className: 'dsh-autorestart-choice__head' },
            h('h3', null, t('backupChoiceTitle')),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-autorestart-choice__close',
                'aria-label': t('backupChoiceDismissAria'),
                title: t('backupChoiceDismissAria'),
                disabled: busy,
                onClick: dismissBackup,
              },
              '×',
            ),
          ),
          h('p', { className: 'dsh-autorestart-choice__subtitle' }, t('backupChoiceBody')),
          h(
            'div',
            { className: 'dsh-autorestart-choice__options' },
            optionRow(
              'plugins',
              t('backupChoiceWithPlugins'),
              t('backupChoiceWithPluginsHint'),
              t('backupChoicePickPrimary'),
              'primary',
              true,
              () => choose(true),
              'data-backup-choice',
            ),
            optionRow(
              'config-only',
              t('backupChoiceConfigOnly'),
              t('backupChoiceConfigOnlyHint'),
              t('backupChoicePickSecondary'),
              'secondary',
              false,
              () => choose(false),
              'data-backup-choice',
            ),
          ),
          h('p', { className: 'dsh-autorestart-choice__footnote' }, t('backupChoiceFootnote')),
          error === '' ? null : h('p', { role: 'alert' }, error),
        )
      }

      // The SECOND question: should the graceful-shutdown button stay?
      return h(
        'div',
        {
          className: 'dsh-autorestart-choice',
          role: 'status',
          'aria-live': 'polite',
          tabIndex: 0,
          onKeyDown,
          'data-dsh-autorestart-backup-choice': 'true',
          'data-dsh-autorestart-choice-step': 'sleep',
        },
        h(
          'div',
          { className: 'dsh-autorestart-choice__head' },
          h('h3', null, t('sleep.choice.title')),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-autorestart-choice__close',
              'aria-label': t('backupChoiceDismissAria'),
              title: t('backupChoiceDismissAria'),
              disabled: busy,
              onClick: dismissSleep,
            },
            '×',
          ),
        ),
        h(
          'div',
          {
            className: 'dsh-autorestart-choice__diagram',
            role: 'img',
            'aria-label': t('sleep.choice.diagramLabel'),
          },
          sleepDiagram(),
        ),
        h('p', { className: 'dsh-autorestart-choice__subtitle' }, t('sleep.choice.body')),
        h(
          'div',
          { className: 'dsh-autorestart-choice__options' },
          optionRow(
            'keep',
            t('sleep.choice.keep'),
            t('sleep.choice.keepHint'),
            t('sleep.choice.keepCta'),
            'primary',
            true,
            () => chooseSleep(true),
            'data-sleep-choice',
          ),
          optionRow(
            'hide',
            t('sleep.choice.hide'),
            t('sleep.choice.hideHint'),
            t('sleep.choice.hideCta'),
            'secondary',
            false,
            () => chooseSleep(false),
            'data-sleep-choice',
          ),
        ),
        h('p', { className: 'dsh-autorestart-choice__footnote' }, t('sleep.choice.footnote')),
        error === '' ? null : h('p', { role: 'alert' }, error),
      )
    }

    /* ------------------------------------------------------------------ *
     * The graceful-shutdown (sleep) half.
     * ------------------------------------------------------------------ */

    // The route that arms and cancels the shutdown. It is a sibling of the
    // health route and shares its prefix, so it is derived the very same way.
    const DEFAULT_SLEEP_URL = ROUTE_PREFIX + '/sleep'

    /**
     * ONE shared poller for the sleep status, shared by the sidebar button
     * and the overlay.
     *
     * It follows the pattern of the pending-restart store: the first
     * subscriber starts ONE interval (the same POLL_MS cadence) plus an
     * immediate fetch, and the last one to leave clears the interval and
     * aborts the in-flight request. A failed fetch keeps the last known
     * status, so a transient error never blanks a live countdown.
     */
    const sleepStore = {
      info: null,
      listeners: new Set(),
      timer: null,
      inFlight: false,
      controller: null,
      // When the current status was received: the countdown runs on this
      // clock, so the big number keeps moving between two polls.
      at: 0,
    }

    /** Publish a new sleep status to every surface. */
    function setSleepInfo(body) {
      sleepStore.info = body
      sleepStore.at = Date.now()
      sleepStore.listeners.forEach((listener) => {
        try {
          listener(body)
        } catch {
          // One broken listener must not stop the others.
        }
      })
    }

    async function pollSleepOnce() {
      if (sleepStore.inFlight) return
      sleepStore.inFlight = true
      try {
        // The ticket travels with the poll (it is NOT spent by the status
        // request): the host answers `ticketReady`, so a page that cannot
        // arm the machine is visible in the state.
        const grant = sleepTicket()
        const response = await fetch(DEFAULT_SLEEP_URL, {
          cache: 'no-store',
          headers: grant ? { 'x-dsh-sleep-ticket': grant.ticket } : {},
          signal: sleepStore.controller ? sleepStore.controller.signal : undefined,
        })
        if (!response.ok) return
        const body = await response.json()
        if (!body || typeof body !== 'object') return
        setSleepInfo(body)
      } catch {
        // Ignored on purpose: the last known status stays.
      } finally {
        sleepStore.inFlight = false
      }
    }

    /**
     * Adds a listener and starts the shared poll when it is the first one.
     * The returned callback stops the poll when the last listener leaves.
     */
    function subscribeSleep(listener) {
      sleepStore.listeners.add(listener)
      if (sleepStore.listeners.size === 1) {
        sleepStore.controller = new AbortController()
        pollSleepOnce()
        sleepStore.timer = setInterval(pollSleepOnce, POLL_MS)
      }
      return () => {
        sleepStore.listeners.delete(listener)
        if (sleepStore.listeners.size === 0) {
          if (sleepStore.timer !== null) {
            clearInterval(sleepStore.timer)
            sleepStore.timer = null
          }
          if (sleepStore.controller) {
            sleepStore.controller.abort()
            sleepStore.controller = null
          }
          // The last sleep surface left: its stylesheet goes away with it, so
          // the document does not keep the CSS of a plugin that is gone.
          removeSleepStyle()
        }
      }
    }

    /**
     * Ask the Host to arm or to cancel the shutdown.
     *
     * The answer carries the new status, so the surfaces do not have to wait
     * for the next poll. A refused request throws, and the caller shows the
     * reason.
     *
     * @param {'arm'|'cancel'} action
     * @param {object} [extraHeaders] the gesture headers of a real click
     * @returns {Promise<object>} the new sleep status
     */
    async function requestSleep(action, extraHeaders) {
      const headers = { 'content-type': 'application/json' }
      if (extraHeaders && typeof extraHeaders === 'object') {
        for (const [key, value] of Object.entries(extraHeaders)) {
          if (typeof value === 'string' && value !== '') headers[key] = value
        }
      }
      const response = await fetch(DEFAULT_SLEEP_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action }),
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok) {
        const message = body && typeof body === 'object'
          ? (body.message || body.error || '')
          : ''
        const failure = new Error(message || String(response.status))
        failure.sleepStatus = response.status
        if (body && typeof body === 'object' && typeof body.reason === 'string') {
          failure.reason = body.reason
        }
        throw failure
      }
      if (body && typeof body === 'object') setSleepInfo(body)
      return body
    }

    /**
     * The last real gesture on the shutdown button.
     *
     * A trusted event (`isTrusted === true`) is something the page itself
     * cannot fake, so it is the proof that a person really clicked. The host
     * only accepts an arm request within {@link SLEEP_GESTURE_WINDOW_MS} of
     * it.
     *
     * WHICH event carries that proof differs per device: a modern browser
     * sends `pointerdown`, an older one only `mousedown`, a touch screen
     * `touchstart`, and a keyboard activation (or a driver that sends
     * nothing at all) only a `click`. So every one of them counts — but only
     * when it is trusted.
     */
    const sleepGesture = { at: 0 }

    /**
     * Remember a trusted gesture.
     *
     * A synthetic event (a script that dispatches one, or an injected
     * message) is never trusted, so it never records a gesture and never
     * leads to a ticket.
     *
     * @param {object} event the DOM event of the gesture
     */
    function rememberSleepGesture(event) {
      if (!event || event.isTrusted !== true) return
      sleepGesture.at = Date.now()
    }

    /**
     * The one-time ticket the host injected into this page.
     *
     * @returns {{ ticket: string, issuedAt: number }|null}
     */
    function sleepTicket() {
      if (typeof window === 'undefined') return null
      const grant = window.__DSH_SLEEP_TICKET__
      if (!grant || typeof grant !== 'object') return null
      if (typeof grant.ticket !== 'string' || grant.ticket === '') return null
      return { ticket: grant.ticket, issuedAt: Number(grant.issuedAt) || 0 }
    }

    /**
     * The headers of a click: the one-time ticket of this page plus the
     * timestamp of the gesture.
     *
     * The ticket always travels with the request (on its own it is worth
     * nothing: the host wants the gesture as well), the gesture only when it
     * is fresh.
     *
     * @returns {object}
     */
    function gestureHeaders() {
      const grant = sleepTicket()
      if (!grant) return {}
      const headers = { 'x-dsh-sleep-ticket': grant.ticket }
      const at = sleepGesture.at
      if (at && Date.now() - at <= SLEEP_GESTURE_WINDOW_MS) {
        headers['x-dsh-sleep-gesture'] = String(at)
      }
      return headers
    }

    /**
     * The current sleep status, re-rendered whenever the shared poll lands. */
    function useSleepStatus() {
      const [status, setStatus] = useState(sleepStore.info)
      useEffect(() => {
        setStatus(sleepStore.info)
        return subscribeSleep(setStatus)
      }, [])
      return status
    }

    /**
     * Whether the browser has no record of the sleep-button answer yet.
     *
     * The question is asked exactly once, so the key is written as soon as
     * the user answers — or closes the prompt.
     */
    function sleepChoicePending() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return false
        return window.localStorage.getItem(SLEEP_BUTTON_KEY) === null
      } catch {
        return false
      }
    }

    /** Record the sleep-button answer in the browser. */
    function writeSleepChoice(value) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return false
        window.localStorage.setItem(SLEEP_BUTTON_KEY, String(value))
        return true
      } catch {
        return false
      }
    }

    // The styles of the sleep surfaces. They live in ONE <style> element so
    // the button and the overlay never disagree, and every colour comes from
    // a theme token: light and dark themes both work.
    const SLEEP_STYLE_ID = 'dsh-autorestart-sleep'
    const SLEEP_CSS = [
      // The button at the foot of the left sidebar, beside Settings.
      // It follows the host's own row language (same hover token, same
      // radius token, icon + label), but it stays compact: the sidebar foot
      // is a tight place, and the Settings row must keep its own space.
      '.dsh-autorestart-sleep-button{',
      '  box-sizing:border-box;',
      '  display:inline-flex;',
      '  align-items:center;',
      '  gap:8px;',
      '  height:32px;',
      '  max-width:100%;',
      '  padding:0 10px 0 8px;',
      '  border:none;',
      '  border-radius:var(--dsw-radius-md,8px);',
      '  background:transparent;',
      '  color:var(--dsw-alias-label-primary);',
      '  font:inherit;',
      '  font-size:13px;',
      '  line-height:20px;',
      '  white-space:nowrap;',
      '  overflow:hidden;',
      '  flex:none;',
      '  cursor:pointer;',
      '  transition:background-color .14s,color .14s;',
      '}',
      '.dsh-autorestart-sleep-button:hover{',
      '  background:var(--dsw-alias-interactive-bg-hover);',
      '}',
      '.dsh-autorestart-sleep-button:focus-visible{',
      '  outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
      '  outline-offset:2px;',
      '}',
      '.dsh-autorestart-sleep-button:disabled{cursor:default;opacity:.65;}',
      '.dsh-autorestart-sleep-button--armed{',
      '  color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
      '  background:var(--dsw-alias-bg-module-platform,color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent));',
      '}',
      // The narrow rail (the collapsed sidebar): the icon only, so the rail
      // keeps its width and the row does not push the Settings row away.
      '.dsh-autorestart-sleep-button--rail{',
      '  width:36px;',
      '  height:36px;',
      '  padding:0;',
      '  gap:0;',
      '  justify-content:center;',
      '  border-radius:50%;',
      '}',
      '.dsh-autorestart-sleep-button__icon{width:16px;height:16px;flex:none;display:block;}',
      '.dsh-autorestart-sleep-button__label{',
      '  white-space:nowrap;',
      '  overflow:hidden;',
      '  text-overflow:ellipsis;',
      '}',
      // The button and the reason a request was refused.
      '.dsh-autorestart-sleep-button__wrap{',
      '  display:flex;',
      '  flex-direction:column;',
      '  align-items:flex-start;',
      '  gap:2px;',
      '  min-width:0;',
      '  max-width:100%;',
      '}',
      '.dsh-autorestart-sleep-button__error{',
      '  max-width:100%;',
      '  padding:0 2px;',
      '  color:var(--dsw-alias-danger,#d14343);',
      '  font-size:11.5px;',
      '  line-height:15px;',
      '  text-align:left;',
      '}',
      // The hint that says what to do when the page has no gesture ticket.
      '.dsh-autorestart-sleep-button__hint{',
      '  max-width:100%;',
      '  padding:0 2px;',
      '  color:var(--dsw-alias-label-secondary);',
      '  font-size:11.5px;',
      '  line-height:15px;',
      '  text-align:left;',
      '}',
      '.dsh-autorestart-sleep-button__spinner{',
      '  width:12px;',
      '  height:12px;',
      '  flex:none;',
      '  border-radius:50%;',
      '  border:2px solid var(--dsw-alias-border-l1);',
      '  border-top-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
      '  animation:dsh-autorestart-sleep-spin .8s linear infinite;',
      '}',
      // The countdown CARD: a floating corner card, never a full-screen
      // cover. It lets every click through (only the cancel button takes
      // clicks), so the conversation below stays readable and usable.
      '.dsh-autorestart-sleep-overlay{',
      '  position:fixed;',
      '  top:calc(var(--dsh-frame-chrome-top,0px) + 12px);',
      '  right:16px;',
      '  z-index:9998;',
      '  display:flex;',
      '  flex-direction:column;',
      '  align-items:center;',
      '  justify-content:flex-start;',
      '  gap:4px;',
      '  box-sizing:border-box;',
      '  width:max-content;',
      '  max-width:min(320px,calc(100vw - 32px));',
      '  padding:14px 18px 16px;',
      '  border:1px solid var(--dsw-alias-border-l1);',
      '  border-radius:16px;',
      '  background:var(--dsw-alias-bg-layer-1);',
      '  box-shadow:0 10px 30px color-mix(in srgb, var(--dsw-alias-bg-mask-3) 22%, transparent);',
      '  color:var(--dsw-alias-label-primary);',
      '  text-align:center;',
      '  pointer-events:none;',
      '}',
      '.dsh-autorestart-sleep-overlay__number{',
      '  font-size:clamp(72px,9vmin,140px);',
      '  font-weight:700;',
      '  line-height:1;',
      '  letter-spacing:-.02em;',
      '  color:var(--dsw-alias-label-primary);',
      '  animation:dsh-autorestart-sleep-tick 1s ease-out;',
      '}',
      '.dsh-autorestart-sleep-overlay--urgent .dsh-autorestart-sleep-overlay__number{',
      '  color:var(--dsw-alias-danger,#d14343);',
      '  animation:dsh-autorestart-sleep-tick .7s ease-out;',
      '}',
      // The whale is a guest in the card now, not the star of a full screen.
      '.dsh-autorestart-sleep-overlay .dsh-autorestart-whale{width:min(30vmin,150px);}',
      '.dsh-autorestart-sleep-overlay__caption{',
      '  margin:4px 0 0;',
      '  font-size:14px;',
      '  font-weight:600;',
      '  line-height:1.4;',
      '  color:var(--dsw-alias-label-primary);',
      '  animation:dsh-autorestart-sleep-fade .5s ease-out;',
      '}',
      '.dsh-autorestart-sleep-overlay__hint{',
      '  margin:2px 0 0;',
      '  font-size:13px;',
      '  line-height:1.5;',
      '  color:var(--dsw-alias-label-secondary);',
      '}',
      '.dsh-autorestart-sleep-overlay__error{',
      '  margin:10px 0 0;',
      '  font-size:12.5px;',
      '  line-height:1.5;',
      '  color:var(--dsw-alias-danger,#d14343);',
      '}',
      '.dsh-autorestart-sleep-overlay__cancel{',
      '  margin-top:10px;',
      '  min-height:32px;',
      '  padding:6px 16px;',
      '  border:1px solid var(--dsw-alias-border-l1);',
      '  border-radius:9px;',
      '  background:transparent;',
      '  color:var(--dsw-alias-label-primary);',
      '  font:inherit;',
      '  font-size:13px;',
      '  font-weight:600;',
      '  line-height:20px;',
      '  cursor:pointer;',
      // The card itself lets every click through; the cancel button is the
      // one thing in it that takes a click.
      '  pointer-events:auto;',
      '  transition:background-color .14s,border-color .14s,color .14s;',
      '}',
      '.dsh-autorestart-sleep-overlay__cancel:hover{',
      '  border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
      '  color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
      '  background:var(--dsw-alias-bg-layer-2,color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent));',
      '}',
      '.dsh-autorestart-sleep-overlay__cancel:focus-visible{',
      '  outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
      '  outline-offset:2px;',
      '}',
      '.dsh-autorestart-sleep-overlay__cancel:disabled{cursor:default;opacity:.65;}',
      // The waiting card: a soft corner card that never covers the reading.
      // Like the countdown card it lets every click through; only its
      // cancel button takes clicks.
      '.dsh-autorestart-sleep-waiting{',
      '  position:fixed;',
      '  right:16px;',
      '  bottom:16px;',
      '  z-index:9998;',
      '  box-sizing:border-box;',
      '  max-width:min(320px,calc(100vw - 32px));',
      '  padding:12px 14px;',
      '  border:1px solid var(--dsw-alias-border-l1);',
      '  border-radius:12px;',
      '  background:var(--dsw-alias-bg-layer-1);',
      '  box-shadow:0 8px 24px color-mix(in srgb, var(--dsw-alias-bg-mask-3) 18%, transparent);',
      '  color:var(--dsw-alias-label-secondary);',
      '  font-size:12.5px;',
      '  line-height:18px;',
      '  text-align:left;',
      '  pointer-events:none;',
      '}',
      '.dsh-autorestart-sleep-waiting__title{',
      '  margin:0 0 2px;',
      '  font-size:13.5px;',
      '  font-weight:600;',
      '  line-height:19px;',
      '  color:var(--dsw-alias-label-primary);',
      '}',
      '.dsh-autorestart-sleep-waiting__body{margin:0 0 6px;}',
      '.dsh-autorestart-sleep-waiting__list{margin:0 0 6px;padding-left:2px;list-style:none;}',
      '.dsh-autorestart-sleep-waiting__list li{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsh-autorestart-sleep-waiting__none{margin:0 0 6px;opacity:.8;}',
      // The command a rehearsal WOULD have run: it has to stay readable,
      // whatever the shell command looks like.
      '.dsh-autorestart-sleep-dryrun__command{',
      '  display:block;',
      '  margin:0 0 8px;',
      '  padding:6px 8px;',
      '  border-radius:8px;',
      '  background:var(--dsw-alias-bg-layer-2,color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent));',
      '  color:var(--dsw-alias-label-primary);',
      '  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
      '  font-size:11.5px;',
      '  line-height:17px;',
      '  word-break:break-all;',
      '}',
      '.dsh-autorestart-sleep-waiting__count{margin:0 0 8px;opacity:.8;}',
      '.dsh-autorestart-sleep-waiting__cancel{',
      '  min-height:28px;',
      '  padding:4px 12px;',
      '  border:1px solid var(--dsw-alias-border-l1);',
      '  border-radius:8px;',
      '  background:transparent;',
      '  color:var(--dsw-alias-label-primary);',
      '  font:inherit;',
      '  font-size:12.5px;',
      '  font-weight:600;',
      '  line-height:18px;',
      '  cursor:pointer;',
      '  pointer-events:auto;',
      '}',
      '.dsh-autorestart-sleep-waiting__cancel:hover{',
      '  border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
      '  color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
      '}',
      // The whale.
      '.dsh-autorestart-whale{width:min(44vmin,240px);height:auto;display:block;overflow:visible;}',
      '.dsh-autorestart-whale__float{',
      '  animation:dsh-autorestart-whale-float 3.2s ease-in-out infinite;',
      '  transform-origin:90px 90px;',
      '}',
      '.dsh-autorestart-whale__eye{',
      '  animation:dsh-autorestart-whale-blink 4.6s ease-in-out infinite;',
      '  transform-origin:48px 74px;',
      '}',
      '.dsh-autorestart-whale__spout{animation:dsh-autorestart-whale-spout 3.6s ease-in-out infinite;}',
      '.dsh-autorestart-whale__z{',
      '  font-family:inherit;',
      '  font-size:15px;',
      '  font-weight:600;',
      '  fill:var(--dsw-alias-label-secondary);',
      '  animation:dsh-autorestart-whale-z 2.8s ease-out infinite;',
      '}',
      '.dsh-autorestart-whale__z--2{animation-delay:.9s;}',
      '.dsh-autorestart-whale__z--3{animation-delay:1.8s;}',
      '.dsh-autorestart-whale--urgent .dsh-autorestart-whale__float{animation-duration:1.1s;}',
      '.dsh-autorestart-whale--urgent .dsh-autorestart-whale__body,',
      '.dsh-autorestart-whale--urgent .dsh-autorestart-whale__tail,',
      '.dsh-autorestart-whale--urgent .dsh-autorestart-whale__fin{fill:var(--dsw-alias-danger,#d14343);}',
      // The keyframes.
      '@keyframes dsh-autorestart-sleep-spin{to{transform:rotate(360deg);}}',
      '@keyframes dsh-autorestart-sleep-tick{',
      '  0%{transform:scale(.86);opacity:.55;}',
      '  40%{transform:scale(1.04);opacity:1;}',
      '  100%{transform:scale(1);opacity:1;}',
      '}',
      '@keyframes dsh-autorestart-sleep-fade{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}',
      '@keyframes dsh-autorestart-whale-float{',
      '  0%,100%{transform:translateY(0) rotate(0deg);}',
      '  50%{transform:translateY(-10px) rotate(-1.5deg);}',
      '}',
      '@keyframes dsh-autorestart-whale-blink{',
      '  0%,88%,100%{transform:scaleY(1);}',
      '  93%{transform:scaleY(.08);}',
      '  97%{transform:scaleY(1);}',
      '}',
      '@keyframes dsh-autorestart-whale-spout{',
      '  0%,70%,100%{opacity:.35;}',
      '  35%{opacity:1;}',
      '}',
      '@keyframes dsh-autorestart-whale-z{',
      '  0%{opacity:0;transform:translate(0,0) scale(.7);}',
      '  25%{opacity:.9;}',
      '  100%{opacity:0;transform:translate(12px,-26px) scale(1.15);}',
      '}',
      // A user who asked for less motion gets a still whale.
      '@media (prefers-reduced-motion: reduce){',
      '  .dsh-autorestart-whale__float,',
      '  .dsh-autorestart-whale__eye,',
      '  .dsh-autorestart-whale__spout,',
      '  .dsh-autorestart-whale__z,',
      '  .dsh-autorestart-sleep-overlay__number,',
      '  .dsh-autorestart-sleep-overlay__caption,',
      '  .dsh-autorestart-sleep-button__spinner{animation:none !important;}',
      '}',
    ].join('\n')

    /** Inject the sleep styles exactly once. */
    function ensureSleepStyle() {
      if (typeof document === 'undefined' || !document.head) return
      try {
        if (document.getElementById(SLEEP_STYLE_ID)) return
        const style = document.createElement('style')
        style.id = SLEEP_STYLE_ID
        style.textContent = SLEEP_CSS
        document.head.appendChild(style)
      } catch {
        // Without the stylesheet the surfaces are still readable.
      }
    }

    /**
     * Remove the sleep styles again.
     *
     * The stylesheet belongs to the sleep surfaces: when the last one leaves
     * (the plugin is unloaded, the conversation is closed), the CSS goes with
     * it instead of staying in the document forever.
     */
    function removeSleepStyle() {
      if (typeof document === 'undefined') return
      try {
        const node = document.getElementById(SLEEP_STYLE_ID)
        if (node && node.parentNode) node.parentNode.removeChild(node)
      } catch {
        // Nothing to clean up.
      }
    }

    /** The moon of the sidebar button: an inline SVG, no external image. */
    function moonIcon() {
      return h(
        'svg',
        {
          className: 'dsh-autorestart-sleep-button__icon',
          viewBox: '0 0 24 24',
          width: '16',
          height: '16',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z',
          fill: 'currentColor',
        }),
        h('circle', { cx: '16.5', cy: '6.5', r: '1.3', fill: 'var(--dsw-alias-brand-primary,#4d6bfe)' }),
      )
    }

    /**
     * The graceful-shutdown button, at the foot of the left sidebar.
     *
     * It renders NOTHING at all when the Host says the button must not be
     * shown: no placeholder, no empty space.
     *
     * The sidebar hands the column state to the slot: `wide` is false while
     * the sidebar is collapsed into its narrow rail, and there the button
     * shows its icon only, so the rail keeps its width.
     *
     * @param {{ wide?: boolean }} [props] the sidebar's column state
     */
    function SleepButton(props) {
      const status = useSleepStatus()
      const [arming, setArming] = useState(false)
      const [error, setError] = useState('')
      // The page has no usable gesture ticket: a restart of DSH is the only
      // way out, and the button says so.
      const [ticketHint, setTicketHint] = useState(false)
      const t = translate ?? ((name) => name)

      // The Host's truth decides, and an UNKNOWN truth decides NOTHING: before
      // the first poll the button renders nothing at all, so a host that has
      // the button switched off never sees it flash for two seconds.
      const remoteKnown = Boolean(
        status && typeof status === 'object' && typeof status.showSleepButton === 'boolean',
      )
      const visible = remoteKnown && shouldShowSleepButton(status)

      // The narrow rail shows the icon only; the wide column shows the label.
      const wide = !(props && props.wide === false)

      // How long the countdown lasts (the settings page offers a dropdown).
      const reported = status && typeof status === 'object' && typeof status.countdownSeconds === 'number'
        ? status.countdownSeconds
        : SLEEP_DEFAULT_COUNTDOWN_SECONDS
      const countdownSeconds = SLEEP_COUNTDOWN_CHOICES.indexOf(reported) === -1
        ? SLEEP_DEFAULT_COUNTDOWN_SECONDS
        : reported
      const countdownHint = countdownSeconds > 0
        ? fill(t('sleep.button.title'), { n: countdownSeconds })
        : t('sleep.button.titleImmediate')

      // The button is a TOGGLE: a click arms the shutdown, and a click while
      // the shutdown is armed cancels it. That way there is ALWAYS a way out,
      // even when the countdown screen is not (or no longer) on top.
      const armed = Boolean(
        status && typeof status === 'object' && (
          status.armed === true
          || status.phase === 'waiting'
          || status.phase === 'countdown'
          || status.phase === 'shutting-down'
        ),
      )

      /**
       * Ask the Host to stand by: it waits for every session to finish and
       * then counts down.
       *
       * The Host only accepts a REAL gesture: the one-time ticket the page
       * got from the host plus the timestamp of a trusted pointerdown that
       * happened a moment ago. Without them the host refuses the request
       * (403) and nothing is armed — so the button does not even send a
       * request it knows would be refused.
       *
       * A page that was opened BEFORE the plugin was updated has no ticket
       * at all (the host injects it into the HTML it serves). Then there is
       * nothing to send, and there is deliberately no route that hands out a
       * ticket — so the button only says what to do: restart DSH.
       */
      const arm = async () => {
        if (arming) return
        setArming(true)
        setError('')
        try {
          if (!sleepTicket()) {
            // No ticket at all: this page cannot arm the machine.
            setTicketHint(true)
            return
          }
          const headers = gestureHeaders()
          if (!headers['x-dsh-sleep-gesture']) {
            // No trusted pointerdown (a scripted click, a keyboard
            // activation): the host would refuse it anyway.
            setError(t('sleep.gestureMissing'))
            return
          }
          await requestSleep('arm', headers)
        } catch (failure) {
          // A refused gesture has its own sentence (the host explains why).
          const message = describeError(failure)
          setError(failure && failure.reason
            ? fill(t('sleep.refused'), { message })
            : fill(t('sleep.error'), { message }))
          // A ticket that is too old, too fresh or already spent means the
          // page has no usable ticket any more: only a restart helps.
          if (failure && typeof failure.reason === 'string'
            && SLEEP_STALE_TICKET_REASONS.indexOf(failure.reason) !== -1) {
            setTicketHint(true)
          }
        } finally {
          setArming(false)
        }
      }

      /** Take the shutdown back: the countdown stops and the machine stays on. */
      const cancel = async () => {
        if (arming) return
        setArming(true)
        setError('')
        try {
          await requestSleep('cancel')
        } catch (failure) {
          setError(fill(t('sleep.error'), { message: describeError(failure) }))
        } finally {
          setArming(false)
        }
      }

      /**
       * The click itself is the last fallback of the gesture: a device that
       * sends no pointer event at all still sends a trusted click.
       *
       * @param {object} event the DOM event of the click
       */
      const handleClick = (event) => {
        rememberSleepGesture(event)
        if (armed) cancel()
        else arm()
      }

      if (!visible) return null
      ensureSleepStyle()

      const button = h(
        'button',
        {
          type: 'button',
          className: 'dsh-autorestart-sleep-button'
            + (armed ? ' dsh-autorestart-sleep-button--armed' : '')
            + (wide ? '' : ' dsh-autorestart-sleep-button--rail'),
          'aria-label': armed ? t('sleep.button.cancel') : t('sleep.button.aria'),
          title: error || (armed ? t('sleep.button.cancel') : countdownHint),
          disabled: arming,
          onClick: handleClick,
          // The gesture: only a TRUSTED event counts, so the page cannot arm
          // the machine on its own. Which event carries that proof differs
          // per device, so every real input event is accepted.
          onPointerDown: rememberSleepGesture,
          onMouseDown: rememberSleepGesture,
          onTouchStart: rememberSleepGesture,
          'data-dsh-autorestart-sleep-button': 'true',
          'data-armed': armed ? 'true' : 'false',
          'data-wide': wide ? 'true' : 'false',
        },
        arming
          ? h('span', { className: 'dsh-autorestart-sleep-button__spinner', 'aria-hidden': 'true' })
          : moonIcon(),
        // The narrow rail has no room for a label: the icon alone, with the
        // title and the aria-label telling what it does.
        wide
          ? h(
            'span',
            { className: 'dsh-autorestart-sleep-button__label' },
            arming
              ? t('sleep.button.busy')
              : (armed ? t('sleep.button.cancel') : t('sleep.button.label')),
          )
          : null,
      )

      // A refused request (no gesture, an expired ticket, ...) is never
      // silent: the reason is written under the button.
      if (!wide || (error === '' && !ticketHint)) return button
      return h(
        'div',
        { className: 'dsh-autorestart-sleep-button__wrap' },
        button,
        // The hint replaces the raw reason: it is the one thing the user can
        // act on (restart DSH — there is no ticket to fetch over HTTP).
        ticketHint
          ? h(
            'span',
            { className: 'dsh-autorestart-sleep-button__hint', role: 'alert' },
            t('sleep.ticketHint'),
          )
          : h(
            'span',
            { className: 'dsh-autorestart-sleep-button__error', role: 'alert' },
            error,
          ),
      )
    }

    /**
     * A small sketch of the workspace with the shutdown button at the foot of
     * the left sidebar: the arrow points at the place the button appears.
     *
     * It carries no copy of its own: the words around it come from the
     * locale files.
     */
    function sleepDiagram() {
      return h(
        'svg',
        {
          className: 'dsh-autorestart-choice__diagram__art',
          viewBox: '0 0 260 120',
          width: '260',
          height: '120',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        // The window.
        h('rect', {
          x: '6',
          y: '6',
          width: '248',
          height: '108',
          rx: '10',
          fill: 'var(--dsw-alias-bg-layer-2,transparent)',
          stroke: 'var(--dsw-alias-border-l1)',
        }),
        h('line', {
          x1: '6',
          y1: '24',
          x2: '254',
          y2: '24',
          stroke: 'var(--dsw-alias-border-l1)',
        }),
        // The left sidebar.
        h('line', {
          x1: '78',
          y1: '24',
          x2: '78',
          y2: '114',
          stroke: 'var(--dsw-alias-border-l1)',
        }),
        // Two session rows in the sidebar.
        h('rect', {
          x: '16',
          y: '36',
          width: '46',
          height: '7',
          rx: '3.5',
          fill: 'var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))',
        }),
        h('rect', {
          x: '16',
          y: '50',
          width: '52',
          height: '7',
          rx: '3.5',
          fill: 'var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))',
        }),
        // The button at the foot of the sidebar, right above the Settings row.
        h('rect', {
          x: '14',
          y: '80',
          width: '52',
          height: '18',
          rx: '6',
          fill: 'var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe))',
        }),
        h(
          'g',
          { transform: 'translate(-4 45)' },
          h('path', {
            d: 'M28 44a6 6 0 0 1 8-8 6 6 0 1 0 7 7 6 6 0 0 1-8 8 6 6 0 0 1-7-7z',
            fill: 'var(--dsw-alias-bg-layer-1,#fff)',
          }),
        ),
        // The Settings row underneath it.
        h('circle', {
          cx: '20',
          cy: '107',
          r: '4.5',
          fill: 'none',
          stroke: 'var(--dsw-alias-label-secondary)',
          'stroke-width': '1.5',
        }),
        h('rect', {
          x: '30',
          y: '103',
          width: '34',
          height: '7',
          rx: '3.5',
          fill: 'var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))',
        }),
        // The arrow that points at the bottom-left corner.
        h('path', {
          d: 'M186 100 L74 92',
          fill: 'none',
          stroke: 'var(--dsw-alias-label-secondary)',
          'stroke-width': '2',
          'stroke-linecap': 'round',
          'stroke-dasharray': '5 4',
        }),
        h('path', {
          d: 'M74 92 l12-1 -5 10 z',
          fill: 'var(--dsw-alias-label-secondary)',
        }),
      )
    }

    /**
     * The whale: an inline SVG animated with CSS only.
     *
     * No external image and no dependency on another plugin: the whale is
     * drawn here, floats, blinks and blows sleepy Zs.
     */
    function whaleArt(urgent) {
      return h(
        'svg',
        {
          className: 'dsh-autorestart-whale' + (urgent ? ' dsh-autorestart-whale--urgent' : ''),
          viewBox: '0 0 200 140',
          width: '200',
          height: '140',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h(
          'g',
          { className: 'dsh-autorestart-whale__float' },
          h('path', {
            className: 'dsh-autorestart-whale__tail',
            d: 'M142 84c14-16 26-30 44-38-6 12-9 22-9 30 0 8 3 18 9 30-18-8-30-16-44-22z',
            fill: 'var(--dsw-alias-brand-primary,#4d8bf0)',
          }),
          h('ellipse', {
            className: 'dsh-autorestart-whale__body',
            cx: '84',
            cy: '84',
            rx: '66',
            ry: '38',
            fill: 'var(--dsw-alias-brand-primary,#4d8bf0)',
          }),
          h('ellipse', {
            className: 'dsh-autorestart-whale__belly',
            cx: '90',
            cy: '97',
            rx: '50',
            ry: '23',
            fill: 'var(--dsw-alias-bg-layer-1,#fff)',
            opacity: '0.85',
          }),
          h('path', {
            className: 'dsh-autorestart-whale__fin',
            d: 'M72 110c8 10 18 14 30 12-6 8-16 12-26 10-8-2-12-11-4-22z',
            fill: 'var(--dsw-alias-brand-primary,#4d8bf0)',
          }),
          h(
            'g',
            { className: 'dsh-autorestart-whale__eye' },
            h('circle', { cx: '48', cy: '74', r: '6.5', fill: 'var(--dsw-alias-bg-layer-1,#fff)' }),
            h('circle', { cx: '47', cy: '75', r: '3', fill: 'var(--dsw-alias-label-primary,#333)' }),
          ),
          h('path', {
            className: 'dsh-autorestart-whale__mouth',
            d: 'M28 88c6 6 14 8 22 6',
            fill: 'none',
            stroke: 'var(--dsw-alias-label-secondary,#888)',
            'stroke-width': '2',
            'stroke-linecap': 'round',
          }),
          h(
            'g',
            { className: 'dsh-autorestart-whale__spout' },
            h('circle', { cx: '62', cy: '38', r: '5', fill: 'var(--dsw-alias-label-secondary,#888)', opacity: '0.7' }),
            h('circle', { cx: '74', cy: '28', r: '3.5', fill: 'var(--dsw-alias-label-secondary,#888)', opacity: '0.55' }),
            h('circle', { cx: '52', cy: '26', r: '3', fill: 'var(--dsw-alias-label-secondary,#888)', opacity: '0.45' }),
          ),
        ),
        h('text', { className: 'dsh-autorestart-whale__z dsh-autorestart-whale__z--1', x: '148', y: '46' }, 'Z'),
        h('text', { className: 'dsh-autorestart-whale__z dsh-autorestart-whale__z--2', x: '166', y: '30' }, 'Z'),
        h('text', { className: 'dsh-autorestart-whale__z dsh-autorestart-whale__z--3', x: '182', y: '16' }, 'Z'),
      )
    }

    /**
     * The countdown overlay, in the shell's overlay layer.
     *
     * It renders NOTHING unless the Host really is counting down, waiting
     * for the sessions or already powering off.
     */
    function SleepOverlay() {
      const status = useSleepStatus()
      const [, setTick] = useState(0)
      // The overlay folds away locally as soon as the user cancels.
      const [hidden, setHidden] = useState(false)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      // The safety net of the "good night" screen: the user may close the
      // notice, and a screen that stays for too long offers the same exit.
      const [dismissed, setDismissed] = useState(false)
      const [stuck, setStuck] = useState(false)
      // The note of a finished rehearsal: what the host WOULD have run. It
      // folds away on its own (or when the user closes it).
      const [dryNotice, setDryNotice] = useState(null)
      const t = translate ?? ((name) => name)

      const phase = status && typeof status === 'object' && typeof status.phase === 'string'
        ? status.phase
        : ''

      // The last run the host reports. A REHEARSAL (dry run) says what it
      // would have done and executed nothing; a real failure says what went
      // wrong. The two never look alike, so the notice can never mistake one
      // for the other.
      const lastRun = status && typeof status === 'object' && status.lastRun && typeof status.lastRun === 'object'
        ? status.lastRun
        : null
      const dryRunAt = lastRun !== null && lastRun.dryRun === true && typeof lastRun.at === 'string'
        ? lastRun.at
        : ''
      const planned = lastRun !== null && typeof lastRun.command === 'string' && lastRun.command !== ''
        ? [lastRun.command].concat(Array.isArray(lastRun.args) ? lastRun.args : []).join(' ')
        : ''

      // The shared poll runs every 2s, but the big number has to move every
      // second: the countdown owns a local 1s tick. The interval is cleared
      // when the phase changes and when the component leaves.
      useEffect(() => {
        if (phase !== 'countdown') return undefined
        const timer = setInterval(() => setTick((value) => value + 1), 1000)
        return () => clearInterval(timer)
      }, [phase])

      // A NEW countdown always shows the overlay again: a cancellation that
      // happened earlier must never leave the layer folded away, or the next
      // countdown would run without the user being able to see (or stop) it.
      useEffect(() => {
        if (phase === 'countdown') setHidden(false)
      }, [phase])

      // A finished rehearsal leaves a note: the command it WOULD have run.
      // Without it the user would see nothing at all and could not tell a
      // rehearsal from a real shutdown. The note folds away after eight
      // seconds (or when the user closes it); a new rehearsal shows it again.
      useEffect(() => {
        if (dryRunAt === '') return undefined
        setDryNotice({ at: dryRunAt, command: planned })
        const timer = setTimeout(() => setDryNotice(null), SLEEP_DRY_RUN_NOTICE_MS)
        return () => clearTimeout(timer)
      }, [dryRunAt])

      /**
       * The time safety net of the "good night" screen.
       *
       * A machine that really powers off is killed by the system, so this
       * screen cannot last eight seconds — if it does, the command did not
       * work and the user gets a way out. The timer is cleared when the phase
       * changes and when the component leaves.
       */
      useEffect(() => {
        if (phase !== 'shutting-down') {
          setStuck(false)
          setDismissed(false)
          return undefined
        }
        const timer = setTimeout(() => setStuck(true), 8000)
        return () => clearTimeout(timer)
      }, [phase])

      // The remaining time is measured from the moment the status arrived,
      // so the number keeps ticking between two polls.
      const remainingMs = status && typeof status.remainingMs === 'number' && Number.isFinite(status.remainingMs)
        ? status.remainingMs
        : 0
      const elapsed = sleepStore.at > 0 ? Date.now() - sleepStore.at : 0
      const seconds = formatRemainingMs(Math.max(0, remainingMs - elapsed))

      // How long the countdown lasts (the settings page offers a dropdown).
      const reported = status && typeof status === 'object' && typeof status.countdownSeconds === 'number'
        ? status.countdownSeconds
        : SLEEP_DEFAULT_COUNTDOWN_SECONDS
      const countdownSeconds = SLEEP_COUNTDOWN_CHOICES.indexOf(reported) === -1
        ? SLEEP_DEFAULT_COUNTDOWN_SECONDS
        : reported
      // A countdown of zero seconds is NO countdown: the machine is switched
      // off the moment the gate opens, so there is no card to show (and no
      // whale). The waiting card takes over when the gate keeps it closed.
      const noCountdown = countdownSeconds === 0

      /**
       * Cancel the shutdown.
       *
       * The layer folds away only when the Host CONFIRMS the cancellation
       * (`phase === 'cancelled'`): a request that fails leaves the countdown
       * on screen, so the user can simply try again instead of being stuck
       * behind a machine that is still counting down.
       */
      const cancel = async () => {
        if (busy) return
        setBusy(true)
        setError('')
        try {
          const body = await requestSleep('cancel')
          if (body && typeof body === 'object' && body.phase === 'cancelled') setHidden(true)
        } catch (failure) {
          // The countdown keeps running: the button can be pressed again.
          setHidden(false)
          setError(fill(t('sleep.error'), { message: describeError(failure) }))
        } finally {
          setBusy(false)
        }
      }

      // The line that tells the user WHY the last request failed.
      const errorLine = () => (error === ''
        ? null
        : h('p', { className: 'dsh-autorestart-sleep-overlay__error', role: 'alert' }, error))

      // The Host confirmed the cancellation: the layer is gone.
      if (hidden) return null

      if (phase === 'waiting') {
        ensureSleepStyle()
        const blockers = status && Array.isArray(status.blockers) ? status.blockers : []
        return h(
          'div',
          {
            className: 'dsh-autorestart-sleep-waiting',
            role: 'status',
            'aria-live': 'polite',
            'data-dsh-autorestart-sleep-waiting': 'true',
            // The card never eats a click: only its cancel button does.
            style: { pointerEvents: 'none' },
          },
          h('p', { className: 'dsh-autorestart-sleep-waiting__title' }, t('sleep.waiting.title')),
          h('p', { className: 'dsh-autorestart-sleep-waiting__body' }, t('sleep.waiting.body')),
          blockers.length === 0
            ? h('p', { className: 'dsh-autorestart-sleep-waiting__none' }, t('sleep.waiting.none'))
            : h(
              'ul',
              { className: 'dsh-autorestart-sleep-waiting__list' },
              blockers.map((entry, index) => h(
                'li',
                { key: 'blocker-' + index },
                fill(t('sleep.waiting.blocker'), {
                  title: entry && typeof entry.title === 'string' && entry.title !== ''
                    ? entry.title
                    : t('panelBlockedGeneric'),
                }),
              )),
            ),
          h('p', { className: 'dsh-autorestart-sleep-waiting__count' }, blockers.length === 0
            ? null
            : fill(t('sleep.waiting.count'), { n: blockers.length })),
          errorLine(),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-autorestart-sleep-waiting__cancel',
              onClick: cancel,
              disabled: busy,
              style: { pointerEvents: 'auto' },
            },
            t('sleep.waiting.cancel'),
          ),
        )
      }

      if (phase === 'countdown') {
        // A countdown of zero seconds shows NO card at all: the machine is
        // switched off the moment the gate opens, so there is nothing to
        // count down and nothing to cancel.
        if (noCountdown) return null
        ensureSleepStyle()
        const urgent = seconds <= 3
        const hint = fill(t('sleep.countdown.hint'), { n: seconds })
        return h(
          'div',
          {
            className: 'dsh-autorestart-sleep-overlay'
              + (urgent ? ' dsh-autorestart-sleep-overlay--urgent' : ''),
            role: 'dialog',
            'aria-live': 'assertive',
            'aria-label': hint,
            'data-dsh-autorestart-sleep-countdown': 'true',
            // The card is a FLOATING card: it never covers the interface and
            // it never eats a click — only its cancel button does.
            style: { pointerEvents: 'none' },
          },
          // The key changes every second, so the number restarts its pulse
          // on every tick.
          h(
            'div',
            { className: 'dsh-autorestart-sleep-overlay__number', key: 'number-' + seconds },
            String(Math.max(0, seconds)),
          ),
          whaleArt(urgent),
          h(
            'p',
            { className: 'dsh-autorestart-sleep-overlay__caption', key: 'caption-' + seconds },
            pickSleepCaption(seconds, t),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-autorestart-sleep-overlay__cancel',
              onClick: cancel,
              disabled: busy,
              style: { pointerEvents: 'auto' },
            },
            t('sleep.countdown.cancel'),
          ),
          h('p', { className: 'dsh-autorestart-sleep-overlay__hint' }, hint),
          errorLine(),
        )
      }

      if (phase === 'shutting-down') {
        ensureSleepStyle()
        // The user closed the notice: the screen is gone, the Host keeps
        // whatever it thinks (this button never cancels anything).
        if (dismissed) return null
        // A dry run never powers the machine off, so the screen must say so
        // and offer the way out right away.
        const dryRun = (status && status.dryRun === true) || dryRunAt !== ''
        const closeButton = (dryRun || stuck)
          ? h(
            'button',
            {
              type: 'button',
              className: 'dsh-autorestart-sleep-overlay__cancel',
              onClick: () => setDismissed(true),
              style: { pointerEvents: 'auto' },
            },
            t('sleep.shuttingDown.dismiss'),
          )
          : null
        return h(
          'div',
          {
            className: 'dsh-autorestart-sleep-overlay dsh-autorestart-sleep-overlay--goodnight',
            role: 'status',
            'aria-live': 'assertive',
            'data-dsh-autorestart-sleep-shutdown': 'true',
            'data-dsh-autorestart-sleep-dry-run': dryRun ? 'true' : 'false',
            // The good-night card is a floating card too: it never covers the
            // interface, only its dismiss button takes clicks.
            style: { pointerEvents: 'none' },
          },
          whaleArt(false),
          h(
            'p',
            { className: 'dsh-autorestart-sleep-overlay__caption' },
            dryRun
              ? fill(t('sleep.shuttingDown.dryRun'), { command: planned })
              : t('sleep.shuttingDown.title'),
          ),
          h('p', { className: 'dsh-autorestart-sleep-overlay__hint' }, t('sleep.shuttingDown.body')),
          closeButton,
        )
      }

      // The machine is idle again. A finished rehearsal leaves its note:
      // the command it WOULD have run. A real failure has no dryRun marker
      // and therefore never ends up here (the host says so in `message`).
      if (dryNotice !== null) {
        ensureSleepStyle()
        return h(
          'div',
          {
            className: 'dsh-autorestart-sleep-waiting dsh-autorestart-sleep-dryrun',
            role: 'status',
            'aria-live': 'polite',
            'data-dsh-autorestart-sleep-dryrun': 'true',
            // The note is a FLOATING card: it never covers the interface and
            // it never eats a click — only its close button does.
            style: { pointerEvents: 'none' },
          },
          h('p', { className: 'dsh-autorestart-sleep-waiting__title' }, t('sleep.dryRun.title')),
          h('p', { className: 'dsh-autorestart-sleep-waiting__body' }, t('sleep.dryRun.body')),
          h(
            'code',
            { className: 'dsh-autorestart-sleep-dryrun__command' },
            dryNotice.command,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-autorestart-sleep-waiting__cancel',
              onClick: () => setDryNotice(null),
              style: { pointerEvents: 'auto' },
            },
            t('sleep.dryRun.close'),
          ),
        )
      }

      return null
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh: ZH, en: EN }),
          'dsh-autorestart: client locale',
        )
        const t = ctx.locale.bind(NS)
        translate = t
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'autorestart-restart-pill', order: 0 }, RestartPill))
        ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({ name: 'sidebar.session.row.leading', id: 'autorestart-restart-dot', order: 20 }, RestartDot))
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'autorestart-backup-choice', order: 7, locale: NS }, BackupChoicePanel))
        // The graceful-shutdown button: a LIST slot at the foot of the left
        // sidebar, beside the Settings row. The slot is a ROOT slot, so the
        // button is there even when no conversation is open — and the
        // sidebar hands the column state to it, so the collapsed rail shows
        // the icon only.
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'autorestart-sleep-button', order: 10, locale: NS }, SleepButton))
        // The countdown overlay: a frame-wide floating layer above every
        // column.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'autorestart-sleep-overlay', order: 60 }, SleepOverlay))
      },
      // The named exports of this module (the client module system hands
      // `factory(require) -> exports` to every importer).
      pickSleepCaption,
      shouldShowSleepButton,
      buildChoiceBody,
      formatRemainingMs,
    }
  },
})
