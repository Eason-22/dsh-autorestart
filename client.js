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
 * `export` keyword is NOT available here. The pure helpers are
 * therefore published in the two places a test can reach them:
 *
 *   1. as NAMED properties of this module's exports — the client module
 *      system materializes `factory(require) -> exports`, so the exports
 *      object carries `pickSleepCaption`, `shouldShowSleepButton`,
 *      `buildChoiceBody`, `formatRemainingMs`, `formatLongWaitNote`,
 *      `formatLongWaitNoteParts`, `groupBlockers`, `summarizeBlockers`
 *      and `truncateBlockerName`;
 *   2. on the global namespace `globalThis.__dshAutorestartClient`, which
 *      exists as soon as this file is evaluated (no factory call needed).
 *
 * The copy lives in the two dictionaries below and is mirrored verbatim in
 * locale/zh.json + locale/en.json (same words, same keys).
 * ------------------------------------------------------------------ */

// THE WHOLE FILE IS ONE IIFE.
//
// The client module loader evaluates this file as a CLASSIC script, and the
// browser concatenates the client scripts of ALL the plugins into ONE bundle:
// they therefore share ONE global lexical scope. A top-level `const ZH` here
// collided with another plugin's `const ZH`, and the whole bundle died with
// "Identifier 'ZH' has already been declared" — every client plugin was dead
// and the desktop app could not start at all.
//
// Wrapping the file keeps every declaration of this plugin private to it: the
// bundle scope stays free of our names, so no other plugin can collide with
// them. The loader call at the end of the file still runs at the same moment
// as before, and nothing else changes.
;(function () {
  'use strict'

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

  /**
   * The RESTART reserve the settings page offers (a dropdown, in seconds).
   *
   * It belongs to the restart only: a restart is a daily operation, so it
   * should happen as soon as the conversations are done. The graceful shutdown
   * has no reserve of its own — its VISIBLE countdown is the wait before the
   * machine goes off.
   */
  const GRACE_CHOICES_SECONDS = Object.freeze([0, 5, 10, 20, 30, 60])

  /** The RESTART reserve used when the Host did not report one (ms / seconds). */
  const GRACE_DEFAULT_MS = 0
  const GRACE_DEFAULT_SECONDS = 0

  const ZH = {
    label: '待重启',
    busyPrefix: ' · 等待 ',
    busySuffix: ' 个任务结束',
    idle: ' · 空闲后自动重启',
    goalActive: ' · 被某个自动续跑的 goal 占着',
    goalExhausted: ' · 某个任务的 goal 轮次额度已用完，无法续跑',
    settling: ' · 还在等这段安静期',
    parkedGoals: ' · 已停泊 {n} 个 goal，重启后自动继续',
    parkButton: '停泊并重启',
    parkButtonAria: '停泊该会话的 goal，并立即请求重启',
    parkBusy: '停泊中…',
    parkError: '停泊失败：{message}',
    tooltip: '等待其他会话空闲后自动重启；重启后会自动继续本会话进度',
    tooltipBusy: '等待其他任务结束（计数含“排队但还没开始”的任务）后自动重启；重启后本会话会自动继续进度',
    tooltipWithError: '等待其他会话空闲后自动重启；重启后本会话会自动继续进度。{message}',
    dotAria: '待重启',
    panelHeading: '待重启',
    panelStateBusy: '等待其他会话空闲后重启',
    panelStateIdle: '等待空闲窗口后重启',
    panelStateGoalActive: '等待其他会话停泊它自动续跑的 goal',
    panelStateGoalExhausted: '等待其他会话的 goal（轮次额度已用完）',
    panelBlockedTitle: '占用会话：{title}',
    panelBlockedGeneric: '有一个任务正在运行',
    // One line per blocker: a session and a subagent are told apart, and
    // neither of them is ever shown as a raw session id.
    panelBlockedSession: '会话「{label}」正在运行',
    panelBlockedSubagent: '{name}正在运行',
    panelBlockedSubagentGeneric: '有一个子智能体正在运行',
    // The N subagents of ONE session are one line: the session is named once
    // and the number of its subagents says how many there are.
    panelBlockedSubagentGroup: '会话「{label}」的 {n} 个子智能体正在运行',
    panelBlockedSubagentGroupGeneric: '有 {n} 个子智能体正在运行',
    panelBlockedRestartPending: '等这次重启完成后再关机',
    panelGoalActiveLine: '占用会话「{title}」：goal 正在自动续跑（goal-active）',
    panelGoalExhaustedLine: '占用会话「{title}」：goal 轮次额度已用完，无法继续（goal-exhausted）',
    panelParkedTitle: '已停泊的 goal（重启后自动继续）：',
    panelParkedGoal: '会话 {session} · {goal}',
    panelWaiting: '已等待 {duration}',
    panelResume: '重启后本会话会自动继续进度',
    // The long wait: the restart passed the hard deadline while a conversation
    // was still running. The capsule is ONE clipped line of 22px: it holds a
    // number and a duration, NEVER a name. Every name goes into the tooltip,
    // where there is room for all of them.
    longWaitPill: ' · 已等 {duration} · {n} 项任务在跑',
    longWaitTooltip: '已等 {duration}。在跑：{blockers}',
    // The blockers of one list. They are grouped by the session that created
    // them (N subagents of one session are ONE item), the tooltip names them
    // ALL and the shutdown card lists them. One rule, two surfaces: the
    // tooltip of the capsule and the list of the shutdown card.
    blockerGeneric: '有会话',
    blockerJoin: '、',
    blockerGroupSubagents: '{label}（{n} 个子智能体）',
    blockerGroupSubagentsGeneric: '{n} 个子智能体',
    blockerMore: '…等 {n} 项',
    blockersTitleLine: '占用会话：{blockers}',
    durationSeconds: '{n} 秒',
    durationMinutes: '{n} 分 {m} 秒',
    durationHours: '{n} 小时 {m} 分',
    // The COMPACT duration of the capsule: it can afford "16 分钟", not
    // "16 分 37 秒" — the capsule is one clipped line.
    durationMinutesShort: '{n} 分钟',
    durationHoursShort: '{n} 小时',
    durationHoursMinutesShort: '{n} 小时 {m} 分',
    // The manual cancel of the capsule: the panel, the confirmation and the
    // readable reasons. The capsule's own text stays free of hints — the panel
    // is the discoverability.
    cancelPanelTasks: '这次重启还在等 {n} 个任务结束',
    cancelPanelOthers: '还有 {n} 个会话也在等这次重启',
    cancelPanelOthersAfter: '还剩 {n} 个会话在等',
    cancelPanelAria: '待重启详情',
    cancelButton: '取消我的这次重启',
    cancelButtonAria: '取消我的这次重启',
    cancelConfirmTitle: '取消你的这次重启？',
    cancelConfirmOnlyMe: '取消后这次重启就不会发生了。',
    cancelConfirmOthers: '还有 {n} 个会话也在等这次重启——取消只影响你自己，他们仍会重启。',
    cancelConfirmUnknown: '当前会话未知，无法只撤自己。',
    cancelConfirmButton: '确认取消',
    cancelConfirmButtonAria: '确认取消这次重启',
    cancelDismissButton: '再想想',
    cancelDismissButtonAria: '算了，不取消',
    cancelFailed: '没能取消这次重启。',
    cancelFailedWith: '没能取消这次重启：{message}',
    cancelNotRequester: '这个会话没有请求这次重启，所以什么都没取消。',
    cancelNothingPending: '现在没有待重启的请求。',
    cancelUnknownSession: '当前会话未知，无法只撤自己。',
    cancelNoRoute: '找不到取消接口（宿主版本太旧）。',
    // The one-time install prompt (the choice is asked exactly once).
    // "Backup" is the verb and BOTH options share the "configuration" base:
    // the plugins are an ADDITION to the configuration, never a rival of it.
    backupChoiceTitle: '重启前自动备份：要不要把已安装的插件也一起备份？',
    backupChoiceBody: '每次重启前会快照当前配置，万一重启后起不来就能自动回退。',
    backupChoiceWithPlugins: '配置 + 已安装插件',
    backupChoiceWithPluginsHint: '多约 3 秒、约 117 MB；插件把启动搞坏时也能回退。',
    backupChoiceConfigOnly: '只备份配置',
    backupChoiceConfigOnlyHint: '瞬间完成、约 66 KB；插件问题无法回退，需要手动重装。',
    backupChoiceFootnote: '以后可在 设置 → 自动重启与关机 修改',
    backupChoicePickPrimary: '用这个',
    backupChoicePickSecondary: '只备份配置',
    backupChoiceRecommended: '推荐',
    backupChoiceDismissAria: '关闭这个一次性提示',
    backupChoiceError: '保存失败：{message}',
    'supervisor.title': '让 DSH 自己把自己拉起来？',
    'supervisor.body': '现在这个 DSH 托管实例是手动/外部启动的——它挂了不会自己回来。我可以给你装一个自带的守护：登录时自动启动，进程掉了自动拉起，启动失败自动回滚上次快照。守护不会碰你的会话数据，只做「拉起 + 看住 + 回滚」三件事。',
    'supervisor.changes': '会改什么：新增 <stateDir>/supervisor/（守护脚本 + 配置 + 日志 + 锁）；Windows 注册一条登录自启记录（计划任务 dsh-autorestart-web），Linux 注册一个 systemd 用户服务。不改：会话数据、模型配置、已装插件。',
    'supervisor.rights': '需要什么权限：Windows 不需要管理员（用「登录时运行」；若该机策略禁止普通用户建计划任务，会自动降级到「启动文件夹」，同样不需要）；Linux 需要能写自己的家目录（systemctl --user，普通用户即可）。',
    'supervisor.uninstall': '怎么卸：设置页「开机自启 → 卸载」一键；或手动 schtasks /Delete /TN "dsh-autorestart-web" /F（Linux：systemctl --user disable --now dsh-autorestart-web.service && rm ~/.config/systemd/user/dsh-autorestart-web.service），两者都要再删掉 <stateDir>/supervisor/ 目录。',
    'supervisor.install': '帮我装（推荐）',
    'supervisor.installHint': '会写一个守护脚本到 <stateDir>/supervisor/，并在 Windows 注册一条登录自启记录 / Linux 注册一个 systemd 用户服务。不需要管理员。之后宿主进程退出，守护会在几秒内拉起它；起不来会自动回滚到重启前的快照。随时可以在设置里一键卸载。',
    'supervisor.keep': '保持我现在的启动方式',
    'supervisor.keepHint': '什么都不改。你现在用什么启动就继续用什么。代价：宿主进程退出后不会自动回来——重启功能会退化成「只能在有外部守护时生效」。',
    'supervisor.later': '以后再说',
    'supervisor.laterHint': '这张卡片不再出现。你可以随时在「设置 → 自动重启与关机 → 开机自启」里手动装。',
    'supervisor.error': '操作失败：{message}',
    'supervisor.busy': '正在处理…',
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
    // The settings section: the entry in the settings sidebar.
    'nav': '自动重启与关机',
    'settings.groups.restart': '重启相关设置',
    'settings.groups.shutdown': '关机相关设置',
    'settings.seconds.label': '关机倒数秒数',
    'settings.seconds.immediate': '不倒数（立即关机）',
    'settings.seconds.value': '{n} 秒',
    'settings.seconds.hint': '所有会话收工后，屏幕上会显示这段倒数（可点「不关了」取消），数完才关机；想要更多落盘时间就把倒数调大。',
    'settings.restartGrace.label': '重启前等待',
    'settings.restartGrace.hint': '重启没有倒数环节，会话一收工就会立刻重启；如果你装了“会话结束后才写”的记忆/总结类插件，把这里调大（默认 0 秒）。',
    'settings.restartGrace.value': '{n} 秒',
    'settings.restartGrace.immediate': '不等（立即重启）',
    'settings.backup.label': '重启前备份',
    'settings.backup.hint': '每次重启前先快照一次当前配置；万一重启后起不来，能自动回退。',
    'settings.backupPlugins.label': '备份包含已安装插件',
    'settings.backupPlugins.hint': '关闭后只备份 DSH 自身状态，不含 profile 里的插件目录。',
    'settings.groups.supervisor': '开机自启',
    'settings.supervisor.status': '当前由',
    'settings.supervisor.installed': '插件守护',
    'settings.supervisor.external': '你自己的方式',
    'settings.supervisor.unknown': '未知',
    'settings.supervisor.off': '关闭',
    'settings.supervisor.capable': '重启能力',
    'settings.supervisor.capableYes': '可用：宿主退出后会自动回来',
    'settings.supervisor.capableNo': '不可用：宿主退出后不会自动回来',
    'settings.supervisor.install': '装上守护',
    'settings.supervisor.uninstall': '卸载守护',
    'settings.supervisor.hint': '守护是一个独立进程：登录时自动启动，宿主进程掉了自动拉起，启动失败自动回滚上次快照。不需要管理员。',
    'settings.supervisor.noInstallDesktop': '桌面版自带重启，这里不用装守护。',
    'settings.supervisor.noInstallExternal': '已经有别的守护在管这个宿主：再装一个会两个一起拉起、抢同一个端口，所以这里不提供安装。',
    'settings.supervisor.noInstallUnknown': '宿主没说清是谁在拉起它，所以这里不提供安装。',
    'settings.supervisor.access': '当前访问链接',
    'settings.supervisor.accessHint': '重启后 token 会变，链接也会变。这个链接一直是最新的。',
    'settings.supervisor.pending': '卸载没有完成，请手动执行：{commands}',
    'settings.supervisor.reason': '说明',
    'settings.supervisor.command': '重启命令',
    'settings.supervisor.derive': '推导重启命令',
    'settings.supervisor.apply': '就用这条命令',
    'settings.supervisor.revert': '撤销',
    'settings.supervisor.noCommand': '推不出可重放的重启命令',
    'settings.supervisor.plan': '干跑预览',
    'settings.supervisor.reason.ok': '可以用这条命令重新拉起这个 DSH。',
    'settings.supervisor.reason.desktop-app': '桌面版自带重启，不用管这条命令。',
    'settings.supervisor.reason.not-a-web-host': '这个 DSH 不是网页型宿主，没有端口也没有监听器。',
    'settings.supervisor.reason.argv-unavailable': '读不回启动命令行（它是被一个特殊方式拉起来的），所以不猜。',
    'settings.supervisor.reason.external-supervisor': '已经有别的守护在管这个进程：装第二个会抢端口。改为「优雅退出，让它拉起我」。',
    'settings.supervisor.reason.container-no-init': '这台机器没有开机自启机制（容器），所以不承诺自动拉起。',
    'settings.supervisor.reason.port-not-fixable': '端口每次都变，浏览器会被踢出去；得先把端口固定下来。',
    'settings.supervisor.reason.supervised': '插件自己的守护在管这个进程，重启直接交给它。',
    'settings.error': '没能保存设置：{message}',
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
    'sleep.waiting.count': '还有 {n} 个任务在干活',
    'sleep.waiting.subagents': '其中 {k} 个是子智能体',
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
    'sleep.choice.footnote': '以后可在 设置 → 自动重启与关机 修改',
    'sleep.choice.diagramLabel': '按钮出现在左侧栏最底部、设置按钮旁边',
    'sleep.choice.error': '保存失败：{message}',
    // The one-time announcement of a new feature. An installation that already
    // existed never sees the install prompt again, so this card is the only way
    // a new feature reaches it.
    'announcement.title': '新功能：收工关机',
    'announcement.line1': '左侧栏最底部多了一个 🌙「收工关机」按钮。',
    'announcement.line2': '点一下 → 所有会话收工后倒数 {n} 秒关机。',
    'announcement.line2.generic': '点一下 → 所有会话收工后倒数几秒关机。',
    'announcement.line3': '想改行为，去「设置 → 自动重启与关机」。',
    'announcement.disabled': '按钮目前关闭，可在设置里打开。',
    'announcement.button': '知道了',
    'announcement.error': '没能记下来：{message}',
  }

  const EN = {
    label: 'Pending restart',
    busyPrefix: ' · waiting for ',
    busySuffix: ' task(s) to finish',
    idle: ' · restarts once idle',
    goalActive: ' · held by a self-continuing goal',
    goalExhausted: ' · a goal ran out of rounds',
    settling: ' · still waiting for the quiet window',
    parkedGoals: ' · {n} goal(s) parked, they continue after the restart',
    parkButton: 'Park & restart',
    parkButtonAria: 'Park that session goal and request the restart now',
    parkBusy: 'Parking…',
    parkError: 'Park failed: {message}',
    tooltip:
      'Waits for the other sessions to become idle, then restarts automatically; this session resumes its progress after the restart.',
    tooltipBusy:
      'Waits for the other tasks to finish (the count includes work that is queued but not started yet), then restarts automatically; this session resumes its progress after the restart.',
    tooltipWithError:
      'Waits for the other sessions to become idle, then restarts automatically; this session resumes its progress after the restart. {message}',
    dotAria: 'Pending restart',
    panelHeading: 'Pending restart',
    panelStateBusy: 'Waiting for the other sessions to become idle',
    panelStateIdle: 'Waiting for the idle window',
    panelStateGoalActive: 'Waiting for the other sessions to park their self-continuing goal',
    panelStateGoalExhausted: 'Waiting for the other sessions\' goal (its round budget is used up)',
    panelBlockedTitle: 'Blocking session: {title}',
    panelBlockedGeneric: 'One task is running',
    // One line per blocker: a session and a subagent are told apart, and
    // neither of them is ever shown as a raw session id.
    panelBlockedSession: 'Session "{label}" is running',
    panelBlockedSubagent: '{name} is running',
    panelBlockedSubagentGeneric: 'One subagent is running',
    // The N subagents of ONE session are one line.
    panelBlockedSubagentGroup: 'The {n} subagents of session "{label}" are running',
    panelBlockedSubagentGroupGeneric: '{n} subagents are running',
    panelBlockedRestartPending: 'Waiting for the pending restart to finish before shutting down',
    panelGoalActiveLine: 'Blocking session "{title}": the goal keeps driving rounds by itself (goal-active)',
    panelGoalExhaustedLine: 'Blocking session "{title}": the goal ran out of rounds and cannot continue (goal-exhausted)',
    panelParkedTitle: 'Parked goals (they continue after the restart):',
    panelParkedGoal: 'session {session} · {goal}',
    panelWaiting: 'Waiting for {duration}',
    panelResume: 'This session resumes its progress automatically after the restart.',
    // The long wait: the restart passed the hard deadline while a conversation
    // was still running. The capsule is ONE clipped line of 22px: it holds a
    // number and a duration, NEVER a name. Every name goes into the tooltip,
    // where there is room for all of them.
    longWaitPill: ' · waiting for {duration} · {n} task(s) running',
    longWaitTooltip: 'Waiting for {duration}. Running: {blockers}',
    // The blockers of one list: they are grouped by the session that created
    // them (N subagents of one session are ONE item), the tooltip names them
    // ALL and the shutdown card lists them. One rule, two surfaces.
    blockerGeneric: 'another session',
    blockerJoin: ', ',
    blockerGroupSubagents: '{label} ({n} subagents)',
    blockerGroupSubagentsGeneric: '{n} subagents',
    blockerMore: '… and {n} more',
    blockersTitleLine: 'Blocking sessions: {blockers}',
    durationSeconds: '{n}s',
    durationMinutes: '{n}m {m}s',
    durationHours: '{n}h {m}m',
    // The COMPACT duration of the capsule: it can afford "16 min", not
    // "16m 37s" — the capsule is one clipped line.
    durationMinutesShort: '{n} min',
    durationHoursShort: '{n}h',
    durationHoursMinutesShort: '{n}h {m}m',
    // The manual cancel of the capsule: the panel, the confirmation and the
    // readable reasons. The capsule's own text stays free of hints — the panel
    // is the discoverability.
    cancelPanelTasks: 'This restart is still waiting for {n} task(s) to finish',
    cancelPanelOthers: '{n} other session(s) are waiting for this restart too',
    cancelPanelOthersAfter: '{n} session(s) are still waiting',
    cancelPanelAria: 'Pending restart details',
    cancelButton: 'Cancel my restart',
    cancelButtonAria: 'Cancel my restart',
    cancelConfirmTitle: 'Cancel your restart?',
    cancelConfirmOnlyMe: 'After this, the restart will not happen.',
    cancelConfirmOthers: '{n} other session(s) are waiting for this restart too — cancelling only affects you; they will still restart.',
    cancelConfirmUnknown: 'The current session is unknown, so its own request cannot be withdrawn.',
    cancelConfirmButton: 'Cancel it',
    cancelConfirmButtonAria: 'Confirm the cancellation',
    cancelDismissButton: 'Never mind',
    cancelDismissButtonAria: 'Keep the restart',
    cancelFailed: 'The restart could not be cancelled.',
    cancelFailedWith: 'The restart could not be cancelled: {message}',
    cancelNotRequester: 'This session did not request the pending restart, so nothing was cancelled.',
    cancelNothingPending: 'There is no pending restart to cancel.',
    cancelUnknownSession: 'The current session is unknown, so its own request cannot be withdrawn.',
    cancelNoRoute: 'The cancel route is not available (the Host is too old).',
    // The one-time install prompt (the choice is asked exactly once).
    // "Backup" is the verb and BOTH options share the "configuration" base:
    // the plugins are an ADDITION to the configuration, never a rival of it.
    backupChoiceTitle: 'Automatic pre-restart backup: include the installed plugins too?',
    backupChoiceBody: 'A snapshot of the current configuration is taken before every restart, so a host that fails to come back can be rolled back automatically.',
    backupChoiceWithPlugins: 'Configuration + installed plugins',
    backupChoiceWithPluginsHint: 'About 3 seconds and 117 MB more; a plugin that breaks the boot can be rolled back too.',
    backupChoiceConfigOnly: 'Configuration only',
    backupChoiceConfigOnlyHint: 'Instant, about 66 KB; plugin problems cannot be rolled back and need a manual reinstall.',
    backupChoiceFootnote: 'You can change this later in Settings → Auto-restart & shut down',
    backupChoicePickPrimary: 'Use this',
    backupChoicePickSecondary: 'Configuration only',
    backupChoiceRecommended: 'Recommended',
    backupChoiceDismissAria: 'Close this one-time prompt',
    backupChoiceError: 'Could not save the choice: {message}',
    'supervisor.title': 'Let DSH bring itself back up?',
    'supervisor.body': 'This hosted DSH instance is started by hand (or by something else) — when it dies it does not come back. I can install a supervisor of my own: it starts at login, it starts the host again when the process is gone, and it restores the last snapshot when the host does not come up. The supervisor never touches your session data; it only starts, watches and rolls back.',
    'supervisor.changes': 'What it changes: a new <stateDir>/supervisor/ directory (the supervisor script, its configuration, its log and its lock); on Windows a login record (the scheduled task dsh-autorestart-web), on Linux a systemd user service. What it does NOT change: your session data, your model configuration, the installed plugins.',
    'supervisor.rights': 'Which rights it needs: on Windows NO administrator rights (it runs "at login"; if the machine forbids ordinary users from creating scheduled tasks, it falls back to the startup folder, which needs none either); on Linux it needs write access to your own home directory (systemctl --user — an ordinary user is enough).',
    'supervisor.uninstall': 'How to remove it: one click on "Start at login → Uninstall" in the settings; or by hand: schtasks /Delete /TN "dsh-autorestart-web" /F (on Linux: systemctl --user disable --now dsh-autorestart-web.service && rm ~/.config/systemd/user/dsh-autorestart-web.service). Both ways also delete the <stateDir>/supervisor/ directory.',
    'supervisor.install': 'Install it for me (recommended)',
    'supervisor.installHint': 'It writes a supervisor script into <stateDir>/supervisor/ and registers a login record on Windows / a systemd user service on Linux. No administrator rights needed. After that the host is started again within seconds when its process is gone; when it does not come up, the snapshot of the last restart is restored. You can uninstall it with one click at any time.',
    'supervisor.keep': 'Keep the way I start it',
    'supervisor.keepHint': 'Nothing is changed. Whatever starts the host today keeps starting it. The price: the host does not come back by itself when its process is gone — the restart only works while something else (a docker "restart: always", your own systemd unit) brings it back.',
    'supervisor.later': 'Later',
    'supervisor.laterHint': 'This card does not come back. You can install the supervisor by hand at any time in "Settings → Auto-restart & shut down → Start at login".',
    'supervisor.error': 'That did not work: {message}',
    'supervisor.busy': 'Working…',
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
    // The settings section: the entry in the settings sidebar.
    'nav': 'Auto-restart & shut down',
    'settings.groups.restart': 'Restart settings',
    'settings.groups.shutdown': 'Shutdown settings',
    'settings.seconds.label': 'Shutdown countdown seconds',
    'settings.seconds.immediate': 'No countdown (switch off right away)',
    'settings.seconds.value': '{n} seconds',
    'settings.seconds.hint': 'Once every conversation is done, this countdown is shown on screen (pick "Never mind, keep it on" to cancel); the machine goes off when it reaches zero. Raise it when you want more time to write.',
    'settings.restartGrace.label': 'Wait before the restart',
    'settings.restartGrace.hint': 'A restart has no countdown: the host restarts as soon as the conversations are done. Raise this if you rely on a memory or summary plugin that writes its notes after the conversation ended (default 0 seconds).',
    'settings.restartGrace.value': '{n} seconds',
    'settings.restartGrace.immediate': 'Do not wait (restart right away)',
    'settings.backup.label': 'Backup before a restart',
    'settings.backup.hint': 'Take a snapshot of the current configuration before every restart, so a host that cannot boot again is rolled back automatically.',
    'settings.backupPlugins.label': 'Include the installed plugins in the backup',
    'settings.backupPlugins.hint': 'Off: only the state of DSH itself is backed up — the plugin directory of the profile is left out.',
    'settings.groups.supervisor': 'Start at login',
    'settings.supervisor.status': 'Started by',
    'settings.supervisor.installed': 'the supervisor of this plugin',
    'settings.supervisor.external': 'your own way',
    'settings.supervisor.unknown': 'nobody knows',
    'settings.supervisor.off': 'switched off',
    'settings.supervisor.capable': 'Restart capability',
    'settings.supervisor.capableYes': 'available: the host comes back on its own',
    'settings.supervisor.capableNo': 'not available: the host does not come back on its own',
    'settings.supervisor.install': 'Install the supervisor',
    'settings.supervisor.uninstall': 'Uninstall the supervisor',
    'settings.supervisor.hint': 'The supervisor is a process of its own: it starts at login, it starts the host again when its process is gone, and it restores the last snapshot when the host does not come up. No administrator rights needed.',
    'settings.supervisor.noInstallDesktop': 'The desktop app restarts itself — there is no supervisor to install here.',
    'settings.supervisor.noInstallExternal': 'Another supervisor is already in charge of this host. A second one would start the host as well and both would fight over the port, so there is nothing to install here.',
    'settings.supervisor.noInstallUnknown': 'The host did not say who starts it, so there is nothing to install here.',
    'settings.supervisor.access': 'The current access link',
    'settings.supervisor.accessHint': 'The token changes with every restart, and so does the link. This one is always the current one.',
    'settings.supervisor.pending': 'The uninstall did not finish. Please run it by hand: {commands}',
    'settings.supervisor.reason': 'Why',
    'settings.supervisor.command': 'The restart command',
    'settings.supervisor.derive': 'Derive the restart command',
    'settings.supervisor.apply': 'Use this command',
    'settings.supervisor.revert': 'Undo',
    'settings.supervisor.noCommand': 'No replayable restart command could be derived',
    'settings.supervisor.plan': 'Dry run',
    'settings.supervisor.reason.ok': 'This command starts this DSH again.',
    'settings.supervisor.reason.desktop-app': 'The desktop app restarts itself; there is no command to write.',
    'settings.supervisor.reason.not-a-web-host': 'This DSH is not a web host: it has no port and no listener.',
    'settings.supervisor.reason.argv-unavailable': 'The command line cannot be read back (it was started in a special way), so nothing is guessed.',
    'settings.supervisor.reason.external-supervisor': 'Another supervisor is already in charge: a second one would fight over the port. The restart becomes "exit gracefully and let it start me again".',
    'settings.supervisor.reason.container-no-init': 'This machine has no "at login" (a container), so no automatic start is promised.',
    'settings.supervisor.reason.port-not-fixable': 'The port changes every time, so the browser would be logged out; the port has to be fixed first.',
    'settings.supervisor.reason.supervised': 'The supervisor of this plugin is in charge: the restart is handed to it.',
    'settings.error': 'Could not save the settings: {message}',
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
    'sleep.waiting.count': '{n} task(s) still working',
    'sleep.waiting.subagents': '{k} of them are subagents',
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
    'sleep.choice.footnote': 'You can change this later in Settings → Auto-restart & shut down',
    'sleep.choice.diagramLabel': 'The button sits at the bottom of the left sidebar, next to Settings',
    'sleep.choice.error': 'Could not save the choice: {message}',
    // The one-time announcement of a new feature. An installation that already
    // existed never sees the install prompt again, so this card is the only way
    // a new feature reaches it.
    'announcement.title': 'New feature: graceful shutdown',
    'announcement.line1': 'There is a new 🌙 "Shut down" button at the very bottom of the left sidebar.',
    'announcement.line2': 'Click it → once every conversation is done it counts down {n} seconds and powers the machine off.',
    'announcement.line2.generic': 'Click it → once every conversation is done it counts down a few seconds and powers the machine off.',
    'announcement.line3': 'To change that, go to "Settings → Auto-restart & shut down".',
    'announcement.disabled': 'The button is currently switched off; you can turn it on in the settings.',
    'announcement.button': 'Got it',
    'announcement.error': 'Could not record it: {message}',
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
   * Fill `{name}` placeholders in a locale template.
   *
   * The locale API is not assumed to interpolate, so the helpers below do it
   * themselves. This is the module-level twin of the panel's own `fill`.
   *
   * @param {string} template
   * @param {Record<string, unknown>} vars
   * @returns {string}
   */
  function fillTemplate(template, vars) {
    if (typeof template !== 'string') return ''
    return template.replace(/\{(\w+)\}/g, (match, name) => (
      vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
    ))
  }

  /**
   * A duration as a locale string: "45 秒" / "3 分 12 秒" / "2 小时 5 分".
   *
   * @param {number} ms
   * @param {(name: string) => string} [t] the translator
   * @returns {string}
   */
  function formatDurationMs(ms, t) {
    const translate = typeof t === 'function' ? t : (name) => name
    const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
    if (totalSeconds < 60) return fillTemplate(translate('durationSeconds'), { n: totalSeconds })
    const minutes = Math.floor(totalSeconds / 60)
    if (minutes < 60) return fillTemplate(translate('durationMinutes'), { n: minutes, m: totalSeconds % 60 })
    const hours = Math.floor(minutes / 60)
    return fillTemplate(translate('durationHours'), { n: hours, m: minutes % 60 })
  }

  /**
   * A duration as a COMPACT locale string: "45 秒" / "3 分钟" / "2 小时 5 分".
   *
   * The capsule of the pending restart is ONE clipped line of 22px: it can
   * afford "16 分钟", not "16 分 37 秒". The precise duration belongs into the
   * tooltip, where there is room for it.
   *
   * @param {number} ms
   * @param {(name: string) => string} [t] the translator
   * @returns {string}
   */
  function formatCompactDurationMs(ms, t) {
    const translate = typeof t === 'function' ? t : (name) => name
    const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
    if (totalSeconds < 60) return fillTemplate(translate('durationSeconds'), { n: totalSeconds })
    const minutes = Math.floor(totalSeconds / 60)
    if (minutes < 60) return fillTemplate(translate('durationMinutesShort'), { n: minutes })
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest === 0
      ? fillTemplate(translate('durationHoursShort'), { n: hours })
      : fillTemplate(translate('durationHoursMinutesShort'), { n: hours, m: rest })
  }

  /* ------------------------------------------------------------------ *
   * The blocker lists: ONE rule for every surface that names them.
   *
   * The defect the real machine showed: the pending-restart bubble grew a
   * line that named EVERY blocker — and every AgentTeams member is a
   * subagent, so the names of one team turned into a string of a dozen
   * "…的子智能体" phrases that did not fit into a 22px pill any more and
   * were clipped away.
   *
   * The rule, in one place:
   *
   *   1. the subagents of ONE session are ONE item ("<that session>
   *      (N subagents)"); a plain session is an item of its own;
   *   2. a list names at most `BLOCKER_SUMMARY_LIMIT` items and says
   *      "… and N more" about the rest — never an endless list;
   *   3. the SHORT list shortens a name that is too long;
   *   4. the COMPLETE list goes into the tooltip (`title`).
   *
   * WHERE THE NAMES LIVE. The capsule of the pending restart is 22px high
   * and ONE line wide: a name in it is a name that gets clipped away. So
   * the capsule says NUMBERS ONLY ("已等 16 分钟 · 3 项任务在跑") and every
   * name goes into the tooltip (`title`) — where the COMPLETE list lives.
   * The shutdown card has room, so it keeps the readable list.
   *
   * THE TWO REAL SHAPES. The Host does not report the blockers in one shape,
   * so the rule has to read every field the Host actually sends:
   *
   *   A. the gate / the long wait / the state route (`index.js`,
   *      `describeBlocker` + `busyAgents`):
   *
   *        { sessionId, reason, busyReason?, kind, label, name,
   *          parentTitle, parentSessionId }
   *
   *      `label` is the title of the session — for a SUBAGENT it is the title
   *      of the session that created it, and `name` is the composed phrase
   *      ("<that session>'s subagent"). `parentSessionId` says which session
   *      it belongs to.
   *
   *   B. the shutdown card (`lib/sleep.js`, `blockerEntry`):
   *
   *        { sessionId, kind, label, name, parentTitle, title }
   *
   *      The SAME information, but WITHOUT `parentSessionId` — so the
   *      grouping falls back to the parent's title (`parentTitle`).
   *
   * A rule that only knows `parentSessionId` therefore groups the card
   * wrongly: every member of a team becomes an item of its own, which is
   * exactly the endless list the rule is there to prevent.
   * ------------------------------------------------------------------ */

  /**
   * How many blockers a bubble names at once.
   *
   * The bubble is a 22px high pill: a long list is clipped away, so the list
   * is capped and the complete list goes into the tooltip.
   */
  const BLOCKER_SUMMARY_LIMIT = 2

  /**
   * How many characters one name may have in the bubble.
   *
   * The bubble is small, so a long session title is shortened instead of
   * pushing the rest of the line out of the pill. The "…" is part of the
   * budget: the bubble never shows MORE than this many characters of one
   * name.
   */
  const BLOCKER_NAME_MAX_LENGTH = 12

  /** The character a shortened name ends with. */
  const BLOCKER_ELLIPSIS = '…'

  /**
   * A name that is at most `maxLength` characters long.
   *
   * The characters are counted, not the code units, so a name of Chinese
   * characters is cut after the requested number of characters. The ellipsis
   * counts towards the limit: a name of 12 characters is shown as 11
   * characters plus "…", never as 13.
   *
   * @param {string} name
   * @param {number} [maxLength]
   * @returns {string}
   */
  function truncateBlockerName(name, maxLength) {
    const text = typeof name === 'string' ? name.trim() : ''
    if (text === '') return ''
    const limit = Number.isFinite(maxLength) && maxLength > 0
      ? Math.floor(maxLength)
      : BLOCKER_NAME_MAX_LENGTH
    const characters = Array.from(text)
    if (characters.length <= limit) return text
    if (limit === 1) return BLOCKER_ELLIPSIS
    return characters.slice(0, limit - 1).join('') + BLOCKER_ELLIPSIS
  }

  /**
   * One trimmed string field of a blocker, or '' when the field is missing.
   *
   * @param {any} entry
   * @param {string} key
   * @returns {string}
   */
  function blockerField(entry, key) {
    if (!entry || typeof entry !== 'object') return ''
    const value = entry[key]
    return typeof value === 'string' ? value.trim() : ''
  }

  /**
   * WHAT a blocker is: a session, a subagent or a pending restart.
   *
   * The Host says it (`kind`), but the kind is NOT the only evidence: an
   * entry that names a parent session (`parentSessionId` / `parentTitle`) IS
   * a subagent, whatever the Host called it. A Host that does not label the
   * kind must not turn a team of subagents into a list of single items.
   *
   * @param {any} entry
   * @returns {'session'|'subagent'|'restart-pending'}
   */
  function blockerEntryKind(entry) {
    if (!entry || typeof entry !== 'object') return 'session'
    if (entry.kind === 'restart-pending') return 'restart-pending'
    if (entry.kind === 'subagent') return 'subagent'
    if (entry.kind === 'session') return 'session'
    if (blockerField(entry, 'parentSessionId') !== '' || blockerField(entry, 'parentTitle') !== '') {
      return 'subagent'
    }
    return 'session'
  }

  /**
   * The title of the session a subagent belongs to.
   *
   * For a subagent the Host's `label` IS the title of the session that
   * created it (that is what the "…的子智能体" name is built from);
   * `parentTitle` is the same title under its own name, and `title` is the
   * old alias of `label`.
   *
   * @param {any} entry
   * @returns {string}
   */
  function blockerParentTitle(entry) {
    return blockerField(entry, 'label')
      || blockerField(entry, 'parentTitle')
      || blockerField(entry, 'title')
  }

  /**
   * The identity of the session that created a subagent — the key its
   * subagents are grouped by.
   *
   * The parent session id is the exact identity. The parent's title is the
   * fallback for the surfaces that do not carry the id: the shutdown card
   * reports `parentTitle` but NO `parentSessionId`, so without this
   * fallback every member of a team would become an item of its own.
   *
   * @param {any} entry
   * @returns {string|null}
   */
  function blockerParentKey(entry) {
    const id = blockerField(entry, 'parentSessionId')
    if (id !== '') return 'id:' + id
    const title = blockerField(entry, 'parentTitle')
    if (title !== '') return 'title:' + title
    const label = blockerField(entry, 'label')
    if (label !== '') return 'label:' + label
    return null
  }

  /* ------------------------------------------------------------------ *
   * THE TASK COUNT: one rule, four surfaces.
   *
   * A TASK is one conversation of the left sidebar: the session itself. A
   * subagent belongs to the session that spawned it, so a session and its
   * subagents are ONE task — the sidebar counts them once, and so does the
   * bubble.
   *
   * The defect this fixes: the bubble counted every BLOCKER, so a session
   * with two subagents was three tasks. The sidebar showed two busy
   * conversations and the bubble said "waiting for 3 tasks to finish".
   *
   * The rule:
   *
   *   - a session is a task of its own (its key is its own session id);
   *   - a subagent belongs to the session that created it (its key is the
   *     PARENT's session id), so a parent and its subagents are ONE task;
   *   - a subagent whose parent is only known by its TITLE joins the session
   *     with that title (the shutdown card reports the title but no id);
   *   - a subagent with no known parent is a task of its own;
   *   - a pending restart is not a task.
   *
   * MIRRORED: `lib/blockers.js` (the host half) carries the same rule — the
   * client is a CLASSIC script and cannot import that module. The two
   * implementations MUST agree, and `test/task-count.test.mjs` runs the same
   * cases through both.
   * ------------------------------------------------------------------ */

  /** The prefix of the key of a family that is known by its session id. */
  const TASK_KEY_SESSION = 'session:'

  /** The prefix of the key of a family that is only known by its title. */
  const TASK_KEY_TITLE = 'title:'

  /**
   * The session id of a blocker.
   *
   * @param {any} entry
   * @returns {string}
   */
  function blockerSessionId(entry) {
    if (!entry || typeof entry !== 'object') return ''
    const value = entry.sessionId
    return value == null ? '' : String(value).trim()
  }

  /**
   * The title of the session a subagent belongs to.
   *
   * @param {any} entry
   * @returns {string}
   */
  function blockerTaskParentTitle(entry) {
    return blockerField(entry, 'parentTitle') || blockerField(entry, 'label')
  }

  /**
   * The title of a blocker (for a session: its own title).
   *
   * @param {any} entry
   * @returns {string}
   */
  function blockerTaskTitle(entry) {
    return blockerField(entry, 'label') || blockerField(entry, 'title')
  }

  /**
   * The map "title of a session" → "session id" of the sessions in the list.
   *
   * @param {any[]} entries
   * @returns {Map<string, string>}
   */
  function blockerTaskTitles(entries) {
    const map = new Map()
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      if (blockerEntryKind(entry) === 'subagent') continue
      const title = blockerTaskTitle(entry)
      if (title === '') continue
      const id = blockerSessionId(entry)
      if (id === '') continue
      if (!map.has(title)) map.set(title, id)
    }
    return map
  }

  /**
   * The key of the family every entry belongs to.
   *
   * One key per entry, in the order of the list ('' for an entry that is not a
   * task at all).
   *
   * @param {any[]} entries the blockers the Host reported
   * @returns {string[]}
   */
  function blockerTaskKeys(entries) {
    const list = Array.isArray(entries) ? entries : []
    const titles = blockerTaskTitles(list)
    const keys = []
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index]
      if (!entry || typeof entry !== 'object') {
        keys.push('')
        continue
      }
      const kind = blockerEntryKind(entry)
      if (kind === 'restart-pending') {
        // A pending restart is not a task: it is what the shutdown waits for.
        keys.push('')
        continue
      }
      if (kind === 'subagent') {
        const parentId = blockerField(entry, 'parentSessionId')
        if (parentId !== '') {
          keys.push(TASK_KEY_SESSION + parentId)
          continue
        }
        const parentTitle = blockerTaskParentTitle(entry)
        if (parentTitle !== '') {
          const known = titles.get(parentTitle)
          keys.push(known ? TASK_KEY_SESSION + known : TASK_KEY_TITLE + parentTitle)
          continue
        }
        const own = blockerSessionId(entry)
        keys.push(own !== '' ? TASK_KEY_SESSION + own : 'entry:' + index)
        continue
      }
      const own = blockerSessionId(entry)
      keys.push(own !== '' ? TASK_KEY_SESSION + own : 'entry:' + index)
    }
    return keys
  }

  /**
   * How many TASKS the blockers are.
   *
   * A parent session and its own subagents are ONE task: the same number the
   * left sidebar shows.
   *
   * @param {any[]} entries the blockers the Host reported
   * @returns {number}
   */
  function countBlockerTasks(entries) {
    const keys = blockerTaskKeys(entries)
    const families = new Set()
    for (const key of keys) {
      if (key !== '') families.add(key)
    }
    return families.size
  }

  /**
   * How many of those tasks are carried by SUBAGENTS ONLY.
   *
   * A task whose session is idle and whose subagent works is a task of the
   * subagent — that is what the card tells the user ("2 of them are
   * subagents"). A task whose session works itself is not one of them, even
   * when it has subagents of its own.
   *
   * @param {any[]} entries the blockers the Host reported
   * @returns {number}
   */
  function countSubagentTasks(entries) {
    const list = Array.isArray(entries) ? entries : []
    const keys = blockerTaskKeys(list)
    const families = new Map()
    list.forEach((entry, index) => {
      const key = keys[index]
      if (key === '') return
      const family = families.get(key) || { session: false, subagent: false }
      if (blockerEntryKind(entry) === 'subagent') family.subagent = true
      else family.session = true
      families.set(key, family)
    })
    let count = 0
    for (const family of families.values()) {
      if (family.subagent && !family.session) count += 1
    }
    return count
  }

  /**
   * The readable name of one blocker.
   *
   * The Host names a session by its title (`label`, also carried as `name`)
   * and a subagent by the whole phrase ("<that session>'s subagent"). A
   * surface that carries the title under the old name (`title`) still gets a
   * name; an entry without any of them has nothing to show.
   *
   * @param {any} entry
   * @returns {string}
   */
  function blockerEntryName(entry) {
    if (!entry || typeof entry !== 'object') return ''
    return blockerField(entry, 'name')
      || blockerField(entry, 'label')
      || blockerField(entry, 'title')
      || blockerField(entry, 'parentTitle')
  }

  /**
   * The blockers of one list, grouped by the session that created them.
   *
   * A subagent belongs to the session that spawned it, so N subagents of one
   * session are ONE item. A plain session is an item of its own: it is a
   * conversation in its own right, even when its own subagents are busy too.
   *
   * The group key is the parent session id when the surface reports it, and
   * the parent's TITLE when it does not (the shutdown card reports
   * `parentTitle` but no id).
   *
   * @param {any[]} entries the blockers the Host reported
   * @returns {Array<{ key: string, kind: string, label: string, name: string, count: number, entry: any, sessionIds: string[] }>}
   */
  function groupBlockers(entries) {
    const list = Array.isArray(entries) ? entries : []
    const groups = []
    const byKey = new Map()
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const kind = blockerEntryKind(entry)
      // A subagent of a KNOWN session joins that session's group. A subagent
      // whose parent is unknown joins the one generic group of parentless
      // subagents — they are counted ("N subagents"), not listed one by one.
      const parent = kind === 'subagent' ? (blockerParentKey(entry) || 'unknown') : null
      const sessionId = entry.sessionId == null ? '' : String(entry.sessionId)
      const key = parent !== null ? 'parent:' + parent : 'own:' + kind + ':' + sessionId
      let group = byKey.get(key)
      if (!group) {
        group = {
          key,
          kind,
          parentSessionId: blockerField(entry, 'parentSessionId') || null,
          // The label of a subagent group is the title of the session that
          // created it; the label of a session is its own title.
          label: kind === 'subagent'
            ? blockerParentTitle(entry)
            : (blockerField(entry, 'label') || blockerField(entry, 'title')),
          name: blockerEntryName(entry),
          count: 0,
          entry,
          sessionIds: [],
        }
        byKey.set(key, group)
        groups.push(group)
      }
      group.count += 1
      group.sessionIds.push(sessionId)
      if (group.label === '') {
        group.label = kind === 'subagent'
          ? blockerParentTitle(entry)
          : (blockerField(entry, 'label') || blockerField(entry, 'title'))
      }
      if (group.name === '') group.name = blockerEntryName(entry)
    }
    return groups
  }

  /**
   * The name of one group, as it is shown.
   *
   * A group of more than one subagent is named after the session that
   * created them ("<that session> (N subagents)"); a lone subagent keeps its
   * own name ("<that session>'s subagent").
   *
   * @param {any} group one group of `groupBlockers`
   * @param {(name: string) => string} t the translator
   * @param {number} maxLength how many characters the name may have
   * @param {boolean} shorten whether the name may be shortened
   * @returns {string}
   */
  function blockerGroupName(group, t, maxLength, shorten) {
    if (!group) return ''
    const translate = typeof t === 'function' ? t : (name) => name
    if (group.kind === 'subagent') {
      // A group of MORE THAN ONE subagent is named after the session that
      // created them ("<that session> (N subagents)"); a lone subagent keeps
      // its own name ("<that session>'s subagent").
      if (group.count > 1) {
        const label = shorten ? truncateBlockerName(group.label, maxLength) : group.label
        return label === ''
          ? fillTemplate(translate('blockerGroupSubagentsGeneric'), { n: group.count })
          : fillTemplate(translate('blockerGroupSubagents'), { label, n: group.count })
      }
      const own = group.name || group.label
      if (own !== '') return shorten ? truncateBlockerName(own, maxLength) : own
      // A lone subagent without any name at all: the generic line still says
      // something — an empty name never reaches the interface.
      return fillTemplate(translate('blockerGroupSubagentsGeneric'), { n: group.count })
    }
    const name = group.name || group.label
    return shorten ? truncateBlockerName(name, maxLength) : name
  }

  /**
   * The names of the blockers: a SHORT summary for the bubble and the
   * COMPLETE list for the tooltip.
   *
   * The summary never grows without a bound: at most `limit` items, every
   * name shortened to `maxNameLength` characters, and a "… and N more" for
   * the rest. The complete list names every group with its full name — it is
   * only ever shown in a tooltip, where there is room for it.
   *
   * @param {any[]} entries the blockers the Host reported
   * @param {{ t?: Function, limit?: number, maxNameLength?: number, joiner?: string }} [options]
   * @returns {{ groups: any[], summary: string, full: string, total: number }}
   */
  function summarizeBlockers(entries, options) {
    const opts = options && typeof options === 'object' ? options : {}
    const translate = typeof opts.t === 'function' ? opts.t : (name) => name
    const limit = Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : BLOCKER_SUMMARY_LIMIT
    const maxNameLength = Number.isFinite(opts.maxNameLength) && opts.maxNameLength > 0
      ? Math.floor(opts.maxNameLength)
      : BLOCKER_NAME_MAX_LENGTH
    const joiner = typeof opts.joiner === 'string' ? opts.joiner : translate('blockerJoin')
    const groups = groupBlockers(entries)

    const full = groups
      .map((group) => blockerGroupName(group, translate, maxNameLength, false))
      .filter((name) => name !== '')
      .join(joiner)

    const shown = groups.slice(0, limit)
    const names = shown
      .map((group) => blockerGroupName(group, translate, maxNameLength, true))
      .filter((name) => name !== '')
    const rest = groups.length - shown.length
    const more = rest > 0 ? fillTemplate(translate('blockerMore'), { n: rest }) : ''

    return {
      groups,
      total: groups.length,
      // How many of the groups carry a name at all: a list of unnamed blockers
      // has nothing to show, so a caller can leave its clause out.
      named: groups.filter((group) => blockerGroupName(group, translate, maxNameLength, false) !== '').length,
      summary: names.length === 0 ? translate('blockerGeneric') : (names.join(joiner) + more),
      full: full === '' ? translate('blockerGeneric') : full,
    }
  }

  /**
   * The note of a LONG wait.
   *
   * The Host says that the pending restart passed the hard deadline while a
   * conversation was still running. That is not "a little longer" any more, so
   * the bubble says it out loud: how long the restart has been waiting and who
   * holds it. The note is empty when there is no long wait.
   *
   * @param {any} info the state payload of the Host
   * @param {(name: string) => string} [t] the translator
   * @returns {string}
   */
  function formatLongWaitNote(info, t) {
    return formatLongWaitNoteParts(info, t).note
  }

  /**
   * The note of a LONG wait, in both shapes: the CAPSULE shows the numbers
   * only, the tooltip the COMPLETE list.
   *
   * The capsule of the pending restart is 22px high and ONE line wide: a name
   * in it is a name that gets clipped away. So the capsule says HOW LONG the
   * restart has been waiting and HOW MANY tasks are running — never WHO they
   * are — and every name goes into the tooltip.
   *
   * @param {any} info the state payload of the Host
   * @param {(name: string) => string} [t] the translator
   * @returns {{ note: string, full: string, pill: string, summary: string, count: number, hasLongWait: boolean }}
   */
  function formatLongWaitNoteParts(info, t) {
    const translate = typeof t === 'function' ? t : (name) => name
    const longWait = info && typeof info === 'object' ? info.longWait : null
    if (!longWait || typeof longWait !== 'object') {
      return { note: '', full: '', pill: '', summary: '', count: 0, hasLongWait: false }
    }
    const blockedBy = Array.isArray(longWait.blockedBy) ? longWait.blockedBy : []
    const summary = summarizeBlockers(blockedBy, { t: translate })
    // The precise duration belongs into the tooltip, the COMPACT one into the
    // capsule: the capsule cannot afford "16 分 37 秒".
    const duration = formatDurationMs(longWait.waitedMs, translate)
    const compact = formatCompactDurationMs(longWait.waitedMs, translate)
    // The count is about TASKS, not blockers: a session and its own subagents
    // are ONE task, exactly as the left sidebar counts them.
    const count = countBlockerTasks(blockedBy)
    // The tooltip: the whole story, every name, nothing cut.
    const sentence = fillTemplate(translate('longWaitTooltip'), { duration, blockers: summary.full })
    return {
      // The CAPSULE: numbers only, no name at all.
      pill: fillTemplate(translate('longWaitPill'), { duration: compact, n: count }),
      note: sentence,
      full: sentence,
      summary: summary.summary,
      count,
      hasLongWait: true,
    }
  }

  /**
   * The readable reason why a manual cancel did not work.
   *
   * The Host answers with a machine reason (`not-a-requester`,
   * `session-id-required`, …); the panel of the capsule shows something a
   * person can act on.
   *
   * @param {any} body the answer of the Host
   * @param {(name: string) => string} [t] the translator
   * @returns {string}
   */
  function cancelFailureText(body, t) {
    const translate = typeof t === 'function' ? t : (name) => name
    if (body && typeof body.error === 'string' && body.error.trim() !== '') return body.error.trim()
    if (body && typeof body.reason === 'string') {
      if (body.reason === 'not-a-requester') return translate('cancelNotRequester')
      if (body.reason === 'no-restart-pending') return translate('cancelNothingPending')
      if (body.reason === 'session-id-required' || body.reason === 'no-session-id') {
        return translate('cancelUnknownSession')
      }
    }
    return translate('cancelFailed')
  }

  /**
   * The URL the browser has to move to after a restart, or null.
   *
   * THE LOCKOUT. The boot token of `dsh web` is created PER PROCESS, so the
   * link the browser holds answers 401 after a restart: the user sits in front
   * of a page that cannot talk to its own host. The Host publishes the access
   * link of the instance that is really running, so the browser can follow it —
   * that is the way back in.
   *
   * The rules (ALL of them must hold, or nothing happens at all):
   *   - the access link carries a token;
   *   - the current URL carries a token too — a URL without one is an ordinary
   *     session, and following the link would reload the page for nothing;
   *   - the two tokens differ (otherwise there is nothing to follow);
   *   - the origin and the path are the same: the plugin never sends the
   *     browser to another host or to another page.
   *
   * @param {string} currentUrl the URL the browser is on
   * @param {string} accessUrl the access link the Host published
   * @returns {string|null} the URL to move to, or null
   */
  function resolveAccessRedirect(currentUrl, accessUrl) {
    const from = typeof currentUrl === 'string' ? currentUrl : ''
    const to = typeof accessUrl === 'string' ? accessUrl : ''
    if (from === '' || to === '') return null
    let current
    let next
    try {
      current = new URL(from)
      next = new URL(to, from)
    } catch {
      return null
    }
    if (next.origin !== current.origin) return null
    if (next.pathname !== current.pathname) return null
    const currentToken = current.searchParams.get('token')
    const nextToken = next.searchParams.get('token')
    if (!currentToken || !nextToken || currentToken === nextToken) return null
    return next.toString()
  }

  /**
   * The label of "who starts this host".
   *
   * The Host reports the mode; this only turns it into a word the user can
   * read: the supervisor of this plugin, the user's own way, nobody, or off.
   *
   * @param {Function} t the translator
   * @param {any} status the supervisor status of the Host
   * @returns {string}
   */
  function supervisorModeLabel(t, status) {
    const translate = typeof t === 'function' ? t : (name) => name
    const mode = status && typeof status === 'object' ? status.mode : ''
    if (mode === 'installed') return translate('settings.supervisor.installed')
    if (mode === 'external') return translate('settings.supervisor.external')
    if (mode === 'off') return translate('settings.supervisor.off')
    // The desktop app relaunches itself: it is not "nobody knows".
    if (mode === 'app') return translate('settings.supervisor.app')
    return translate('settings.supervisor.unknown')
  }

  /**
   * The label of "how this host was started" (the startup matrix).
   *
   * @param {Function} t the translator
   * @param {any} startup the startup classification of the Host
   * @returns {string}
   */
  function startupModeLabel(t, startup) {
    const translate = typeof t === 'function' ? t : (name) => name
    const mode = startup && typeof startup === 'object' ? startup.mode : ''
    if (mode === 'bare') return translate('settings.supervisor.startup.bare')
    if (mode === 'external') return translate('settings.supervisor.startup.external')
    if (mode === 'container') return translate('settings.supervisor.startup.container')
    if (mode === 'desktop') return translate('settings.supervisor.startup.desktop')
    if (mode === 'self-supervised') return translate('settings.supervisor.startup.selfSupervised')
    return translate('settings.supervisor.startup.unknown')
  }

  /**
   * May the panel offer to install the supervisor of this plugin?
   *
   * The browser side serves the desktop app AND the hosted web host, so it may
   * not assume one of them:
   *
   *   - the desktop app brings itself back up (there is nothing to install);
   *   - a host that somebody ELSE supervises must not get a SECOND supervisor:
   *     both would start the host and they would fight over the port;
   *   - the automatic restart may be switched off;
   *   - a host whose starter could not be established gets NOTHING: the
   *     plugin would rather say "I cannot tell" than start a second host.
   *
   * When the Host says nothing, the answer is "no": an unknown host is no
   * reason to touch the machine. The UNINSTALL button always stays available
   * when a supervisor of this plugin is installed — removing it is always
   * allowed.
   *
   * @param {any} status the supervisor status of the Host
   * @param {any} host the host block of the Host (which end this is)
   * @returns {boolean}
   */
  function canOfferSupervisorInstall(status, host) {
    if (!status || typeof status !== 'object') return false
    if (status.installed === true) return true
    const isDesktop = host && typeof host === 'object' && host.isDesktopApp === true
    if (isDesktop) return false
    // The startup matrix has the final word: only a bare host (nobody manages
    // it) may get a supervisor of this plugin.
    const startup = status.startup && typeof status.startup === 'object' ? status.startup : null
    if (startup !== null && startup.canInstallSupervisor !== true) return false
    const mode = typeof status.mode === 'string' ? status.mode : ''
    if (mode === 'external' || mode === 'off') return false
    // The Host says the desktop app manages itself: a supervisor there would
    // start a SECOND client at every login.
    if (mode === 'app') return false
    return true
  }

  /**
   * The named exports of this module.
   *
   * The client module system materializes `factory(require) -> exports`, so
   * these helpers ARE the module's exports; they are mirrored on
   * `globalThis.__dshAutorestartClient` for the tests that evaluate the file
   * without a loader.
   */
  const SLEEP_EXPORTS = {
    pickSleepCaption,
    shouldShowSleepButton,
    buildChoiceBody,
    formatRemainingMs,
    formatLongWaitNote,
    formatLongWaitNoteParts,
    formatCompactDurationMs,
    cancelFailureText,
    groupBlockers,
    summarizeBlockers,
    truncateBlockerName,
    // The task count: one rule, four surfaces (mirrored from lib/blockers.js).
    blockerTaskKeys,
    countBlockerTasks,
    countSubagentTasks,
    resolveAccessRedirect,
    supervisorModeLabel,
    startupModeLabel,
    canOfferSupervisorInstall,
    // The two dictionaries, so a test can build a translator without a Host.
    dictionaries: { zh: ZH, en: EN },
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
      const DEFAULT_CANCEL_URL = ROUTE_PREFIX + '/cancel'
      // The route that persists the one-time install choice.
      const DEFAULT_CHOICE_URL = ROUTE_PREFIX + '/choice'
      // The browser-side record of the one-time install choice. The prompt is
      // shown only while this key is missing, so it is asked exactly once.
      const BACKUP_CHOICE_KEY = 'dsh-autorestart:backup-choice-v1'

      /**
       * The route that installs, uninstalls and reports the supervisor.
       *
       * The Host sends the authoritative one with the state payload; this is
       * the fallback for a Host that is older than the supervisor.
       */
      const DEFAULT_SUPERVISOR_URL = '/__dsh_autorestart/supervisor'
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

      /**
       * Follow the access link the Host published, when the one the browser
       * holds is stale.
       *
       * After a restart the boot token of the old link is dead, so the browser
       * would sit on a page that cannot talk to its host. The Host reports the
       * access link of the instance that is really running; when it differs,
       * the browser moves there.
       */
      function followAccessUrl(body) {
        if (typeof window === 'undefined' || !window.location) return
        const target = resolveAccessRedirect(window.location.href, body && body.accessUrl)
        if (!target) return
        try {
          window.location.replace(target)
        } catch {
          // A browser that refuses the navigation must not break the poll.
        }
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
          // The boot token is created per process: after a restart the link the
          // browser holds answers 401. The Host publishes the access link of
          // the instance that is really running — following it is the way back
          // into the interface.
          followAccessUrl(body)
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

      /**
       * The line of one blocker: a session and a subagent are told apart, and
       * neither of them is ever shown as a raw session id.
       *
       * The Host says WHAT the blocker is (`kind`) and HOW it is called: a
       * session by its own title (`label`), a subagent by the whole phrase
       * (`name`: "写代码的会话的子智能体"). The phrase is used as it is — it
       * reads as a sentence, while a bracketed label would read like an
       * annotation. A subagent whose parent title is unknown has no name of its
       * own, so it gets the generic line instead of an empty bracket.
       *
       * @param {any} entry the blocker the Host reported
       * @returns {string}
       */
      function blockerLine(entry) {
        const t = translate ?? ((name) => name)
        // The SAME rule as the grouping: an entry that names a parent is a
        // subagent, whatever the Host called it.
        const kind = blockerEntryKind(entry)
        const label = kind === 'subagent'
          ? blockerParentTitle(entry)
          : (blockerField(entry, 'label') || blockerField(entry, 'title'))
        if (kind === 'restart-pending') {
          // A pending restart goes first: the shutdown waits for it.
          return t('panelBlockedRestartPending')
        }
        if (kind === 'subagent') {
          const name = blockerField(entry, 'name')
          if (name === '' || label === '') return t('panelBlockedSubagentGeneric')
          return fill(t('panelBlockedSubagent'), { name })
        }
        return label === ''
          ? t('panelBlockedGeneric')
          : fill(t('panelBlockedSession'), { label })
      }

      /**
       * Whether a blocker is a pending RESTART (and not a task that is running).
       *
       * The restart is not a task: it is the thing the shutdown waits for, so it
       * is never counted as one.
       *
       * @param {any} entry
       * @returns {boolean}
       */
      function isRestartPending(entry) {
        return Boolean(entry) && entry.kind === 'restart-pending'
      }

      /**
       * The line of one GROUP of blockers.
       *
       * The N subagents of ONE session are one line: the session is named once
       * and the number of its subagents says how many there are. A group of one
       * keeps the ordinary line (a session, or a lone subagent).
       *
       * @param {any} group one group of `groupBlockers`
       * @returns {string}
       */
      function blockerGroupLine(group) {
        const t = translate ?? ((name) => name)
        if (!group) return ''
        if (group.kind === 'subagent' && group.count > 1) {
          return group.label === ''
            ? fill(t('panelBlockedSubagentGroupGeneric'), { n: group.count })
            : fill(t('panelBlockedSubagentGroup'), { label: group.label, n: group.count })
        }
        return blockerLine(group.entry)
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
       * The route that withdraws ONE session's own restart request: the one the
       * Host sent with the state payload, or the one derived from the health
       * path.
       */
      function cancelUrlFor(info) {
        const sent = info && typeof info.cancelUrl === 'string' ? info.cancelUrl.trim() : ''
        if (sent.startsWith('/')) return sent
        return DEFAULT_CANCEL_URL
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

      // The extra line of a LONG wait: how long the restart has been waiting and
      // who holds it. It is a separate element (not more text in the same span)
      // so the bubble can tell "the ordinary status" from "the long wait", and
      // it stays inside the clipped pill — the composer row never grows.
      const LONG_WAIT_STYLE = {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        opacity: 0.85,
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

      // The confirmation box INSIDE the panel: it is the second step of the
      // manual cancel (the button opens it, only the confirmation cancels).
      // It has NO timeout: it stays until the user decides.
      const CONFIRM_STYLE = {
        marginTop: 8,
        paddingTop: 8,
        borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
      }

      // The buttons of the panel: they look like the pill's own buttons, only
      // smaller, and they are real buttons (focusable, Enter/Space work).
      const PANEL_BUTTON_STYLE = {
        marginTop: 8,
        padding: '3px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '16px',
        cursor: 'pointer',
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
        // The manual cancel: the panel, the confirmation and its outcome.
        const [panelOpen, setPanelOpen] = useState(false)
        const [confirmOpen, setConfirmOpen] = useState(false)
        const [cancelling, setCancelling] = useState(false)
        const [cancelError, setCancelError] = useState('')
        // How many OTHER sessions still wait for the restart, as the Host
        // reported it after the cancellation (null = use the polled value).
        const [sessionsLeft, setSessionsLeft] = useState(null)
        // True after this session withdrew its own request: the capsule stays
        // until the restart is really over.
        const [withdrawn, setWithdrawn] = useState(false)
        // True when the restart this session was waiting for is GONE (nobody
        // waits for it any more): the capsule has nothing left to say.
        const [gone, setGone] = useState(false)
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

        // The panel and the confirmation never outlive the pending state.
        useEffect(() => {
          if (!pending) {
            setPanelOpen(false)
            setConfirmOpen(false)
            setCancelError('')
            setSessionsLeft(null)
            setWithdrawn(false)
            setGone(false)
          }
        }, [pending])

        // A click OUTSIDE the panel closes it (Esc does the same inside the
        // capsule). The listener only exists while the panel is open.
        useEffect(() => {
          if (!panelOpen) return undefined
          const onOutside = () => {
            setPanelOpen(false)
            setConfirmOpen(false)
          }
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          document.addEventListener('click', onOutside)
          return () => {
            if (typeof document.removeEventListener === 'function') {
              document.removeEventListener('click', onOutside)
            }
          }
        }, [panelOpen])

        if (!info || info.pendingRestart !== true) return null
        // The restart this session waited for is gone (nobody waits for it any
        // more): the capsule has nothing left to say.
        if (gone) return null

        const waiters = Array.isArray(info.waiters) ? info.waiters : []
        const key = String(sessionId)
        const waiting = waiters.some((waiter) => String(waiter) === key)
        // After this session withdrew its own request it is no longer a waiter,
        // but the restart may still be pending for the others: the capsule stays
        // until the restart is really over.
        if (!waiting && !withdrawn) return null

        const blockedBy = Array.isArray(info.blockedBy) ? info.blockedBy : []
        // The TASK of every blocker: a session and its own subagents are ONE
        // task (the sidebar counts them once). The keys are aligned with the
        // list, so the filter below can ask "is this MY task?".
        const taskKeys = blockerTaskKeys(blockedBy)
        const ownTaskKey = TASK_KEY_SESSION + key
        // The own session blocks itself — but only when it is a top-level
        // session. A subagent mounted capsule belongs to its parent's task, and
        // the parent's other work still blocks the restart.
        const ownIsTask = !blockedBy.some((entry) => (
          entry && String(entry.sessionId) === key && blockerEntryKind(entry) === 'subagent'
        ))
        // One entry per SESSION: a conversation that is running *and* still has
        // queued work is one conversation, so the pill never counts it twice.
        const seenSessions = new Set()
        const others = blockedBy.filter((entry, index) => {
          if (!entry) return false
          const id = String(entry.sessionId)
          if (id === key || seenSessions.has(id)) return false
          seenSessions.add(id)
          // The own task is not a blocker of the own capsule.
          if (ownIsTask && taskKeys[index] === ownTaskKey) return false
          return true
        })
        // A goal-driven blocker: an armed goal that keeps driving rounds by
        // itself (`goal-active`, parkable) or a goal whose round budget is used
        // up (`goal-exhausted`, not parkable at all).
        const goalActive = others.filter((entry) => String(entry.reason) === 'goal-active')
        const goalExhausted = others.filter((entry) => String(entry.reason) === 'goal-exhausted')
        // The tasks that are NOT a goal: the count and the names of the waiting
        // sentence talk about the same set.
        const busyBlockers = others.filter(
          (entry) => String(entry.reason) !== 'goal-active' && String(entry.reason) !== 'goal-exhausted',
        )
        // The count is about TASKS, not blockers: a parent session and its own
        // subagents are ONE task, exactly as the left sidebar counts them.
        const otherBusy = countBlockerTasks(busyBlockers)

        // WHY the gate is closed: the Host reports the reason next to the
        // blockers. With no blocker but the reason "settling" the restart is
        // waiting for the quiet window — not for a conversation.
        const gateReason = info && typeof info.reason === 'string' ? info.reason : ''

        // The long wait: the Host says that the restart passed the hard
        // deadline while a conversation was still running. The capsule shows one
        // more line about it — how long it has been waiting and how many tasks
        // are running.
        const longWait = formatLongWaitNoteParts(info, t)
        // The blockers of the ordinary list: the SAME rule as the long wait
        // (grouped by the session that created them).
        const blockers = summarizeBlockers(busyBlockers, { t })

        // The capsule is ONE clipped line of 22px: it holds a NUMBER and a
        // duration, never a NAME. Every name goes into the tooltip, where
        // there is room for all of them.
        //
        // A long wait says it ONCE: its own line carries the duration and the
        // count, so the ordinary "waiting for N tasks" sentence is left out —
        // it would say the same thing twice and take twice the width.
        const status = longWait.hasLongWait
          ? ''
          : goalActive.length > 0
            ? t('goalActive')
            : goalExhausted.length > 0
              ? t('goalExhausted')
              : otherBusy > 0
                ? `${t('busyPrefix')}${otherBusy}${t('busySuffix')}`
                : (gateReason === 'settling' ? t('settling') : t('idle'))

        const tooltipText = otherBusy > 0 ? t('tooltipBusy') : t('tooltip')
        // The tooltip carries the COMPLETE list of the blockers: the capsule
        // shows numbers only, the tooltip every name.
        const detail = longWait.hasLongWait
          ? longWait.full
          : (blockers.total === 0 ? '' : fill(t('blockersTitleLine'), { blockers: blockers.full }))
        const titleText = parkError
          ? fill(t('tooltipWithError'), { message: parkError })
          : (detail === '' ? tooltipText : `${tooltipText} ${detail}`)

        // The panel: how many tasks the restart waits for, and how many OTHER
        // sessions wait for the same restart. The count is about TASKS (a
        // session and its own subagents are one), like everywhere else.
        const taskCount = longWait.hasLongWait ? longWait.count : countBlockerTasks(others)
        const otherWaiters = waiters.filter((waiter) => String(waiter) !== key).length
        const sessionsWaiting = sessionsLeft === null ? otherWaiters : sessionsLeft
        // The session that asks for the cancel: without it the own request
        // cannot be identified, so nothing is sent.
        const ownSessionId = sessionId === null || sessionId === undefined ? '' : String(sessionId)

        if (pulsing) ensurePulseStyle()

        /**
         * Open the panel. A double click is only an ALIAS for it: it never
         * cancels anything.
         */
        const openPanel = (event) => {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
          setPanelOpen(true)
          setCancelError('')
        }

        /** Close the panel (and the confirmation) without cancelling. */
        const closePanel = () => {
          setPanelOpen(false)
          setConfirmOpen(false)
        }

        /** The keyboard of the capsule: Enter/Space opens the panel, Esc closes it. */
        const onPillKeyDown = (event) => {
          if (!event) return
          const pressed = event.key
          if (pressed === 'Enter' || pressed === ' ' || pressed === 'Spacebar') {
            if (typeof event.preventDefault === 'function') event.preventDefault()
            openPanel(event)
            return
          }
          if (pressed === 'Escape') {
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
            closePanel()
          }
        }

        /**
         * Withdraw THIS session's own restart request.
         *
         * The Host answers what happened: whether the restart is gone, how many
         * sessions still wait for it, and — when it did not work — WHY.
         */
        const cancelOwnRestartRequest = async () => {
          if (ownSessionId === '') {
            setCancelError(t('cancelUnknownSession'))
            return
          }
          const url = cancelUrlFor(info)
          if (url === '') {
            setCancelError(t('cancelNoRoute'))
            return
          }
          setCancelling(true)
          setCancelError('')
          try {
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: ownSessionId, scope: 'mine' }),
            })
            let body = null
            try {
              body = await response.json()
            } catch {
              body = null
            }
            if (!response.ok || !body || body.ok !== true) {
              // It did not work: the confirmation closes and the panel says
              // WHY (a silent failure would leave the user guessing).
              setConfirmOpen(false)
              setCancelError(cancelFailureText(body, t))
              return
            }
            setConfirmOpen(false)
            setWithdrawn(true)
            if (typeof body.remainingRequesters === 'number') setSessionsLeft(body.remainingRequesters)
            // The restart is gone: the capsule has nothing left to say.
            if (body.cancelled === true) {
              setGone(true)
              setPanelOpen(false)
            }
          } catch (error) {
            setCancelError(fill(t('cancelFailedWith'), { message: describeError(error) }))
          } finally {
            setCancelling(false)
          }
        }

        /** The body of the confirmation: what cancelling means, right now. */
        const confirmBody = ownSessionId === ''
          ? t('cancelConfirmUnknown')
          : sessionsWaiting > 0
            ? fill(t('cancelConfirmOthers'), { n: sessionsWaiting })
            : t('cancelConfirmOnlyMe')

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

        /**
         * The panel of the capsule: the status of the pending restart and the
         * manual way out of it. It FLOATS above the capsule (the wrapper is
         * the positioning anchor), so the composer row never grows.
         */
        const panel = panelOpen
          ? h(
            'div',
            {
              className: 'dsh-autorestart-pill-panel',
              'data-dsh-autorestart-panel': 'true',
              role: 'dialog',
              'aria-label': t('cancelPanelAria'),
              style: PANEL_STYLE,
              // A click inside the panel is not a click outside it.
              onClick: (event) => {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
              },
            },
            h('p', { style: { margin: 0 } }, fill(t('cancelPanelTasks'), { n: taskCount })),
            sessionsWaiting > 0
              ? h(
                'p',
                { style: { margin: '4px 0 0' } },
                fill(sessionsLeft === null ? t('cancelPanelOthers') : t('cancelPanelOthersAfter'), { n: sessionsWaiting }),
              )
              : null,
            ownSessionId === ''
              ? h('p', { style: { margin: '4px 0 0' } }, t('cancelUnknownSession'))
              : null,
            cancelError !== ''
              ? h(
                'p',
                { style: { margin: '4px 0 0', color: 'var(--dsw-alias-state-error, #d33)' } },
                cancelError,
              )
              : null,
            confirmOpen
              ? h(
                'div',
                {
                  className: 'dsh-autorestart-pill-confirm',
                  'data-dsh-autorestart-confirm': 'true',
                  role: 'dialog',
                  'aria-label': t('cancelConfirmTitle'),
                  style: CONFIRM_STYLE,
                },
                h('p', { style: { margin: 0, fontWeight: 600 } }, t('cancelConfirmTitle')),
                h('p', { style: { margin: '4px 0 0' } }, confirmBody),
                ownSessionId === ''
                  ? null
                  : h(
                    'div',
                    { style: { display: 'flex', gap: 8, marginTop: 8 } },
                    h(
                      'button',
                      {
                        type: 'button',
                        style: PANEL_BUTTON_STYLE,
                        title: t('cancelConfirmButtonAria'),
                        'aria-label': t('cancelConfirmButtonAria'),
                        disabled: cancelling,
                        onClick: (event) => {
                          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                          void cancelOwnRestartRequest()
                        },
                      },
                      t('cancelConfirmButton'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: PANEL_BUTTON_STYLE,
                        title: t('cancelDismissButtonAria'),
                        'aria-label': t('cancelDismissButtonAria'),
                        onClick: (event) => {
                          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                          setConfirmOpen(false)
                        },
                      },
                      t('cancelDismissButton'),
                    ),
                  ),
              )
              : h(
                'button',
                {
                  type: 'button',
                  style: PANEL_BUTTON_STYLE,
                  title: t('cancelButtonAria'),
                  'aria-label': t('cancelButtonAria'),
                  disabled: cancelling,
                  onClick: (event) => {
                    if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                    setConfirmOpen(true)
                  },
                },
                t('cancelButton'),
              ),
          )
          : null

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
              title: titleText,
              // The capsule opens the panel. A DOUBLE click is only an alias
              // for it — it never cancels anything.
              role: 'button',
              tabIndex: 0,
              'aria-haspopup': 'dialog',
              'aria-expanded': panelOpen,
              onClick: openPanel,
              onDoubleClick: openPanel,
              onKeyDown: onPillKeyDown,
            },
            h('span', { style: dotStyle(DOT_STYLE, pulsing), 'aria-hidden': 'true' }),
            h('span', { style: TEXT_STYLE }, h('b', null, t('label')), status),
            // One more line for the long wait: how long the restart has been
            // waiting and how many tasks are running. It is only there when the
            // Host says so. The line carries NO name at all — it is one
            // clipped line — and its own tooltip carries the COMPLETE list.
            longWait.pill === ''
              ? null
              : h(
                'span',
                {
                  style: LONG_WAIT_STYLE,
                  'data-dsh-autorestart-long-wait': 'true',
                  title: longWait.full,
                },
                longWait.pill,
              ),
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
          panel,
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

        // The long wait is worth a word in the tooltip too: the dot is
        // icon-only, so the text is the only place where it can be read.
        // The tooltip carries the COMPLETE list of the blockers.
        const longWait = formatLongWaitNoteParts(info, t)

        return h('span', {
          style: dotStyle(SIDEBAR_DOT_STYLE, pulsing),
          title: longWait.hasLongWait ? `${t('tooltip')} ${longWait.full}` : t('tooltip'),
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
          backupChoicePending()
            ? 'backup'
            : (sleepChoicePending() ? 'sleep' : (supervisorChoicePending(info) ? 'supervisor' : 'done')),
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
         * Hand the THIRD answer to the Host: what should happen with the
         * self-starting supervisor?
         *
         * `choice` is 'install' (the card IS the confirmation: the user just
         * read what would change), 'external' (keep the way you start it) or
         * 'dismissed' (later).
         */
        const chooseSupervisor = (choice) => {
          if (busy) return
          setBusy(true)
          setError('')
          void (async () => {
            try {
              const response = await fetch(supervisorUrlFor(info), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  action: choice === 'install' ? 'install' : 'external',
                  confirmed: true,
                  choice: choice === 'install' ? 'install' : 'external',
                }),
              })
              const body = await response.json().catch(() => null)
              if (!response.ok) {
                const message = body && typeof body === 'object' ? (body.error || String(response.status)) : String(response.status)
                setError(fill(t('supervisor.error'), { message }))
                return
              }
            } catch (failure) {
              setError(fill(t('supervisor.error'), { message: describeError(failure) }))
              return
            } finally {
              setBusy(false)
            }
            setStep('done')
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
            // The shutdown button is settled: the supervisor question may follow.
            setStep(supervisorChoicePending(info) ? 'supervisor' : 'done')
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
          // "Do not ask me again" also covers the new-feature announcement: the
          // install prompt is where the features of a fresh installation are
          // explained, so no announcement may follow it.
          void acknowledgeAnnouncement(ANNOUNCED_FEATURE).catch(() => {})
          setStep('done')
        }

        /**
         * Close the SECOND question without answering: the button stays (the
         * default) and the question is not asked again.
         */
        const dismissSleep = () => {
          if (busy) return
          writeSleepChoice('dismissed')
          void acknowledgeAnnouncement(ANNOUNCED_FEATURE).catch(() => {})
          setStep('done')
        }

        /** Esc closes the prompt (the panel itself is focusable). */
        const onKeyDown = (event) => {
          if (!event) return
          if (event.key === 'Escape' || event.key === 'Esc') {
            if (step === 'supervisor') dismissSupervisor()
            else if (step === 'sleep') dismissSleep()
            else dismissBackup()
          }
        }

        /**
         * Close the supervisor question without answering: the card does not
         * come back, and the user can install the supervisor by hand later.
         */
        const dismissSupervisor = () => {
          if (busy) return
          // "Later" is recorded, so the question is never asked again.
          void (async () => {
            try {
              await fetch(supervisorUrlFor(info), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'external', confirmed: true, choice: 'dismissed' }),
              })
            } catch {
              // The card is gone either way; the Host asks again next time.
            }
          })()
          void acknowledgeAnnouncement(ANNOUNCED_FEATURE).catch(() => {})
          setStep('done')
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

        // The THIRD question: shall the supervisor be installed?
        if (step === 'supervisor') {
          return h(
            'div',
            {
              className: 'dsh-autorestart-choice',
              role: 'status',
              'aria-live': 'polite',
              tabIndex: 0,
              onKeyDown,
              'data-dsh-autorestart-backup-choice': 'true',
              'data-dsh-autorestart-choice-step': 'supervisor',
            },
            h(
              'div',
              { className: 'dsh-autorestart-choice__head' },
              h('h3', null, t('supervisor.title')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-autorestart-choice__close',
                  'aria-label': t('backupChoiceDismissAria'),
                  title: t('backupChoiceDismissAria'),
                  disabled: busy,
                  onClick: dismissSupervisor,
                },
                '×',
              ),
            ),
            h('p', { className: 'dsh-autorestart-choice__subtitle' }, t('supervisor.body')),
            // The three things the card has to say: what it changes, which rights
            // it needs, and how to remove it again.
            h('p', { className: 'dsh-autorestart-choice__footnote' }, t('supervisor.changes')),
            h('p', { className: 'dsh-autorestart-choice__footnote' }, t('supervisor.rights')),
            h('p', { className: 'dsh-autorestart-choice__footnote' }, t('supervisor.uninstall')),
            h(
              'div',
              { className: 'dsh-autorestart-choice__options' },
              optionRow(
                'install',
                t('supervisor.install'),
                t('supervisor.installHint'),
                t('supervisor.install'),
                'primary',
                true,
                () => chooseSupervisor('install'),
                'data-supervisor-choice',
              ),
              optionRow(
                'external',
                t('supervisor.keep'),
                t('supervisor.keepHint'),
                t('supervisor.keep'),
                'secondary',
                false,
                () => chooseSupervisor('external'),
                'data-supervisor-choice',
              ),
              optionRow(
                'later',
                t('supervisor.later'),
                t('supervisor.laterHint'),
                t('supervisor.later'),
                'secondary',
                false,
                dismissSupervisor,
                'data-supervisor-choice',
              ),
            ),
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

      /**
       * Carry out one intent ('arm' or 'cancel').
       *
       * There is no ticket and no ceremony: the request carries nothing but the
       * action, so the desktop client and the hosted web client drive exactly
       * the same route.
       */
      async function driveSleep(intent) {
        return requestSleep(intent)
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
          const response = await fetch(DEFAULT_SLEEP_URL, {
            cache: 'no-store',
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
       * @returns {Promise<object>} the new sleep status
       */
      async function requestSleep(action) {
        const headers = { 'content-type': 'application/json' }
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

      /**
       * Whether the question about the self-starting supervisor may be shown.
       *
       * The HOST decides: only a HOSTED host is asked (the desktop app brings
       * itself back up, so the question would be noise there), and only while
       * the question was never answered. The Host reports it as
       * `supervisorOffer` in the state payload.
       */
      function supervisorChoicePending(info) {
        if (!info || typeof info !== 'object') return false
        return info.supervisorOffer === true
      }

      /** The route that installs, uninstalls and reports the supervisor. */
      function supervisorUrlFor(info) {
        const sent = info && typeof info.supervisorUrl === 'string' ? info.supervisorUrl.trim() : ''
        if (sent.startsWith('/')) return sent
        return DEFAULT_SUPERVISOR_URL
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
        // The line that says how many blockers are NOT shown: it is a note,
        // not a blocker of its own.
        '.dsh-autorestart-sleep-waiting__more{opacity:.7;}',
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
        // The configuration page of the plugin row.
        '.dsh-autorestart-settings{display:flex;flex-direction:column;gap:14px;}',
        // The two titled groups (restart first, shutdown after it).
        '.dsh-autorestart-settings__group{',
        '  display:flex;',
        '  flex-direction:column;',
        '  gap:12px;',
        '  padding:12px 14px;',
        '  border:1px solid var(--dsw-alias-border-l1);',
        '  border-radius:10px;',
        '}',
        '.dsh-autorestart-settings__group-title{',
        '  font-size:12px;',
        '  font-weight:700;',
        '  line-height:18px;',
        '  color:var(--dsw-alias-label-secondary);',
        '}',
        '.dsh-autorestart-settings__field{display:flex;flex-direction:column;gap:4px;}',
        '.dsh-autorestart-settings__label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}',
        '.dsh-autorestart-settings__select{',
        '  min-height:30px;',
        '  padding:4px 8px;',
        '  border:1px solid var(--dsw-alias-border-l1);',
        '  border-radius:8px;',
        '  background:var(--dsw-alias-bg-layer-2,transparent);',
        '  color:var(--dsw-alias-label-primary);',
        '  font:inherit;',
        '  font-size:13px;',
        '}',
        '.dsh-autorestart-settings__hint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);}',
        // The two backup switches.
        '.dsh-autorestart-settings__switch{',
        '  width:16px;',
        '  height:16px;',
        '  margin:0;',
        '  accent-color:var(--dsw-alias-brand-primary,#4d6bfe);',
        '  cursor:pointer;',
        '}',
        '.dsh-autorestart-settings__switch:disabled{cursor:not-allowed;opacity:.5;}',
        '.dsh-autorestart-settings__error{',
        '  margin:0;',
        '  color:var(--dsw-alias-danger,#d14343);',
        '  font-size:12.5px;',
        '  line-height:18px;',
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
      /**
       * The settings section of the plugin (the "Auto-restart & shut down" entry
       * in the settings sidebar).
       *
       * The Host renders this section for the slot `settings.section` with the
       * id `dsh-autorestart`. The settings are split into two titled groups:
       *
       *   - "Restart settings": how long the host waits before a restart (a
       *     dropdown), whether the pre-restart backup is taken at all (a
       *     switch) and whether that backup also snapshots the installed
       *     plugins (a switch);
       *   - "Shutdown settings": how long the visible countdown of the
       *     graceful shutdown runs (a dropdown).
       *
       * The restart group comes first. The shutdown has no invisible reserve:
       * its countdown on screen IS the wait before the machine goes off.
       *
       * A change is written to the profile configuration at once (through the
       * plugin's own choice route, which uses the official `configEditor`
       * service), and the section reads the new values back from the Host.
       *
       * @param {object} props the Host's props: `t` (the translator of the
       *   registered locale, injected by the section registration)
       */
      function AutorestartSection(props) {
        const status = useSleepStatus()
        const info = useSharedInfo(true)
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState('')
        // The dry run of the restart command (null = not derived yet).
        const [dryRun, setDryRun] = useState(null)
        const t = props && typeof props.t === 'function'
          ? props.t
          : (translate ?? ((name) => name))

        // The current values come from the Host, so the panel always shows what
        // is really in effect.
        const reported = status && typeof status === 'object' && typeof status.countdownSeconds === 'number'
          ? status.countdownSeconds
          : SLEEP_DEFAULT_COUNTDOWN_SECONDS
        const seconds = SLEEP_COUNTDOWN_CHOICES.indexOf(reported) === -1
          ? SLEEP_DEFAULT_COUNTDOWN_SECONDS
          : reported
        // The two backup switches: the Host says what is in effect.
        const backupOnRestart = status && typeof status === 'object' && typeof status.backupOnRestart === 'boolean'
          ? status.backupOnRestart
          : true
        const backupIncludePlugins = status && typeof status === 'object' && typeof status.backupIncludePlugins === 'boolean'
          ? status.backupIncludePlugins
          : true
        // The RESTART reserve: the Host reports it in milliseconds, the
        // dropdown works in seconds.
        const reportedRestartGraceMs = status && typeof status === 'object' && typeof status.restartGraceMs === 'number'
          ? status.restartGraceMs
          : GRACE_DEFAULT_MS
        const restartGraceSeconds = GRACE_CHOICES_SECONDS.indexOf(Math.round(reportedRestartGraceMs / 1000)) === -1
          ? GRACE_DEFAULT_SECONDS
          : Math.round(reportedRestartGraceMs / 1000)

        // THE SUPERVISOR: who starts this host, and can the restart work at all.
        // The Host reports it in the state payload.
        const supervisorStatus = info && typeof info === 'object' && info.supervisor && typeof info.supervisor === 'object'
          ? info.supervisor
          : null
        // HOW this host was started (the startup matrix): the mode, the
        // evidence the verdict rests on, and what the plugin may do about it.
        const supervisorStartup = supervisorStatus !== null
          && supervisorStatus.startup !== null
          && typeof supervisorStatus.startup === 'object'
          ? supervisorStatus.startup
          : null
        // THE PLATFORM GUIDE: how "start at login" works here (Windows /
        // Linux / WSL / container) and the commands the user can copy.
        const supervisorAutostart = supervisorStatus !== null
          && supervisorStatus.autostart !== null
          && typeof supervisorStatus.autostart === 'object'
          ? supervisorStatus.autostart
          : null
        const supervisorInstalled = supervisorStatus !== null && supervisorStatus.installed === true
        // WHICH END IS THIS? The same browser side serves the desktop app and
        // the hosted web host, so it may not assume one of them. The Host says
        // which one it is; when it does not say, the panel stays neutral.
        const hostIsDesktop = info && typeof info === 'object' && info.instance && typeof info.instance === 'object'
          ? info.instance.isDesktopApp === true
          : false
        const supervisorMode = supervisorStatus !== null && typeof supervisorStatus.mode === 'string'
          ? supervisorStatus.mode
          : ''
        // The install button is only offered where it makes sense: the desktop
        // app brings itself back up (there is nothing to install there), and a
        // host that somebody ELSE supervises must not get a second supervisor
        // (they would both start the host and fight over the port).
        const supervisorCanInstall = canOfferSupervisorInstall(supervisorStatus, info && info.instance)
        const supervisorNoInstall = hostIsDesktop
          ? 'settings.supervisor.noInstallDesktop'
          : (supervisorMode === 'external'
            ? 'settings.supervisor.noInstallExternal'
            : 'settings.supervisor.noInstallUnknown')
        const accessUrl = info && typeof info === 'object' && typeof info.accessUrl === 'string' ? info.accessUrl : ''
        const supervisorPending = supervisorStatus !== null
          && supervisorStatus.detail !== null
          && typeof supervisorStatus.detail === 'object'
          && Array.isArray(supervisorStatus.detail.pendingCommands)
          && supervisorStatus.detail.pendingCommands.length > 0
          ? supervisorStatus.detail.pendingCommands.join('   ;   ')
          : ''

        /**
         * Install or uninstall the supervisor.
         *
         * The button IS the confirmation: the user pressed it, so the request
         * carries `confirmed: true`. Without it the Host refuses to touch the
         * machine.
         */
        const driveSupervisor = async (action) => {
          if (busy) return
          setBusy(true)
          setError('')
          try {
            const response = await fetch(supervisorUrlFor(info), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action, confirmed: true }),
            })
            const body = await response.json().catch(() => null)
            if (!response.ok) {
              const message = body && typeof body === 'object'
                ? (body.error || String(response.status))
                : String(response.status)
              setError(fill(t('supervisor.error'), { message }))
              return
            }
          } catch (failure) {
            setError(fill(t('supervisor.error'), { message: describeError(failure) }))
          } finally {
            setBusy(false)
          }
        }

        /**
         * E + B: derive the restart command and show it (the dry run).
         *
         * The dry run writes NOTHING. Only the "use this command" button sends
         * the confirmation, and only then does the Host write the command into
         * the profile configuration.
         */
        const driveDryRun = async (action) => {
          if (busy) return
          setBusy(true)
          setError('')
          try {
            const response = await fetch(supervisorUrlFor(info), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action, confirmed: action !== 'dry-run' }),
            })
            const body = await response.json().catch(() => null)
            if (!response.ok) {
              const message = body && typeof body === 'object'
                ? (body.error || String(response.status))
                : String(response.status)
              setError(fill(t('supervisor.error'), { message }))
              return
            }
            if (action === 'dry-run') {
              setDryRun(body && typeof body.plan === 'object' ? body.plan : null)
            } else {
              // The command was written (or the undo ran): the preview is stale.
              setDryRun(null)
            }
          } catch (failure) {
            setError(fill(t('supervisor.error'), { message: describeError(failure) }))
          } finally {
            setBusy(false)
          }
        }

        /**
         * Write one change into the profile configuration.
         *
         * The Host answers with the effective values, and the panel reads them
         * back with a fresh poll — so the controls never show a value the
         * Host did not take.
         *
         * @param {object} changes the keys to write
         */
        const save = async (changes) => {
          if (busy) return
          setBusy(true)
          setError('')
          try {
            const response = await fetch(choiceUrlFor(info), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(changes),
            })
            const body = await response.json().catch(() => null)
            if (!response.ok) {
              const message = body && typeof body === 'object'
                ? (body.message || body.error || String(response.status))
                : String(response.status)
              setError(fill(t('settings.error'), { message }))
              return
            }
            // Read the new values back from the Host.
            await pollSleepOnce()
          } catch (failure) {
            setError(fill(t('settings.error'), { message: describeError(failure) }))
          } finally {
            setBusy(false)
          }
        }

        ensureSleepStyle()

        return h(
          'div',
          { className: 'dsh-autorestart-settings' },
          // The panel is split into two titled groups: the RESTART settings
          // come first, the SHUTDOWN settings after them. The two situations
          // are different, so they do not share one flat list.
          h(
            'div',
            {
              className: 'dsh-autorestart-settings__group',
              'data-dsh-autorestart-group': 'restart',
            },
            h(
              'div',
              { className: 'dsh-autorestart-settings__group-title' },
              t('settings.groups.restart'),
            ),
            h(
              'label',
              { className: 'dsh-autorestart-settings__field' },
              h('span', { className: 'dsh-autorestart-settings__label' }, t('settings.restartGrace.label')),
              h(
                'select',
                {
                  className: 'dsh-autorestart-settings__select',
                  value: String(restartGraceSeconds),
                  disabled: busy,
                  'data-dsh-autorestart-setting': 'restartGraceMs',
                  onChange: (event) => {
                    const value = Number(event && event.target ? event.target.value : NaN)
                    if (!Number.isFinite(value) || value === restartGraceSeconds) return
                    void save({ restartGraceMs: value * 1000 })
                  },
                },
                GRACE_CHOICES_SECONDS.map((choice) => h(
                  'option',
                  { key: String(choice), value: String(choice) },
                  choice === 0
                    ? t('settings.restartGrace.immediate')
                    : fill(t('settings.restartGrace.value'), { n: choice }),
                )),
              ),
              h('span', { className: 'dsh-autorestart-settings__hint' }, t('settings.restartGrace.hint')),
            ),
            h(
              'label',
              { className: 'dsh-autorestart-settings__field' },
              h('span', { className: 'dsh-autorestart-settings__label' }, t('settings.backup.label')),
              h(
                'input',
                {
                  type: 'checkbox',
                  className: 'dsh-autorestart-settings__switch',
                  checked: backupOnRestart,
                  disabled: busy,
                  'data-dsh-autorestart-setting': 'backupOnRestart',
                  onChange: (event) => {
                    const value = Boolean(event && event.target ? event.target.checked : false)
                    if (value === backupOnRestart) return
                    void save({ backupOnRestart: value })
                  },
                },
              ),
              h('span', { className: 'dsh-autorestart-settings__hint' }, t('settings.backup.hint')),
            ),
            h(
              'label',
              { className: 'dsh-autorestart-settings__field' },
              h('span', { className: 'dsh-autorestart-settings__label' }, t('settings.backupPlugins.label')),
              h(
                'input',
                {
                  type: 'checkbox',
                  className: 'dsh-autorestart-settings__switch',
                  checked: backupIncludePlugins,
                  // Without a pre-restart backup there is nothing to extend: the
                  // switch is greyed out (and the Host never reads it).
                  disabled: busy || !backupOnRestart,
                  'data-dsh-autorestart-setting': 'backupIncludePlugins',
                  onChange: (event) => {
                    const value = Boolean(event && event.target ? event.target.checked : false)
                    if (value === backupIncludePlugins) return
                    void save({ backupIncludePlugins: value })
                  },
                },
              ),
              h('span', { className: 'dsh-autorestart-settings__hint' }, t('settings.backupPlugins.hint')),
            ),
          ),
          h(
            'div',
            {
              className: 'dsh-autorestart-settings__group',
              'data-dsh-autorestart-group': 'shutdown',
            },
            h(
              'div',
              { className: 'dsh-autorestart-settings__group-title' },
              t('settings.groups.shutdown'),
            ),
            h(
              'label',
              { className: 'dsh-autorestart-settings__field' },
              h('span', { className: 'dsh-autorestart-settings__label' }, t('settings.seconds.label')),
              h(
                'select',
                {
                  className: 'dsh-autorestart-settings__select',
                  value: String(seconds),
                  disabled: busy,
                  'data-dsh-autorestart-setting': 'sleepCountdownSeconds',
                  onChange: (event) => {
                    const value = Number(event && event.target ? event.target.value : NaN)
                    if (!Number.isFinite(value) || value === seconds) return
                    void save({ sleepCountdownSeconds: value })
                  },
                },
                SLEEP_COUNTDOWN_CHOICES.map((choice) => h(
                  'option',
                  { key: String(choice), value: String(choice) },
                  choice === 0 ? t('settings.seconds.immediate') : fill(t('settings.seconds.value'), { n: choice }),
                )),
              ),
              h('span', { className: 'dsh-autorestart-settings__hint' }, t('settings.seconds.hint')),
            ),
          ),
          // The SUPERVISOR group: who starts this host, and whether the restart
          // can work at all.
          h(
            'div',
            {
              className: 'dsh-autorestart-settings__group',
              'data-dsh-autorestart-group': 'supervisor',
            },
            h(
              'div',
              { className: 'dsh-autorestart-settings__group-title' },
              t('settings.groups.supervisor'),
            ),
            h(
              'div',
              { className: 'dsh-autorestart-settings__field' },
              h(
                'span',
                { className: 'dsh-autorestart-settings__label' },
                t('settings.supervisor.status'),
              ),
              h(
                'span',
                { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-supervisor': 'mode' },
                supervisorModeLabel(t, supervisorStatus),
              ),
              h(
                'span',
                { className: 'dsh-autorestart-settings__hint' },
                t('settings.supervisor.hint'),
              ),
            ),
            h(
              'div',
              { className: 'dsh-autorestart-settings__field' },
              h(
                'span',
                { className: 'dsh-autorestart-settings__label' },
                t('settings.supervisor.capable'),
              ),
              h(
                'span',
                { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-supervisor': 'capable' },
                supervisorStatus && supervisorStatus.restartCapable === true
                  ? t('settings.supervisor.capableYes')
                  : t('settings.supervisor.capableNo'),
              ),
            ),
            supervisorStartup !== null
              ? h(
                  'div',
                  { className: 'dsh-autorestart-settings__field' },
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__label' },
                    t('settings.supervisor.startup'),
                  ),
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-supervisor': 'startup' },
                    startupModeLabel(t, supervisorStartup),
                  ),
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__hint' },
                    supervisorStartup.evidence + (supervisorStartup.suggestion !== '' ? ' — ' + supervisorStartup.suggestion : ''),
                  ),
                )
              : null,
            supervisorAutostart !== null
              ? h(
                  'div',
                  { className: 'dsh-autorestart-settings__field' },
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__label' },
                    t('settings.supervisor.autostart'),
                  ),
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-supervisor': 'autostart' },
                    supervisorAutostart.kind,
                  ),
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__hint' },
                    supervisorAutostart.reason,
                  ),
                  supervisorAutostart.commands.length > 0
                    ? h(
                        'span',
                        { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-supervisor': 'autostart-commands' },
                        supervisorAutostart.commands.join('   ;   '),
                      )
                    : null,
                )
              : null,
            supervisorInstalled || supervisorCanInstall
              ? h(
                  'div',
                  { className: 'dsh-autorestart-settings__field' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-autorestart-settings__button',
                      disabled: busy,
                      'data-dsh-autorestart-supervisor': supervisorInstalled ? 'uninstall' : 'install',
                      onClick: () => void driveSupervisor(supervisorInstalled ? 'uninstall' : 'install'),
                    },
                    supervisorInstalled ? t('settings.supervisor.uninstall') : t('settings.supervisor.install'),
                  ),
                  supervisorPending
                    ? h(
                        'span',
                        { className: 'dsh-autorestart-settings__hint' },
                        fill(t('settings.supervisor.pending'), { commands: supervisorPending }),
                      )
                    : null,
                )
              : h(
                  'div',
                  { className: 'dsh-autorestart-settings__field' },
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-supervisor': 'no-install' },
                    t(supervisorNoInstall),
                  ),
                ),
            accessUrl
              ? h(
                  'div',
                  { className: 'dsh-autorestart-settings__field' },
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__label' },
                    t('settings.supervisor.access'),
                  ),
                  h(
                    'code',
                    { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-access': 'url' },
                    accessUrl,
                  ),
                  h(
                    'span',
                    { className: 'dsh-autorestart-settings__hint' },
                    t('settings.supervisor.accessHint'),
                  ),
                )
              : null,
            // E + B: the derived restart command. The dry run shows it; only
            // the "use this command" button writes it into the configuration.
            h(
              'div',
              { className: 'dsh-autorestart-settings__field' },
              h(
                'span',
                { className: 'dsh-autorestart-settings__label' },
                t('settings.supervisor.command'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-autorestart-settings__button',
                  disabled: busy,
                  'data-dsh-autorestart-supervisor': 'derive',
                  onClick: () => void driveDryRun('dry-run'),
                },
                t('settings.supervisor.derive'),
              ),
              dryRun
                ? h(
                    'div',
                    { className: 'dsh-autorestart-settings__dry-run', 'data-dsh-autorestart-dry-run': 'true' },
                    h(
                      'span',
                      { className: 'dsh-autorestart-settings__hint' },
                      t('settings.supervisor.plan'),
                    ),
                    h(
                      'code',
                      { className: 'dsh-autorestart-settings__value', 'data-dsh-autorestart-dry-run': 'command' },
                      dryRun.command || t('settings.supervisor.noCommand'),
                    ),
                    h(
                      'span',
                      { className: 'dsh-autorestart-settings__hint', 'data-dsh-autorestart-dry-run': 'reason' },
                      t('settings.supervisor.reason.' + (dryRun.reason || 'ok')),
                    ),
                    dryRun.ok
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-autorestart-settings__button',
                            disabled: busy,
                            'data-dsh-autorestart-supervisor': 'apply',
                            onClick: () => void driveDryRun('apply'),
                          },
                          t('settings.supervisor.apply'),
                        )
                      : null,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-autorestart-settings__button',
                        disabled: busy,
                        'data-dsh-autorestart-supervisor': 'revert',
                        onClick: () => void driveDryRun('revert'),
                      },
                      t('settings.supervisor.revert'),
                    ),
                  )
                : null,
            ),
          ),
          error === ''
            ? null
            : h('p', { className: 'dsh-autorestart-settings__error', role: 'alert' }, error),
        )
      }

      function SleepButton(props) {
        const status = useSleepStatus()
        const [arming, setArming] = useState(false)
        const [error, setError] = useState('')
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
         * That is all a click does: the Host arms the shutdown, waits for the
         * busy conversations and counts down. Clicking again (or the cancel
         * button on the card) takes it back.
         */
        const arm = async () => {
          if (arming) return
          setArming(true)
          setError('')
          try {
            await driveSleep('arm')
          } catch (failure) {
            setError(fill(t('sleep.error'), { message: describeError(failure) }))
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
            await driveSleep('cancel')
          } catch (failure) {
            setError(fill(t('sleep.error'), { message: describeError(failure) }))
          } finally {
            setArming(false)
          }
        }

        /**
         * The click itself is the action: the moon button arms the shutdown,
         * and while it is armed the same button cancels it again.
         *
         * @param {object} event the DOM event of the click
         */
        const handleClick = (event) => {
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

        // A refused request is never silent: the reason is written under the
        // button.
        if (!wide || error === '') return button
        return h(
          'div',
          { className: 'dsh-autorestart-sleep-button__wrap' },
          button,
          h(
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
            const body = await driveSleep('cancel')
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
          // A pending restart is not a task: it is what the shutdown waits for,
          // so it is never counted as one.
          const tasks = blockers.filter((entry) => !isRestartPending(entry))
          // The count is about TASKS, not blockers: a session and its own
          // subagents are ONE task, exactly as the left sidebar counts them.
          const taskCount = countBlockerTasks(tasks)
          // How many of the tasks are carried by SUBAGENTS ONLY: the session
          // itself is idle, one of its subagents works. The card says so, so the
          // count is not read as "that many conversations".
          const subagentCount = countSubagentTasks(tasks)
          // The list of the card: the SAME rule as the bubble (the subagents of
          // one session are one item, the list is capped), so a team of a dozen
          // members does not become a dozen lines.
          const pending = blockers.filter((entry) => isRestartPending(entry))
          const grouped = summarizeBlockers(tasks, { t })
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
              ? h(
                'p',
                { className: 'dsh-autorestart-sleep-waiting__none' },
                // The Host's own message explains WHY the machine waits (the
                // grace window for work this plugin cannot see); the generic
                // line is only the fallback.
                typeof status.message === 'string' && status.message !== ''
                  ? status.message
                  : t('sleep.waiting.none'),
              )
              : h(
                'ul',
                {
                  className: 'dsh-autorestart-sleep-waiting__list',
                  // The tooltip carries the COMPLETE list: the card itself
                  // shows a short one (the same rule as the bubble).
                  title: grouped.full,
                },
                grouped.groups.slice(0, BLOCKER_SUMMARY_LIMIT).map((group, index) => h(
                  'li',
                  { key: 'blocker-' + index },
                  blockerGroupLine(group),
                )),
                grouped.groups.length > BLOCKER_SUMMARY_LIMIT
                  ? h(
                    'li',
                    { key: 'blocker-more', className: 'dsh-autorestart-sleep-waiting__more' },
                    fill(t('blockerMore'), { n: grouped.groups.length - BLOCKER_SUMMARY_LIMIT }),
                  )
                  : null,
                // A pending restart is not a task: it is what the shutdown waits
                // for, so it is never part of the grouped list.
                pending.map((entry, index) => h(
                  'li',
                  { key: 'pending-' + index },
                  blockerLine(entry),
                )),
              ),
            h('p', { className: 'dsh-autorestart-sleep-waiting__count' }, tasks.length === 0
              ? null
              : fill(t('sleep.waiting.count'), { n: taskCount })),
            subagentCount === 0
              ? null
              : h(
                'p',
                { className: 'dsh-autorestart-sleep-waiting__subagents' },
                fill(t('sleep.waiting.subagents'), { k: subagentCount }),
              ),
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

      /* ------------------------------------------------------------------ *
       * The one-time announcement of a new feature.
       * ------------------------------------------------------------------ */

      // The route that reports the announcements the user has not seen yet and
      // records that it saw one. It is a sibling of the health route and shares
      // its prefix, so it is derived the very same way.
      const DEFAULT_ANNOUNCEMENTS_URL = ROUTE_PREFIX + '/announcements'

      // The feature this client half can describe. The Host may know more
      // features, but only this one has a card here.
      const ANNOUNCED_FEATURE = 'sleep'

      /**
       * The announcements the user has not seen yet.
       *
       * @returns {Promise<{ feature: string, version: string }[]>}
       */
      async function fetchAnnouncements() {
        const response = await fetch(DEFAULT_ANNOUNCEMENTS_URL, { cache: 'no-store' })
        if (!response.ok) return []
        const body = await response.json().catch(() => null)
        if (!body || typeof body !== 'object' || !Array.isArray(body.pending)) return []
        return body.pending.filter((entry) => entry && typeof entry.feature === 'string')
      }

      /**
       * The sleep status, read ONCE for the announcement.
       *
       * The card quotes the countdown length that is really in effect (it is
       * never written into the copy) and says whether the moon button is
       * switched on.
       *
       * @returns {Promise<object|null>}
       */
      async function fetchSleepStatusOnce() {
        try {
          const response = await fetch(DEFAULT_SLEEP_URL, { cache: 'no-store' })
          if (!response.ok) return null
          const body = await response.json().catch(() => null)
          return body && typeof body === 'object' ? body : null
        } catch {
          return null
        }
      }

      /**
       * Tell the Host that the user has seen the announcement of a feature.
       *
       * @param {string} feature
       * @returns {Promise<boolean>} true when the Host recorded it
       */
      async function acknowledgeAnnouncement(feature) {
        const response = await fetch(DEFAULT_ANNOUNCEMENTS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ feature }),
        })
        return response.ok === true
      }

      // The look of the card follows the install prompt: one heading, three
      // lines of copy and one button. Only theme tokens are used, so light and
      // dark themes both work.
      const ANNOUNCEMENT_STYLE_ID = 'dsh-autorestart-announcement'
      const ANNOUNCEMENT_CSS = [
        '.dsh-autorestart-announcement{',
        '  display:flex;',
        '  flex-direction:column;',
        '  gap:6px;',
        '  width:min(560px,94vw);',
        '  max-width:100%;',
        '  box-sizing:border-box;',
        '  margin:0 0 6px;',
        '  padding:14px 16px;',
        '  border:1px solid var(--dsw-alias-border-l1);',
        '  border-radius:12px;',
        '  background:var(--dsw-alias-bg-layer-1);',
        '  box-shadow:0 8px 24px color-mix(in srgb, var(--dsw-alias-bg-mask-3) 20%, transparent);',
        '  color:var(--dsw-alias-label-secondary);',
        '  font-size:13px;',
        '  line-height:18px;',
        '}',
        '.dsh-autorestart-announcement h3{',
        '  margin:0;',
        '  font-size:14px;',
        '  font-weight:600;',
        '  line-height:20px;',
        '  color:var(--dsw-alias-label-primary);',
        '}',
        '.dsh-autorestart-announcement p{margin:0;}',
        '.dsh-autorestart-announcement__note{',
        '  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));',
        '}',
        '.dsh-autorestart-announcement__error{',
        '  color:var(--dsw-alias-state-error-fg,var(--dsw-alias-label-secondary));',
        '}',
        '.dsh-autorestart-announcement__cta{',
        '  align-self:flex-start;',
        '  margin-top:4px;',
        '  padding:5px 14px;',
        '  border:none;',
        '  border-radius:var(--dsw-radius-md,8px);',
        '  background:var(--dsw-alias-brand-primary,#5b8def);',
        '  color:var(--dsw-alias-label-on-primary,#fff);',
        '  font:inherit;',
        '  font-size:13px;',
        '  line-height:20px;',
        '  cursor:pointer;',
        '}',
        '.dsh-autorestart-announcement__cta:disabled{',
        '  opacity:.6;',
        '  cursor:default;',
        '}',
        '.dsh-autorestart-announcement__cta:focus-visible{',
        '  outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));',
        '  outline-offset:2px;',
        '}',
      ].join('\n')

      /**
       * Inject the announcement styles exactly once. The id keeps a second
       * injection from duplicating the rule.
       */
      function ensureAnnouncementStyle() {
        if (typeof document === 'undefined' || !document.head) return
        try {
          if (document.getElementById(ANNOUNCEMENT_STYLE_ID)) return
          const style = document.createElement('style')
          style.id = ANNOUNCEMENT_STYLE_ID
          style.textContent = ANNOUNCEMENT_CSS
          document.head.appendChild(style)
        } catch {
          // Without the stylesheet the card is still readable, just plainer.
        }
      }

      /**
       * The one-time card that announces a new feature.
       *
       * The install prompt only ever reaches a FRESH installation, so an
       * installation that already existed would never learn about the new moon
       * button — the feature would simply not exist for it. This card is that
       * missing half: the Host reports the announcements the user has not seen
       * yet, and the card disappears for good when the user presses "知道了".
       *
       * It is an ordinary block in the composer dock (the same place as the
       * install prompt): it never covers the interface, it never touches the
       * countdown, and it stays until the user answers it. An unanswered
       * announcement comes back with the next start — it is never swallowed
       * silently.
       */
      function FeatureAnnouncementPanel() {
        const [state, setState] = useState({ loaded: false, pending: [], status: null, error: '' })
        const [busy, setBusy] = useState(false)
        const t = translate ?? ((name) => name)

        useEffect(() => {
          let cancelled = false
          // The install prompt owns the dock while it is unanswered: a fresh
          // installation must never get two prompts at once.
          if (backupChoicePending() || sleepChoicePending()) return undefined
          const load = async () => {
            let pending = []
            let status = null
            try {
              const [announced, sleepStatus] = await Promise.all([
                fetchAnnouncements(),
                fetchSleepStatusOnce(),
              ])
              pending = announced
              status = sleepStatus
            } catch {
              // A failed request shows nothing: the announcement comes back
              // with the next start (it is never swallowed silently).
            }
            if (cancelled) return
            setState({ loaded: true, pending, status, error: '' })
          }
          void load()
          return () => { cancelled = true }
        }, [])

        /**
         * The "知道了" button: the Host records the announcement and the card
         * disappears. A refused request keeps the card (with the reason), so
         * the announcement is never lost.
         */
        const acknowledge = () => {
          if (busy) return
          setBusy(true)
          setState((current) => ({ ...current, error: '' }))
          void (async () => {
            try {
              const recorded = await acknowledgeAnnouncement(ANNOUNCED_FEATURE)
              if (!recorded) throw new Error('the Host refused the announcement')
            } catch (failure) {
              setBusy(false)
              setState((current) => ({
                ...current,
                error: fill(t('announcement.error'), { message: describeError(failure) }),
              }))
              return
            }
            setBusy(false)
            setState((current) => ({
              ...current,
              pending: current.pending.filter((entry) => entry.feature !== ANNOUNCED_FEATURE),
            }))
          })()
        }

        if (!state.loaded) return null
        const entry = state.pending.find((item) => item && item.feature === ANNOUNCED_FEATURE)
        if (!entry) return null

        // The countdown length is read from the Host, never written into the
        // copy: the card always quotes what is really in effect.
        const seconds = state.status && typeof state.status.countdownSeconds === 'number'
          ? state.status.countdownSeconds
          : null
        const hidden = Boolean(state.status && state.status.showSleepButton === false)
        ensureAnnouncementStyle()

        return h(
          'div',
          {
            className: 'dsh-autorestart-announcement',
            role: 'status',
            'data-dsh-autorestart-announcement': 'true',
            'data-dsh-autorestart-announcement-feature': ANNOUNCED_FEATURE,
          },
          h('h3', { className: 'dsh-autorestart-announcement__title' }, t('announcement.title')),
          h('p', { className: 'dsh-autorestart-announcement__line' }, t('announcement.line1')),
          h(
            'p',
            { className: 'dsh-autorestart-announcement__line' },
            seconds === null
              ? t('announcement.line2.generic')
              : fill(t('announcement.line2'), { n: seconds }),
          ),
          h('p', { className: 'dsh-autorestart-announcement__line' }, t('announcement.line3')),
          hidden
            ? h('p', { className: 'dsh-autorestart-announcement__note' }, t('announcement.disabled'))
            : null,
          state.error === ''
            ? null
            : h('p', { className: 'dsh-autorestart-announcement__error', role: 'alert' }, state.error),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-autorestart-announcement__cta',
              'data-dsh-autorestart-announcement-ack': 'true',
              disabled: busy,
              onClick: acknowledge,
            },
            t('announcement.button'),
          ),
        )
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
          // The one-time announcement of a new feature: the install prompt only
          // reaches a fresh installation, so an installation that already
          // existed would never hear of a new feature. The card sits in the
          // same dock (it never covers the interface and never touches the
          // countdown) and disappears for good once the user answered it.
          ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'autorestart-feature-announcement', order: 8, locale: NS }, FeatureAnnouncementPanel))
          // The graceful-shutdown button: a LIST slot at the foot of the left
          // sidebar, beside the Settings row. The slot is a ROOT slot, so the
          // button is there even when no conversation is open — and the
          // sidebar hands the column state to it, so the collapsed rail shows
          // the icon only.
          ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'autorestart-sleep-button', order: 10, locale: NS }, SleepButton))
          // The settings section of the plugin: an entry of its own in the
          // settings sidebar ("Auto-restart & shut down"), right below the
          // Agent presets. The three controls live inside it, so the user does
          // not have to dig through the plugin details.
          //
          // The order is computed at registration time: right after
          // `agent-presets` when that section exists, otherwise after the
          // sections that are registered already; 1000 when there is none.
          // That is "naturally last" without hard-coding a number.
          ctx.slots.inject('settings.section', function* () {
            const existing = ctx.slots.entries('settings.section')
            const agentPresets = existing.find((entry) => entry.options.id === 'agent-presets')
            const maxOrder = existing.reduce((max, entry) => Math.max(max, entry.options.order ?? 0), 0)
            const order = agentPresets !== undefined
              ? (agentPresets.options.order ?? 0) + 1
              : existing.length > 0
                ? maxOrder + 1
                : 1000
            yield ctx.slots.register({
              name: 'settings.section',
              id: 'dsh-autorestart',
              order,
              label: () => t('nav'),
              locale: NS,
              inject: () => ({ t }),
            }, AutorestartSection)
          })
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

})()
