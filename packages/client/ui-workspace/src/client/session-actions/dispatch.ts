/**
 * The relay dispatch client (FORK session-relay-1106): the same-origin POST
 * that creates a successor Session and queues the relay seed in one server
 * call — the dsh-session-dispatch plugin's single-dispatch route, reached
 * from a Session row's relay button.
 *
 * The body carries only what relay owns: the successor's Workspace, the seed
 * prompt, the inherited display title, and the explicit `danger-full-access`
 * pin the 2026-11-04 dispatch ruling demands — a relay continues work that
 * ran with full freedom, so the pin is never omitted and never silently
 * downgraded. Everything else (mode, sessionClass) stays the profile
 * default, and no `taskRef` rides along: relay is not a taskbot binding and
 * must not occupy the quick ledger's occupancy sensor.
 *
 * The wait is bounded so a wedged host cannot pin the row's pending state
 * forever. An abort cancels the wait, not the dispatch: a server that
 * completed after the abort leaves a successor the row list shows and the
 * user can archive (forward-only — the retry may produce a second Session,
 * which is visible rather than hidden). Failures answer a stable message —
 * the server's own error string, a status, or a code — untranslated, like
 * `createFailed`'s message policy.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Same-origin dispatch route the dsh-session-dispatch plugin serves (loopback-fenced). */
const DISPATCH_ROUTE = '/api/session-dispatch'

/**
 * Request ceiling: dispatch is a loopback create + rename + prompt queue,
 * normally well under a second; fifteen seconds is a wedged host, and the
 * button must recover with a retryable notice instead of staying pending.
 */
const DISPATCH_TIMEOUT_MS = 15_000

/** What the button sends: the successor's Workspace, the seed, and its title. */
export interface SessionDispatchRequest {
  /** Workspace the successor joins; its directory becomes the Session cwd. */
  readonly workspaceId: string
  /** The relay seed — one instruction carrying the source Session id. */
  readonly prompt: string
  /** The source Session's display title, so the continuation keeps the name. */
  readonly title?: string
}

/** The route's answer: the new Session, or the failure's own message. */
export type SessionDispatchResult =
  | { readonly ok: true; readonly sessionId: SessionId }
  | { readonly ok: false; readonly message: string }

/**
 * Create and seed a successor Session through the dispatch route.
 * @param request - workspace, seed, and optional inherited title.
 * @returns the new Session id, or the failure message; never rejects.
 */
export async function postSessionDispatch(request: SessionDispatchRequest): Promise<SessionDispatchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, DISPATCH_TIMEOUT_MS)
  try {
    const response = await fetch(DISPATCH_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 2026-11-04 dispatch ruling: the permission pin is explicit on every
      // POST — never omitted, never a silent downgrade.
      body: JSON.stringify({ ...request, permission: 'danger-full-access' }),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => undefined) as
      { ok?: unknown; sessionId?: unknown; error?: unknown } | undefined
    if (!response.ok) {
      return { ok: false, message: typeof payload?.error === 'string' ? payload.error : `HTTP ${String(response.status)}` }
    }
    if (payload?.ok !== true || typeof payload.sessionId !== 'string' || payload.sessionId === '') {
      return { ok: false, message: 'dispatch: response carried no sessionId' }
    }
    return { ok: true, sessionId: payload.sessionId as SessionId }
  } catch (reason) {
    if (reason instanceof Error && reason.name === 'AbortError') return { ok: false, message: 'dispatch: timed out' }
    return { ok: false, message: reason instanceof Error ? reason.message : String(reason) }
  } finally {
    clearTimeout(timer)
  }
}
