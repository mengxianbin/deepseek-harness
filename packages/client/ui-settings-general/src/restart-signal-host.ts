/**
 * Host restart-signal state route: registers `POST /api/restart-signal/state`
 * on Connection's authenticated exact-fetch fence — the same fence the restart
 * dispatch rides — and answers with the judgment the external collector
 * collected (offhost-1110): the route itself recomputes nothing,
 * it reads the DSH-home state file through `collectRestartSignal` (fresh file
 * served directly, stale file falls back to the last fresh judgment). Unlike
 * the restart dispatch, the route registers unconditionally: the signal
 * machine matters whether or not the user configured a restart command (the
 * browser badge gates itself on the configured capability).
 *
 * Registration is also the host's two off-host wiring points, both one-shot:
 * it persists this process's runtime capture (R) for the collector to judge
 * against, and it maps state refreshes onto the allowlisted
 * `restart-signal/changed` push, so every open page pulls when — and only
 * when — a new collection moved the judgment.
 *
 * Every answer stays deadline-bounded (the 1107 cache/timeout fix's semantics,
 * unchanged by the move): past {@link RESTART_SIGNAL_STATE_TIMEOUT_MS} the
 * route serves the last fresh judgment — or 504 when none exists yet —
 * instead of hanging the request behind a stalled read. A collect that finds
 * no servable state (file absent or stale with no previous judgment) answers
 * that same 504 shape; a malformed state file answers 500 with one stderr
 * line. The attestation leg is untouched: the body is recorded before the
 * deadline races, so a served-from-timeout or cached answer never starves the
 * 90s freshness window.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.connection merge (exact Fetch-route registry).
import type {} from '@deepseek-ai/dsh-client-connection'
import { recordClientRunningCount } from './restart-disposition.ts'
import {
  collectRestartSignal,
  lastRestartSignalJudgment,
  onRestartSignalStateRefresh,
  persistRestartSignalRuntime,
  RestartSignalStateUnavailableError,
  type RestartSignalJudgment,
} from './restart-signal.ts'
import { RESTART_SIGNAL_STATE_PATH } from './restart.ts'

/** Ceiling for one state answer: past it the route serves the last fresh
 * judgment (or 504 with none) instead of hanging the request. Kept under the
 * client flow's own fetch deadline so the server's fallback wins the race. */
export const RESTART_SIGNAL_STATE_TIMEOUT_MS = 12_000

/** Injectable gatherer seam: tests substitute a fixed judgment. */
export interface RestartSignalInternals {
  /** Judgment source; defaults to the production state-file read. */
  readonly collect?: () => Promise<RestartSignalJudgment>
  /** Answer deadline in milliseconds; defaults to {@link RESTART_SIGNAL_STATE_TIMEOUT_MS}. Tests shorten it. */
  readonly timeoutMs?: number
  /** Last-fresh judgment behind the timeout and the stale file; defaults to the state reader's own store. */
  readonly lastJudgment?: () => RestartSignalJudgment | undefined
  /** Push the `restart-signal/changed` bell on a refreshed judgment; defaults to the host event. Tests spy. */
  readonly emitChanged?: () => void
  /** Persist this process's runtime capture for the collector; defaults to the production writer. Tests observe. */
  readonly persistRuntime?: () => void
}

/** The wire body of one judgment: only the fields the badge renders.
 * `startedAt` rides only on a BUILDING judgment whose start capture carried a
 * readable time; the browser renders it as the timer tooltip's start stamp +
 * elapsed age (build-timer-tooltip-1101) — a cached or timeout-served answer
 * carries the same absolute instant, so the client's own 30s refresh keeps the
 * elapsed age walking. `linkedRepo` rides only on a linked-only NEED_BUILD:
 * the drifted tree the copy names (build-scope-rework-1105 A). The
 * `linkedBuild`/`linkedBuildFailures` pair rides only when the collector
 * confirmed it (linked-lamp-twostate-1111) — an absent pair reaches the
 * browser as an absent pair, so the copy falls back to the plain linked line.
 * Pass-through only: this route never recomputes anything. */
