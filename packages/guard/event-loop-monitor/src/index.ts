/**
 * Event-loop state probe — thin shell over the external sampler's state
 * file (m-note design `event-loop-monitor-offproc-design-1123.md` §六
 * stages 2–3; user ruling 2026-11-24: mechanism A = RTT probe + on-demand
 * external capture, `elu` = external CPU% proxy, package kept as a shell).
 *
 * The in-process watch this package used to be — the
 * `monitorEventLoopDelay` histogram, the ELU delta, the 60 s window tick,
 * the light fold, the conditional aggregate log line, the slice-overshoot
 * registry, the red-window alert fact file, and the loop-report-sign-1123
 * signature/cold-layer output scheme — is retired with this change: a
 * frozen main thread cannot sample itself (the「事后 dump 栈永远是报案人
 * 栈」structural blind spot), and all sampling now lives in an external
 * process (availability gate `rule/dsh-availability-gate.md` §二 first
 * choice「外移出宿主」: external collector computes, the host only reads
 * and answers).
 *
 * What remains is the answer surface the settings card already polls:
 *
 * - `GET /api/event-loop/state` behind the exported
 *   `isLoopbackProbeRequest` fence (non-loopback → 403, non-GET → 405),
 *   serving `<dsh-home>/event-loop-state.json` — the external sampler's
 *   one small file; one read per poll, no timers, no sampling, no writes.
 * - Freshness is the fail-soft contract: the file's own `windowSec`
 *   (default {@link DEFAULT_WINDOW_SEC}) sizes the bound and
 *   {@link FRESHNESS_WINDOWS} × that window is the margin — a fresh file
 *   passes its bytes through verbatim (200); a missing / unreadable /
 *   unparseable / stale file answers 503 {@link STALE_BODY}. Consumers
 *   already treat any non-200 as absent (`pullOne` → `null` → the health
 *   card shows its unavailable line, the frame pill renders no face), so
 *   a dead sampler is a quiet absence, never a broken face
 *   (availability Q4: 面消失 ≠ 面变坏).
 *
 * The config schema keeps every historical key so existing profiles keep
 * loading; only `disable` still has an effect. The sampling keys
 * (`windowSec` / `p99WarnMs` / `maxBadMs`) are held by the external
 * sampler now — accepted and ignored here, with their defaults still the
 * design §二 judgment values (60 s / 250 ms / 2000 ms, zero change).
 *
 * Mounted from `packages/bundle/base/cordis.patch.yml` next to
 * unit-scheduler, `disable` configurable (cordis `disabled:` yml key OR
 * this Config field).
 *
 * @module @deepseek-ai/dsh-event-loop-monitor
 */

import { readFileSync, statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.webServer merge (route registration surface).
import type {} from '@deepseek-ai/dsh-host-webserver'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { isLoopbackProbeRequest } from '@deepseek-ai/dsh-unit-scheduler'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'event-loop-monitor'

/** No hard service requirements: the probe waits for `webServer` in a child fiber (unit-scheduler channel-c shape). */
export const inject: string[] = []

/** The read-only state probe route (channel c, unchanged shape and fence). */
export const STATE_PATH = '/api/event-loop/state'

/** The external sampler's state file under the DSH home (one small file, never a per-tick scheduler query — duty-inventory 先例). */
export const STATE_FILE = 'event-loop-state.json'

/** Freshness default (seconds) when the state file carries no usable `windowSec` — the design §二 window, unchanged. */
export const DEFAULT_WINDOW_SEC = 60

/** Freshness margin: a state file older than {@link FRESHNESS_WINDOWS} × its window reads as stale. */
export const FRESHNESS_WINDOWS = 2

/** Design §二 default p99 warn threshold (ms) — held by the external sampler; kept as the schema default, judgment value unchanged. */
export const DEFAULT_P99_WARN_MS = 250

/** Design §二 default single-block bad threshold (ms) — held by the external sampler; judgment value unchanged. */
export const DEFAULT_MAX_BAD_MS = 2000

/** The stale answer body (fail-soft: consumers read any non-200 as absent, never as broken). */
export const STALE_BODY: Readonly<{ ok: false; error: string }> = Object.freeze({ ok: false, error: 'stale' })

/** Plugin configuration; every field optional, schema supplies the historical defaults. */
export interface Config {
  /**
   * Turn the probe off entirely: no route registers — a disabled
   * component is a quiet absence (the probe 404s through the webserver's
   * unmatched path), never a broken face. The cordis yml-level
   * `disabled: true` key is the other door and skips `apply` entirely.
   */
  disable?: boolean
  /** Retired with internal sampling (held by the external sampler): accepted for profile compatibility, no effect here. Default: 60. */
  windowSec?: number
  /** Retired with internal sampling (held by the external sampler): accepted for profile compatibility, no effect here. Default: 250. */
  p99WarnMs?: number
  /** Retired with internal sampling (held by the external sampler): accepted for profile compatibility, no effect here. Default: 2000. */
  maxBadMs?: number
}

export const Config: z<Config> = z.object({
  disable: z.boolean().default(false),
  windowSec: z.number().default(DEFAULT_WINDOW_SEC),
  p99WarnMs: z.number().default(DEFAULT_P99_WARN_MS),
  maxBadMs: z.number().default(DEFAULT_MAX_BAD_MS),
})

/** The three-state light the external sampler folds (design §二 table; carried verbatim in the state file). */
export type EventLoopLight = 'green' | 'yellow' | 'red'

/**
 * The design slice points (design §一第二层 table: list / migration /
 * zstd) plus the heartbeat sweep added by stall-rootcause-1123 — the
 * state file's `attribution` rows follow this order; the in-process
 * registry that used to book them is retired with the internal watch.
 */
export type SliceName = 'list' | 'migration' | 'zstd' | 'sweep'

/** Slice points in order, for consumers reading the attribution contract. */
export const SLICE_NAMES: readonly SliceName[] = ['list', 'migration', 'zstd', 'sweep']

/** One completed window as the state file's history carries it (shape unchanged). */
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
  /** ELU delta over the window (0..1); externally this is the CPU% proxy (ruling 2026-11-24). */
  elu: number
  /** Whether this window crossed the p99 warn threshold. */
  over: boolean
  /** The light after folding this window. */
  light: EventLoopLight
}

