/**
 * Multi-window usage glance for the logo row (FORK dsh-local, 2026-10-15).
 *
 * The wide logo row belongs to this control (v2 removed the brand/New Session
 * button), and its bars column holds one row per quota window the host reports
 * among `month`/`week`/`5h`, in that order (FORK v2.4, 2026-10-22, three
 * quota windows on screen — the row order is cycle-first, so the month row
 * keeps today's top-bar seat): each row is a short window label
 * (`glance.window.*.label`), a same-width left-aligned track, and two
 * right-aligned read-out columns — the usage percent (`33%`) beside the time
 * pair (`5/31d`, em dash without a span); 2026-10-22 用户指示拆列右对齐. The fill is the window's consumed share of 100; a
 * 1px tick marks its continuous time progress — the span is back-derived from
 * `resetsAt` (one month / seven days / five hours before the reset) — and the
 * fill segment past the tick paints in the warn color, i.e. usage running
 * ahead of the clock (the pace reading, chosen over a second stacked bar on
 * 2026-10-22, plan B). Month and week read elapsed/total in days, the 5-hour
 * window in hours (`3/5h`). A window the provider does not report (or reports
 * without a numeric percent) drops its WHOLE row; rolling windows — no day
 * structure — never render. The rows and the cycle token read the same
 * provider row (current provider first), so the token column stays on the
 * month row's window. Rows stack gapless: 3 × 12px line boxes plus the
 * button's 4px padding = 40px, exactly the Windows titlebar logo row's height
 * (the web row, 60px with 8px padding, keeps slack). Today's compact token
 * total lives in its own column to the right (`200M`). FORK dsh-local (v2.2,
 * 2026-10-15): that column stacks vertically — the token total above, and
 * below it a small data-refresh stamp (`26.10.15 21:30`) carrying the local
 * wall-clock time the overview last loaded. FORK dsh-local (v2.3, 2026-10-22):
 * the column becomes two labeled rows — `今日 321.7M` above `周期 4.21B`, each
 * a single-key locale label plus its compact total — and the refresh stamp
 * moves into the column tooltip. The second row is plan-cycle, not calendar
 * (2026-10-22 ruling): it sums the trend series over the pickWindow main
 * window (month preferred — re-affirmed as the cycle row's window when v2.4
 * split the bars per window; same quota window as the month row), start day
 * inclusive (the reset day therefore carries the previous cycle's pre-reset
 * slice too — chosen over dropping that day; ruling kept the full day), and
 * the series is capped (30 entries), so when `availableDays` proves in-cycle
 * days fell outside it the total reads as a floor and renders `≥…`.
 *
 * Data is the dsh-usage host half's same-origin overview — the plugin this
 * fork's settings section belongs to — read once on mount and refreshed on a
 * relaxed cadence while the tab is visible. A 404 (host half off, plugin
 * disabled) hides the control entirely; transport failures keep the last
 * snapshot and retry on the next tick. The whole control degrades to silence,
 * so the shell never depends on it.
 *
 * v3 (FORK usage-glance v3, 2026-10-24): a window may carry an absolute
 * water-line pair (`used`/`limit` — the host now sources OpenCode Go from
 * console go/status, where the pair is authoritative and unrounded). The
 * read-out stays percent-only (the `$used / $limit` column was ruled
 * off-screen on 2026-10-24 to keep the v2.4.x three-column geometry); the
 * pair instead feeds the switch trigger: `used / limit >= 0.85` marks the
 * row, every marked row paints its percent figure in the error red, and the
 * week/month rows — the two windows the A-plan trigger reads (go-plan
 * 2026-10-22 §5) — also paint the fill solid red and append
 * `glance.trigger.hint` ("switch to MiMo official") to their tooltip. The
 * 5-hour row turns its figure only: a five-hour pool is not a switch signal.
 * Windows without the pair (other providers, or a host still serving the
 * pre-restart overview) never trigger. The fill for the tick still comes from
 * the window's percent, and the span still derives from `resetsAt` — a month
 * / seven days / five hours before the reset.
 *
 * mimo balance row (FORK usage-glance-mimo-balance, 2026-10-25): the stats
 * column gains a third labeled row — `mimo 余额` above/below the 今日/周期
 * readings — carrying the MiMo official pay-as-you-go balance the host
 * reports on the `mimo` route (`providers[].mimo.balance = { currency,
 * totalBalance, updatedAt }`). The row is bound to the STABLE route id
 * (`mimo`), never to "the first provider that has a balance": today's
 * overview also carries deepseek-official's `-0.18 CNY`, which must not
 * answer for mimo's row. The label carries the attribution (`mimo`) because
 * the two rows above are OpenCode readings while this one is mimo's. A host
 * that reports no mimo balance (adapter absent, cookie expired, probe
 * failed) degrades this row alone to an em dash — the v2.3 single-column
 * degrade contract, the rest of the control untouched. The figure prints as
 * `¥6.16` / `$12.00` for the known symbols, `1.23 XXX` otherwise, and the
 * column tooltip folds the reading in alongside 今日/周期 and the refresh
 * stamp (v2.3 tooltip precedent).
 *
 * Clicking the control opens the settings panel on the usage section by
 * replaying the user's own path — the shell owns the panel state and exposes
 * no service for it, so every step degrades silently.
 * @module ui-sidebar/client/UsageGlance
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
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

/** Hour length in ms (the 5-hour window's arithmetic unit). */
const HOUR_MS = 3_600_000

