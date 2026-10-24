/**
 * Host recheck route: registers `POST /api/stamp-recheck` on Connection's
 * authenticated exact-fetch fence — the same fence the restart dispatch
 * rides — so a recheck only triggers a state-machine recomputation and
 * answers with the fresh judgment. Unlike the restart dispatch, the route
 * registers unconditionally: the signal machine matters whether or not the
 * user configured a restart command (the browser badge gates itself on the
 * configured capability).
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.connection merge (exact Fetch-route registry).
import type {} from '@deepseek-ai/dsh-client-connection'
import { recordClientRunningCount } from './restart-disposition.ts'
import { collectRestartSignal, type RestartSignalJudgment } from './restart-signal.ts'
import { RECHECK_PATH } from './restart.ts'

/** Injectable gatherer seam: tests substitute a fixed judgment. */
export interface RestartSignalInternals {
  /** Judgment source; defaults to the production collect. */
  readonly collect?: () => Promise<RestartSignalJudgment>
}

/**
 * Serve `POST /api/stamp-recheck`: recompute the signal and answer its
 * state; a gather failure answers 500 with one stderr line instead of
 * crashing the route.
 * @param ctx - Host context carrying the connection service.
 * @param internals - Injectable gatherer seam for tests.
 */
export function registerRestartSignal(ctx: Context, internals: RestartSignalInternals = {}): void {
  const collect = internals.collect ?? (() => collectRestartSignal())
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
      return collect().then(
        (judgment): Promise<Response> => Promise.resolve(Response.json(
          judgment.reason === undefined
            ? { state: judgment.state }
            : { state: judgment.state, reason: judgment.reason },
        )),
        (error: unknown): Promise<Response> => {
          process.stderr.write(`ui-settings-general: restart-signal recheck failed: ${error instanceof Error ? error.message : String(error)}\n`)
          return Promise.resolve(Response.json({ error: 'restart-signal recheck failed' }, { status: 500 }))
        },
      )
    },
  })
}