/** Cumulative slice attribution row (shape unchanged; the external sampler may carry an empty list). */
export interface SliceAttribution {
  /** Which slice point. */
  slice: SliceName
  /** Overshoots since the sampler started. */
  count: number
  /** Worst single overshoot (ms past the yield deadline). */
  worstMs: number
  /** Most recent overshoot (ms since epoch); 0 when never. */
  lastAt: number
}

/** Unattributed spike tally (shape unchanged). */
export interface UnattributedSpike {
  /** Windows that spiked without attribution. */
  count: number
  /** Worst unattributed max (ms). */
  worstMs: number
  /** Most recent unattributed spike (ms since epoch); 0 when never. */
  lastAt: number
  /** Captures written for unattributed spikes (external capture leg). */
  dumps: number
}

/** One timeline entry (design §四 block 5: 尖峰 / 红态 / 恢复; shape unchanged). */
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

/**
 * The `GET /api/event-loop/state` payload: the response shape contract,
 * byte-for-byte what the external sampler writes into
 * `<dsh-home>/event-loop-state.json` and this probe passes through.
 */
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
  /** ELU delta of the last completed window (0..1); externally the CPU% proxy. */
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
  /** Cumulative slice-overshoot attribution, design order (list / migration / zstd / sweep); may be empty under the external sampler. */
  attribution: readonly SliceAttribution[]
  /** Unattributed spike tally. */
  unattributed: UnattributedSpike
  /** Bounded event timeline, oldest first. */
  events: readonly EventLoopTimelineEvent[]
}

/**
 * Freshness gate over the external sampler's state file: read → parse
 * (its `windowSec` sizes the bound, {@link DEFAULT_WINDOW_SEC} when
 * absent) → mtime within {@link FRESHNESS_WINDOWS} × that window.
 * Anything the gate cannot prove fresh — missing, unreadable, not a JSON
 * object, or too old — reads as stale. Fail-soft by contract: every
 * failure path returns `undefined` and never throws into the request.
 *
 * @returns the file's bytes to pass through verbatim, or `undefined` when stale.
 */
function readFreshState(): string | undefined {
  try {
    const file = dshHomePath(STATE_FILE)
    const raw = readFileSync(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const windowSec = (parsed as { windowSec?: unknown }).windowSec
    const effectiveWindowSec = typeof windowSec === 'number' && Number.isFinite(windowSec) && windowSec >= 1
      ? windowSec
      : DEFAULT_WINDOW_SEC
    const ageMs = Date.now() - statSync(file).mtimeMs
    if (!Number.isFinite(ageMs) || ageMs > FRESHNESS_WINDOWS * effectiveWindowSec * 1000) return undefined
    return raw
  } catch {
    return undefined
  }
}

/**
 * Register the state probe. Order: honor `disable` first (an off switch
 * that can throw is not an off switch — availability Q4), then wait for a
 * `webServer` carrier in a child fiber so registration never blocks the
 * watch. No timers, no sampling, no writes: the plugin answers one small
 * file per poll.
 *
 * @param ctx - plugin context; the route is scoped to it.
 * @param config - validated {@link Config}; only `disable` has an effect.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.disable === true) return

  // Channel c (design §三.3): the fence runs before the method check so
  // an untrusted caller learns nothing — not even the schema.
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
        const fresh = readFreshState()
        if (fresh === undefined) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(STALE_BODY))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(fresh)
      },
    }), 'event-loop-monitor: GET /api/event-loop/state')
  })
}
