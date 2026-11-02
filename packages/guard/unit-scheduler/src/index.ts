/**
 * Cross-session unit-operation scheduling gate (P0 static). Every session's
 * tool execution runs through one host-process pipeline (`tools/execute`), so
 * an around-dispatch wrapper here is the single point where local execution
 * can be held back: slot-holding calls queue on ONE host-global semaphore — a
 * GOMAXPROCS-shaped budget — instead of every session running at full
 * parallelism and saturating CPU/disk.
 *
 * Scheduling shape (P0 static):
 * - a fixed global slot budget (default `max(1, availableParallelism() - 4)`),
 * - a per-session held-slot cap (default 2) so one session cannot eat the pool,
 * - FIFO waiting — priority tiers are deferred: the host has no reliable
 *   "human is interacting" signal today, so FIFO + the per-session cap is the
 *   documented P0 intermediate,
 * - bounded wait with **fail-open**: a waiter that outlives `waitTimeoutMs` is
 *   released WITHOUT a slot and the release is logged — never hang a session
 *   (same precedent as the heavy-IO gate's timed fail-open).
 *
 * Deadlock-avoidance rules (the three iron laws):
 * 1. A slot is held only across the local execution segment: acquired right
 *    before delegating `next()` and released as soon as it settles; waiting on
 *    LLM streams happens outside this wrapper entirely.
 * 2. Tools are split into two classes. Pass-through ("wait on someone else")
 *    tools — {@link DEFAULT_PASS_THROUGH_TOOLS} plus configured
 *    `passThroughTools` patterns — never touch the semaphore; that is what
 *    breaks the classic ring (a tool holding a slot while waiting for
 *    `job_output` or a subagent whose own tool calls need slots). Everything
 *    else, INCLUDING UNKNOWN TOOLS, holds a slot (fail-closed: rather control
 *    too much than leak).
 * 3. Reentrancy: a nested dispatch that happens while an ancestor execution
 *    already holds a slot (composite tools such as PTC sub-calls) rides the
 *    ancestor's slot via `AsyncLocalStorage` — an accounting offset that
 *    neither queues nor consumes a second slot. Tools that wait on derived
 *    sessions (`subagent`, `workflow`, `squads_*`) are pass-through instead,
 *    so children book their own slots against the same semaphore with the same
 *    bounded fail-open wait.
 *
 * Known boundary (P0): a background job spawned by a slot-holding tool keeps
 * running after that tool call settles, so the job's own runtime is not
 * gated here; `job_output` stays pass-through so waiting for it can never
 * close a ring.
 *
 * Observation layer (P0.5, plan §4.2 three channels): the gate COUNTS what it
 * already does and never feeds those counts back into a scheduling decision.
 * Channel a prints one conditional aggregate log line every five minutes,
 * channel c serves `GET /api/unit-scheduler/state` behind a loopback fence,
 * and both read the same internal {@link UnitSlotSemaphore.stats} counters —
 * held slots, the queue and its oldest wait, granted-wait percentiles over a
 * rolling window, and the fail-open tally split by cause (the M1 attribution
 * field). Scheduling defaults, FIFO order, the pass-through list, the three
 * iron laws and the fail-open semantics above are untouched by this layer.
 *
 * @module @deepseek-ai/dsh-unit-scheduler
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage } from 'node:http'
import { availableParallelism } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'unit-scheduler'

/** The tool registry service this plugin wraps (`tools/execute`). */
export const inject = ['tools']

/**
 * Plugin configuration. Every field is optional; the schema supplies the
 * static defaults and `maxSlots` is derived from the machine when omitted
 * (see {@link defaultMaxSlots}). Misconfiguration fails loud at plugin load
 * — the checks in `apply` throw instead of silently falling back.
 */