/**
 * The A-plan switch threshold: a water line at 85% of its pool (go-plan
 * 2026-10-22 §5), compared on the UNROUNDED `used/limit` pair — the percent
 * column rounds, the trigger must not fire (or hold back) on the rounding.
 */
const TRIGGER_RATIO = 0.85

/**
 * Figure space (U+2007): a digit-wide pad CSS white-space processing does NOT
 * collapse — it fills the right-aligned columns to a constant text width, so
 * the gutters between percent / time-pair / stats stay uniform across rows
 * (2026-10-22 用户反馈：天数列与百分比列应比与统计列更紧凑).
 */
const COLUMN_PAD = ' '

/**
 * Window keys in cycle-preference order: the billing cycle first, then the
 * week, then whatever else the provider reports.
 */
const WINDOW_PREFERENCE = ['month', 'week', 'rolling', '5h'] as const

/**
 * On-screen quota windows in row order (FORK v2.4, 2026-10-22): the billing
 * cycle first, then the week, then the 5-hour window. Rolling windows have no
 * day structure and stay off screen.
 */
const GLANCE_WINDOW_KEYS = ['month', 'week', '5h'] as const

/** Locale key maps for one window row's short label and row tooltip. */
const WINDOW_LABEL_KEY = {
  month: 'glance.window.month.label',
  week: 'glance.window.week.label',
  '5h': 'glance.window.5h.label',
} as const satisfies Record<(typeof GLANCE_WINDOW_KEYS)[number], SidebarKey>

const WINDOW_TITLE_KEY = {
  month: 'glance.window.month.title',
  week: 'glance.window.week.title',
  '5h': 'glance.window.5h.title',
} as const satisfies Record<(typeof GLANCE_WINDOW_KEYS)[number], SidebarKey>

/**
 * The MiMo official route key the balance row reads (FORK
 * usage-glance-mimo-balance): a STABLE id, never localized text and never
 * "whichever provider reports a balance" — the overview today also carries
 * deepseek-official's balance, which must not answer for mimo's row.
 */
const MIMO_ROUTE_ID = 'mimo'

/** Currency symbols the balance row knows; others print `1.23 XXX`. */
const BALANCE_SYMBOL: Record<string, string> = { CNY: '¥', USD: '$' }

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
  /** Absolute water line consumed (currency units), when the host reports one. */
  used?: number
  /** Absolute window capacity (currency units), when the host reports one. */
  limit?: number
}

/** One provider balance fact as the host normalizes it. */
interface BalanceView {
  /** ISO-4217 code the host reports (`CNY`, `USD`, …). */
  currency?: string
  /** Spendable total, display-formatted (no currency symbol). */
  totalBalance?: string
  /** Probe instant of the fact; the column tooltip rides the load stamp instead. */
  updatedAt?: number
}

/** One provider row of the overview the glance reads. */
interface ProviderSnapshotView {
  provider?: string
  plan?: { windows?: PlanWindowView[] }
  balance?: BalanceView
}

/** One per-day trend entry of the overview's ledger series. */
interface UsageDayView {
  date?: string
  totals?: UsageTokenTotalsView
}

/** The overview document (the slice the glance consumes). */
export interface UsageOverviewView {
  current?: { provider?: string }
  providers?: ProviderSnapshotView[]
  usage?: {
    today?: { totals?: UsageTokenTotalsView }
    /** Rolling per-day trend series (the current host serves 30 entries). */
    days?: UsageDayView[]
    /** Every retained ledger day key, ascending — the truncation witness. */
    availableDays?: string[]
  }
}