function judgmentBody(judgment: RestartSignalJudgment): Record<string, unknown> {
  return {
    state: judgment.state,
    ...(judgment.reason === undefined ? {} : { reason: judgment.reason }),
    ...(judgment.startedAt === undefined ? {} : { startedAt: judgment.startedAt }),
    ...(judgment.linkedRepo === undefined ? {} : { linkedRepo: judgment.linkedRepo }),
    ...(judgment.linkedBuild === undefined ? {} : { linkedBuild: judgment.linkedBuild }),
    ...(judgment.linkedBuildFailures === undefined ? {} : { linkedBuildFailures: judgment.linkedBuildFailures }),
  }
}

/**
 * Serve `POST /api/restart-signal/state`: answer the externally collected
 * judgment; a malformed state file answers 500 with one stderr line instead
 * of crashing the route, an absent/unfresh state answers 504 (响亮，不静默),
 * and a read past the deadline answers the last fresh judgment (504 when none
 * exists) with one stderr line instead of hanging.
 * @param ctx - Host context carrying the connection service and the push event bus.
 * @param internals - Injectable gatherer, deadline, last-judgment, push, and persist seams for tests.
 */
export function registerRestartSignal(ctx: Context, internals: RestartSignalInternals = {}): void {
  const collect = internals.collect ?? (() => collectRestartSignal())
  const timeoutMs = internals.timeoutMs ?? RESTART_SIGNAL_STATE_TIMEOUT_MS
  const lastJudgment = internals.lastJudgment ?? lastRestartSignalJudgment
  // Off-host wiring ①: a refreshed judgment rings every open page (payload-free
  // by design — the judgment itself keeps riding this route, so the push can
  // never drift from the state the reader served).
  const emitChanged = internals.emitChanged ?? ((): void => { ctx.emit('restart-signal/changed') })
  const offRefresh = onRestartSignalStateRefresh(() => { emitChanged() })
  ctx.effect(() => () => { offRefresh() }, 'ui-settings-general: restart-signal state push')
  // Off-host wiring ②: R (what this process loaded) leaves the process here,
  // once, so the collector's judgment can keep its NEED_RESTART branch.
  const persistRuntime = internals.persistRuntime ?? ((): void => { persistRestartSignalRuntime() })
  persistRuntime()
  ctx.connection.fetch.register({
    path: RESTART_SIGNAL_STATE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    // The browser rides its own running-count report on the state pull (P3
    // attestation): the disposition compares it against the host count and a
    // missing or malformed body simply leaves the slot unrefreshed, which
    // holds the automatic restart (fail-closed, P11 报告 §五).
    fetch: (request) => {
      void request.text().then((text) => {
        if (text.trim() === '') return
        let parsed: unknown
        try { parsed = JSON.parse(text) } catch { return }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
        recordClientRunningCount(Reflect.get(parsed, 'runningCount'))
      }, () => {})
      // One deadline per request. `Promise.race` subscribes to the collect
      // outcome too, so a late rejection of the timed-out read is absorbed
      // here instead of surfacing as an unhandled rejection, and the timer
      // never outlives the answer.
      let deadline: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<'timeout'>((resolve) => {
        deadline = setTimeout(() => { resolve('timeout') }, timeoutMs)
        deadline.unref()
      })
      const outcome = collect().then(
        judgment => ({ judgment }),
        (error: unknown) => ({ error }),
      )
      return Promise.race([outcome, timeout]).then((winner): Response => {
        if (winner === 'timeout') {
          const last = lastJudgment()
          process.stderr.write(`ui-settings-general: restart-signal state read timed out after ${String(timeoutMs)}ms${last === undefined ? '' : '; answering with the last judgment'}\n`)
          if (last === undefined) return Response.json({ error: 'restart-signal state read timed out' }, { status: 504 })
          return Response.json(judgmentBody(last))
        }
        if ('error' in winner) {
          if (winner.error instanceof RestartSignalStateUnavailableError) {
            process.stderr.write(`ui-settings-general: restart-signal state unavailable: ${winner.error.message}\n`)
            return Response.json({ error: 'restart-signal state unavailable' }, { status: 504 })
          }
          process.stderr.write(`ui-settings-general: restart-signal state read failed: ${winner.error instanceof Error ? winner.error.message : String(winner.error)}\n`)
          return Response.json({ error: 'restart-signal state read failed' }, { status: 500 })
        }
        return Response.json(judgmentBody(winner.judgment))
      }).finally(() => {
        if (deadline !== undefined) clearTimeout(deadline)
      })
    },
  })
}