export interface Config {
  /**
   * Host-global slot budget across all sessions. Default: the value returned
   * by {@link defaultMaxSlots} — `max(1, availableParallelism() - 4)` —
   * computed when the plugin loads, so the machine keeps core headroom.
   */
  maxSlots?: number
  /**
   * Per-session held-slot cap: the most slots ONE session may hold at once,
   * no matter how many calls it dispatches in parallel. Default: 2 (a session
   * can run a couple of local operations but cannot starve the other
   * sessions; extra calls wait in the shared FIFO queue).
   */
  maxSlotsPerSession?: number
  /**
   * Bounded wait for a slot before the fail-open release, in milliseconds.
   * Default: 60000. When the wait outlives this budget the call is released
   * WITHOUT a slot and the release is logged — the session makes progress
   * instead of hanging. Set to 0 to release immediately whenever all slots
   * (or this session's slots) are taken.
   */
  waitTimeoutMs?: number
  /**
   * Extra pass-through tool-name patterns layered over
   * {@link DEFAULT_PASS_THROUGH_TOOLS} (each pattern is an exact name or a
   * `*` wildcard such as `browser_*`). Pass-through tools wait on someone
   * else — a human, the network, a background job, a derived session — so
   * they never occupy a slot. Names NOT matched here (including tool names
   * this plugin has never heard of) hold a slot: fail-closed by design.
   */
  passThroughTools?: string[]
}

export const Config: z<Config> = z.object({
  // No schema default: the machine-derived budget is computed in `apply`
  // (this schemastery leaves a key without `.default()`/`.required()` absent
  // on output, which is exactly the "omitted → derive" contract).
  maxSlots: z.number(),
  maxSlotsPerSession: z.number().default(2),
  waitTimeoutMs: z.number().default(60_000),
  passThroughTools: z.array(z.string()).default([]),
})

/**
 * The built-in pass-through coverage list: tools whose execution is a wait on
 * someone/something else (human answer, network, background job, derived
 * session, external browser), so holding a slot across them would waste the
 * budget — and, for job/subagent waits, could close a deadlock ring.
 */
export const DEFAULT_PASS_THROUGH_TOOLS: readonly string[] = [
  // Waits for a human answer.
  'ask_user_question',
  // Waits on / administers background jobs (the documented ring-breaker).
  'job_output',
  'job_list',
  'job_kill',
  // Waits on the network.
  'web_fetch',
  'web_search',
  // Waits on derived sessions; the children book their own slots.
  'subagent',
  'subagent_fork',
  'workflow',
  'squads_run_member',
  'squads_run_squad',
  // Waits for the user to act in the UI.
  'ui_present',
  // Waits on an external browser (CDP), not on local execution.
  'browser_*',
]

/**
 * The default global slot budget: leave four cores of headroom for the host
 * process itself and the interactive machine, but never fall below one slot.
 *
 * @returns `max(1, availableParallelism() - 4)` for this machine.
 */
export function defaultMaxSlots(): number {
  return Math.max(1, availableParallelism() - 4)
}

/** Compile one `*`-wildcard tool-name pattern to an anchored RegExp (every other regex metacharacter matches literally). */
function compilePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * Build the pass-through predicate for this plugin instance: the built-in
 * coverage list plus the configured extra patterns. Exact names and `*`
 * wildcards are supported; anything not matched is slot-holding (fail-closed).
 *
 * @param extraPatterns - additional pass-through patterns from `Config.passThroughTools`.
 * @returns A predicate telling whether a tool name skips the semaphore.
 */
export function compilePassThrough(extraPatterns: readonly string[] = []): (toolName: string) => boolean {
  const patterns = [...DEFAULT_PASS_THROUGH_TOOLS, ...extraPatterns].map(compilePattern)
  return (toolName: string): boolean => patterns.some(pattern => pattern.test(toolName))
}

/** Session key used when a direct `ctx.tools.execute()` caller carries no agent: one shared anonymous bucket. */
const NO_AGENT_SESSION_KEY = '#no-agent'

/** The read-only state probe route (plan §4.2c channel c). */
export const STATE_PATH = '/api/unit-scheduler/state'

/**
 * Channel a's cadence (plan §4.2a「每 5min」): one conditional aggregate log
 * line per interval, printed only when the queue is non-empty or a fail-open
 * happened since the previous tick.
 */
export const AGGREGATION_INTERVAL_MS = 5 * 60_000

/**
 * Rolling window behind {@link UnitSchedulerState.waitP50} and
 * {@link UnitSchedulerState.waitP95} (plan §4.2c `waitP50/P95(win)`): exactly
 * one {@link AGGREGATION_INTERVAL_MS}, so one percentile read covers the same
 * span one aggregate line reports. Samples age out on every read and on every
 * new sample; the five-minute tick reads continuously, so a quiet gate never
 * accumulates stale waits.
 */
