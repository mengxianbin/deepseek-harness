/**
 * Server main-loop frame-interval pill in the settings trigger row
 * (event-loop-frame-pill-1123): the gear-adjacent glance chip carrying the
 * recent window's value plus the monitor's lamp color — the p99 wording rides
 * the hover label and aria only (2026-11-23 口径: 只去 p99 文字、数值保留) —
 * the 250ms/2000ms
 * judgments stay server-side in event-loop-monitor, this seat only renders
 * them (⛔ no threshold copy of its own). Rides the System-health card's
 * pull chain verbatim (`pullEventLoopHealth` + `HEALTH_POLL_MS`, same
 * visibility re-pull): no new cadence, no new endpoint, no second poller.
 * First pull in flight (`undefined`) paints the in-flight placeholder face
 * immediately (event-loop-pill-placeholder-1123) so a sidebar re-expand is
 * never blank for the ~1.3s the overview sweep blocks the probe; the real
 * value replaces it the moment the pull settles. Fail-soft by construction:
 * a refused or absent probe (403 fence, dead server, malformed body) settles
 * to `null` and the pill unrendered — the placeholder covers the in-flight
 * state only, so 面消失 ≠ 面变坏 holds on the refusal path, and never a
 * second red light (one fact, one lamp face).
 */
import { useEffect, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { HEALTH_POLL_MS, pullEventLoopHealth, type EventLoopStateView } from './event-loop-health.ts'
import css from './EventLoopFramePill.module.css'

/** Copy seat; the value below arrives from the shared probe pull. */
export type EventLoopFramePillProps = PropsLocale<'settings'>

/** Lamp key per probe light (the server owns these judgments, not this seat). */
const LIGHT_KEYS = {
  green: 'eventLoop.light.green',
  yellow: 'eventLoop.light.yellow',
  red: 'eventLoop.light.red',
} as const

/** Delay formatting identical to the System-health card's metric row. */
function formatDelay(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

/**
 * Render the frame-interval pill: value + lamp while the probe answers, the
 * in-flight placeholder face while the first pull has not settled (no stale
 * guess, but never blank either), and nothing at all once the probe refuses.
 * @param props - composed Settings slot copy seat.
 * @returns the pill element, or `null` when there is no face to show.
 */
export function EventLoopFramePill({ t }: EventLoopFramePillProps) {
  const [loop, setLoop] = useState<EventLoopStateView | null | undefined>(undefined)

  // Same pull lifecycle as EventLoopHealthCard: immediate pull, HEALTH_POLL_MS
  // cadence, re-pull on tab return — shared chain, zero new polling surface.
  useEffect(() => {
    let alive = true
    const pull = (): void => {
      void pullEventLoopHealth().then((next) => {
        if (alive) setLoop(next.eventLoop)
      })
    }
    pull()
    const timer = setInterval(pull, HEALTH_POLL_MS)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') pull()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // In-flight first pull: the placeholder face paints immediately and the
  // real reading replaces it the moment the pull settles (段1 立即有脸).
  // No metric key here: the merged p99-only-in-hover 口径 deleted
  // `eventLoop.pill.metric`, and the placeholder claims no value anyway.
  if (loop === undefined) {
    return (
      <span className={css.pill} data-event-loop-pill-loading aria-busy="true">
        <span className={`${css.dot} ${css.dot_loading}`} aria-hidden="true" />
        <span aria-hidden="true">…</span>
      </span>
    )
  }
  // Fail-soft: refused probe or malformed payload → no face (占位不覆盖拒答态).
  if (loop === null) return null
  const value = formatDelay(loop.p99)
  const light = t(LIGHT_KEYS[loop.light])
  return (
    <Tooltip
      label={() => `${t('eventLoop.pill.label', { value, light })} · ${t('eventLoop.pill.tooltip')}`}
      delayMs={500}
      side="top"
    >
      <span
        className={css.pill}
        data-event-loop-pill={value}
        data-light={loop.light}
        aria-label={t('eventLoop.pill.label', { value, light })}
      >
        <span className={`${css.dot} ${css[`dot_${loop.light}`] ?? ''}`} aria-hidden="true" />
        <span aria-hidden="true">{value}</span>
      </span>
    </Tooltip>
  )
}
