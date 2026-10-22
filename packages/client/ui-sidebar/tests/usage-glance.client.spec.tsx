// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { deriveGlance, formatCompactTokens, formatRefreshStamp, openUsageSection, UsageGlance, type GlanceWindowRow, type UsageOverviewView } from '../src/client/UsageGlance.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate({ ...commonEn, ...en })

/** Fixed evaluation instant: 2026-10-15T10:30Z inside every fixture window. */
const NOW = Date.parse('2026-10-15T10:30:00Z')

/**
 * Elapsed shares at NOW, mirroring the span derivation (start = reset minus
 * the window's length): month = 28d 4m12s of 30d, week = 3d10h30m of 7d
 * (~49.1%), 5-hour = 3.5h of 5h (70%).
 */
const MONTH_FRACTION = (NOW - Date.parse('2026-09-17T10:25:48Z'))
  / (Date.parse('2026-10-17T10:25:48Z') - Date.parse('2026-09-17T10:25:48Z'))
const WEEK_FRACTION = (NOW - Date.parse('2026-10-12T00:00:00Z'))
  / (Date.parse('2026-10-19T00:00:00Z') - Date.parse('2026-10-12T00:00:00Z'))
const FIVE_HOUR_FRACTION = (NOW - Date.parse('2026-10-15T07:00:00Z'))
  / (Date.parse('2026-10-15T12:00:00Z') - Date.parse('2026-10-15T07:00:00Z'))

/** The on-screen rows at NOW: week's 50% runs ahead of its 49.1% clock. */
const MONTH_ROW: GlanceWindowRow = {
  key: 'month', percent: 85, elapsed: 28, total: 30, unit: 'd', timeFraction: MONTH_FRACTION,
}
const WEEK_ROW: GlanceWindowRow = {
  key: 'week', percent: 50, elapsed: 3, total: 7, unit: 'd', timeFraction: WEEK_FRACTION, overPace: true,
}
const FIVE_HOUR_ROW: GlanceWindowRow = {
  key: '5h', percent: 13, elapsed: 3, total: 5, unit: 'h', timeFraction: FIVE_HOUR_FRACTION,
}

/** The host overview shape the glance consumes (plan windows + today's ledger). */
const OVERVIEW: UsageOverviewView = {
  current: { provider: 'opencode-go' },
  providers: [
    {
      provider: 'opencode-go',
      plan: {
        windows: [
          { key: 'rolling', percent: 1, resetsAt: '2026-10-15T07:27:12Z' },
          { key: '5h', percent: 13, resetsAt: '2026-10-15T12:00:00Z' },
          { key: 'week', percent: 50, resetsAt: '2026-10-19T00:00:00Z' },
          { key: 'month', percent: 85, resetsAt: '2026-10-17T10:25:48Z' },
        ],
      },
    },
  ],
  usage: {
    today: {
      // 120M + 40M + 40M + 0 = 200M disjoint tokens.
      totals: { inputTokens: 120_000_000, outputTokens: 40_000_000, cacheReadTokens: 40_000_000, cacheWriteTokens: 0 },
    },
  },
}

/** The percent column one row renders (`33%`). */
function percentOf(row: GlanceWindowRow): string {
  return `${String(row.percent)}%`
}

/** The time-pair column one row renders (`5/31d`), em dash without a span. */
function pairOf(row: GlanceWindowRow): string {
  return row.elapsed === undefined || row.total === undefined || row.unit === undefined
    ? '—'
    : `${String(row.elapsed)}/${String(row.total)}${row.unit}`
}