export const WAIT_WINDOW_MS = AGGREGATION_INTERVAL_MS

/**
 * Which grant gate kept a waiter queued until its bounded wait expired — the
 * P0.5 split of `#canGrant`'s two short-circuited conditions (plan §4.2a
 * 分因, the M1 attribution field):
 * - `global-full` — 「全局满」: every slot is held (`held >= maxSlots`);
 * - `session-cap` — 「本会话 cap=2 挤兑」: the pool has room, but this owner
 *   session already holds `maxSlotsPerSession` slots.
 */
export type FailOpenCause = 'global-full' | 'session-cap'

/** Cumulative fail-open tally carried by {@link UnitSchedulerState}. */
export interface FailOpenStats {
  /** Fail-open releases since the plugin loaded. */
  total: number
  /** Enqueue→expiry elapsed time of the most recent fail-open (ms); 0 when there has been none. */
  lastMs: number
  /** Wall clock of the most recent fail-open (ms since epoch); 0 when there has been none. */
  lastAt: number
  /** Cause of the most recent fail-open; `null` while the gate has never failed open. */
  cause: FailOpenCause | null
}

/**
 * The `GET /api/unit-scheduler/state` payload — plan §4.2c schema verbatim.
 * A read-only projection of the live gate: nothing in here feeds back into a
 * scheduling decision.
 */
export interface UnitSchedulerState {
  /** Wall clock of this snapshot (ms since epoch). */
  at: number
  /** Configured host-global slot budget. */
  maxSlots: number
  /** Slots currently held across all sessions. */
  held: number
  /** Slots currently held, per owner session; a session holding none is absent. */
  heldBySession: Readonly<Record<string, number>>
  /** Waiters currently queued for a slot. */
  queued: number
  /** Age of the oldest queued waiter (ms); 0 when the queue is empty. */
  queueOldestMs: number
  /** p50 of granted enqueue→grant waits inside {@link WAIT_WINDOW_MS} (ms); 0 with no sample. */
  waitP50: number
  /** p95 of the same window (ms); 0 with no sample. */
  waitP95: number
  /** Fail-open tally (plan §4.2c). */
  failOpen: FailOpenStats
}

/** What the semaphore's `stats()` returns: the probe payload plus the per-cause tallies its fixed schema omits. */
export interface UnitSchedulerStats {
  /** The plan §4.2c payload, exactly as the endpoint serves it. */
  readonly state: UnitSchedulerState
  /** Cumulative fail-open count per cause — the aggregate line's 分因 suffix. */
  readonly failOpenByCause: Readonly<Record<FailOpenCause, number>>
}

/** Outcome of one bounded-wait acquisition: either a held slot with its release, or an ordered release without one. */
type SlotAcquireOutcome =
  | { readonly acquired: true; readonly waitedMs: number; release(): void }
  | { readonly acquired: false; readonly reason: 'fail-open' | 'aborted'; readonly waitedMs: number }

/** One queued acquisition request. `settled` guards the three release paths (grant / timeout / abort) against double resolution. */
interface Waiter {
  readonly sessionKey: string
  readonly enqueuedAt: number
  readonly resolve: (outcome: SlotAcquireOutcome) => void
  readonly signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  settled: boolean
}

interface UnitSlotSemaphoreOptions {
  /** Global slot budget (integer >= 1). */
  readonly maxSlots: number
  /** Per-session held-slot cap (integer >= 1). */
  readonly maxPerSession: number
  /** Default bounded wait in milliseconds (finite, >= 0). */
  readonly defaultWaitMs: number
}

/**
 * The host-global slot semaphore: a fixed budget, a per-session held-slot
 * cap, FIFO waiting (skipping waiters whose session is already at its cap),
 * and a bounded wait whose expiry fails OPEN — the waiter is released
 * without a slot rather than left hanging.
 */
class UnitSlotSemaphore {
  readonly #maxSlots: number
  readonly #maxPerSession: number
  readonly #defaultWaitMs: number
  #held = 0
  readonly #heldBySession = new Map<string, number>()
  readonly #queue: Waiter[] = []
  /** Granted enqueue→grant waits inside {@link WAIT_WINDOW_MS}, oldest first. */
  readonly #waitSamples: { at: number; ms: number }[] = []
  /** Fail-open tally: total, the most recent event's wait/time/cause, and the per-cause split. */
  #failOpenTotal = 0
  #failOpenLastMs = 0
  #failOpenLastAt = 0
  #failOpenCause: FailOpenCause | null = null
  readonly #failOpenByCause: Record<FailOpenCause, number> = { 'global-full': 0, 'session-cap': 0 }

