/**
 * Restart-signal recheck flow: the browser half's single command — ask the
 * Host to recompute the signal and publish the delivered judgment.
 *
 * The flow runs once at start (the page's boot recheck), re-runs whenever the
 * page returns to visibility (design trigger ③), and exposes `recheck` for
 * the connection-reconnect leg of the灯自灭 chain (R6: reconnect → recompute
 * → delivery). Failures — network, non-OK status, malformed body — keep the
 * previous published badge and warn once per attempt.
 *
 * P3 additions, both dark until the host's flag is on: every recheck carries
 * the page's own running-Session count (`runningCount`, the host's automatic
 * fork compares it against its own reading), and a `NEED_RESTART` badge keeps
 * the attestation fresh with a quiet 30s refresh until the state moves on.
 */
import { RECHECK_PATH, resolveRestartSignal, type RestartSignalView } from '../restart.ts'

/** Minimal response facts the recheck acts on. */
interface RecheckResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

/** Default cadence of the NEED_RESTART attestation refresh (P3; host freshness window 90s). */
const DEFAULT_REFRESH_MS = 30_000

/** Injectable browser surfaces; defaults come from the served page. */
export interface RestartSignalSurfaces {
  /** Same-origin fetch of the recheck route. */
  fetch?: (this: void, input: string, init?: {
    readonly method: string
    readonly body?: string
    readonly headers?: Readonly<Record<string, string>>
  }) => Promise<RecheckResponse>
  /** Page-visibility event target; a visible page rechecks. */
  visibility?: {
    readonly visibilityState: string
    addEventListener(type: 'visibilitychange', listener: () => void): void
    removeEventListener(type: 'visibilitychange', listener: () => void): void
  } | undefined
  /** The page's running-Session count, reported with every recheck (P3 attestation). */
  runningCount?: () => number | undefined
  /** Cadence of the NEED_RESTART attestation refresh in milliseconds; `0` disables it. */
  refreshMs?: number
  /** Failure sink; defaults to a console warning. */
  warn?: (message: string) => void
}

/** Browser page globals the flow reads when no surfaces are injected. */
interface PageGlobals {
  fetch?: (this: void, input: string, init?: { readonly method: string }) => Promise<RecheckResponse>
  document?: { readonly visibilityState: string } & Pick<NonNullable<RestartSignalSurfaces['visibility']>, 'addEventListener' | 'removeEventListener'>
  console?: Pick<Console, 'warn'>
}

/** The recheck handle: one command plus the visibility-listener lifetime. */
export interface RestartSignalFlow {
  /** Ask the Host to recompute and deliver the signal; a failure keeps the previous badge. */
  recheck(): void
  /** Stop the visibility listener. */
  dispose(): void
}

function defaultSurfaces(): RestartSignalSurfaces {
  const globals = globalThis as PageGlobals
  return {
    ...(globals.fetch === undefined ? {} : { fetch: globals.fetch }),
    visibility: globals.document,
    ...(globals.console === undefined ? {} : { warn: (message: string) => { globals.console?.warn(message) } }),
  }
}

/**
 * Start the recheck flow: publish once at start, then on every return to
 * visibility.
 * @param publish - Sink for each delivered, validated judgment; malformed responses never reach it.
 * @param injected - Test seams replacing the page's fetch, visibility, and warning surfaces.
 * @returns The flow handle; `dispose` removes the visibility listener.
 */
export function startRestartSignalFlow(
  publish: (view: RestartSignalView) => void,
  injected: RestartSignalSurfaces = {},
): RestartSignalFlow {
  const surfaces: RestartSignalSurfaces = { ...defaultSurfaces(), ...injected }
  const fetchImpl = surfaces.fetch
  const warn = surfaces.warn ?? ((message: string) => { (globalThis as PageGlobals).console?.warn(message) })
  const refreshMs = surfaces.refreshMs ?? DEFAULT_REFRESH_MS
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  const stopRefresh = (): void => {
    if (refreshTimer !== undefined) clearInterval(refreshTimer)
    refreshTimer = undefined
  }
  const startRefresh = (): void => {
    if (refreshTimer !== undefined || refreshMs <= 0) return
    refreshTimer = setInterval(() => { recheck() }, refreshMs)
  }
  const recheck = (): void => {
    if (fetchImpl === undefined) return
    // The attestation rides along only when the caller supplies a counter;
    // without it the request stays exactly the pre-P3 shape.
    const runningCount = surfaces.runningCount?.()
    const init = typeof runningCount === 'number'
      ? { method: 'POST', body: JSON.stringify({ runningCount }), headers: { 'content-type': 'application/json' } }
      : { method: 'POST' }
    void Promise.resolve()
      .then(() => fetchImpl(RECHECK_PATH, init))
      .then(async (response) => {
        if (!response.ok) throw new Error(`recheck answered HTTP ${String(response.status)}`)
        const view = resolveRestartSignal(await response.json())
        if (view === undefined) throw new Error('recheck answered a malformed body')
        publish(view)
        // A NEED_RESTART badge keeps its attestation fresh (the host's fork
        // window is 90s); any other state stops the refresh.
        if (view.state === 'NEED_RESTART') startRefresh()
        else stopRefresh()
      })
      .catch((error: unknown) => {
        warn(`[ui-settings-general] restart-signal recheck failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }
  const visibility = surfaces.visibility
  const onVisible = (): void => {
    if (visibility?.visibilityState !== 'visible') return
    recheck()
  }
  visibility?.addEventListener('visibilitychange', onVisible)
  recheck()
  return {
    recheck,
    dispose: () => {
      visibility?.removeEventListener('visibilitychange', onVisible)
      stopRefresh()
    },
  }
}
