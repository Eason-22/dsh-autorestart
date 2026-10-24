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
 */
window.__ModuleLoader__.load({
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
      tooltipWithError: '等待其他会话空闲后自动重启；重启后会自动继续本会话进度。{message}',
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
    }

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
      },
    }
  },
})
