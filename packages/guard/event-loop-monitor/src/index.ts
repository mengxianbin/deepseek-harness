/**
 * Event-loop health watch (design `event-loop-monitor-1108` §二/§三): one
 * plugin that answers "is the main thread stuck" at runtime, in three
 * channels copied from the unit-scheduler P0.5 observation precedent.
 *
 * Layer 1 (what): a `monitorEventLoopDelay({ resolution: 10 })` histogram is
 * enabled for the process lifetime and read once per configurable window
 * (default 60 s) into p50/p99/max/mean (ns → ms), alongside a
 * `performance.eventLoopUtilization()` delta for the same window — the
 * design's "p99 sees the norm, max catches the one long block, ELU separates
 * busy from stuck". Each window also folds the slice-overshoot delta (see
 * `./overshoot.ts`) so a spike can be attributed.
 *
 * Layer 2 (who): histogram spike + slice overshoot in the same window =
 * attributed; spike with no slice overshoot = unattributed, which triggers
 * the light `process.report.getReport()` dump into `.tmp/loop-report/`
 * (cooldown-bounded so a hot loop cannot flood the disk).
 *
 * Layer 3 (don't misread): the state probe serves the same numbers the log
 * line reports, so the settings card can place this histogram next to the
 * unit-scheduler queue card — a full gate queue is deliberate throttling,
 * not a stuck loop.
 *
 * Channels (design §三): (a) ONE conditional aggregate log line per
 * over-threshold window — green stays silent; (b) a red window stamps the
 * `<dsh-home>/event-loop-watch-state.json` fact file (auto-route alarm-pipeline
 * shape: pure facts, fail-soft absence); (c) `GET /api/event-loop/state`
 * behind the exported `isLoopbackProbeRequest` fence. Mounted from
 * `packages/bundle/base/cordis.patch.yml` next to unit-scheduler, `disable`
 * configurable (cordis `disabled:` yml key OR this Config field).
 *
 * @module @deepseek-ai/dsh-event-loop-monitor
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.webServer merge (route registration surface).
import type {} from '@deepseek-ai/dsh-host-webserver'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { isLoopbackProbeRequest } from '@deepseek-ai/dsh-unit-scheduler'
import z from '@deepseek-ai/schemastery'
import { overshootDelta, snapshotOvershoots, type SliceName } from './overshoot.ts'

/**
 * Slice-overshoot accounting, re-exported for the three cooperative-yield
 * slice points (session list loop, log migration decode, zstd frame scan):
 * they CALL `recordOvershoot` at the deadline check they already perform,
 * this plugin READS the same registry each window for attribution. The
 * registry is globalThis-keyed, so one host process shares one accumulator.
 */
export { recordOvershoot, resetOvershoots, snapshotOvershoots } from './overshoot.ts'
export type { SliceName, SliceOvershootStats } from './overshoot.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'event-loop-monitor'

/** No hard service requirements: the probe waits for `webServer` in a child fiber (unit-scheduler channel-c shape). */
export const inject: string[] = []

/** The read-only state probe route (channel c). */
export const STATE_PATH = '/api/event-loop/state'

/** Design §二 default sampling window (seconds). */
export const DEFAULT_WINDOW_SEC = 60

/** Design §二 default p99 warn threshold (ms): 🟢 below, 🟡/🔴 at or above for 1–2 / ≥3 consecutive windows. */
export const DEFAULT_P99_WARN_MS = 250

/** Design §二 default single-block bad threshold (ms): one window above it is at least 🟡. */
export const DEFAULT_MAX_BAD_MS = 2000

/** Design §一 sampling resolution (ms) — matches the design's `resolution: 10`. */
export const HISTOGRAM_RESOLUTION_MS = 10

/** Design §二 red rule: this many consecutive over-windows reddens the light. */
export const RED_WINDOWS = 3

/**
 * Design §二 red rule「ELU>90% 持续」has no window count; this implementation
 * fills the gap by mirroring the ≥3 consecutive-window rule (recorded as a
 * design-gap fill in the task closeout, not a new metric).
 */
export const ELU_HOT_RATIO = 0.9

/** How many consecutive ELU-hot windows redden the light (gap-fill mirror of {@link RED_WINDOWS}). */
export const ELU_HOT_WINDOWS = 3

/** Bounded probe history: at the default window this is two hours of sparkline. */
export const HISTORY_LIMIT = 120

/** Bounded timeline ring (design §四 block 5: spikes / red / recovery, newest kept). */
export const EVENTS_LIMIT = 100

/** Unattributed-spike dump directory, relative to the process cwd (harness `.tmp/` is the sanctioned scratch出口). */
export const DUMP_DIR = join('.tmp', 'loop-report')

