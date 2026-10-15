/**
 * Plan-cycle usage glance for the logo row (FORK dsh-local, 2026-10-15).
 *
 * The two stacked progress bars sit beside the whale mark in the sidebar's
 * logo row: the upper bar is the current plan cycle's consumed share against
 * its total, the lower bar the cycle's elapsed days against its length. Both
 * tracks are the same fixed width and left-aligned; each carries its own
 * `numerator / denominator` read-out to the right of the track.
 *
 * Data is the dsh-usage host half's same-origin overview — the plugin this
 * fork's settings section belongs to — read once on mount and refreshed on a
 * relaxed cadence while the tab is visible. A 404 (host half off, plugin
 * disabled) hides the control entirely; transport failures keep the last
 * snapshot and retry on the next tick. The whole control degrades to silence,
 * so the shell never depends on it.
 *
 * The OpenCode Go quota endpoint reports `percent` + `resetsAt` only (raw
 * response verified 2026-10-15), so the cycle bar's read-out is the
 * percentage pair; the day bar derives its window from `resetsAt` (a month
 * before the reset for the monthly window, seven days for the weekly one).
 *
 * Clicking the control opens the settings panel on the usage section by
 * replaying the user's own path — the shell owns the panel state and exposes
 * no service for it, so every step degrades silently.
 * @module ui-sidebar/client/UsageGlance
 */
import { useEffect, useState, type ReactNode } from 'react'
import css from './SidebarRoot.module.css'
import type { SidebarKey } from './locales.ts'

/** Same-origin overview the dsh-usage host half serves. */
const OVERVIEW_ROUTE = '/api/dsh-usage/overview'

/** Request ceiling: a stalled host must not pile up glance fetches. */
const GLANCE_TIMEOUT_MS = 10_000

/** Refresh cadence; only fires while the tab is visible. */
const GLANCE_POLL_MS = 60_000

/** Day length in ms (the day bar's arithmetic unit). */
const DAY_MS = 86_400_000

/**
 * Window keys in cycle-preference order: the billing cycle first, then the
 * week, then whatever else the provider reports.
 */
const WINDOW_PREFERENCE = ['month', 'week', 'rolling', '5h'] as const

/**
 * Stable selector for the usage nav row. The settings shell stamps each nav
 * button with `data-settings-section`, so the replay addresses the row by its
 * section id instead of localized text.
 */
const USAGE_SECTION_ROW = '[data-settings-section="dsh-usage"]'

/** One quota window as the host normalizes it. */
interface PlanWindowView {
  key?: string
  percent?: number
  resetsAt?: string
}

/** One provider row of the overview the glance reads. */
interface ProviderSnapshotView {
  provider?: string
  plan?: { windows?: PlanWindowView[] }
}

/** The overview document (the slice the glance consumes). */
export interface UsageOverviewView {
  current?: { provider?: string }
  providers?: ProviderSnapshotView[]
}

/** What the two bars render once an overview has been derived. */
export interface GlanceState {
  /** Consumed share of the cycle, 0-100 (rounded to whole percent). */
  percent: number
  /** Whole days since the cycle started, when a cycle length is derivable. */
  elapsedDays?: number
  /** Cycle length in days, when derivable from the reset instant. */
  totalDays?: number
}

/**
 * The window the glance reports: the current provider's cycle window first,
 * then any provider's, preferring the longest cycle the provider exposes.
 * @param overview - the host overview document.
 * @returns the chosen window, or undefined when no provider reports one.
 */
