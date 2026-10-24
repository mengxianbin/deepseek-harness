/** Welcome acknowledgement stored in the plugin configuration. */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile, Context } from '@deepseek-ai/cordis'

import z from '@deepseek-ai/schemastery'

import { registerRestart } from './restart-host.ts'
import { registerRestartSignal } from './restart-signal-host.ts'
import { restartStamp } from './restart-stamp.ts'
import { registerStampPoll } from './stamp-poll-host.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Last acknowledged welcome notice version. */
  welcomeNoticeVersion: Volatile<string | undefined>
}

/** Live welcome preference. */
export const Config = z.object({
  welcomeNoticeVersion: z.string().volatile(),
})

/** The browser consumes the configuration form projection, and the configured restart command
 * (absent by default) gains its dispatch route and capability page global. The process-start
 * read of the restart-signal build manifest (R stamp) happens unconditionally at load, and the
 * recheck route serves the seven-state signal judgment the browser badge renders.
 * @param ctx Plugin context used for optional settings presentation and restart registration.
 */
export function apply(ctx: Context): void {
  restartStamp()
  // The polling sensor (design triggers ① and ②) needs neither route
  // service: it captures source and configuration fingerprints on its own
  // interval and fires the state machine's recheck when they move.
  registerStampPoll(ctx)
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Both routes ride Connection's authenticated exact-route fence; the dispatch additionally
  // gates on the configured command and the served-page injection table.
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    registerRestart(webCtx)
    registerRestartSignal(webCtx)
  })
}