/**
 * Cooldown between `process.report` dumps. The design asks for a dump "at the
 * moment the threshold trips"; without a floor a sustained unattributed loop
 * would write one multi-hundred-KB report per window, so the first unattributed
 * spike of a window still dumps and the next ones wait out this floor
 * (availability gate Q3: bounded output, memory and disk).
 */
export const DUMP_COOLDOWN_MS = 10 * 60_000

/** Channel-b fact file under the DSH home (auto-route poll-state shape: pure facts, one writer). */
export const ALERT_STATE_FILE = 'event-loop-watch-state.json'

/** Plugin configuration; every field optional, schema supplies the design defaults. */
export interface Config {
  /**
   * Turn the whole watch off: no histogram, no timer, no probe route, no
   * alert file. Availability Q4 — a disabled component is a quiet absence
   * (the probe 404s through the webserver's unmatched path), never a broken
   * face. The cordis yml-level `disabled: true` key is the other door and
   * skips `apply` entirely; this field covers config-driven disable without
   * editing the yml.
   */
  disable?: boolean
  /** Sampling window in seconds. Default: 60 (design §二). Minimum: 1. */
  windowSec?: number
  /** p99 warn threshold in ms. Default: 250 (design §二). */
  p99WarnMs?: number
  /** Single-block bad threshold in ms. Default: 2000 (design §二). */
  maxBadMs?: number
}

export const Config: z<Config> = z.object({
  disable: z.boolean().default(false),
  windowSec: z.number().default(DEFAULT_WINDOW_SEC),
  p99WarnMs: z.number().default(DEFAULT_P99_WARN_MS),
  maxBadMs: z.number().default(DEFAULT_MAX_BAD_MS),
})

/** The three-state light (design §二). */
export type EventLoopLight = 'green' | 'yellow' | 'red'

/** Consecutive-window counters behind the light; the continuity of over-windows is the disease signal (design §一). */
export interface LightState {
  /** Consecutive windows with `p99 >= p99WarnMs`. */
  consecutiveOver: number
  /** Consecutive windows below the p99 warn threshold. */
  consecutiveNormal: number
  /** Consecutive windows with `elu > 0.9` (gap-fill mirror of the p99 counter). */
  consecutiveEluHot: number
  /** The light this state currently shows. */
  light: EventLoopLight
}

/** Facts of one completed window, in milliseconds / ratio. */
export interface WindowFacts {
  /** p99 event-loop delay over the window (ms). */
  readonly p99: number
  /** Max event-loop delay over the window (ms). */
  readonly max: number
  /** Event-loop utilization delta over the window (0..1). */
  readonly elu: number
}

/** Threshold pair the fold judges against (design §二 config surface). */
export interface EventLoopThresholds {
  /** p99 warn threshold (ms). */
  readonly p99WarnMs: number
  /** Single-block bad threshold (ms). */
  readonly maxBadMs: number
}

/** One completed window as the probe history carries it. */
export interface EventLoopWindow {
  /** Wall clock of the window read (ms since epoch). */
  at: number
  /** p50 delay (ms). */
  p50: number
  /** p99 delay (ms). */
  p99: number
  /** Max delay (ms). */
  max: number
  /** Mean delay (ms). */
  mean: number
  /** ELU delta over the window (0..1). */
  elu: number
  /** Whether this window crossed the p99 warn threshold. */
  over: boolean
  /** The light after folding this window. */
  light: EventLoopLight
}

/** Cumulative slice attribution (design §一第二层): who overshot, how badly, when. */
export interface SliceAttribution {
  /** Which slice point. */
  slice: SliceName
  /** Overshoots since the process loaded. */
  count: number
  /** Worst single overshoot (ms past the yield deadline). */
  worstMs: number
  /** Most recent overshoot (ms since epoch); 0 when never. */
  lastAt: number
}

/** Unattributed spikes: histogram max over threshold with no slice overshoot in the same window. */
export interface UnattributedSpike {
  /** Windows that spikED without attribution. */
  count: number
  /** Worst unattributed max (ms). */
  worstMs: number
  /** Most recent unattributed spike (ms since epoch); 0 when never. */
  lastAt: number
  /** `process.report` dumps written for unattributed spikes. */
  dumps: number
}

/** One timeline entry (design §四 block 5: 尖峰 / 红态 / 恢复). */
export interface EventLoopTimelineEvent {
  /** Wall clock (ms since epoch). */
  at: number
  /** What happened. */
  kind: 'spike' | 'red' | 'recover'
  /** Spike: the window max that tripped (ms). */
  max?: number
  /** Spike: slice points that overshot in the same window; empty = unattributed. */
  slices?: readonly SliceName[]
  /** Recovery: how long the red stretch lasted (ms). */
  redMs?: number
}

