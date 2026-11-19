/** Machine-readable motive the restart button rides on `POST /api/restart`. */
import type { RestartSignalView } from '../restart.ts'

/**
 * The audit reason the button sends with its dispatch (restart-attribution-
 * inbox-1118 批1 L3, 2026-11-19): a lit lamp names the judgment that prompted
 * the click — `signal-config` / `signal-built` for NEED_RESTART, otherwise
 * `signal-<state>` — and a dark lamp is a plain `manual` click. The server
 * already reads the field (`readRestartReason`), so this is a body-only change:
 * the motive finally reaches the `restart dispatched (manual route, reason=…)`
 * line for the ~24h window in which two of three reason-less restarts were
 * button presses.
 * @param signal - Latest restart-signal judgment, undefined before the first delivery.
 * @returns the reason string to put in the request body.
 */
export function restartDispatchReason(signal: RestartSignalView | undefined): string {
  if (signal === undefined || signal.state === 'OK' || signal.state === 'CLIENT_UPDATED') return 'manual'
  if (signal.state === 'NEED_RESTART' && signal.reason !== undefined) return `signal-${signal.reason}`
  return `signal-${signal.state}`
}
