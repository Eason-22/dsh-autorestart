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
      tooltip: '等待其他会话空闲后自动重启；重启后会自动继续本会话进度',
      dotAria: '待重启',
      panelHeading: '待重启',
      panelStateBusy: '等待其他会话空闲后重启',
      panelStateIdle: '等待空闲窗口后重启',
      panelBlockedTitle: '占用会话：{title}',
      panelBlockedGeneric: '有一个会话正在运行',
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
      tooltip:
        'Waits for the other sessions to become idle, then restarts automatically; this session resumes its progress after the restart.',
      dotAria: 'Pending restart',
      panelHeading: 'Pending restart',
      panelStateBusy: 'Waiting for the other sessions to become idle',
      panelStateIdle: 'Waiting for the idle window',
      panelBlockedTitle: 'Blocking session: {title}',
      panelBlockedGeneric: 'One session is running',
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

    /**
     * One compact pill in the composer tool row, visible only while THIS
     * session is waiting for a pending restart. Clicking it (or pressing
     * Enter / Space) opens the details panel. Single root element.
     */
    function RestartPill(props) {
      const sessionId = props && props.sessionId !== undefined ? props.sessionId : null
      const hasSession = sessionId !== null && sessionId !== ''
      const info = useSharedInfo(hasSession)
      const [open, setOpen] = useState(false)
      const [, setTick] = useState(0)
      const wrapperRef = useRef(null)

      const pending = Boolean(info && info.pendingRestart === true)
      // The restart is imminent: the Host's idle gate is open, so the restart
      // happens as soon as this poll cycle ends.
      const pulsing = pending && Boolean(info.allowRestart === true) && !prefersReducedMotion()

      // The panel never outlives the pending state.
      useEffect(() => {
        if (!pending) setOpen(false)
      }, [pending])

      // Clicking outside the panel or pressing Escape closes it. Both
      // listeners are removed when the panel closes and on unmount.
      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const node = wrapperRef.current
          if (node && event && event.target && typeof node.contains === 'function'
            && node.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event && event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      // A one-second tick keeps the "waiting for" duration in the panel fresh.
      useEffect(() => {
        if (!open) return undefined
        const timer = setInterval(() => setTick((value) => value + 1), 1000)
        return () => clearInterval(timer)
      }, [open])

      if (!info || info.pendingRestart !== true) return null

      const waiters = Array.isArray(info.waiters) ? info.waiters : []
      const key = String(sessionId)
      const waiting = waiters.some((waiter) => String(waiter) === key)
      if (!waiting) return null

      const blockedBy = Array.isArray(info.blockedBy) ? info.blockedBy : []
      const others = blockedBy.filter((entry) => entry && String(entry.sessionId) !== key)
      const otherBusy = others.length

      const t = translate ?? ((name) => name)
      const status =
        otherBusy > 0 ? `${t('busyPrefix')}${otherBusy}${t('busySuffix')}` : t('idle')

      if (pulsing) ensurePulseStyle()

      const toggle = () => setOpen((value) => !value)
      const onKeyDown = (event) => {
        if (!event) return
        const pressed = event.key
        if (pressed === 'Enter' || pressed === ' ' || pressed === 'Spacebar') {
          event.preventDefault()
          toggle()
        }
      }

      const pendingSince = stateStore.pendingSince
      const waitingMs = pendingSince === null || pendingSince === undefined
        ? 0
        : Math.max(0, Date.now() - pendingSince)

      const panelLines = [
        h('div', { key: 'heading', style: PANEL_HEADING_STYLE }, t('panelHeading')),
        h(
          'div',
          { key: 'state', style: PANEL_LINE_STYLE },
          otherBusy > 0 ? t('panelStateBusy') : t('panelStateIdle'),
        ),
      ]
      others.forEach((entry, index) => {
        const title = entry && typeof entry.title === 'string' ? entry.title.trim() : ''
        panelLines.push(h(
          'div',
          { key: 'blocked-' + index, style: PANEL_LINE_STYLE },
          title ? fill(t('panelBlockedTitle'), { title }) : t('panelBlockedGeneric'),
        ))
      })
      panelLines.push(h(
        'div',
        { key: 'waiting', style: PANEL_LINE_STYLE },
        fill(t('panelWaiting'), { duration: formatWaiting(waitingMs, t) }),
      ))
      panelLines.push(h(
        'div',
        { key: 'resume', style: PANEL_MUTED_STYLE },
        t('panelResume'),
      ))

      return h(
        'div',
        {
          ref: wrapperRef,
          style: WRAPPER_STYLE,
          role: 'status',
          'aria-live': 'polite',
        },
        h(
          'div',
          {
            style: PILL_STYLE,
            title: t('tooltip'),
            role: 'button',
            tabIndex: 0,
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            onClick: toggle,
            onKeyDown,
          },
          h('span', { style: dotStyle(DOT_STYLE, pulsing), 'aria-hidden': 'true' }),
          h('span', { style: TEXT_STYLE }, h('b', null, t('label')), status),
        ),
        open
          ? h(
            'div',
            {
              style: PANEL_STYLE,
              role: 'dialog',
              'aria-label': t('panelHeading'),
            },
            panelLines,
          )
          : null,
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
