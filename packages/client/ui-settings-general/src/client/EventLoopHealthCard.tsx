/**
 * Settings "System health" card — design event-loop-monitor-1108 §四, the
 * five blocks in one column card: the metrics row + sparkline answer "is it
 * stuck now", the light gauge with its written rules answer "do I care",
 * the attribution table with the unattributed gray fallback answer "who did
 * it", the unit-scheduler contrast card answers "don't misread the queue",
 * and the event timeline answers "what happened before". Data comes from
 * the two loopback probes through {@link pullEventLoopHealth}; a refused or
 * absent probe shows the quiet unavailable line (面消失 ≠ 面变坏).
 */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  HEALTH_POLL_MS, pullEventLoopHealth,
  type EventLoopHealthSnapshot, type EventLoopStateView, type TimelineEventView,
} from './event-loop-health.ts'
import css from './EventLoopHealthCard.module.css'

/** Full Settings-row props: runtime share plus this package's dictionary. */
export type EventLoopHealthCardProps = PropsRuntime<'settings.general.item'> & PropsLocale<'settings'>

const SLICE_KEYS = {
  list: 'eventLoop.slice.list',
  migration: 'eventLoop.slice.migration',
  zstd: 'eventLoop.slice.zstd',
} as const

const LIGHT_KEYS = {
  green: 'eventLoop.light.green',
  yellow: 'eventLoop.light.yellow',
  red: 'eventLoop.light.red',
} as const

type SliceKey = (typeof SLICE_KEYS)[keyof typeof SLICE_KEYS]

/** The label for a server slice, `undefined` when this build does not know the value. */
function lookupSlice(slice: string): SliceKey | undefined {
  return SLICE_KEYS[slice as keyof typeof SLICE_KEYS]
}

/** A server slice this build does not know falls back to the list label instead of a blank cell. */
function sliceLabel(slice: string, t: EventLoopHealthCardProps['t']): string {
  return t(lookupSlice(slice) ?? 'eventLoop.slice.list')
}

/** Sparkline geometry (design: two dashed threshold lines, spike dots). */
const SPARK_WIDTH = 320
const SPARK_HEIGHT = 56
const P99_WARN_MS = 250
const MAX_BAD_MS = 2000

/** Design §二 thresholds drawn as the two dashed lines (static copy beside the gauge too). */
function formatDelay(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  return `${String(Math.floor(minutes / 60))}h`
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString()
}

/** The latency sparkline: p99 polyline over the bounded history, spike dots, two dashed thresholds. */
function Sparkline({ history }: { history: EventLoopStateView['history'] }) {
  if (history.length < 2) return null
  const points = history.slice(-60)
  const peak = Math.max(MAX_BAD_MS * 1.1, ...points.map(point => Math.max(point.p99, point.max)))
  const x = (index: number): number => (index / Math.max(1, points.length - 1)) * SPARK_WIDTH
  const y = (value: number): number => SPARK_HEIGHT - (value / peak) * SPARK_HEIGHT
  const line = points.map((point, index) => `${x(index).toFixed(1)},${y(point.max).toFixed(1)}`).join(' ')
  const spikes = points
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => point.max > MAX_BAD_MS || point.over)
  return (
    <svg
      className={css.spark} viewBox={`0 0 ${String(SPARK_WIDTH)} ${String(SPARK_HEIGHT)}`}
      role="img" aria-label="event loop delay"
    >
      <line className={css.threshold} x1="0" x2={String(SPARK_WIDTH)} y1={y(P99_WARN_MS)} y2={y(P99_WARN_MS)} />
      <line className={css.threshold} x1="0" x2={String(SPARK_WIDTH)} y1={y(MAX_BAD_MS)} y2={y(MAX_BAD_MS)} />
      <polyline className={css.sparkLine} points={line} />
      {spikes.map(({ point, index }) => (
        <circle key={point.at} className={css.spikeDot} cx={x(index)} cy={y(point.max)} r="2.5" />
      ))}
    </svg>
  )
}