  constructor(options: UnitSlotSemaphoreOptions) {
    this.#maxSlots = options.maxSlots
    this.#maxPerSession = options.maxPerSession
    this.#defaultWaitMs = options.defaultWaitMs
  }

  /**
   * Take a slot for `sessionKey`, waiting at most `waitMs` (defaulting to
   * the configured bounded wait). The FIFO queue grants to the first waiter
   * whose session is under its cap whenever a global slot is free; a waiter
   * over its session's cap never blocks other sessions from being granted.
   *
   * @param sessionKey - owner-session accounting key (agent/session id).
   * @param signal - caller cancellation: aborting settles as `aborted` at once.
   * @param waitMs - override of the bounded wait (tests inject short budgets).
   * @returns The acquisition outcome with a one-shot `release()` when granted.
   */
  async acquire(sessionKey: string, signal?: AbortSignal, waitMs?: number): Promise<SlotAcquireOutcome> {
    if (signal?.aborted === true) return { acquired: false, reason: 'aborted', waitedMs: 0 }
    const budgetMs = waitMs ?? this.#defaultWaitMs
    return new Promise<SlotAcquireOutcome>((resolve) => {
      const waiter: Waiter = { sessionKey, enqueuedAt: Date.now(), resolve, signal, onAbort: undefined, timer: undefined, settled: false }
      this.#queue.push(waiter)
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.#settle(waiter, { acquired: false, reason: 'aborted', waitedMs: Date.now() - waiter.enqueuedAt })
        }
        waiter.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
      waiter.timer = setTimeout(() => {
        const waitedMs = Date.now() - waiter.enqueuedAt
        // Tally the expiry (with its cause) before resolving, so the caller's
        // fail-open warn and any probe read see the same accounting.
        this.#recordFailOpen(waiter.sessionKey, waitedMs)
        this.#settle(waiter, { acquired: false, reason: 'fail-open', waitedMs })
      }, budgetMs)
      // Grant synchronously when the budget already allows it; otherwise the
      // waiter stays queued until a release (or the bounded wait expires).
      this.#drain()
    })
  }

  /**
   * Read the P0.5 observation counters (plan §4.4 `stats()`): one coherent
   * snapshot of the live gate plus the cumulative fail-open tally. A read
   * changes no scheduling state and disturbs no waiter.
   * @returns the plan §4.2c payload and the per-cause tally it omits.
   */
  stats(): UnitSchedulerStats {
    const now = Date.now()
    this.#pruneWaits(now)
    const heldBySession: Record<string, number> = {}
    for (const [sessionKey, held] of this.#heldBySession) heldBySession[sessionKey] = held
    // Settled waiters are dequeued as they settle; filtering keeps the probe
    // honest even if a release path ever leaves one behind.
    const queued = this.#queue.filter(waiter => !waiter.settled)
    const oldest = queued[0]
    const { p50, p95 } = this.#percentiles()
    return {
      state: {
        at: now,
        maxSlots: this.#maxSlots,
        held: this.#held,
        heldBySession,
        queued: queued.length,
        queueOldestMs: oldest === undefined ? 0 : Math.max(0, now - oldest.enqueuedAt),
        waitP50: p50,
        waitP95: p95,
        failOpen: {
          total: this.#failOpenTotal,
          lastMs: this.#failOpenLastMs,
          lastAt: this.#failOpenLastAt,
          cause: this.#failOpenCause,
        },
      },
      failOpenByCause: { ...this.#failOpenByCause },
    }
  }

  /**
   * Which grant gate denies `sessionKey` one more slot right now — the two
   * conditions of the P0 `#canGrant`, split so a fail-open can record WHICH
   * one blocked (plan §4.2a 分因). Evaluation order is unchanged: the global
   * pool is checked first, then the per-session cap, so `#canGrant` keeps
   * exactly its P0 meaning.
   * @param sessionKey - owner-session accounting key.
   * @returns `global-full`, `session-cap`, or `undefined` when the session may hold one more slot.
   */
  #denyCause(sessionKey: string): FailOpenCause | undefined {
    if (this.#held >= this.#maxSlots) return 'global-full'
    if ((this.#heldBySession.get(sessionKey) ?? 0) >= this.#maxPerSession) return 'session-cap'
    return undefined
  }

  /** Whether `sessionKey` may hold one more slot right now. */
  #canGrant(sessionKey: string): boolean {
    return this.#denyCause(sessionKey) === undefined
  }

  /** Grant to the FIFO-first grantable waiter while global slots are free (skipping sessions at their cap). */
  #drain(): void {
    while (true) {
      if (this.#held >= this.#maxSlots) return
      const index = this.#queue.findIndex(waiter => !waiter.settled && this.#canGrant(waiter.sessionKey))
      if (index === -1) return
      const [waiter] = this.#queue.splice(index, 1)
      if (waiter === undefined) return
      this.#grant(waiter)
    }
  }

  /** Count the slot against the session, arm the one-shot release, and resolve the waiter as granted. */
  #grant(waiter: Waiter): void {
    this.#held += 1
    this.#heldBySession.set(waiter.sessionKey, (this.#heldBySession.get(waiter.sessionKey) ?? 0) + 1)
    // P0.5: this wait BECAME a grant, so it is the sample behind waitP50/P95
    // (fail-open and aborted waits never became grants; they are tallied apart).
    this.#recordWait(Date.now() - waiter.enqueuedAt)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.#held -= 1
      const held = (this.#heldBySession.get(waiter.sessionKey) ?? 1) - 1
      if (held <= 0) this.#heldBySession.delete(waiter.sessionKey)
      else this.#heldBySession.set(waiter.sessionKey, held)
      // Freeing a slot may unblock this session's own waiter (cap dropped)
      // or any other session's FIFO head.
      this.#drain()
    }
    this.#settle(waiter, { acquired: true, waitedMs: Date.now() - waiter.enqueuedAt, release })
  }

  /** Resolve a waiter exactly once, disarming its timer and abort listener and dequeueing it. */
  #settle(waiter: Waiter, outcome: SlotAcquireOutcome): void {
    if (waiter.settled) return
    waiter.settled = true
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    const index = this.#queue.indexOf(waiter)
    if (index !== -1) this.#queue.splice(index, 1)
    waiter.resolve(outcome)
  }

  /**
   * Keep one granted enqueue→grant wait for the percentile window.
   * @param waitedMs - the enqueue→grant elapsed time just observed.
   */
  #recordWait(waitedMs: number): void {
    const now = Date.now()
    this.#waitSamples.push({ at: now, ms: waitedMs })
    this.#pruneWaits(now)
  }

  /** Drop window-expired wait samples; samples are appended in time order, so the first live one bounds the expired prefix. */
  #pruneWaits(now: number): void {
    const cutoff = now - WAIT_WINDOW_MS
    const keepFrom = this.#waitSamples.findIndex(sample => sample.at >= cutoff)
    if (keepFrom === -1) {
      this.#waitSamples.length = 0
      return
    }
    if (keepFrom > 0) this.#waitSamples.splice(0, keepFrom)
  }

  /**
   * Nearest-rank percentiles over the windowed granted waits: rank
   * `ceil(p · n)` of the ascending samples (the classic definition, so the
   * p95 of ten samples is the largest of them rather than an interpolation
   * between the ninth and tenth).
   * @returns p50/p95 in milliseconds; 0 for both while the window is empty.
   */
  #percentiles(): { p50: number; p95: number } {
    const sorted = this.#waitSamples.map(sample => sample.ms).sort((a, b) => a - b)
    const at = (p: number): number => {
      if (sorted.length === 0) return 0
      const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)))
      return sorted[rank - 1] ?? 0
    }
    return { p50: at(0.5), p95: at(0.95) }
  }

  /**
   * Count one bounded-wait expiry together with the gate that kept its waiter
   * queued (the plan §4.2a 分因 split performed by `#denyCause`).
   * @param sessionKey - the owner session whose budget expired.
   * @param waitedMs - the enqueue→expiry elapsed time.
   */
  #recordFailOpen(sessionKey: string, waitedMs: number): void {
    // At expiry the waiter is queue-resident, and `#drain` never leaves a
    // grantable waiter queued, so one of the two gates is always closed here;
    // `session-cap` names that unreachable third state so the tally stays total.
    const cause = this.#denyCause(sessionKey) ?? 'session-cap'
    this.#failOpenTotal += 1
    this.#failOpenLastMs = waitedMs
    this.#failOpenLastAt = Date.now()
    this.#failOpenCause = cause
    this.#failOpenByCause[cause] += 1
  }
}

