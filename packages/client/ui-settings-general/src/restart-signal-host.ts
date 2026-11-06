/**
 * Host recheck route: registers `POST /api/stamp-recheck` on Connection's
 * authenticated exact-fetch fence — the same fence the restart dispatch
 * rides — so a recheck only triggers a state-machine recomputation and
 * answers with the fresh judgment. Unlike the restart dispatch, the route
 * registers unconditionally: the signal machine matters whether or not the
 * user configured a restart command (the browser badge gates itself on the
 * configured capability).
 *
 * Every answer is deadline-bounded (stamp-recheck-cache-timeout-1107): past
 * {@link RECHECK_TIMEOUT_MS} the route serves the last computed judgment — or
 * 504 when none exists yet — instead of hanging the request behind a
 * multi-tens-of-seconds full-tree recompute (observed 5–77s, peak 76.9s).
 * The timed-out computation itself keeps running and fills the result cache,
 * so the recheck after it answers fresh. The attestation leg is untouched:
 * the body is recorded before the deadline races, so a served-from-timeout or
 * cached answer never starves the 90s freshness window.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.connection merge (exact Fetch-route registry).
import type {} from '@deepseek-ai/dsh-client-connection'
import { recordClientRunningCount } from './restart-disposition.ts'
import { collectRestartSignal, lastRestartSignalJudgment, type RestartSignalJudgment } from './restart-signal.ts'
import { RECHECK_PATH } from './restart.ts'

/** Ceiling for one recheck answer: past it the route serves the last computed
 * judgment (or 504 with none) instead of hanging the request. Kept under the
 * client flow's own fetch deadline so the server's fallback wins the race. */
export const RECHECK_TIMEOUT_MS = 12_000

/** Injectable gatherer seam: tests substitute a fixed judgment. */
export interface RestartSignalInternals {
  /** Judgment source; defaults to the production collect. */
  readonly collect?: () => Promise<RestartSignalJudgment>
  /** Answer deadline in milliseconds; defaults to {@link RECHECK_TIMEOUT_MS}. Tests shorten it. */
  readonly timeoutMs?: number
  /** Last-computed judgment behind the timeout; defaults to the state machine's own store. */
  readonly lastJudgment?: () => RestartSignalJudgment | undefined
}

/** The wire body of one judgment: only the fields the badge renders.
 * `startedAt` rides only on a BUILDING judgment whose start capture carried a
 * readable time; the browser renders it as the timer tooltip's start stamp +
 * elapsed age (build-timer-tooltip-1101) — a cached or timeout-served answer
 * carries the same absolute instant, so the client's own 30s refresh keeps the
 * elapsed age walking. `linkedRepo` rides only on a linked-only NEED_BUILD:
 * the drifted tree the copy names (build-scope-rework-1105 A). */
function judgmentBody(judgment: RestartSignalJudgment): Record<string, unknown> {
  return {
    state: judgment.state,
    ...(judgment.reason === undefined ? {} : { reason: judgment.reason }),
    ...(judgment.startedAt === undefined ? {} : { startedAt: judgment.startedAt }),
    ...(judgment.linkedRepo === undefined ? {} : { linkedRepo: judgment.linkedRepo }),
  }
}

/**
 * Serve `POST /api/stamp-recheck`: recompute the signal and answer its
 * state; a gather failure answers 500 with one stderr line instead of
 * crashing the route, and a gather past the deadline answers the last
 * judgment (504 when none exists) with one stderr line instead of hanging.
 * @param ctx - Host context carrying the connection service.
 * @param internals - Injectable gatherer, deadline, and last-judgment seams for tests.
 */
export function registerRestartSignal(ctx: Context, internals: RestartSignalInternals = {}): void {
  const collect = internals.collect ?? (() => collectRestartSignal())
  const timeoutMs = internals.timeoutMs ?? RECHECK_TIMEOUT_MS
  const lastJudgment = internals.lastJudgment ?? lastRestartSignalJudgment
  ctx.connection.fetch.register({
    path: RECHECK_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    // The browser rides its own running-count report on the recheck (P3
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
      // outcome too, so a late rejection of the timed-out computation is
      // absorbed here instead of surfacing as an unhandled rejection, and the
      // timer never outlives the answer.
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
          process.stderr.write(`ui-settings-general: restart-signal recheck timed out after ${String(timeoutMs)}ms${last === undefined ? '' : '; answering with the last judgment'}\n`)
          if (last === undefined) return Response.json({ error: 'restart-signal recheck timed out' }, { status: 504 })
          return Response.json(judgmentBody(last))
        }
        if ('error' in winner) {
          process.stderr.write(`ui-settings-general: restart-signal recheck failed: ${winner.error instanceof Error ? winner.error.message : String(winner.error)}\n`)
          return Response.json({ error: 'restart-signal recheck failed' }, { status: 500 })
        }
        return Response.json(judgmentBody(winner.judgment))
      }).finally(() => {
        if (deadline !== undefined) clearTimeout(deadline)
      })
    },
  })
}
