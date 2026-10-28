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
 * @module @deepseek-ai/dsh-unit-scheduler
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { availableParallelism } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
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
        this.#settle(waiter, { acquired: false, reason: 'fail-open', waitedMs: Date.now() - waiter.enqueuedAt })
      }, budgetMs)
      // Grant synchronously when the budget already allows it; otherwise the
      // waiter stays queued until a release (or the bounded wait expires).
      this.#drain()
    })
  }

  /** Whether `sessionKey` may hold one more slot right now. */
  #canGrant(sessionKey: string): boolean {
    if (this.#held >= this.#maxSlots) return false
    return (this.#heldBySession.get(sessionKey) ?? 0) < this.#maxPerSession
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
}

/**
 * Register the scheduling gate. It wraps `tools/execute`: pass-through tools
 * and reentrant dispatches delegate at once; every other call takes a slot
 * (bounded wait, fail-open on expiry) for the delegated lifetime and releases
 * it in a `finally`.
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
}