/** The `GET /api/event-loop/state` payload: layer-1 metrics, the light, layer-2 attribution, layer-3 timeline. */
export interface EventLoopState {
  /** Wall clock of this snapshot (ms since epoch). */
  at: number
  /** Configured window (seconds). */
  windowSec: number
  /** p50 of the last completed window (ms); 0 before the first window. */
  p50: number
  /** p99 of the last completed window (ms); 0 before the first window. */
  p99: number
  /** Max of the last completed window (ms); 0 before the first window. */
  max: number
  /** Mean of the last completed window (ms); 0 before the first window. */
  mean: number
  /** ELU delta of the last completed window (0..1); 0 before the first window. */
  elu: number
  /** Current light. */
  light: EventLoopLight
  /** Consecutive over-windows right now. */
  consecutiveOver: number
  /** Consecutive normal windows right now (the「已连续 N 窗正常」gauge). */
  consecutiveNormal: number
  /** Windows over the p99 warn threshold since load (the design §一「超阈次数」lifetime count). */
  overWindows: number
  /** Bounded window history for the sparkline, oldest first. */
  history: readonly EventLoopWindow[]
  /** Cumulative slice-overshoot attribution, design order (list / migration / zstd). */
  attribution: readonly SliceAttribution[]
  /** Unattributed spike tally. */
  unattributed: UnattributedSpike
  /** Bounded event timeline, oldest first. */
  events: readonly EventLoopTimelineEvent[]
}

/** The starting light state (all counters zero, green). */
export const INITIAL_LIGHT_STATE: LightState = {
  consecutiveOver: 0,
  consecutiveNormal: 0,
  consecutiveEluHot: 0,
  light: 'green',
}

/** The three slice points in design order (design §一第二层 table). */
export const SLICE_NAMES: readonly SliceName[] = ['list', 'migration', 'zstd']

/**
 * Fold one window into the light state — the design §二 table as a pure
 * function: 🟢 `p99 < p99WarnMs` and no max breach; 🟡 p99 over for 1–2
 * consecutive windows or a single window above `maxBadMs`; 🔴 ≥3
 * consecutive over-windows or ≥3 consecutive ELU-hot windows. A window back
 * under the threshold resets the consecutive-over counter, so recovery is
 * automatic (the light never latches).
 *
 * @param previous - counters carried from the previous window.
 * @param facts - this window's p99 / max / elu.
 * @param thresholds - configured warn/bad thresholds.
 * @returns the folded state for this window.
 */
export function foldWindow(previous: LightState, facts: WindowFacts, thresholds: EventLoopThresholds): LightState {
  const over = facts.p99 >= thresholds.p99WarnMs
  const maxBreach = facts.max > thresholds.maxBadMs
  const eluHot = facts.elu > ELU_HOT_RATIO
  const consecutiveOver = over ? previous.consecutiveOver + 1 : 0
  const consecutiveEluHot = eluHot ? previous.consecutiveEluHot + 1 : 0
  const light: EventLoopLight = consecutiveOver >= RED_WINDOWS || consecutiveEluHot >= ELU_HOT_WINDOWS
    ? 'red'
    : over || maxBreach ? 'yellow' : 'green'
  return {
    consecutiveOver,
    consecutiveNormal: over ? 0 : previous.consecutiveNormal + 1,
    consecutiveEluHot,
    light,
  }
}

/** Format one duration the way the design §三.2 example does: `412ms` below a second, `2.1s` at or above. */
function formatDelay(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

/**
 * The conditional aggregate log line (channel a, design §三.2 verbatim
 * shape): `event-loop: p99 412ms max 2.1s elu 63% over 60s window`. Green
 * windows return `undefined` — silence is the design's default state; only
 * an over-threshold light (yellow or red) speaks, once per window.
 *
 * @param facts - the completed window's numbers.
 * @param light - the light after folding this window.
 * @param windowSec - the configured window, for the line's suffix.
 * @returns the line to log, or `undefined` while green.
 */
export function formatAggregateLine(facts: WindowFacts, light: EventLoopLight, windowSec: number): string | undefined {
  if (light === 'green') return undefined
  const p99 = `${Math.round(facts.p99)}ms`
  const max = formatDelay(facts.max)
  const elu = `${Math.round(facts.elu * 100)}%`
  return `event-loop: p99 ${p99} max ${max} elu ${elu} over ${windowSec}s window`
}

/** Nanoseconds → milliseconds with a zero floor (an empty histogram reads NaN). */
function nsToMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? value / 1e6 : 0
}