/**
 * The request facts the loopback fence reads; a Node `IncomingMessage`
 * supplies both members structurally.
 */
export interface ProbeRequest {
  readonly headers: IncomingMessage['headers']
  readonly socket: { readonly remoteAddress: string | undefined }
}

/** Whether a decimal IPv4 literal lies in 127/8 (RFC 5735 loopback). */
function isIPv4Loopback(value: string): boolean {
  const octets = value.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

/** Whether a socket peer address names loopback: 127/8, `::1`, or the IPv4-mapped form of either. */
function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a parsed URL hostname names loopback: `localhost`, `[::1]`, or a 127/8 literal. */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || isIPv4Loopback(hostname)
}

/**
 * The state probe's fence — plan §4.2c「自写 loopback 判定」: a request passes
 * only when the SOCKET peer is loopback AND the Host header names a loopback
 * authority AND any browser same-origin markers agree (`sec-fetch-site:
 * cross-site` is refused outright; an attached Origin must be exactly the Host
 * authority). The socket address is authoritative and `X-Forwarded-For` is
 * never read, so a DNS-rebound or cross-site page is refused the same way the
 * dsh-web sysmon route refuses it — loopback 恒过, everything else 403.
 *
 * The precedent's second door (a paired remote-web-ui device cookie) is
 * deliberately NOT reimplemented: until the P1 chip batch (plan §4.4) the
 * only consumer is a loopback `curl`, and the alternative fence offered by
 * the plan — mounting the gateway's browserAuth — would answer 401 to exactly
 * that caller. The trade is recorded in this change's fence reconciliation
 * note; extending the probe to a paired remote browser belongs to P1.
 *
 * @param request - the incoming request (headers plus socket peer address).
 * @returns true only for a loopback caller speaking for this loopback authority.
 */