/** Flush pending microtasks and timers inside act(). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

/** Local `YYYY-MM-DD` key for a date (mirrors the host ledger's date keys). */
function dayKey(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(at.getFullYear()).padStart(4, '0')}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('deriveGlance', () => {
  it('derives one row per on-screen window with pair, tick and pace flag', () => {
    // Month/week/5h each render with their pair and tick; the rolling window
    // is never on screen, and week's 50% at ~49.1% of the clock flags over-pace.
    expect(deriveGlance(OVERVIEW, NOW)).toEqual({
      windows: [MONTH_ROW, WEEK_ROW, FIVE_HOUR_ROW],
      todayTokens: 200_000_000,
    })
  })

  it('falls back when the current provider reports no plan', () => {
    const overview: UsageOverviewView = {
      current: { provider: 'deepseek-official' },
      providers: [
        { provider: 'deepseek-official' },
        { provider: 'opencode-go', plan: { windows: [{ key: 'week', percent: 31, resetsAt: '2026-10-19T00:00:00Z' }] } },
      ],
    }
    // The window rows and the cycle token both read the FIRST provider row
    // that reports a preferred window — here the second one, week only.
    expect(deriveGlance(overview, NOW)).toEqual({
      windows: [{ key: 'week', percent: 31, elapsed: 3, total: 7, unit: 'd', timeFraction: WEEK_FRACTION }],
    })
  })

  it('returns no bar fields while no provider reports a cycle window', () => {
    // Each fact degrades on its own — a ledger day without a plan still reads.
    expect(deriveGlance({ providers: [{ provider: 'custom' }] }, NOW)).toEqual({})
    expect(deriveGlance(OVERVIEW, NOW).todayTokens).toBe(200_000_000)
  })

  it('drops the time facts when the reset instant is missing', () => {
    const overview: UsageOverviewView = { providers: [{ provider: 'p', plan: { windows: [{ key: 'month', percent: 42 }] } }] }
    expect(deriveGlance(overview, NOW)).toEqual({ windows: [{ key: 'month', percent: 42 }] })
  })

  it('never renders rolling windows — no span, no row', () => {
    const overview: UsageOverviewView = {
      providers: [{ provider: 'p', plan: { windows: [{ key: 'rolling', percent: 7, resetsAt: '2026-10-15T07:27:12Z' }] } }],
    }
    expect(deriveGlance(overview, NOW)).toEqual({})
  })

  it('renders the 5-hour window with an hours pair and withholds its cycle total', () => {
    // The ledger is day-keyed: even with a series present, a sub-day window
    // must not swallow a whole day — the cycle row reads nothing instead.
    const overview: UsageOverviewView = {
      providers: [{ provider: 'p', plan: { windows: [{ key: '5h', percent: 13, resetsAt: '2026-10-15T12:00:00Z' }] } }],
      usage: {
        days: [{ date: '2026-10-15', totals: { inputTokens: 1_000_000 } }],
        availableDays: ['2026-10-15'],
      },
    }
    expect(deriveGlance(overview, NOW)).toEqual({ windows: [FIVE_HOUR_ROW] })
  })

  it('sums the plan-cycle window, not the calendar month (start day inclusive)', () => {
    // Window: reset 2026-10-17T10:29:32Z → month start 2026-09-17 (day keys are
    // local; every realistic test offset lands the start day on Sep 16/17, and
    // every row below sits strictly before or after both candidates except the
    // Sep 17 row, which pins the inclusive rule whenever the start day is Sep 17).
    const overview: UsageOverviewView = {
      providers: [{ provider: 'p', plan: { windows: [{ key: 'month', percent: 31, resetsAt: '2026-10-17T10:29:32Z' }] } }],
      usage: {
        days: [
          { date: '2026-09-01', totals: { inputTokens: 900_000_000 } }, // before the cycle: out
          { date: '2026-09-17', totals: { inputTokens: 7_000_000 } },   // cycle start day: in (ruling)
          { date: '2026-09-30', totals: { inputTokens: 5_000_000 } },   // before October, inside cycle: in
          { date: '2026-10-14', totals: { inputTokens: 3_000_000 } },
        ],
        availableDays: ['2026-09-01', '2026-09-17', '2026-09-30', '2026-10-14'],
      },
    }
    // The Sep 30 row proves the sum is cycle-driven: a calendar-month sum
    // would exclude it, a cycle sum starting Sep 17 must include it.
    expect(deriveGlance(overview, NOW)).toEqual({
      windows: [{
        key: 'month',
        percent: 31,
        elapsed: 28,
        total: 30,
        unit: 'd',
        timeFraction: (NOW - Date.parse('2026-09-17T10:29:32Z'))
          / (Date.parse('2026-10-17T10:29:32Z') - Date.parse('2026-09-17T10:29:32Z')),
      }],
      cycleTokens: 15_000_000,
    })
  })

  it('marks the cycle total a floor when the trend window cuts in-cycle days', () => {
    // Late-cycle instant; the 30-entry series starts 2026-10-02 while the
    // cycle began a month earlier and availableDays still lists Sep days.
    const NOW_LATE = Date.parse('2026-10-31T00:00:00Z')
    const overview: UsageOverviewView = {
      providers: [{ provider: 'p', plan: { windows: [{ key: 'month', percent: 90, resetsAt: '2026-10-16T00:00:00Z' }] } }],
      usage: {
        days: [
          { date: '2026-10-02', totals: { inputTokens: 1_000_000 } },
          { date: '2026-10-29', totals: { inputTokens: 2_000_000 } },
        ],
        availableDays: ['2026-09-25', '2026-10-02', '2026-10-29'],
      },
    }
    expect(deriveGlance(overview, NOW_LATE)).toMatchObject({
      windows: [{ key: 'month', percent: 90, elapsed: 30, total: 30, unit: 'd', timeFraction: 1 }],
      cycleTokens: 3_000_000,
      cycleTruncated: true,
    })
  })

  it('derives the cycle sum from a weekly window too', () => {
    // Reset 2026-10-19T00:00Z → week start 2026-10-12; three elapsed days.
    const overview: UsageOverviewView = {
      providers: [{ provider: 'p', plan: { windows: [{ key: 'week', percent: 50, resetsAt: '2026-10-19T00:00:00Z' }] } }],
      usage: {
        days: [
          { date: '2026-10-10', totals: { inputTokens: 900_000_000 } }, // before the week: out
          { date: '2026-10-12', totals: { inputTokens: 4_000_000 } },
          { date: '2026-10-14', totals: { inputTokens: 6_000_000 } },
        ],
        availableDays: ['2026-10-10', '2026-10-12', '2026-10-14'],
      },
    }
    expect(deriveGlance(overview, NOW)).toEqual({
      windows: [WEEK_ROW],
      cycleTokens: 10_000_000,
    })
  })

  it('withholds the cycle total for rolling windows even when days arrive', () => {
    // Rolling windows have no day span, so a series must not leak into a
    // cycle reading the rows never showed.
    const overview: UsageOverviewView = {
      providers: [{ provider: 'p', plan: { windows: [{ key: 'rolling', percent: 7, resetsAt: '2026-10-15T07:27:12Z' }] } }],
      usage: {
        days: [{ date: '2026-10-15', totals: { inputTokens: 1_000_000 } }],
        availableDays: ['2026-10-15'],
      },
    }
    expect(deriveGlance(overview, NOW)).toEqual({})
  })
})

