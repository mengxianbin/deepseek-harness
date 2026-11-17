/** Server start-time contract shared by the Host route and the browser stamp. */

/** Browser fetch route answering the Host process's start instant
 * (server-started-at-1117): the sidebar stamp's "did the server actually
 * restart" fact, separate from the restart-signal judgment — the signal says
 * whether a restart is owed, this instant says when the running process began. */
export const SERVER_STARTED_AT_PATH = '/api/server/started-at'

/**
 * Validate a start-time response; an absent or malformed body leaves the
 * published stamp at its previous instant (or hidden) instead of rendering a
 * broken time string — the same fail-closed seat the restart-signal view
 * gives its `startedAt`.
 * @param value - raw JSON body of a `GET /api/server/started-at` response.
 * @returns the validated ISO 8601 start instant, or `undefined` when malformed.
 */
export function resolveServerStartedAt(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const startedAt: unknown = Reflect.get(value, 'startedAt')
  if (typeof startedAt !== 'string' || !Number.isFinite(Date.parse(startedAt))) return undefined
  return startedAt
}