export function isLoopbackProbeRequest(request: ProbeRequest): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Compact age for the `…/last …` field: seconds below a minute, hours past an hour. */
function formatAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  return `${String(Math.floor(minutes / 60))}h`
}

/**
 * The conditional aggregate log line (channel a, plan §4.2a): printed once per
 * {@link AGGREGATION_INTERVAL_MS} and only when there is something to report —
 * a non-empty queue, or at least one fail-open since the previous tick. The
 * shape follows the plan verbatim (`unit-scheduler: held 8/12 queued 3
 * wait-p95 420ms fail-open 1/last 12m`) with the per-cause tally appended, so
 * a grep of the host log carries both the timeline and the M1 attribution.
 *
 * @param state - the snapshot describing this tick.
 * @param failOpensSinceTick - fail-opens counted since the previous tick.
 * @param failOpenByCause - cumulative per-cause tally (the 分因 suffix).
 * @returns the line to log, or `undefined` when this tick must stay silent.
 */
export function formatAggregateLine(
  state: UnitSchedulerState,
  failOpensSinceTick: number,
  failOpenByCause: Readonly<Record<FailOpenCause, number>>,
): string | undefined {
  if (state.queued === 0 && failOpensSinceTick === 0) return undefined
  const { total, lastAt } = state.failOpen
  const last = total === 0 ? 'never' : formatAge(Math.max(0, state.at - lastAt))
  const causes = total === 0
    ? ''
    : ` (${Object.entries(failOpenByCause).map(([cause, count]) => `${cause} ${count}`).join(', ')})`
  return `unit-scheduler: held ${state.held}/${state.maxSlots} queued ${state.queued} `
    + `wait-p95 ${state.waitP95}ms fail-open ${total}/last ${last}${causes}`
}

/**
 * Register the scheduling gate. It wraps `tools/execute`: pass-through tools
 * and reentrant dispatches delegate at once; every other call takes a slot
 * (bounded wait, fail-open on expiry) for the delegated lifetime and releases
 * it in a `finally`.
 *
 * The P0.5 observation layer registers alongside: the REST probe waits for a
 * `webServer` carrier in its own child fiber, so the gate itself never waits
 * for one (a composition without an HTTP layer keeps P0 behaviour unchanged
 * and simply has no route), and the aggregate log tick is one unref'd timer
 * disposed with this fiber.
 *
 * @param ctx - plugin context; the listener is scoped to it and disposed with it.
 * @param config - validated {@link Config}; range checks fail loud at load.
 */
