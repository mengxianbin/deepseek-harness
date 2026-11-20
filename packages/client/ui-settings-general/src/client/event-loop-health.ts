/**
 * Event-loop health pull flow (browser half of the settings System-health
 * card): same-origin GETs of the loopback-fenced `GET /api/event-loop/state`
 * probe (design event-loop-monitor-1108 §三.3) and the existing
 * `GET /api/unit-scheduler/state` queue probe, parsed into the card's view
 * shapes. Both fetches are independent and fail soft — an absent or refused
 * probe (the fence answers 403 off-host) publishes `null` for that half, so
 * the card shows a quiet unavailable line instead of a broken face
 * (availability Q4: 面消失 ≠ 面变坏).
 */

/** The event-loop watch probe route (mirrors the host package's STATE_PATH). */
export const EVENT_LOOP_STATE_PATH = '/api/event-loop/state'

/** The unit-scheduler queue probe route the design's contrast card reads. */
export const UNIT_SCHEDULER_STATE_PATH = '/api/unit-scheduler/state'

/** Card refresh cadence while the settings page is open; visibility re-pulls on return. */
export const HEALTH_POLL_MS = 10_000

/** One sampled window as the probe history carries it. */
export interface EventLoopWindowView {
  at: number
  p50: number
  p99: number
  max: number
  mean: number
  elu: number
  over: boolean
  light: 'green' | 'yellow' | 'red'
}

/** Cumulative slice-overshoot attribution row. */
export interface SliceAttributionView {
  slice: 'list' | 'migration' | 'zstd'
  count: number
  worstMs: number
  lastAt: number
}

/** Unattributed spike tally (the design's gray fallback row). */
export interface UnattributedView {
  count: number
  worstMs: number
  lastAt: number
  dumps: number
}

/** One timeline entry: spike / red / recovery. */
export interface TimelineEventView {
  at: number
  kind: 'spike' | 'red' | 'recover'
  max?: number
  slices?: readonly string[]
  redMs?: number
}

/** The `GET /api/event-loop/state` payload the card renders (host EventLoopState, structural copy). */
export interface EventLoopStateView {
  at: number
  windowSec: number
  p50: number
  p99: number
  max: number
  mean: number
  elu: number
  light: 'green' | 'yellow' | 'red'
  consecutiveOver: number
  consecutiveNormal: number
  overWindows: number
  history: readonly EventLoopWindowView[]
  attribution: readonly SliceAttributionView[]
  unattributed: UnattributedView
  events: readonly TimelineEventView[]
}

/** The fields of `GET /api/unit-scheduler/state` the contrast card renders. */
export interface UnitSchedulerStateView {
  at: number
  maxSlots: number
  held: number
  queued: number
  queueOldestMs: number
  waitP95: number
}

/** One card refresh: each half `null` when its probe is absent or refused. */
export interface EventLoopHealthSnapshot {
  eventLoop: EventLoopStateView | null
  scheduler: UnitSchedulerStateView | null
}

/** Minimal shape guard: a probe answer either passes its check or is treated as absent. */
function asView(payload: unknown, check: (value: Record<string, unknown>) => boolean): object | null {
  if (typeof payload !== 'object' || payload === null) return null
  return check(payload as Record<string, unknown>) ? payload : null
}

function parseEventLoop(payload: unknown): EventLoopStateView | null {
  return asView(payload, value =>
    typeof value.p99 === 'number' && typeof value.max === 'number' && typeof value.elu === 'number'
    && typeof value.light === 'string' && Array.isArray(value.history) && Array.isArray(value.attribution)) as EventLoopStateView | null
}

function parseScheduler(payload: unknown): UnitSchedulerStateView | null {
  return asView(payload, value =>
    typeof value.held === 'number' && typeof value.queued === 'number') as UnitSchedulerStateView | null
}

/** Injectable fetch seam; defaults to the page's same-origin fetch. */
export type HealthFetch = (input: string, init?: { readonly method: string }) => Promise<{ ok: boolean; json(): Promise<unknown> }>

async function pullOne<T>(fetchImpl: HealthFetch, path: string, parse: (payload: unknown) => T | null): Promise<T | null> {
  try {
    const response = await fetchImpl(path, { method: 'GET' })
    if (!response.ok) return null
    return parse(await response.json())
  } catch {
    return null
  }
}

/**
 * Pull both probe halves once. Never rejects: a refused fence, a missing
 * route, or a malformed body each degrade their half to `null`.
 * @param fetchImpl - test seam; defaults to the served page's same-origin fetch.
 * @returns the snapshot the card renders.
 */
export async function pullEventLoopHealth(fetchImpl?: HealthFetch): Promise<EventLoopHealthSnapshot> {
  const resolve: HealthFetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  const [eventLoop, scheduler] = await Promise.all([
    pullOne(resolve, EVENT_LOOP_STATE_PATH, parseEventLoop),
    pullOne(resolve, UNIT_SCHEDULER_STATE_PATH, parseScheduler),
  ])
  return { eventLoop, scheduler }
}