function pickWindow(overview: UsageOverviewView): PlanWindowView | undefined {
  const providers = overview.providers ?? []
  const current = overview.current?.provider
  const ordered = current === undefined
    ? providers
    : [...providers.filter(row => row.provider === current), ...providers.filter(row => row.provider !== current)]
  for (const row of ordered) {
    const windows = row.plan?.windows
    if (!Array.isArray(windows)) continue
    for (const key of WINDOW_PREFERENCE) {
      const found = windows.find(window => window.key === key && typeof window.percent === 'number')
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** Subtract one calendar month from an epoch-ms instant (month-end safe). */
function monthBefore(ms: number): number {
  const start = new Date(ms)
  start.setMonth(start.getMonth() - 1)
  return start.getTime()
}

/**
 * Derive the cycle's elapsed/total day pair from the window's reset instant.
 * A window without a usable `resetsAt` (or a sub-day window) yields nothing.
 * @param window - the chosen quota window.
 * @param now - the evaluation instant.
 * @returns the day pair; empty when the cycle length is not derivable.
 */
function cycleDays(window: PlanWindowView, now: number): { elapsed?: number; total?: number } {
  if (typeof window.resetsAt !== 'string') return {}
  const end = Date.parse(window.resetsAt)
  if (!Number.isFinite(end)) return {}
  const start = window.key === 'month' ? monthBefore(end) : window.key === 'week' ? end - 7 * DAY_MS : undefined
  if (start === undefined || !Number.isFinite(start) || end <= start) return {}
  const total = Math.max(1, Math.round((end - start) / DAY_MS))
  const elapsed = Math.min(total, Math.max(0, Math.floor((now - start) / DAY_MS)))
  return { elapsed, total }
}

/**
 * Reduce an overview document to the two bars' read-outs.
 * @param overview - the host overview document.
 * @param now - the evaluation instant (injectable for tests).
 * @returns the glance state, or null while no provider reports a cycle window.
 */
export function deriveGlance(overview: UsageOverviewView, now: number = Date.now()): GlanceState | null {
  const window = pickWindow(overview)
  if (window === undefined || typeof window.percent !== 'number') return null
  const { elapsed, total } = cycleDays(window, now)
  return {
    percent: Math.max(0, Math.min(100, Math.round(window.percent))),
    ...(elapsed === undefined ? {} : { elapsedDays: elapsed }),
    ...(total === undefined ? {} : { totalDays: total }),
  }
}

/**
 * Open the settings panel on the usage section. Every step degrades silently:
 * with the panel already open only the nav pick runs, and a missing row leaves
 * the panel on its default section.
 */
export function openUsageSection(): void {
  const pick = (panel: Element): HTMLElement | null =>
    panel.querySelector<HTMLElement>(USAGE_SECTION_ROW)
  const open = document.querySelector('[role="dialog"]')
  if (open !== null) {
    pick(open)?.click()
    return
  }
  const sidebar = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
  const trigger = sidebar?.querySelector('[class*="settingsArea"] button') as HTMLElement | null
  trigger?.click()
  let tries = 0
  const attempt = (): void => {
    const panel = document.querySelector('[role="dialog"]')
    if (panel !== null) {
      pick(panel)?.click()
      return
    }
    tries += 1
    if (tries <= 40) window.setTimeout(attempt, 50)
  }
  window.setTimeout(attempt, 0)
}

/** Props: the sidebar namespace translator the shell owns. */
export interface UsageGlanceProps {
  /** Sidebar-namespace translator. */
  t: (key: SidebarKey) => string
}

/**
 * Render the two-bar plan glance (or nothing while the host half is off).
 * @param props - the shell's locale translator.
 * @returns the glance button, or null when the usage host serves no routes.
 */
export function UsageGlance({ t }: UsageGlanceProps): ReactNode {
  const [state, setState] = useState<GlanceState | null>(null)
  const [hostOff, setHostOff] = useState(false)

  useEffect(() => {
    let alive = true
    let seq = 0
    const load = async (): Promise<void> => {
      const mine = ++seq
      try {
        const response = await fetch(OVERVIEW_ROUTE, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.timeout(GLANCE_TIMEOUT_MS),
        })
        if (response.status === 404) {
          if (alive && mine === seq) setHostOff(true)
          return
        }
        if (!response.ok) throw new Error('overview ' + String(response.status))
        const overview = await response.json() as UsageOverviewView
        if (!alive || mine !== seq) return
        setState(deriveGlance(overview))
        setHostOff(false)
      } catch {
        // Keep the last snapshot; the next tick retries.
      }
    }
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, GLANCE_POLL_MS)
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  if (hostOff) return null
  const percent = state?.percent
  const elapsed = state?.elapsedDays
  const total = state?.totalDays
  return (
    <span className={css.usageGlance}>
      <button
        type="button"
        className={css.glanceButton}
        aria-label={t('glance.open')}
        title={t('glance.open')}
        onClick={() => { openUsageSection() }}
      >
        <span className={css.glanceRow} title={t('glance.usage')}>
          <span className={css.glanceTrack}>
            <span className={css.glanceFill} style={{ width: `${percent ?? 0}%` }} />
          </span>
          <span className={css.glanceValue}>
            {`${percent === undefined ? '—' : String(percent)} / 100`}
          </span>
        </span>
        <span className={css.glanceRow} title={t('glance.days')}>
          <span className={css.glanceTrack}>
            <span
              className={css.glanceFill}
              style={{ width: `${total === undefined || total === 0 ? 0 : Math.round(((elapsed ?? 0) / total) * 100)}%` }}
            />
          </span>
          <span className={css.glanceValue}>
            {`${elapsed === undefined ? '—' : String(elapsed)} / ${total === undefined ? '—' : String(total)}`}
          </span>
        </span>
      </button>
    </span>
  )
}