export function apply(ctx: Context, config: Config): void {
  // The schema supplies defaults for everything except `maxSlots`, which is
  // machine-derived when omitted.
  const maxSlots = config.maxSlots ?? defaultMaxSlots()
  const maxSlotsPerSession = config.maxSlotsPerSession ?? 2
  const waitTimeoutMs = config.waitTimeoutMs ?? 60_000
  if (!Number.isInteger(maxSlots) || maxSlots < 1) {
    throw new Error(`unit-scheduler: invalid maxSlots ${maxSlots} — must be an integer >= 1`)
  }
  if (!Number.isInteger(maxSlotsPerSession) || maxSlotsPerSession < 1) {
    throw new Error(`unit-scheduler: invalid maxSlotsPerSession ${maxSlotsPerSession} — must be an integer >= 1`)
  }
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0) {
    throw new Error(`unit-scheduler: invalid waitTimeoutMs ${waitTimeoutMs} — must be a finite number >= 0`)
  }

  const isPassThrough = compilePassThrough(config.passThroughTools ?? [])
  const semaphore = new UnitSlotSemaphore({ maxSlots, maxPerSession: maxSlotsPerSession, defaultWaitMs: waitTimeoutMs })
  // Iron law 3 (reentrancy): set while a slot-holding dispatch awaits its
  // downstream, so nested dispatches in that async context ride the
  // ancestor's slot instead of queueing for a second one.
  const ancestorHoldsSlot = new AsyncLocalStorage<true>()

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    // Iron law 2: pass-through tools wait on someone else — never a slot.
    if (isPassThrough(exec.name)) return next()
    // Iron law 3: nested dispatch under a slot-holding ancestor (accounting offset).
    if (ancestorHoldsSlot.getStore() !== undefined) return next()

    const sessionKey = exec.agent?.id ?? NO_AGENT_SESSION_KEY
    const outcome = await semaphore.acquire(sessionKey, exec.signal)
    if (!outcome.acquired) {
      if (outcome.reason === 'fail-open') {
        // Bounded wait expired: release WITHOUT a slot, but leave a trace.
        ctx.logger.warn(
          `unit-scheduler fail-open: tool "${exec.name}" (session ${sessionKey}) waited ${outcome.waitedMs}ms `
          + `for a slot and is released WITHOUT one (waitTimeoutMs=${waitTimeoutMs}, maxSlots=${maxSlots})`,
        )
      }
      // `aborted`: the caller cancelled while queued; delegate so the
      // pipeline sees the caller's own aborted signal.
      return next()
    }
    try {
      return await ancestorHoldsSlot.run(true, next)
    } finally {
      outcome.release()
    }
  })

  // Channel c (plan §4.2c): `GET /api/unit-scheduler/state`. The route waits
  // for a carrier in a child fiber so the GATE never waits for one; the fence
  // runs before the method check, so an untrusted caller learns nothing — not
  // even the schema.
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
        res.end(JSON.stringify(semaphore.stats().state))
      },
    }), 'unit-scheduler: GET /api/unit-scheduler/state')
  })

  // Channel a (plan §4.2a): one conditional aggregate line per interval. The
  // cumulative fail-open total doubles as the window flag — its delta since
  // the previous tick is exactly "a fail-open happened inside this window",
  // while the line itself keeps reporting the lifetime total and its cause.
  let failOpenTotalAtLastTick = 0
  ctx.effect(() => {
    const timer = setInterval(() => {
      const { state, failOpenByCause } = semaphore.stats()
      const failOpensSinceTick = state.failOpen.total - failOpenTotalAtLastTick
      failOpenTotalAtLastTick = state.failOpen.total
      const line = formatAggregateLine(state, failOpensSinceTick, failOpenByCause)
      if (line !== undefined) ctx.logger.info(line)
    }, AGGREGATION_INTERVAL_MS)
    timer.unref()
    return () => {
      clearInterval(timer)
    }
  }, 'unit-scheduler: aggregate log tick')
}
