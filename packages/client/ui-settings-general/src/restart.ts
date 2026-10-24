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
