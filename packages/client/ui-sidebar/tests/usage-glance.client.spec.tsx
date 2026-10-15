// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { deriveGlance, formatCompactTokens, formatRefreshStamp, openUsageSection, UsageGlance, type UsageOverviewView } from '../src/client/UsageGlance.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate({ ...commonEn, ...en })

/** Fixed evaluation instant: 2026-10-15T10:30Z inside the monthly cycle. */
const NOW = Date.parse('2026-10-15T10:30:00Z')

/** The host overview shape the glance consumes (plan windows + today's ledger). */
const OVERVIEW: UsageOverviewView = {
  current: { provider: 'opencode-go' },
  providers: [
    {
      provider: 'opencode-go',
      plan: {
        windows: [
          { key: 'rolling', percent: 1, resetsAt: '2026-10-15T07:27:12Z' },
          { key: 'weekly', percent: 31, resetsAt: '2026-10-19T00:00:00Z' },
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

/** Flush pending microtasks and timers inside act(). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('deriveGlance', () => {
  it('prefers the monthly cycle window and derives its day pair plus today total', () => {
    // Monthly window: reset 2026-10-17T10:25:48Z → start 2026-09-17T10:25:48Z
    // (30-day span), 28 elapsed days at NOW; today = the four buckets summed.
    expect(deriveGlance(OVERVIEW, NOW)).toEqual({
      percent: 85, elapsedDays: 28, totalDays: 30, todayTokens: 200_000_000,
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
    // Weekly window: reset 2026-10-19T00:00Z → start 2026-10-12T00:00Z, three
    // elapsed days at NOW (3.44 days in).
    expect(deriveGlance(overview, NOW)).toEqual({ percent: 31, elapsedDays: 3, totalDays: 7 })
  })

  it('returns no bar fields while no provider reports a cycle window', () => {
    // Each fact degrades on its own — a ledger day without a plan still reads.
    expect(deriveGlance({ providers: [{ provider: 'custom' }] }, NOW)).toEqual({})
    expect(deriveGlance(OVERVIEW, NOW).todayTokens).toBe(200_000_000)
  })

  it('drops the day pair when the reset instant is missing', () => {
    const overview: UsageOverviewView = { providers: [{ provider: 'p', plan: { windows: [{ key: 'month', percent: 42 }] } }] }
    expect(deriveGlance(overview, NOW)).toEqual({ percent: 42 })
  })

  it('drops the day pair for a sub-day rolling window', () => {
    const overview: UsageOverviewView = {
      providers: [{ provider: 'p', plan: { windows: [{ key: 'rolling', percent: 7, resetsAt: '2026-10-15T07:27:12Z' }] } }],
    }
    expect(deriveGlance(overview, NOW)).toEqual({ percent: 7 })
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
  it('renders both bars with their numerator/denominator read-outs and today total', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json: async () => OVERVIEW })))
    render(<UsageGlance t={t} />)
    // The component derives against the wall clock; assert the read-outs match
    // the same derivation so the expectation cannot drift across a day boundary.
    const { percent, elapsedDays, totalDays, todayTokens } = deriveGlance(OVERVIEW)
    expect(percent).toBeDefined()
    expect(await screen.findByText(`${String(percent)} / 100`)).toBeTruthy()
    expect(screen.getByText(`${String(elapsedDays)} / ${String(totalDays)}`)).toBeTruthy()
    // Today's column stacks the compact total over its refresh stamp.
    expect(screen.getByText(formatCompactTokens(todayTokens!))).toBeTruthy()
    expect(screen.getByTitle(t('glance.today')).textContent).toContain('200M')
    expect(screen.getByTitle(t('glance.today')).textContent).toMatch(/\d{2}\.\d{2}\.\d{2} \d{2}:\d{2}/)
    expect(screen.getByTitle(t('glance.usage'))).toBeTruthy()
    expect(screen.getByTitle(t('glance.days'))).toBeTruthy()
    expect(screen.getByRole('button', { name: t('glance.open') })).toBeTruthy()
  })

  it('renders nothing while the host half serves no routes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404, ok: false, json: async () => ({}) })))
    const view = render(<UsageGlance t={t} />)
    await flush()
    expect(view.container.textContent).toBe('')
  })

  it('keeps the placeholder read-outs when the overview request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 500, ok: false, json: async () => ({}) })))
    render(<UsageGlance t={t} />)
    expect(await screen.findByText('— / 100')).toBeTruthy()
    expect(screen.getByText('— / —')).toBeTruthy()
  })

  it('shows placeholder read-outs while the first overview is in flight', async () => {
    let release: ((value: unknown) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { release = resolve })))
    render(<UsageGlance t={t} />)
    expect(screen.getByText('— / 100')).toBeTruthy()
    expect(screen.getByText('— / —')).toBeTruthy()
    expect(screen.getByTitle(t('glance.today')).textContent).toContain('—')
    expect(screen.getByTitle(t('glance.today')).textContent).not.toMatch(/\d{2}:\d{2}/)
    await act(async () => {
      release?.({ status: 200, ok: true, json: async () => OVERVIEW })
      await Promise.resolve()
    })
    expect(await screen.findByText('85 / 100')).toBeTruthy()
    expect(screen.getByTitle(t('glance.today')).textContent).toContain('200M')
    expect(screen.getByTitle(t('glance.today')).textContent).toMatch(/\d{2}\.\d{2}\.\d{2} \d{2}:\d{2}/)
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
