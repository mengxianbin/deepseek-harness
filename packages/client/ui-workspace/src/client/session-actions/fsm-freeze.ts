/**
 * The manual unfreeze entry (freeze-reclaim-1127 §6.2 解冻永可用 + the
 * freeze-bind read side): one same-origin view of every FSM-frozen Session,
 * so a row can wear the ❄️/🔒 badge §2.1 defines and release it in one click.
 *
 * Two loopback-fenced routes, both read straight off the dsh-web host:
 * GET `/api/task-fsm/state` answers the whole map in one request (rows would
 * otherwise fan out one request per row), POST `/api/task-fsm/wake` releases
 * one record. The wake trigger follows the record's own reason — E1's queue
 * position (排队位) releases through `quota-free` (E4), a前置 block through
 * `prereq-terminal` (E6) — the wake route's existing axis, never a new event.
 *
 * Fail-open by design: a host without the FSM, a fetch error, a shape drift,
 * or a session-less record all answer "nothing frozen", which is exactly the
 * pre-badge world — the dot keeps painting and the human simply has no
 * button. The badge must never block a row or crash a render.
 *
 * The store is module-level with `useSyncExternalStore`: one fetch + one
 * 30s poll shared by every mounted row, started with the first subscriber
 * and stopped with the last (E1 freezes land without any page event, so a
 * mounted badge re-reads on its own cadence; a wake refreshes immediately).
 */
import { useSyncExternalStore } from 'react'

/** Same-origin FSM routes; the server fences them to loopback. */
const FSM_STATE_ROUTE = '/api/task-fsm/state'
const FSM_WAKE_ROUTE = '/api/task-fsm/wake'

/** Request ceiling: the state file is tiny and local; five seconds is a wedged host. */
const FSM_TIMEOUT_MS = 5_000

/** Re-read cadence while at least one badge is mounted. */
const FSM_POLL_MS = 30_000

/** One frozen (or locked) record as a row badge sees it. */
export interface FrozenSessionView {
  /** The FSM record this badge releases — the wake route's key. */
  readonly taskRef: string
  readonly mode: 'frozen' | 'locked'
  /** The record's own reason, shown in the badge's hover text. */
  readonly reason: string
}

/** sessionId → frozen view; session-less records never appear (no row to badge). */
export type FrozenMap = ReadonlyMap<string, FrozenSessionView>

export type WakeResult = { readonly ok: true } | { readonly ok: false; readonly message: string }

let snapshot: FrozenMap = new Map()
const listeners = new Set<() => void>()
let pollTimer: ReturnType<typeof setInterval> | undefined
let inflight: Promise<void> | undefined

function publish(next: FrozenMap): void {
  snapshot = next
  for (const listener of listeners) listener()
}

/**
 * Fold the state route's answer into the badge map.
 * @param payload - the route's JSON; shape drift answers an empty map.
 * @returns sessionId → frozen view, skipping active and session-less records.
 */
function parseFrozen(payload: unknown): FrozenMap {
  const tasks = (payload as { file?: { tasks?: Record<string, unknown> | null } } | null | undefined)?.file?.tasks
  if (tasks === undefined || tasks === null) return new Map()
  const map = new Map<string, FrozenSessionView>()
  for (const [taskRef, raw] of Object.entries(tasks)) {
    const session = (raw as { session?: { id?: unknown; mode?: unknown; reason?: unknown } } | undefined)?.session
    if (session === undefined) continue
    if (session.mode !== 'frozen' && session.mode !== 'locked') continue
    if (typeof session.id !== 'string' || session.id === '') continue
    map.set(session.id, {
      taskRef,
      mode: session.mode,
      reason: typeof session.reason === 'string' ? session.reason : '',
    })
  }
  return map
}

/**
 * Re-read the frozen map (coalesced: concurrent callers share one request).
 * Never rejects; a failed read keeps the last map (empty at first load).
 */
export function refreshFrozen(): Promise<void> {
  if (inflight !== undefined) return inflight
  inflight = (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, FSM_TIMEOUT_MS)
    try {
      const response = await fetch(FSM_STATE_ROUTE, { signal: controller.signal })
      if (response.ok) publish(parseFrozen(await response.json()))
    } catch {
      /* fail-open: keep the previous map — no badge beats a broken row. */
    } finally {
      clearTimeout(timer)
      inflight = undefined
    }
  })()
  return inflight
}

