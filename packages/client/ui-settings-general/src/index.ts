/** Welcome acknowledgement stored in the plugin configuration. */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile, Context } from '@deepseek-ai/cordis'

import z from '@deepseek-ai/schemastery'

import { registerRestart } from './restart-host.ts'
import { restartStamp } from './restart-stamp.ts'

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
 * read of the restart-signal build manifest (R stamp) happens unconditionally at load; nothing
 * renders or acts on it yet.
 * @param ctx Plugin context used for optional settings presentation and restart registration.
 */
export function apply(ctx: Context): void {
  restartStamp()
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // The dispatch rides Connection's authenticated exact-route fence and the served-page
  // injection table, so both services gate when it exists at all.
  ctx.inject(['connection', 'webServer'], (webCtx) => { registerRestart(webCtx) })
}
