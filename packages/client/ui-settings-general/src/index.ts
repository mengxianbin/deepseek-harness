/** Welcome acknowledgement stored in the plugin configuration. */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile, Context } from '@deepseek-ai/cordis'

import z from '@deepseek-ai/schemastery'

import { registerRestart } from './restart-host.ts'

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
 * (absent by default) gains its dispatch route and capability page global.
 * @param ctx Plugin context used for optional settings presentation and restart registration.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // The dispatch rides Connection's authenticated exact-route fence and the served-page
  // injection table, so both services gate when it exists at all.
  ctx.inject(['connection', 'webServer'], (webCtx) => { registerRestart(webCtx) })
}
