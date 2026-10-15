/**
 * Plan-cycle usage glance for the logo row (FORK dsh-local, 2026-10-15).
 *
 * The wide logo row belongs to this control (v2 removed the brand/New Session
 * button): two stacked progress bars — the upper is the current plan cycle's
 * consumed share against its total, the lower the cycle's elapsed days against
 * its length — both tracks the same fixed width and left-aligned, each with
 * its own `numerator / denominator` read-out, and today's compact token total
 * in its own column to the right (`200M`). FORK dsh-local (v2.2, 2026-10-15):
 * that column stacks vertically — the token total above, and below it a small
 * data-refresh stamp (`26.10.15 21:30`) carrying the local wall-clock time the
 * overview last loaded. FORK dsh-local (v2.2, 2026-10-15):
 * that column stacks — the compact total on top, a small data-refresh stamp
 * (`26.10.15 21:30`, local time of the last successful overview load)
 * underneath.
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
  usage?: { today?: { totals?: UsageTokenTotalsView } }
}

/** Today's ledger totals; only the four disjoint token buckets count. */
interface UsageTokenTotalsView {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** What the glance renders once an overview has been derived. */
export interface GlanceState {
  /** Consumed share of the cycle, 0-100 (rounded to whole percent). */
  percent?: number
  /** Whole days since the cycle started, when a cycle length is derivable. */
  elapsedDays?: number
  /** Cycle length in days, when derivable from the reset instant. */
  totalDays?: number
  /** Today's token total across providers (the four disjoint buckets). */
  todayTokens?: number
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
 * Today's token total across providers: the sum of the four disjoint buckets
 * (reasoning rides inside output; calls and cost are not tokens).
 * @param overview - the host overview document.
 * @returns the total, or undefined when the host reports no ledger day.
 */
function todayTokenTotal(overview: UsageOverviewView): number | undefined {
  const totals = overview.usage?.today?.totals
  if (totals === undefined) return undefined
  return (totals.inputTokens ?? 0) + (totals.outputTokens ?? 0)
    + (totals.cacheReadTokens ?? 0) + (totals.cacheWriteTokens ?? 0)
}

/**
 * Compact token total for the glance's today column (`200M`, `1.5K`, `1.1B`).
 * Values below a thousand print verbatim; each scale drops a trailing `.0`.
 * @param tokens - the total to format.
 * @returns the compact string, or an em dash for unusable values.
 */
export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '—'
  for (const [scale, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (tokens >= scale) {
      const scaled = (tokens / scale).toFixed(1)
      return `${scaled.endsWith('.0') ? scaled.slice(0, -2) : scaled}${suffix}`
    }
  }
  return String(Math.round(tokens))
}

/**
 * Local-time data-refresh stamp under the today total (`26.10.15 21:30`).
 * Two-digit year, zero-padded month/day and a 24-hour clock, read in the
 * viewer's own time zone — it is when the payload last arrived, so it ticks
 * with the poll cadence, not with the ledger day.
 * @param at - epoch-ms instant of the last successful overview load.
 * @returns the stamp string.
 */
export function formatRefreshStamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getFullYear() % 100)}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Reduce an overview document to the glance's read-outs. Each fact degrades on
 * its own: a host may report a ledger day without a plan window (or the
 * reverse), and the field that cannot be derived is simply omitted.
 * @param overview - the host overview document.
 * @param now - the evaluation instant (injectable for tests).
 * @returns the glance state.
 */
export function deriveGlance(overview: UsageOverviewView, now: number = Date.now()): GlanceState {
  let percent: number | undefined
  let elapsed: number | undefined
  let total: number | undefined
  const chosen = pickWindow(overview)
  if (chosen !== undefined && typeof chosen.percent === 'number') {
    percent = Math.max(0, Math.min(100, Math.round(chosen.percent)))
    const days = cycleDays(chosen, now)
    elapsed = days.elapsed
    total = days.total
  }
  const todayTokens = todayTokenTotal(overview)
  return {
    ...(percent === undefined ? {} : { percent }),
    ...(elapsed === undefined ? {} : { elapsedDays: elapsed }),
    ...(total === undefined ? {} : { totalDays: total }),
    ...(todayTokens === undefined ? {} : { todayTokens }),
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
 * Render the plan glance: two bars with their read-outs plus today's compact
 * token total stacked over its data-refresh stamp (or nothing while the host
 * half is off).
 * @param props - the shell's locale translator.
 * @returns the glance button, or null when the usage host serves no routes.
 */
export function UsageGlance({ t }: UsageGlanceProps): ReactNode {
  const [state, setState] = useState<GlanceState | null>(null)
  const [hostOff, setHostOff] = useState(false)
  const [refreshedAt, setRefreshedAt] = useState<number | undefined>(undefined)

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
        setRefreshedAt(Date.now())
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
  const todayTokens = state?.todayTokens
  return (
    <span className={css.usageGlance}>
      <button
        type="button"
        className={css.glanceButton}
        aria-label={t('glance.open')}
        title={t('glance.open')}
        onClick={() => { openUsageSection() }}
      >
        <span className={css.glanceBody}>
          <span className={css.glanceRows}>
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
          </span>
          <span className={css.glanceToday} title={t('glance.today')}>
            <span className={css.glanceTodayTokens}>
              {todayTokens === undefined ? '—' : formatCompactTokens(todayTokens)}
            </span>
            {refreshedAt === undefined
              ? null
              : <span className={css.glanceStamp}>{formatRefreshStamp(refreshedAt)}</span>}
          </span>
        </span>
      </button>
    </span>
  )
}