describe('formatCompactTokens', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1_500, '1.5K'],
    [2_000, '2K'],
    [1_000_000, '1M'],
    [200_000_000, '200M'],
    [1_050_000_000, '1.1B'],
    [Number.NaN, '—'],
  ])('formats %d as %s', (tokens, expected) => {
    expect(formatCompactTokens(tokens)).toBe(expected)
  })
})

describe('formatRefreshStamp', () => {
  it('renders a zero-padded two-digit local stamp', () => {
    // Constructed from local wall-clock parts, so the expectation holds in any TZ.
    const at = new Date(2026, 9, 15, 21, 30).getTime()
    expect(formatRefreshStamp(at)).toBe('26.10.15 21:30')
  })

  it('pads single-digit month, day, hour, and minute', () => {
    const at = new Date(2026, 0, 5, 7, 4).getTime()
    expect(formatRefreshStamp(at)).toBe('26.01.05 07:04')
  })
})

describe('UsageGlance', () => {
  it('renders one row per window (label, tick, merged read-out) over the token column', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json: async () => OVERVIEW })))
    const { container } = render(<UsageGlance t={t} />)
    // The component derives against the wall clock; assert the read-outs match
    // the same derivation so the expectation cannot drift across a day boundary.
    const rows = deriveGlance(OVERVIEW).windows ?? []
    expect(rows.map(row => row.key)).toEqual(['month', 'week', '5h'])
    // Each row carries the percent and the time pair as separate columns.
    expect(await screen.findByText(percentOf(rows[0]!))).toBeTruthy()
    expect(screen.getByText(pairOf(rows[0]!))).toBeTruthy()
    expect(screen.getByText(percentOf(rows[1]!))).toBeTruthy()
    expect(screen.getByText(pairOf(rows[1]!))).toBeTruthy()
    expect(screen.getByText(percentOf(rows[2]!))).toBeTruthy()
    expect(screen.getByText(pairOf(rows[2]!))).toBeTruthy()
    // Short labels in display order, one tick per row, per-window tooltips.
    // Class selectors match the scoped CSS-module names by substring.
    const labels = [...container.querySelectorAll('[class*="glanceLabel"]')].map((el: Element) => el.textContent)
    expect(labels).toEqual(['Mo', 'Wk', '5h'])
    expect(container.querySelectorAll('[class*="glanceTick"]')).toHaveLength(3)
    expect(screen.getByTitle(t('glance.window.month.title'))).toBeTruthy()
    expect(screen.getByTitle(t('glance.window.week.title'))).toBeTruthy()
    expect(screen.getByTitle(t('glance.window.5h.title'))).toBeTruthy()
    // The stats column stacks the 今日/周期 labeled rows over no stamp line —
    // the stamp rides the column tooltip with both readings.
    expect(screen.getByText(formatCompactTokens(rows.length > 0 ? 200_000_000 : 0))).toBeTruthy()
    const column = screen.getByTitle(
      new RegExp(`^${t('glance.today')} · ${t('glance.cycle')} · ${t('glance.refreshed')} \\d{2}\\.\\d{2}\\.\\d{2} \\d{2}:\\d{2}$`),
    )
    expect(column.textContent).toContain('200M')
    expect(screen.getByText(t('glance.today.label'))).toBeTruthy()
    expect(screen.getByText(t('glance.cycle.label'))).toBeTruthy()
    expect(screen.getByRole('button', { name: t('glance.open') })).toBeTruthy()
  })

  it('paints the overrun in warn with the split at the tick on an over-pace row', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json: async () => OVERVIEW })))
    const { container } = render(<UsageGlance t={t} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const fills = [...container.querySelectorAll('[class*="glanceFill"]')]
    expect(fills).toHaveLength(3)
    // Week: 50% used at ~49.1% of the clock → warn class + split at the tick.
    expect(fills[1]?.className).toContain('glanceFillOver')
    expect(fills[1]?.getAttribute('style')).toContain('--glance-split: 49%')
    // Month (85% at ~93%) and 5h (13% at 70%) are behind the clock: no split.
    expect(fills[0]?.className).not.toContain('glanceFillOver')
    expect(fills[2]?.className).not.toContain('glanceFillOver')
    const ticks = [...container.querySelectorAll('[class*="glanceTick"]')]
    expect(ticks[1]?.getAttribute('style')).toContain('left: 49%')
  })

  it('labels both stat rows with their compact totals', async () => {
    // The fixture cycle starts 2026-09-17 (window resets on the 17th); today's
    // local day key always falls inside it, so the rows read today's buckets
    // versus the sum since the cycle start day whenever the suite runs.
    const todayKey = dayKey(new Date())
    const overview: UsageOverviewView = {
      providers: [{ provider: 'p', plan: { windows: [{ key: 'month', percent: 31, resetsAt: '2026-10-17T10:29:32Z' }] } }],
      usage: {
        today: { totals: { inputTokens: 10_000_000, outputTokens: 2_000_000 } },
        days: [
          { date: '2026-09-17', totals: { inputTokens: 3_000_000 } },
          { date: todayKey, totals: { inputTokens: 10_000_000, outputTokens: 2_000_000 } },
        ],
        availableDays: ['2026-09-17', '2026-09-18'],
      },
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json: async () => overview })))
    render(<UsageGlance t={t} />)
    // Anchor on the VALUES: the labels render before the first load lands, so
    // waiting on them alone would race the fetch and read the placeholders.
    expect((await screen.findByText('12M')).parentElement?.textContent)
      .toBe(`${t('glance.today.label')}12M`)
    expect(screen.getByText('15M').parentElement?.textContent)
      .toBe(`${t('glance.cycle.label')}15M`)
  })

  it('renders nothing while the host half serves no routes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404, ok: false, json: async () => ({}) })))
    const view = render(<UsageGlance t={t} />)
    await flush()
    expect(view.container.textContent).toBe('')
  })

  it('keeps only the token placeholders when the overview request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 500, ok: false, json: async () => ({}) })))
    const { container } = render(<UsageGlance t={t} />)
    await flush()
    // No window has been seen, so no rows render — only the column dashes.
    expect(container.querySelectorAll('[class*="glanceRow"]:not([class*="glanceRows"])')).toHaveLength(0)
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  it('shows no window rows while the first overview is in flight', async () => {
    let release: ((value: unknown) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { release = resolve })))
    const { container } = render(<UsageGlance t={t} />)
    expect(container.querySelectorAll('[class*="glanceRow"]:not([class*="glanceRows"])')).toHaveLength(0)
    const pending = screen.getByTitle(`${t('glance.today')} · ${t('glance.cycle')}`)
    expect(pending.textContent).toContain('—')
    expect(pending.textContent).not.toMatch(/\d{2}:\d{2}/)
    await act(async () => {
      release?.({ status: 200, ok: true, json: async () => OVERVIEW })
      await Promise.resolve()
    })
    expect(await screen.findByText('85%')).toBeTruthy()
    const loaded = screen.getByTitle(
      new RegExp(`^${t('glance.today')} · ${t('glance.cycle')} · ${t('glance.refreshed')} \\d{2}\\.\\d{2}\\.\\d{2} \\d{2}:\\d{2}$`),
    )
    expect(loaded.textContent).toContain('200M')
  })

  it('refreshes on the poll cadence and on visibility changes', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => ({ status: 200, ok: true, json: async () => OVERVIEW }))
    vi.stubGlobal('fetch', fetchMock)
    render(<UsageGlance t={t} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('replays the user path onto the usage section', async () => {
    const sidebar = document.createElement('div')
    sidebar.className = 'sidebarCol'
    const settingsArea = document.createElement('div')
    settingsArea.className = 'settingsArea'
    const trigger = document.createElement('button')
    settingsArea.append(trigger)
    sidebar.append(settingsArea)
    document.body.append(sidebar)

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const nav = document.createElement('nav')
    const general = document.createElement('button')
    general.textContent = '通用设置'
    general.setAttribute('data-settings-section', 'general')
    const usage = document.createElement('button')
    usage.textContent = '使用统计'
    usage.setAttribute('data-settings-section', 'dsh-usage')
    nav.append(general, usage)
    dialog.append(nav)

    let triggerClicks = 0
    let usageClicks = 0
    trigger.addEventListener('click', () => {
      triggerClicks += 1
      document.body.append(dialog)
    })
    usage.addEventListener('click', () => { usageClicks += 1 })

    openUsageSection()
    // The trigger activates synchronously; the nav pick rides the retry timer.
    expect(triggerClicks).toBe(1)
    await flush()
    expect(usageClicks).toBe(1)
  })

  it('picks the section directly when the panel is already open', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const nav = document.createElement('nav')
    const usage = document.createElement('button')
    usage.setAttribute('data-settings-section', 'dsh-usage')
    nav.append(usage)
    dialog.append(nav)
    document.body.append(dialog)
    let clicks = 0
    usage.addEventListener('click', () => { clicks += 1 })

    openUsageSection()
    expect(clicks).toBe(1)
  })

  it('leaves the panel alone when the section row is missing', async () => {
    const sidebar = document.createElement('div')
    sidebar.className = 'sidebarCol'
    const settingsArea = document.createElement('div')
    settingsArea.className = 'settingsArea'
    const trigger = document.createElement('button')
    settingsArea.append(trigger)
    sidebar.append(settingsArea)
    document.body.append(sidebar)
    let triggerClicks = 0
    trigger.addEventListener('click', () => {
      triggerClicks += 1
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      const nav = document.createElement('nav')
      nav.append(document.createElement('button'))
      dialog.append(nav)
      document.body.append(dialog)
    })

    openUsageSection()
    expect(triggerClicks).toBe(1)
    await flush()
    expect(document.querySelectorAll('[data-settings-section]')).toHaveLength(0)
  })
})
