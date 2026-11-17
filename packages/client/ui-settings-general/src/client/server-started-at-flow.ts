/**
 * Server start-time pull flow: the browser half's single command — ask the
 * Host when its process started and publish the delivered instant, so the
 * settings-row stamp answers "did the server actually restart" with a fact
 * that changes exactly when the process does (server-started-at-1117).
 *
 * The flow runs once at start (page boot), re-runs whenever the page returns
 * to visibility, and exposes `recheck` for the connection-reconnect leg: the
 * caller clears the published instant on the connected transition before
 * rechecking, so a pre-restart instant can never survive into a new process —
 * hidden until the fresh answer lands (stale = a lie). Failures — network,
 * non-OK status, malformed body — keep the previous instant and warn once per
 * attempt. No refresh cadence and no fetch deadline: the instant is static
 * per process, a restart always reaches this leg through the reconnect
 * itself, and nothing on screen waits on the result (fire-and-forget — a hung
 * fetch only leaves the stamp hidden until the next trigger pulls again).
 */
import { SERVER_STARTED_AT_PATH, resolveServerStartedAt } from '../server-started-at.ts'

/** Minimal response facts the pull acts on. */
interface StartedAtResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

/** Injectable browser surfaces; defaults come from the served page. */
export interface ServerStartedAtSurfaces {
  /** Same-origin fetch of the start-time route. */
  fetch?: (this: void, input: string, init?: {
    readonly method: string
  }) => Promise<StartedAtResponse>
  /** Page-visibility event target; a visible page pulls again. */
  visibility?: {
    readonly visibilityState: string
    addEventListener(type: 'visibilitychange', listener: () => void): void
    removeEventListener(type: 'visibilitychange', listener: () => void): void
  } | undefined
  /** Failure sink; defaults to a console warning. */
  warn?: (message: string) => void
}

/** Browser page globals the flow reads when no surfaces are injected. */
interface PageGlobals {
  fetch?: (this: void, input: string, init?: { readonly method: string }) => Promise<StartedAtResponse>
  document?: { readonly visibilityState: string } & Pick<NonNullable<ServerStartedAtSurfaces['visibility']>, 'addEventListener' | 'removeEventListener'>
  console?: Pick<Console, 'warn'>
}

/** The pull handle: one command plus the visibility-listener lifetime. */
export interface ServerStartedAtFlow {
  /** Ask the Host for its start instant; a failure keeps the previous instant. */
  recheck(): void
  /** Stop the visibility listener. */
  dispose(): void
}

function defaultSurfaces(): ServerStartedAtSurfaces {
  const globals = globalThis as PageGlobals
  return {
    ...(globals.fetch === undefined ? {} : { fetch: globals.fetch }),
    visibility: globals.document,
    ...(globals.console === undefined ? {} : { warn: (message: string) => { globals.console?.warn(message) } }),
  }
}

/**
 * Start the pull flow: publish once at start, then on every return to
 * visibility.
 * @param publish - Sink for each delivered, validated instant; malformed responses never reach it.
 * @param injected - Test seams replacing the page's fetch, visibility, and warning surfaces.
 * @returns The flow handle; `dispose` removes the visibility listener.
 */
export function startServerStartedAtFlow(
  publish: (startedAt: string) => void,
  injected: ServerStartedAtSurfaces = {},
): ServerStartedAtFlow {
  const surfaces: ServerStartedAtSurfaces = { ...defaultSurfaces(), ...injected }
  const fetchImpl = surfaces.fetch
  const warn = surfaces.warn ?? ((message: string) => { (globalThis as PageGlobals).console?.warn(message) })
  const recheck = (): void => {
    if (fetchImpl === undefined) return
    void Promise.resolve()
      .then(() => fetchImpl(SERVER_STARTED_AT_PATH, { method: 'GET' }))
      .then(async (response) => {
        if (!response.ok) throw new Error(`start-time pull answered HTTP ${String(response.status)}`)
        const startedAt = resolveServerStartedAt(await response.json())
        if (startedAt === undefined) throw new Error('start-time pull answered a malformed body')
        publish(startedAt)
      })
      .catch((error: unknown) => {
        warn(`[ui-settings-general] server start-time pull failed: ${error instanceof Error ? error.message : String(error)}`)
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
    },
  }
}