/**
 * The wake route's own trigger axis: a prerequisite block releases through
 * prereq-terminal (E6, which reads the checkbox mechanically); every other
 * freeze family — E1's queue position, E7's mem floor, quota — releases
 * through quota-free (E4), the generic wake proven on both families.
 * @param reason - the record's frozen reason.
 * @returns which wake trigger releases this record.
 */
export function wakeTrigger(reason: string): 'quota-free' | 'prereq-terminal' {
  return reason.includes('前置') ? 'prereq-terminal' : 'quota-free'
}

/**
 * Release one frozen record through the wake route, then re-read the map so
 * the badge disappears without a page event.
 * @param view - the badge's record.
 * @returns success, or the server's own error message; never rejects.
 */
export async function wakeFrozen(view: FrozenSessionView): Promise<WakeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, FSM_TIMEOUT_MS)
  try {
    const response = await fetch(FSM_WAKE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskRef: view.taskRef, trigger: wakeTrigger(view.reason) }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
      return { ok: false, message: body?.error ?? String(response.status) }
    }
    await refreshFrozen()
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** The current map (getSnapshot for `useSyncExternalStore`). */
export function frozenSnapshot(): FrozenMap {
  return snapshot
}

/**
 * Subscribe to the frozen map; the first subscriber starts the fetch + poll,
 * the last unsubscriber stops them.
 * @param listener - change callback.
 * @returns the unsubscribe function.
 */
export function subscribeFrozen(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    void refreshFrozen()
    pollTimer = setInterval(() => { void refreshFrozen() }, FSM_POLL_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }
}

/**
 * The row badge's hook: this Session's frozen view, absent while unfrozen.
 * @param sessionId - the row's Session id.
 * @returns the frozen view or undefined.
 */
export function useFrozenSession(sessionId: string): FrozenSessionView | undefined {
  const map = useSyncExternalStore(subscribeFrozen, frozenSnapshot, frozenSnapshot)
  return map.get(sessionId)
}

/**
 * Test-only: drop the map and stop the poll so cases start from the
 * pre-badge world. Never called by production code.
 */
export function resetFrozenStore(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
  publish(new Map())
}

// ——— §5.1 预告（freeze-reclaim-design-1127 分期5）———
//
// A preview announcement is pure client state: the Phase-2 pipeline (and
// fixtures today) call `setPreview` BEFORE any stop/reclaim action — zero
// LLM, zero round-trips, and a route of its own by design (§5.1 零 LLM、
// 零回合: talking to the model to announce a freeze would be 火上浇油).
// The row banner and the composer block both read this map; a release
// mirrors it out the moment the pipeline clears the announcement.

/** sessionId → localized preview reason; absent = no announcement pending. */
export type PreviewMap = ReadonlyMap<string, string>

let preview: PreviewMap = new Map()
const previewListeners = new Set<() => void>()

function publishPreview(next: PreviewMap): void {
  preview = next
  for (const listener of previewListeners) listener()
}

/** The current preview map (getSnapshot for `useSyncExternalStore`). */
export function previewSnapshot(): PreviewMap {
  return preview
}

/**
 * Subscribe to the preview map (no polling — announcements are local state).
 * @param listener - change callback.
 * @returns the unsubscribe function.
 */
export function subscribePreview(listener: () => void): () => void {
  previewListeners.add(listener)
  return () => { previewListeners.delete(listener) }
}

/**
 * Announce an upcoming freeze for one Session (§5.1 预告).
 * @param sessionId - the Session the announcement is about.
 * @param reason - localized banner/placeholder text.
 */
export function setPreview(sessionId: string, reason: string): void {
  if (preview.get(sessionId) === reason) return
  const next = new Map(preview)
  next.set(sessionId, reason)
  publishPreview(next)
}

/**
 * Clear one Session's announcement (frozen through, or the pipeline retracted it).
 * @param sessionId - the Session to release.
 */
export function clearPreview(sessionId: string): void {
  if (!preview.has(sessionId)) return
  const next = new Map(preview)
  next.delete(sessionId)
  publishPreview(next)
}

/**
 * The row banner's hook: this Session's pending preview reason.
 * @param sessionId - the row's Session id.
 * @returns the reason or undefined.
 */
export function usePreview(sessionId: string): string | undefined {
  return useSyncExternalStore(subscribePreview, previewSnapshot, previewSnapshot).get(sessionId)
}

/** Test-only: drop every announcement so cases start from the quiet world. */
export function resetPreviewStore(): void {
  publishPreview(new Map())
}
