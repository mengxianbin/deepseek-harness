/** Restart capability contract shared by the Host route and the browser button. */

/** Browser fetch route asking the Host to dispatch its configured restart command. */
export const RESTART_PATH = '/api/restart'

/** Page-global name carrying the Host's restart-capability marker. */
export const RESTART_GLOBAL = '__DSH_RESTART__'

/** Capability marker the Host injects into the served page when a restart command is configured. */
export interface RestartCapability {
  /** True when the Host configured a restart command the browser may dispatch. */
  readonly configured: boolean
}

/**
 * Validate the injected restart declaration; an absent or malformed value
 * disables the capability instead of failing the page.
 * @param value - raw `__DSH_RESTART__` page global.
 * @returns whether the Host announced a configured restart command.
 */
export function resolveRestartCapability(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Reflect.get(value, 'configured') === true
}

/** Browser fetch route asking the Host to recompute the restart signal and return it. */
export const RECHECK_PATH = '/api/stamp-recheck'

/**
 * The seven-state restart signal plus its informational twin, judged by the
 * Host from the design's S/B/R stamp comparison: `INIT` (no build baseline),
 * `BUILDING` (a build is running), `BUILD_FAILED` (the last build failed),
 * `NEED_BUILD` (host-face source moved past the baseline), `NEED_RESTART`
 * (built artifacts or configuration are ahead of the running process),
 * `CLIENT_UPDATED` (client-face source moved; F5/HMR territory, no restart
 * lamp), and `OK` (everything agrees).
 */
export type RestartSignalState = 'INIT' | 'BUILDING' | 'BUILD_FAILED' | 'NEED_BUILD' | 'NEED_RESTART' | 'CLIENT_UPDATED' | 'OK'

/** Which restart branch a `NEED_RESTART` judgment landed on. */
export type RestartSignalReason = 'config' | 'built'

/** One restart-signal judgment as the browser store carries it. */
export interface RestartSignalView {
  readonly state: RestartSignalState
  /** Present only on `NEED_RESTART`: configuration vs built-artifact cause. */
  readonly reason?: RestartSignalReason
}

/** Every legal signal state, for response validation. */
export const RESTART_SIGNAL_STATES: readonly RestartSignalState[] = [
  'INIT', 'BUILDING', 'BUILD_FAILED', 'NEED_BUILD', 'NEED_RESTART', 'CLIENT_UPDATED', 'OK',
]

/**
 * Validate a recheck response; an absent or malformed body leaves the
 * previous badge state in place instead of failing the page.
 * @param value - raw JSON body of a `POST /api/stamp-recheck` response.
 * @returns the validated view, or `undefined` when malformed.
 */
export function resolveRestartSignal(value: unknown): RestartSignalView | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const state: unknown = Reflect.get(value, 'state')
  if (typeof state !== 'string' || !RESTART_SIGNAL_STATES.includes(state as RestartSignalState)) return undefined
  const reason: unknown = Reflect.get(value, 'reason')
  if (reason !== undefined && reason !== 'config' && reason !== 'built') return undefined
  return reason === undefined ? { state: state as RestartSignalState } : { state: state as RestartSignalState, reason }
}
