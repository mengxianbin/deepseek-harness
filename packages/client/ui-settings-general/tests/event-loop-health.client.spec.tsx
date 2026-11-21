// @vitest-environment jsdom
/**
 * The settings System-health card (event-loop-monitor design §四): both
 * probe halves render their five blocks, a refused or malformed probe
 * degrades to the quiet unavailable line instead of a broken face, and the
 * queue-contrast half fails independently of the loop half.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { allowAllAccess } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { EventLoopHealthCard } from '../src/client/EventLoopHealthCard.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// Global standard kit: the card consumes only `t`; the runtime hooks stay unused.
const unusedHook = (() => { throw new Error('unused by the health card') }) as never
const kit = {
  useSessions: unusedHook, useSessionStatus: unusedHook, usePanelInfo: unusedHook,
  useSessionRetainInfo: unusedHook, useResource: unusedHook, useWorkspaces: unusedHook,
  ...allowAllAccess,
}

type SettingsTranslate = PropsLocale<'settings'>['t']

function translate(dictionary: typeof zh): SettingsTranslate {
  const messages: Readonly<Record<string, string>> = dictionary
  return (key, params) => Object.entries(params ?? {})
    .reduce((message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
      messages[key] ?? key)
}

/** One successful probe answer; `undefined` makes the path answer not-ok. */
function stubFetch(handler: (path: string) => Record<string, unknown> | undefined) {
  const impl = vi.fn(async (input: string) => {
    const body = handler(input)
    if (body === undefined) return { ok: false, json: async () => { throw new Error('not found') } }
    return { ok: true, json: async () => body }
  })
  vi.stubGlobal('fetch', impl)
  return impl
}

const LOOP = {
  at: 1_700_000_000_000,
  windowSec: 60,
  p50: 15,
  p99: 412,
  max: 2100,
  mean: 18,
  elu: 0.63,
  light: 'yellow',
  consecutiveOver: 1,
  consecutiveNormal: 0,
  overWindows: 4,
  history: [
    { at: 1, p50: 14, p99: 40, max: 60, mean: 16, elu: 0.2, over: false, light: 'green' },
    { at: 2, p50: 15, p99: 412, max: 2100, mean: 18, elu: 0.63, over: true, light: 'yellow' },
  ],
  attribution: [
    { slice: 'list', count: 0, worstMs: 0, lastAt: 0 },
    { slice: 'migration', count: 3, worstMs: 2100, lastAt: 1_700_000_000_500 },
    { slice: 'zstd', count: 1, worstMs: 80, lastAt: 1_700_000_000_100 },
  ],
  unattributed: { count: 1, worstMs: 500, lastAt: 1_700_000_001_000, dumps: 1 },
  events: [
    { at: 1_700_000_002_000, kind: 'spike', max: 2100, slices: ['migration'] },
    { at: 1_700_000_003_000, kind: 'red' },
    { at: 1_700_000_004_000, kind: 'recover', redMs: 180_000 },
  ],
} as const

const SCHEDULER = {
  at: 1_700_000_000_000,
  maxSlots: 3,
  held: 1,
  queued: 2,
  queueOldestMs: 120,
  waitP95: 40,
} as const

function renderCard() {
  return render(<EventLoopHealthCard {...kit} t={translate(zh)} />)
}

it('renders both probe halves: metrics, gauge, attribution, timeline, queue contrast', async () => {
  const fetchImpl = stubFetch((path) => {
    if (path === '/api/event-loop/state') return LOOP
    if (path === '/api/unit-scheduler/state') return SCHEDULER
    return undefined
  })
  renderCard()

  // Header + window chip.
  expect(await screen.findByText('系统健康')).toBeTruthy()
  expect(screen.getByText('60s 窗')).toBeTruthy()

  // Block 1: the now-stuck numbers (formatDelay shapes: 412ms, 2.1s, 63%).
  expect(screen.getByText('412ms')).toBeTruthy()
  // 2.1s appears twice by design: the max metric and the migration worst row.
  expect(screen.getAllByText('2.1s')).toHaveLength(2)
  expect(screen.getByText('63%')).toBeTruthy()
  expect(screen.getByText('4')).toBeTruthy()
  expect(screen.getByText('超阈窗')).toBeTruthy()

  // The sparkline carries the bounded history with both thresholds.
  expect(screen.getByRole('img', { name: 'event loop delay' })).toBeTruthy()

  // Block 2: yellow gauge with the streak and the written rules.
  expect(screen.getByText('注意')).toBeTruthy()
  expect(screen.getByText('已连续 1 窗超阈')).toBeTruthy()
  expect(screen.getByText(/判定：p99 < 250ms/)).toBeTruthy()

  // Block 3: attribution rows plus the gray unattributed fallback.
  expect(screen.getByText('会话列表行循环')).toBeTruthy()
  expect(screen.getByText('日志迁移解码')).toBeTruthy()
  expect(screen.getByText('未归因 · 尖峰没对上切片，已 dump 现场')).toBeTruthy()

  // Block 5: timeline newest first — attributed spike, red, recovery.
  expect(screen.getByText('尖峰 2100ms · 日志迁移解码')).toBeTruthy()
  expect(screen.getByText('红态开始')).toBeTruthy()
  expect(screen.getByText('恢复 · 持续 3m')).toBeTruthy()

  // Block 4: the queue contrast reads the scheduler probe.
  expect(screen.getByText('排队 2 · 占用 1/3 · 等位 p95 40ms')).toBeTruthy()

  // Both paths were pulled once on mount.
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  expect(fetchImpl.mock.calls.map(([path]) => path).sort()).toEqual([
    '/api/event-loop/state', '/api/unit-scheduler/state',
  ])
})

it('shows the quiet unavailable line when both probes refuse (fence answers 403)', async () => {
  stubFetch(() => undefined)
  renderCard()

  // Title still renders; both halves degrade instead of throwing.
  expect(await screen.findByText('系统健康')).toBeTruthy()
  const unavailable = await screen.findAllByText('无法读取（探针仅限本机访问）')
  expect(unavailable).toHaveLength(2)
  // No metrics face at all.
  expect(screen.queryByText('超阈窗')).toBeNull()
  expect(screen.queryByRole('img', { name: 'event loop delay' })).toBeNull()
})

it('keeps the loop half rendered when only the scheduler probe is absent', async () => {
  stubFetch(path => path === '/api/event-loop/state'
    ? LOOP
    : undefined)
  renderCard()

  expect(await screen.findByText('412ms')).toBeTruthy()
  expect(screen.getByText('注意')).toBeTruthy()
  // Queue contrast degrades on its own; the loop blocks stay truthful.
  const unavailable = screen.getAllByText('无法读取（探针仅限本机访问）')
  expect(unavailable).toHaveLength(1)
  expect(screen.queryByText('排队 2 · 占用 1/3 · 等位 p95 40ms')).toBeNull()
})

it('treats a malformed body as absent instead of rendering broken numbers', async () => {
  stubFetch(path => path === '/api/event-loop/state'
    // Shape guard: p99/max/elu must be numbers.
    ? { p99: '412', max: 2100, elu: 0.63, light: 'yellow', history: [], attribution: [] }
    : SCHEDULER)
  renderCard()

  expect(await screen.findByText('系统健康')).toBeTruthy()
  expect(await screen.findAllByText('无法读取（探针仅限本机访问）')).toHaveLength(1)
  // The scheduler half still renders its contrast line.
  expect(screen.getByText('排队 2 · 占用 1/3 · 等位 p95 40ms')).toBeTruthy()
  expect(screen.queryByText('超阈窗')).toBeNull()
})
