/** Served-page heartbeat re-issuing the browser session cookie before its absolute window ends. */
import { REFRESH_PATH } from '../connect-protocol.ts'

/** Host-declared heartbeat cadence injected into the served page. */
export interface CookieRefreshConfig {
  /** Delay between refresh attempts in milliseconds. */
  readonly intervalMs: number
}

/** Window event dispatched when the Host reports that the session cookie expired. */
export const AUTH_EXPIRED_EVENT = 'dsh-auth-expired'

/** Minimal response facts the heartbeat acts on. */
interface RefreshResponse {
  readonly status: number
}

/** Injectable browser surfaces; defaults come from the served page's globals. */
export interface CookieRefreshSurfaces {
  /** Same-origin fetch of the refresh route. */
  fetch?: (this: void, input: string, init?: { readonly method: string }) => Promise<RefreshResponse>
  /** Repeating timer registration; the callback runs after each interval. */
  setInterval?: (this: void, handler: () => void, timeoutMs: number) => () => void
  /** Page-visibility event target; a visible page refreshes after a full interval has elapsed. */
  visibility?: {
    readonly visibilityState: string
    addEventListener(type: 'visibilitychange', listener: () => void): void
    removeEventListener(type: 'visibilitychange', listener: () => void): void
  } | undefined
}

/** Browser page globals the heartbeat reads when no surfaces are injected. */
interface PageGlobals {
  fetch?: (this: void, input: string, init?: { readonly method: string }) => Promise<RefreshResponse>
  setInterval?: (this: void, handler: () => void, timeoutMs: number) => number
  clearInterval?: (this: void, id: number) => void
  document?: { readonly visibilityState: string } & Pick<NonNullable<CookieRefreshSurfaces['visibility']>, 'addEventListener' | 'removeEventListener'>
  window?: { dispatchEvent?(event: Event): boolean }
  CustomEvent?: new (type: string) => Event
  console?: Pick<Console, 'error' | 'warn'>
}

/**
 * Validate the injected heartbeat declaration; an absent or malformed value
 * disables the heartbeat with a console warning instead of failing the page.
 * @param value - raw `__DSH_COOKIE_REFRESH__` page global.
 * @returns the cadence, or undefined when refreshing is disabled.
 */
export function resolveCookieRefresh(value: unknown): CookieRefreshConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const intervalMs: unknown = Reflect.get(value, 'intervalMs')
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0) return undefined
  return { intervalMs }
}

function defaultSurfaces(): CookieRefreshSurfaces {
  const globals = globalThis as PageGlobals
  const globalFetch = globals.fetch
  const globalSetInterval = globals.setInterval
  const globalClearInterval = globals.clearInterval
  return {
    ...(globalFetch === undefined ? {} : { fetch: globalFetch }),
    ...(globalSetInterval === undefined || globalClearInterval === undefined ? {} : {
      setInterval: (handler, timeoutMs) => {
        const id = globalSetInterval(handler, timeoutMs)
        return () => { globalClearInterval(id) }
      },
    }),
    visibility: globals.document,
  }
}

function reportExpired(onExpired: () => void): void {
  const globals = globalThis as PageGlobals
  const CustomEventConstructor = globals.CustomEvent
  if (globals.window?.dispatchEvent !== undefined && CustomEventConstructor !== undefined) {
    globals.window.dispatchEvent(new CustomEventConstructor(AUTH_EXPIRED_EVENT))
  }
  globals.console?.error('[connection] dsh web session expired; reopen the URL printed by dsh web')
  onExpired()
}

/**
 * Start the cookie-refresh heartbeat: one attempt at start, one per interval,
 * and one on return to visibility when a full interval has already elapsed.
 * Network failures and non-401 refusals are silent — the connection loop owns
 * transport recovery, and only a 401 means the cookie itself is gone.
 * @param config - Host-declared cadence.
 * @param onExpired - observer invoked exactly once per attempt that receives a 401.
 * @param injected - test seam replacing the page's fetch, timer, and visibility surfaces.
 * @returns disposer stopping the timer and visibility listener.
 */
export function startCookieRefresh(
  config: CookieRefreshConfig,
  onExpired: () => void = () => {},
  injected: CookieRefreshSurfaces = {},
): () => void {
  const surfaces: CookieRefreshSurfaces = {
    ...defaultSurfaces(),
    ...injected,
  }
  const fetchImpl = surfaces.fetch
  const setIntervalImpl = surfaces.setInterval
  if (fetchImpl === undefined || setIntervalImpl === undefined) return () => {}
  let inFlight = false
  let lastAttemptAt = 0
  let expired = false
  const attempt = (): void => {
    if (inFlight) return
    inFlight = true
    lastAttemptAt = Date.now()
    void Promise.resolve()
      .then(() => fetchImpl(REFRESH_PATH, { method: 'GET' }))
      .then((response) => {
        if (response.status !== 401 || expired) return
        expired = true
        reportExpired(onExpired)
      })
      .catch(() => {})
      .finally(() => { inFlight = false })
  }
  attempt()
  const cancelTimer = setIntervalImpl(attempt, config.intervalMs)
  const visibility = surfaces.visibility
  const onVisible = (): void => {
    if (visibility?.visibilityState !== 'visible' || Date.now() - lastAttemptAt < config.intervalMs) return
    attempt()
  }
  visibility?.addEventListener('visibilitychange', onVisible)
  return () => {
    cancelTimer()
    visibility?.removeEventListener('visibilitychange', onVisible)
  }
}