/** Which design slice points overshot between two registry snapshots (same window). */
function slicesOvershot(
  previous: Readonly<Record<string, { count: number }>>,
  current: Readonly<Record<string, { count: number }>>,
): SliceName[] {
  const out: SliceName[] = []
  for (const slice of SLICE_NAMES) {
    if ((current[slice]?.count ?? 0) > (previous[slice]?.count ?? 0)) out.push(slice)
  }
  return out
}

/**
 * Write the unattributed-spike forensics dump (`process.report.getReport()`,
 * the design's light option) into {@link DUMP_DIR}. Fail-soft by contract:
 * a dump failure is logged by the caller and never breaks the watch.
 * @returns the file path, or `undefined` when the report or the write failed.
 */
function writeLoopReport(): string | undefined {
  try {
    // `process.report` types as always present; a runtime absence (or any
    // throw below) lands in the catch and degrades to the same undefined.
    const report = process.report.getReport()
    mkdirSync(DUMP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    const file = join(DUMP_DIR, `loop-report-${stamp}.json`)
    writeFileSync(file, JSON.stringify(report))
    return file
  } catch {
    return undefined
  }
}

/**
 * Register the event-loop watch. Order: honor `disable` first (a disabled
 * component must never fail loud — availability Q4), then resolve + validate
 * the config, enable the histogram for the process lifetime, and arm the
 * unref'd window tick plus the child-fiber probe route.
 *
 * @param ctx - plugin context; every timer and route is scoped to it.
 * @param config - validated {@link Config}; range checks fail loud at load.
 */
export function apply(ctx: Context, config: Config): void {
  // Disable before validation: an off switch that can throw is not an off switch.
  if (config.disable === true) return
  const windowSec = config.windowSec ?? DEFAULT_WINDOW_SEC
  const p99WarnMs = config.p99WarnMs ?? DEFAULT_P99_WARN_MS
  const maxBadMs = config.maxBadMs ?? DEFAULT_MAX_BAD_MS
  if (!Number.isFinite(windowSec) || windowSec < 1) {
    throw new Error(`event-loop-monitor: invalid windowSec ${windowSec} — must be a number >= 1`)
  }
  if (!Number.isFinite(p99WarnMs) || p99WarnMs < 1) {
    throw new Error(`event-loop-monitor: invalid p99WarnMs ${p99WarnMs} — must be a number >= 1`)
  }
  if (!Number.isFinite(maxBadMs) || maxBadMs < 1) {
    throw new Error(`event-loop-monitor: invalid maxBadMs ${maxBadMs} — must be a number >= 1`)
  }
  const thresholds: EventLoopThresholds = { p99WarnMs, maxBadMs }

  // Layer 1: the histogram samples for the process lifetime; each tick reads
  // it and resets, so one window's numbers feed the line, the probe and the
  // light alike.
  const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS })
  histogram.enable()
  ctx.effect(() => () => { histogram.disable() }, 'event-loop-monitor: delay histogram')

  const history: EventLoopWindow[] = []
  const events: EventLoopTimelineEvent[] = []
  const unattributed: UnattributedSpike = { count: 0, worstMs: 0, lastAt: 0, dumps: 0 }
  let lightState: LightState = INITIAL_LIGHT_STATE
  let overWindows = 0
  let redSince: number | undefined
  let lastDumpAt = 0
  let alertWarned = false
  let prevEluSample = performance.eventLoopUtilization()
  let prevOvershoots = snapshotOvershoots()

  const pushEvent = (event: EventLoopTimelineEvent): void => {
    events.push(event)
    while (events.length > EVENTS_LIMIT) events.shift()
  }

  // Channel b (design §三.4): the alert fact file — auto-route poll-state
  // shape (pure facts, fail-soft). Absence means "never red", never "broken".
  const writeAlertState = (payload: Record<string, unknown>): void => {
    try {
      writeFileSync(dshHomePath(ALERT_STATE_FILE), JSON.stringify(payload))
      alertWarned = false
    } catch (error) {
      if (alertWarned) return
      alertWarned = true
      ctx.logger.warn(
        `event-loop-monitor: alert state write failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const tick = (): void => {
    const now = Date.now()
    const facts = {
      p50: nsToMs(histogram.percentile(50)),
      p99: nsToMs(histogram.percentile(99)),
      max: nsToMs(histogram.max),
      mean: nsToMs(histogram.mean),
    }
    histogram.reset()
    const eluDelta = performance.eventLoopUtilization(prevEluSample)
    prevEluSample = performance.eventLoopUtilization()
    const elu = Number.isFinite(eluDelta.utilization) ? eluDelta.utilization : 0

    // Layer 2: attribute this window before the light folds, so a spike and
    // its slice overshoot are judged on the same window boundary.
    const currentOvershoots = snapshotOvershoots()
    const overshootsInWindow = slicesOvershot(prevOvershoots, currentOvershoots)
    const overshootsInWindowCount = overshootDelta(prevOvershoots, currentOvershoots)
    prevOvershoots = currentOvershoots

    const wasRed = lightState.light === 'red'
    lightState = foldWindow(lightState, { p99: facts.p99, max: facts.max, elu }, thresholds)
    if (facts.p99 >= p99WarnMs) overWindows += 1

    history.push({
      at: now, ...facts, elu, over: facts.p99 >= p99WarnMs, light: lightState.light,
    })
    while (history.length > HISTORY_LIMIT) history.shift()

    // Spike attribution (design §一第二层): max over the bad threshold with
    // no slice overshoot in this window = unattributed → dump the scene.
    if (facts.max > maxBadMs) {
      if (overshootsInWindowCount > 0) {
        pushEvent({ at: now, kind: 'spike', max: facts.max, slices: overshootsInWindow })
      } else {
        unattributed.count += 1
        unattributed.worstMs = Math.max(unattributed.worstMs, facts.max)
        unattributed.lastAt = now
        pushEvent({ at: now, kind: 'spike', max: facts.max, slices: [] })
        if (now - lastDumpAt >= DUMP_COOLDOWN_MS) {
          lastDumpAt = now
          const file = writeLoopReport()
          if (file === undefined) ctx.logger.warn('event-loop-monitor: unattributed spike report dump failed')
          else unattributed.dumps += 1
        }
      }
    }

    // Red stretch bookkeeping + the recovery event with its duration
    // (design §四 block 5: 红态标持续时长).
    if (lightState.light === 'red' && !wasRed) {
      redSince = now
      pushEvent({ at: now, kind: 'red' })
    } else if (wasRed && lightState.light !== 'red') {
      const redMs = Math.max(0, now - (redSince ?? now))
      pushEvent({ at: now, kind: 'recover', redMs })
      writeAlertState({
        at: now, light: lightState.light, windowSec, recoveredAt: now, redSince: redSince ?? now, redDurationMs: redMs,
      })
      redSince = undefined
    }

    // Channel b: every red window stamps fresh facts (a reader judges
    // freshness from mtime, so a stale file means the writer stopped).
    if (lightState.light === 'red') {
      writeAlertState({
        at: now, light: 'red', windowSec, p99: facts.p99, max: facts.max, elu,
        consecutiveOver: lightState.consecutiveOver, unattributed: unattributed.count,
      })
    }

    // Channel a: green is silent, yellow and red speak once per window.
    const line = formatAggregateLine({ p99: facts.p99, max: facts.max, elu }, lightState.light, windowSec)
    if (line !== undefined) ctx.logger.info(line)
  }

  ctx.effect(() => {
    const timer = setInterval(tick, windowSec * 1000)
    timer.unref()
    return () => { clearInterval(timer) }
  }, 'event-loop-monitor: window tick')

  const buildState = (): EventLoopState => {
    const last = history.length > 0 ? history[history.length - 1] : undefined
    const current = snapshotOvershoots()
    const attribution: SliceAttribution[] = SLICE_NAMES.map((slice) => {
      const stats = current[slice]
      return {
        slice,
        count: stats?.count ?? 0,
        worstMs: stats?.worstMs ?? 0,
        lastAt: stats?.lastAt ?? 0,
      }
    })
    return {
      at: Date.now(),
      windowSec,
      p50: last?.p50 ?? 0,
      p99: last?.p99 ?? 0,
      max: last?.max ?? 0,
      mean: last?.mean ?? 0,
      elu: last?.elu ?? 0,
      light: lightState.light,
      consecutiveOver: lightState.consecutiveOver,
      consecutiveNormal: lightState.consecutiveNormal,
      overWindows,
      history: [...history],
      attribution,
      unattributed: { ...unattributed },
      events: [...events],
    }
  }

  // Channel c (design §三.3): the probe waits for a carrier in a child fiber
  // so the watch never blocks on one; the fence runs before the method check
  // so an untrusted caller learns nothing — not even the schema.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: (req, res) => {
        if (!isLoopbackProbeRequest(req)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: 'forbidden: loopback-only' }))
          return
        }
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(buildState()))
      },
    }), 'event-loop-monitor: GET /api/event-loop/state')
  })
}