/** Today's ledger totals; only the four disjoint token buckets count. */
interface UsageTokenTotalsView {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * One on-screen quota-window row (FORK v2.4): usage percent always present,
 * the time pair / tick facts present when the window yields a span.
 */
export interface GlanceWindowRow {
  /** The host window key the row renders. */
  key: (typeof GLANCE_WINDOW_KEYS)[number]
  /** Consumed share of the window, 0-100 (rounded to whole percent). */
  percent: number
  /** Elapsed time numerator (days for month/week, hours for 5h). */
  elapsed?: number
  /** Window length in that unit. */
  total?: number
  /** The read-out unit; present only together with the pair. */
  unit?: 'd' | 'h'
  /** Continuous elapsed share of the window, 0-1 (the tick's position). */
  timeFraction?: number
  /** True when usage runs ahead of the clock (percent past the tick). */
  overPace?: boolean
  /**
   * True when the window carries an absolute water line at or over the switch
   * threshold (`used / limit >= 0.85`, unrounded — v3 trigger, go-plan
   * 2026-10-22 §5). Absent on windows without the pair.
   */
  trigger?: boolean
}

/** What the glance renders once an overview has been derived. */
export interface GlanceState {
  /** The on-screen window rows, in display order; omitted when none render. */
  windows?: GlanceWindowRow[]
  /** Today's token total across providers (the four disjoint buckets). */
  todayTokens?: number
  /** Plan-cycle token total for the chosen quota window (start day inclusive). */
  cycleTokens?: number
  /** True when the trend window omits in-cycle days — the total is a floor. */
  cycleTruncated?: boolean
  /** The mimo route's pay-as-you-go balance; absent when the host reports none. */
  mimoBalance?: BalanceView
}

/**
 * The provider row every glance read-out shares: the current provider's plan
 * first, then any provider's, accepting the first row that reports a preferred
 * window with a numeric percent. Both the window rows (FORK v2.4) and the
 * cycle token's `pickWindow` read from this row, so the token column and the
 * month row can never drift onto different providers.
 * @param overview - the host overview document.
 * @returns the chosen provider row, or undefined when none reports a plan.
 */
function pickPlanRow(overview: UsageOverviewView): ProviderSnapshotView | undefined {
  const providers = overview.providers ?? []
  const current = overview.current?.provider
  const ordered = current === undefined
    ? providers
    : [...providers.filter(row => row.provider === current), ...providers.filter(row => row.provider !== current)]
  return ordered.find((row) => {
    const windows = row.plan?.windows
    if (!Array.isArray(windows)) return false
    return WINDOW_PREFERENCE.some(key =>
      windows.some(window => window.key === key && typeof window.percent === 'number'))
  })
}

/**
 * The mimo route's balance fact (FORK usage-glance-mimo-balance): bound to
 * the stable route id `mimo` — deliberately NOT the first provider carrying a
 * balance, which today would be deepseek-official's `-0.18 CNY` answering a
 * question about MiMo's wallet. The row degrades on its own when the host
 * reports no mimo balance (adapter absent, cookie expired, probe failed).
 * @param overview - the host overview document.
 * @returns the mimo balance fact, or undefined when the host reports none.
 */
function pickMimoBalance(overview: UsageOverviewView): BalanceView | undefined {
  return (overview.providers ?? []).find(row => row.provider === MIMO_ROUTE_ID)?.balance
}

/**
 * The window the cycle token reports: the picked provider row's preferred
 * window — the billing cycle first, then the week, then whatever else it
 * exposes (2026-10-22 ruling: the cycle row stays on this main window even
 * after v2.4 put every window on its own bar).
 * @param overview - the host overview document.
 * @returns the chosen window, or undefined when no provider reports one.
 */
function pickWindow(overview: UsageOverviewView): PlanWindowView | undefined {
  const windows = pickPlanRow(overview)?.plan?.windows
  if (!Array.isArray(windows)) return undefined
  for (const key of WINDOW_PREFERENCE) {
    const found = windows.find(window => window.key === key && typeof window.percent === 'number')
    if (found !== undefined) return found
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
 * The span of a month/week/5-hour quota window: start instant to reset
 * instant — a month / seven days / five hours before the reset (FORK v2.4
 * added the sub-day 5-hour span for the tick; the day-keyed token sum still
 * refuses it, see `cycleTokenTotal`). Rolling windows and absent or
 * unparseable resets yield nothing.
 * @param window - one quota window.
 * @returns the span, or undefined when the window is not span-derivable.
 */
function cycleSpan(window: PlanWindowView): { start: number; end: number } | undefined {
  if (typeof window.resetsAt !== 'string') return undefined
  const end = Date.parse(window.resetsAt)
  if (!Number.isFinite(end)) return undefined
  const start = window.key === 'month' ? monthBefore(end)
    : window.key === 'week' ? end - 7 * DAY_MS
      : window.key === '5h' ? end - 5 * HOUR_MS
        : undefined
  if (start === undefined || !Number.isFinite(start) || end <= start) return undefined
  return { start, end }
}

/**
 * Derive one window's time facts (FORK v2.4): the read-out pair — days for
 * month/week, hours for the 5-hour window — plus the continuous elapsed share
 * the tick marks, clamped to the span so a reset already in the past reads as
 * a full window instead of overshooting. A window without a usable span
 * (rolling, bad reset) yields nothing and its row then reads percent alone.
 * @param window - one quota window.
 * @param now - the evaluation instant.
 * @returns the time facts; empty when the window has no derivable span.
 */
function windowTime(
  window: PlanWindowView,
  now: number,
): { elapsed?: number; total?: number; unit?: 'd' | 'h'; timeFraction?: number } {
  const span = cycleSpan(window)
  if (span === undefined) return {}
  const unit: 'd' | 'h' = window.key === '5h' ? 'h' : 'd'
  const size = unit === 'h' ? HOUR_MS : DAY_MS
  const total = Math.max(1, Math.round((span.end - span.start) / size))
  const elapsed = Math.min(total, Math.max(0, Math.floor((now - span.start) / size)))
  const timeFraction = Math.min(1, Math.max(0, (now - span.start) / (span.end - span.start)))
  return { elapsed, total, unit, timeFraction }
}

/**
 * The four disjoint token buckets summed (reasoning rides inside output;
 * calls and cost are not tokens).
 * @param totals - one ledger bucket row.
 * @returns the token total.
 */
function bucketSum(totals: UsageTokenTotalsView): number {
  return (totals.inputTokens ?? 0) + (totals.outputTokens ?? 0)
    + (totals.cacheReadTokens ?? 0) + (totals.cacheWriteTokens ?? 0)
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
  return bucketSum(totals)
}

/** Local `YYYY-MM-DD` key for an instant (the ledger's day bucket). */
function dayKey(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Plan-cycle token total for the cycle row's window (2026-10-22 ruling: plan
 * cycle, never calendar month; the row stays on pickWindow's main window even
 * after v2.4 gave every quota window its own bar). The trend series days are summed
 * from the cycle's start day — inclusive, so the reset day carries its
 * pre-reset slice too (kept whole rather than dropped) — through today. The
 * series is capped at 30 entries, so a long cycle's early days can fall
 * outside it; `availableDays` proving in-cycle keys the series lacks marks
 * the sum a floor (`truncated`). A host serving no day-key list skips that
 * proof — each fact degrades on its own: rolling windows yield no span, and
 * the 5-hour window's hour span is refused here because the ledger is day
 * keyed (FORK v2.4: a whole day would over-count a sub-day window), or a
 * series with no in-cycle day reads as no cycle total at all.
 * @param overview - the host overview document.
 * @param window - the chosen quota window (the cycle row's window).
 * @param now - the evaluation instant (injectable for tests).
 * @returns the cycle total, or nothing when no day span or series exists.
 */
function cycleTokenTotal(
  overview: UsageOverviewView,
  window: PlanWindowView | undefined,
  now: number,
): { tokens?: number; truncated?: boolean } {
  if (window === undefined || window.key === '5h') return {}
  const span = cycleSpan(window)
  if (span === undefined) return {}
  const days = overview.usage?.days
  if (!Array.isArray(days)) return {}
  const startKey = dayKey(span.start)
  const todayKey = dayKey(now)
  let tokens = 0
  let first: string | undefined
  for (const day of days) {
    if (typeof day.date !== 'string') continue
    if (day.date < startKey || day.date > todayKey) continue
    if (day.totals !== undefined) tokens += bucketSum(day.totals)
    first ??= day.date
  }
  if (first === undefined) return {}
  const available = overview.usage?.availableDays
  const truncated = Array.isArray(available)
    && available.some(key => key >= startKey && key < first)
  return { tokens, ...(truncated ? { truncated: true } : {}) }
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
 * Balance figure for the glance's mimo row (`¥6.16`, `$12.00`, `1.23 GBP`).
 * The host already formats the total for display (a numeric string, no
 * symbol), so this only prepends the known currency symbol; an unknown or
 * missing currency prints the bare total, a missing total the em dash.
 * @param balance - one mimo balance fact.
 * @returns the figure string.
 */
export function formatBalanceFigure(balance: BalanceView): string {
  const total = balance.totalBalance
  if (total === undefined || total === '') return '—'
  const currency = balance.currency
  if (currency === undefined || currency === '') return total
  const symbol = BALANCE_SYMBOL[currency]
  return symbol === undefined ? `${total} ${currency}` : `${symbol}${total}`
}

/**
 * Local-time data-refresh stamp (`26.10.15 21:30`), carried in the stats
 * column's tooltip since v2.3. Two-digit year, zero-padded month/day and a
 * 24-hour clock, read in the viewer's own time zone — it is when the payload
 * last arrived, so it ticks with the poll cadence, not with the ledger day.
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
 * Reduce an overview document to the glance's read-outs (FORK v2.4, v3): one row
 * per on-screen quota window (`month`/`week`/`5h`, display order) derived from
 * the picked provider row — percent always, time pair / tick / over-pace flag
 * when the window yields a span, and the v3 switch trigger when the window
 * carries an absolute `used/limit` pair at or over the threshold — plus the
 * token column's facts. Each fact
 * degrades on its own: a host may report a ledger day without a plan (or the
 * reverse), a window missing or percent-less drops its whole row, and a row
 * without a span still reads its percent alone.
 * @param overview - the host overview document.
 * @param now - the evaluation instant (injectable for tests).
 * @returns the glance state.
 */
export function deriveGlance(overview: UsageOverviewView, now: number = Date.now()): GlanceState {
  const planRow = pickPlanRow(overview)
  const rows: GlanceWindowRow[] = []
  if (planRow !== undefined) {
    const reported = planRow.plan?.windows ?? []
    for (const key of GLANCE_WINDOW_KEYS) {
      const found = reported.find(window => window.key === key && typeof window.percent === 'number')
      if (found === undefined || typeof found.percent !== 'number') continue
      const percent = Math.max(0, Math.min(100, Math.round(found.percent)))
      const time = windowTime(found, now)
      const row: GlanceWindowRow = { key, percent }
      if (typeof found.used === 'number' && typeof found.limit === 'number' && found.limit > 0
        && found.used / found.limit >= TRIGGER_RATIO) {
        row.trigger = true
      }
      if (time.elapsed !== undefined && time.total !== undefined && time.unit !== undefined) {
        row.elapsed = time.elapsed
        row.total = time.total
        row.unit = time.unit
      }
      if (time.timeFraction !== undefined) {
        row.timeFraction = time.timeFraction
        if (percent > time.timeFraction * 100) row.overPace = true
      }
      rows.push(row)
    }
  }
  const todayTokens = todayTokenTotal(overview)
  const cycle = cycleTokenTotal(overview, pickWindow(overview), now)
  const mimoBalance = pickMimoBalance(overview)
  return {
    ...(rows.length === 0 ? {} : { windows: rows }),
    ...(todayTokens === undefined ? {} : { todayTokens }),
    ...(cycle.tokens === undefined ? {} : { cycleTokens: cycle.tokens }),
    ...(cycle.truncated === undefined ? {} : { cycleTruncated: cycle.truncated }),
    ...(mimoBalance === undefined ? {} : { mimoBalance }),
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
 * Render the plan glance (FORK v2.4, v3, usage-glance-mimo-balance): one row per on-screen quota window —
 * short label, usage fill with the time-progress tick (overrun in warn), and
 * the right-aligned percent and time-pair columns — plus the 今日/周期 token rows and the mimo
 * balance row in their own column (every reading in that column's tooltip,
 * refresh stamp included). A v3 triggered row (water line
 * >= 85%) reds its percent figure; the week/month rows also paint the fill
 * solid red and append the switch hint to the tooltip. Nothing renders while
 * the host half is off. Rows the host does not report are absent; before the first load the
 * control shows only the token column's placeholders.
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
  const windows = state?.windows ?? []
  const todayTokens = state?.todayTokens
  const cycleTokens = state?.cycleTokens
  const cycleTruncated = state?.cycleTruncated === true
  const mimoBalance = state?.mimoBalance
  const mimoFigure = mimoBalance === undefined ? '—' : formatBalanceFigure(mimoBalance)
  // One tooltip for the whole column: every reading plus the refresh stamp
  // (the stamp stays off-screen; v2.2 spent a third line on it).
  const columnTitle = [
    t('glance.today'),
    t('glance.cycle'),
    `${t('glance.mimoBalance.label')} ${mimoFigure}`,
    ...(refreshedAt === undefined ? [] : [`${t('glance.refreshed')} ${formatRefreshStamp(refreshedAt)}`]),
  ].join(' · ')
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
            {windows.map((row) => {
              // The tick sits at the continuous elapsed share of the window;
              // the percent and the day/hour pair each hold their own
              // right-aligned column (2026-10-22 用户指示：百分比与天数分列右对齐).
              const tickPercent = row.timeFraction === undefined ? undefined : Math.round(row.timeFraction * 100)
              const pair = row.elapsed === undefined || row.total === undefined || row.unit === undefined
                ? '—'
                : `${String(row.elapsed)}/${String(row.total)}${row.unit}`
              // An over-pace row splits the fill at the tick — but the
              // gradient box IS the fill, not the track: convert the tick's
              // track-relative percent into a share of the fill (`tick /
              // percent`) so the warn boundary lands exactly under the tick
              // (2026-10-22 用户实测交界与刻度相离 → 基准修正; overPace ⇒
              // percent > tick ≥ 0, so the division is safe).
              const overPaceSplit = row.overPace === true && tickPercent !== undefined
                ? `${String(Math.round((tickPercent / row.percent) * 100))}%`
                : undefined
              // v3 switch trigger (go-plan 2026-10-22 §5): the unrounded
              // used/limit pair is the authoritative read. The figure turns
              // red on every marked row, while the solid-red fill and the
              // switch hint belong to the week/month rows only — the windows
              // the A-plan switch reads; the 5-hour pool is a water-level
              // warning, not a switch signal. The solid red takes the
              // over-pace gradient's place while the trigger holds (the tick
              // still marks the pace).
              const triggerOn = row.trigger === true
              const triggerHint = triggerOn && (row.key === 'week' || row.key === 'month')
              const rowTitle = triggerHint
                ? `${t(WINDOW_TITLE_KEY[row.key])} · ${t('glance.trigger.hint')}`
                : t(WINDOW_TITLE_KEY[row.key])
              const fillTrigger = triggerOn && row.key !== '5h'
              const fillStyle: CSSProperties & Record<string, string> = {
                width: `${String(row.percent)}%`,
                ...(overPaceSplit === undefined ? {} : { '--glance-split': overPaceSplit }),
              }
              const fillClass = [
                css.glanceFill,
                ...(overPaceSplit === undefined ? [] : [css.glanceFillOver]),
                ...(fillTrigger ? [css.glanceFillTrigger] : []),
              ].join(' ')
              return (
                <span key={row.key} className={css.glanceRow} title={rowTitle}>
                  <span className={css.glanceLabel}>{t(WINDOW_LABEL_KEY[row.key])}</span>
                  <span className={css.glanceTrack}>
                    <span
                      className={fillClass}
                      style={fillStyle}
                    />
                    {tickPercent === undefined
                      ? null
                      : <span className={css.glanceTick} style={{ left: `${String(tickPercent)}%` }} />}
                  </span>
                  <span
                    className={triggerOn ? `${css.glancePercent} ${css.glancePercentTrigger}` : css.glancePercent}
                  >{`${String(row.percent)}%`.padStart(4, COLUMN_PAD)}</span>
                  <span className={css.glancePair}>{pair.padStart(6, COLUMN_PAD)}</span>
                </span>
              )
            })}
          </span>
          <span className={css.glanceStats} title={columnTitle}>
            <span className={css.glanceStat}>
              <span className={css.glanceStatLabel}>{t('glance.today.label')}</span>
              <span className={css.glanceStatValue}>
                {todayTokens === undefined ? '—' : formatCompactTokens(todayTokens)}
              </span>
            </span>
            <span className={css.glanceStat}>
              <span className={css.glanceStatLabel}>{t('glance.cycle.label')}</span>
              <span className={css.glanceStatValue}>
                {cycleTokens === undefined
                  ? '—'
                  : `${cycleTruncated ? '≥ ' : ''}${formatCompactTokens(cycleTokens)}`}
              </span>
            </span>
            <span className={css.glanceStat}>
              <span className={css.glanceStatLabel}>{t('glance.mimoBalance.label')}</span>
              <span className={css.glanceStatValue}>{mimoFigure}</span>
            </span>
          </span>
        </span>
      </button>
    </span>
  )
}
