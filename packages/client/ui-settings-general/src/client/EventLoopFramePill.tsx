/**
 * Server main-loop frame-interval pill in the settings trigger row
 * (event-loop-frame-pill-1123): the gear-adjacent glance chip carrying the
 * recent window's p99 plus the monitor's lamp color — the 250ms/2000ms
 * judgments stay server-side in event-loop-monitor, this seat only renders
 * them (⛔ no threshold copy of its own). Rides the System-health card's
 * pull chain verbatim (`pullEventLoopHealth` + `HEALTH_POLL_MS`, same
 * visibility re-pull): no new cadence, no new endpoint, no second poller.
 * Fail-soft by construction: a refused or absent probe (403 fence, dead
 * server, malformed body) leaves the state `null` and the pill unrendered —
 * 面消失 ≠ 面变坏, and never a second red light (one fact, one lamp face).
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
 * Render the frame-interval pill: value + lamp while the probe answers,
 * nothing at all otherwise (first pull in flight included — no stale guess).
 * @param props - composed Settings slot copy seat.
 * @returns the pill element, or `null` while no fresh reading exists.
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

  // Fail-soft: no answer, refused probe, or malformed payload → no face.
  if (loop === undefined || loop === null) return null
  const value = formatDelay(loop.p99)
  const light = t(LIGHT_KEYS[loop.light])
  return (
    <Tooltip label={t('eventLoop.pill.tooltip')} delayMs={500} side="top">
      <span
        className={css.pill}
        data-event-loop-pill={value}
        data-light={loop.light}
        aria-label={t('eventLoop.pill.label', { value, light })}
      >
        <span className={`${css.dot} ${css[`dot_${loop.light}`] ?? ''}`} aria-hidden="true" />
        <span aria-hidden="true">{t('eventLoop.pill.metric')} {value}</span>
      </span>
    </Tooltip>
  )
}