/** The timeline block, newest first, bounded to the ten most recent entries. */
function Timeline({ events, t }: { events: readonly TimelineEventView[]; t: EventLoopHealthCardProps['t'] }) {
  if (events.length === 0) return <p className={css.hint}>{t('eventLoop.timelineEmpty')}</p>
  return (
    <ol className={css.timeline}>
      {[...events].reverse().slice(0, 10).map((event) => {
        const text = event.kind === 'spike'
          ? t('eventLoop.event.spike', { max: String(Math.round(event.max ?? 0)) })
          : event.kind === 'red'
            ? t('eventLoop.event.red')
            : t('eventLoop.event.recover', { duration: formatDuration(event.redMs ?? 0) })
        const attributed = event.kind === 'spike' && event.slices !== undefined && event.slices.length > 0
          ? ` · ${event.slices.map(slice => sliceLabel(slice, t)).join(' / ')}`
          : ''
        return (
          <li key={`${String(event.at)}-${event.kind}`} className={css.event}>
            <span className={css.eventTime}>{formatClock(event.at)}</span>
            <span>{text}{attributed}</span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * Render the System-health card.
 * @param props - composed Settings slot props (runtime seats unused; copy from `t`).
 * @returns the card element tree.
 */
export function EventLoopHealthCard({ t }: EventLoopHealthCardProps) {
  const [snapshot, setSnapshot] = useState<EventLoopHealthSnapshot | undefined>(undefined)
  useEffect(() => {
    let alive = true
    const pull = (): void => {
      void pullEventLoopHealth().then((next) => {
        if (alive) setSnapshot(next)
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

  // First pull still in flight: the card has nothing truthful to say yet.
  if (snapshot === undefined) return null
  const loop = snapshot.eventLoop
  const scheduler = snapshot.scheduler

  return (
    <div className={css.card}>
      <div className={css.header}>
        <span className={css.title}>{t('eventLoop.title')}</span>
        {loop !== null && <span className={css.chip}>{t('eventLoop.windowSec', { n: String(loop.windowSec) })}</span>}
      </div>

      {loop === null ? (
        <p className={css.unavailable}>{t('eventLoop.unavailable')}</p>
      ) : (
        <>
          {/* Block 1: now-stuck numbers plus the curve with both thresholds. */}
          <div className={css.metrics}>
            <span className={css.metric}><b>{formatDelay(loop.p50)}</b> p50</span>
            <span className={css.metric}><b>{formatDelay(loop.p99)}</b> p99</span>
            <span className={css.metric}><b>{formatDelay(loop.max)}</b> max</span>
            <span className={css.metric}><b>{String(Math.round(loop.elu * 100))}%</b> {t('eventLoop.elu')}</span>
            <span className={css.metric}><b>{String(loop.overWindows)}</b> {t('eventLoop.overWindows')}</span>
          </div>
          <Sparkline history={loop.history} />

          {/* Block 2: the light gauge with the written rules (design: 规则写死在旁边). */}
          <div className={css.gauge}>
            <span className={`${css.dot} ${css[`dot_${loop.light}`] ?? ''}`} aria-hidden="true" />
            <span className={css.gaugeLabel}>{t(LIGHT_KEYS[loop.light])}</span>
            <span className={css.hint}>
              {loop.consecutiveNormal > 0
                ? t('eventLoop.streak', { n: String(loop.consecutiveNormal) })
                : t('eventLoop.streakOver', { n: String(loop.consecutiveOver) })}
            </span>
          </div>
          <p className={css.rules}>{t('eventLoop.rules')}</p>

          {/* Block 3: attribution Top table with the unattributed gray fallback. */}
          <div className={css.block}>
            <span className={css.blockTitle}>{t('eventLoop.attribution')}</span>
            <table className={css.table}>
              <thead>
                <tr>
                  <th />
                  <th>{t('eventLoop.headers.count')}</th>
                  <th>{t('eventLoop.headers.worst')}</th>
                  <th>{t('eventLoop.headers.last')}</th>
                </tr>
              </thead>
              <tbody>
                {loop.attribution.map(entry => (
                  <tr key={entry.slice}>
                    <td>{t(SLICE_KEYS[entry.slice])}</td>
                    <td>{String(entry.count)}</td>
                    <td>{entry.worstMs > 0 ? formatDelay(entry.worstMs) : '—'}</td>
                    <td>{entry.lastAt > 0 ? formatClock(entry.lastAt) : '—'}</td>
                  </tr>
                ))}
                <tr className={css.grayRow}>
                  <td>{t('eventLoop.unattributed')}</td>
                  <td>{String(loop.unattributed.count)}</td>
                  <td>{loop.unattributed.worstMs > 0 ? formatDelay(loop.unattributed.worstMs) : '—'}</td>
                  <td>{loop.unattributed.lastAt > 0 ? formatClock(loop.unattributed.lastAt) : '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Block 5: the timeline (spike / red / recovery, newest first). */}
          <div className={css.block}>
            <span className={css.blockTitle}>{t('eventLoop.timeline')}</span>
            <Timeline events={loop.events} t={t} />
          </div>
        </>
      )}

      {/* Block 4: the queue contrast — a full gate is deliberate throttling. */}
      <div className={css.block}>
        <span className={css.blockTitle}>{t('eventLoop.scheduler')}</span>
        {scheduler === null ? (
          <p className={css.hint}>{t('eventLoop.unavailable')}</p>
        ) : (
          <p className={css.hint}>
            {t('eventLoop.schedulerStats', {
              queued: String(scheduler.queued),
              held: String(scheduler.held),
              max: String(scheduler.maxSlots),
              wait: String(scheduler.waitP95),
            })}
          </p>
        )}
      </div>
    </div>
  )
}
