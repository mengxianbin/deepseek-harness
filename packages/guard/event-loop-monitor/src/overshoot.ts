/**
 * Slice overshoot accounting (design §一第二层「谁卡的」): the three
 * cooperative-yield slice points already compare `performance.now() >=
 * yieldDeadline` on every slice, so recording how far past the deadline a
 * slice ran is one map increment at a branch they already take — no extra
 * timer, no `async_hooks` (the design explicitly rejects full tracing as a
 * blocking source of its own).
 *
 * The registry lives on `globalThis` under a `Symbol.for` key so every
 * importer in the host process — session-controller's list loop and
 * session-persistence-jsonl's migration/zstd loops — reads and writes ONE
 * accumulator even when module resolution hands out two instances of this
 * file (paths-map source in tests, package exports in the built lib). The
 * event-loop-monitor plugin reads the same registry each window to answer
 * "did a histogram spike line up with a slice overshoot" (attributed) or not
 * (unattributed → process.report dump).
 *
 * @module @deepseek-ai/dsh-event-loop-monitor/overshoot
 */

/** Cumulative overshoot facts for one slice point since the process loaded. */
export interface SliceOvershootStats {
  /** How many slices ran past their yield deadline. */
  count: number
  /** The worst single overshoot seen (ms past the deadline). */
  worstMs: number
  /** Wall clock of the most recent overshoot (ms since epoch); 0 when none. */
  lastAt: number
}

/**
 * Named slice points the design wires (list 16ms / migration 500ms / zstd
 * 500ms) plus the heartbeat-sweep point added by stall-rootcause-1123
 * (sweep 250ms): the 15s `session-controller` tick books its own overshoot
 * so a spike window can answer "was the sweep the blocker".
 */
export type SliceName = 'list' | 'migration' | 'zstd' | 'sweep'

/** Registry shape stored on globalThis; one per host process. */
interface OvershootRegistry {
  readonly slices: Map<string, SliceOvershootStats>
}

/** The cross-instance key: `Symbol.for` returns the same symbol in every module instance. */
const REGISTRY_KEY = Symbol.for('dsh.event-loop-monitor.overshoot')

/** Fetch (or lazily create) the process-wide registry without assuming module identity. */
function registry(): OvershootRegistry {
  const carrier = globalThis as typeof globalThis & Partial<Record<typeof REGISTRY_KEY, OvershootRegistry>>
  const existing = carrier[REGISTRY_KEY]
  if (existing !== undefined) return existing
  const created: OvershootRegistry = { slices: new Map() }
  carrier[REGISTRY_KEY] = created
  return created
}

/**
 * Record one slice that ran past its yield deadline.
 * @param slice - which slice point overshot (`list` / `migration` / `zstd` / `sweep`).
 * @param overMs - milliseconds past the yield deadline (clamped at >= 0).
 */
export function recordOvershoot(slice: SliceName, overMs: number): void {
  const stats = registry().slices.get(slice)
  const at = Date.now()
  if (stats === undefined) {
    registry().slices.set(slice, { count: 1, worstMs: Math.max(0, overMs), lastAt: at })
    return
  }
  stats.count += 1
  stats.worstMs = Math.max(stats.worstMs, Math.max(0, overMs))
  stats.lastAt = at
}

/**
 * Snapshot the cumulative counters (a copy — callers may diff windows
 * without aliasing the live registry).
 * @returns per-slice facts; slices that never overshot are absent.
 */
export function snapshotOvershoots(): Readonly<Record<string, SliceOvershootStats>> {
  const out: Record<string, SliceOvershootStats> = {}
  for (const [slice, stats] of registry().slices) out[slice] = { ...stats }
  return out
}

/** How many overshoots happened between two snapshots (per slice, summing unknown slices too). */
export function overshootDelta(
  previous: Readonly<Record<string, SliceOvershootStats>>,
  current: Readonly<Record<string, SliceOvershootStats>>,
): number {
  let delta = 0
  for (const [slice, stats] of Object.entries(current)) {
    delta += stats.count - (previous[slice]?.count ?? 0)
  }
  return delta
}

/** Drop every counter (tests only; production accumulates for the process lifetime). */
export function resetOvershoots(): void {
  registry().slices.clear()
}
