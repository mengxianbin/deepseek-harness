/**
 * The archive-seal row light's data layer (FORK archive-seal-light-1101): the
 * browser-side store over contract C1 the row lamps read (design ruling
 * `seal-light-landing-ruling`, archive-seal-light.md §五 行灯层).
 *
 * Policy, all of it design-sourced:
 * - **Who is asked** — exactly the rows whose light is mounted: visible,
 *   non-archived, non-blank Session rows (design §三 对象 / §六.6 归档态行
 *   不请求). A row joining or leaving that set raises a check.
 * - **When** — an id-set change, or one row's `running` true→false flip: the
 *   moment a save can turn green (设计点名的最可能变绿时刻). No resident
 *   polling: a settled check with no new trigger never re-arms itself.
 * - **Pace** — at least {@link SEAL_LIGHT_THROTTLE_MS} between two checks and
 *   one in flight at a time (throttle + single flight, 任务书节流 ≥2 秒).
 * - **Failure** — `null` from `requestSealCheck` paints every light dark
 *   (fail-dark, the deliberate mirror of the archive gate's fail-open) and
 *   starts an exponential cooldown. `seal.ts` warns once per failed attempt,
 *   so the cooldown is what keeps a page lifetime from turning into a warning
 *   flood while 单1's endpoint is still absent (当前预期常态): the same
 *   failure state costs one warning per backoff window, never one per flip.
 *
 * The handle is created in `apply` and shared through the browser's inject
 * face (no module-level handle — packages/client/AGENTS.md store discipline);
 * rows reach it only as the injected `hooks.sealLight` snapshot plus the
 * plain `sealRows` observer.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SealLightSnapshot, SealRowObserver } from '../contract/slots.ts'
import { requestSealCheck, type SessionSealInfo } from './seal.ts'

/** The C1 ask the store drives; `null` is the contracted failure answer (seal.ts never rejects). */
export type SealCheckRequest = (ids: readonly SessionId[]) => Promise<Map<SessionId, SessionSealInfo> | null>

/** Minimum gap between two check dispatches (任务书: 节流 ≥2 秒). */
const SEAL_LIGHT_THROTTLE_MS = 2_000

/** Cooldown after the first failed check; doubles with every consecutive failure. */
const SEAL_LIGHT_FAIL_BACKOFF_BASE_MS = 30_000

/** Backoff ceiling: retries keep the light able to wake when the endpoint lands, never hot. */
const SEAL_LIGHT_FAIL_BACKOFF_MAX_MS = 300_000

/** One handle: the snapshot the browser reads and the observer its rows write through. */
export interface SealLightStoreHandle {
  /** The verdict snapshot; identity moves only when a check republishes it. */
  readonly observable: HostObservable<SealLightSnapshot>
  /** The row-side observation channel the mounted lights drive. */
  readonly sealRows: SealRowObserver
}

/**
 * Create one archive-seal light store.
 * @param request - the C1 ask; defaults to the shared `requestSealCheck` so
 * production and specs exercise the same transport (specs inject their own to
 * count calls, or omit it and stub the global fetch).
 * @returns the handle: the snapshot source plus the row observer.
 */
export function createSealLightStore(request: SealCheckRequest = requestSealCheck): SealLightStoreHandle {
  /** Mounted light rows: Session id → the running flag its row last reported. */
  const rows = new Map<SessionId, boolean>()
  const listeners = new Set<() => void>()
  let seals: SealLightSnapshot = new Map()
  /** A trigger arrived that no scheduled or in-flight check has covered yet. */
  let dirty = false
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | undefined
  /** When the last check started, for the throttle gap; -∞ until the first. */
  let lastDispatchAt = Number.NEGATIVE_INFINITY
  /** Consecutive failed checks; resets on any answer the service produced. */
  let failures = 0
  /** No further dispatch before this instant (the failure backoff). */
  let cooldownUntil = Number.NEGATIVE_INFINITY

  const publish = (): void => {
    for (const listener of [...listeners]) listener()
  }

  /** The wait before the next dispatch: whichever of throttle gap and backoff runs longer. */
  const nextDelay = (): number => {
    const now = Date.now()
    const throttle = Number.isFinite(lastDispatchAt)
      ? Math.max(0, SEAL_LIGHT_THROTTLE_MS - (now - lastDispatchAt))
      : 0
    const cooldown = Number.isFinite(cooldownUntil) ? Math.max(0, cooldownUntil - now) : 0
    return Math.max(throttle, cooldown)
  }

  const arm = (): void => {
    // Every call wants a check with the CURRENT row set. While one is already
    // queued or in flight the flag is what remembers that want: the pending
    // dispatch reads the set at its own start, and a settled in-flight one
    // re-arms below.
    dirty = true
    if (inFlight || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      fire()
    }, nextDelay())
  }

  const fire = (): void => {
    /* v8 ignore next -- arm() schedules only while idle, so this stays a backstop. */
    if (inFlight) return
    if (rows.size === 0) {
      // Everything unmounted (list emptied, surface gone): nothing to ask for
      // and nothing to paint, so the want is spent instead of polling.
      dirty = false
      return
    }
    const ids = [...rows.keys()]
    inFlight = true
    dirty = false
    lastDispatchAt = Date.now()
    void request(ids)
      .then((result) => { settle(ids, result) })
      .catch(() => {
        /* v8 ignore next -- requestSealCheck is contracted never to reject; this
           rung only exists for a future contract break and still fails dark. */
        settle(ids, null)
      })
  }

  const settle = (ids: readonly SessionId[], result: Map<SessionId, SessionSealInfo> | null): void => {
    inFlight = false
    if (result === null) {
      failures += 1
      cooldownUntil = Date.now() + Math.min(
        SEAL_LIGHT_FAIL_BACKOFF_BASE_MS * 2 ** (failures - 1),
        SEAL_LIGHT_FAIL_BACKOFF_MAX_MS,
      )
      // Fail-dark: an unreadable answer paints nothing rather than leaving the
      // last known lamp lit (灯暗 = 不制造假信号, 与门的 fail-open 刻意相反).
      if (seals.size > 0) {
        seals = new Map()
        publish()
      }
    } else {
      failures = 0
      cooldownUntil = Number.NEGATIVE_INFINITY
      const next = new Map(seals)
      // A row this check asked about but got no row for reads dark (行无数据
      // → 暗); rows outside this check keep whatever they last proved.
      for (const id of ids) next.delete(id)
      for (const [id, seal] of result) next.set(id, seal)
      seals = next
      publish()
    }
    if (dirty) arm()
  }

  const observable: HostObservable<SealLightSnapshot> = {
    getSnapshot: () => seals,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  const sealRows: SealRowObserver = {
    watch(sessionId) {
      if (!rows.has(sessionId)) {
        rows.set(sessionId, false)
        // A new visible row is an id-set change: the stated trigger.
        arm()
      }
      let released = false
      return () => {
        if (released) return
        released = true
        rows.delete(sessionId)
        arm()
      }
    },
    reportRunning(sessionId, running) {
      const known = rows.get(sessionId)
      if (known === undefined || known === running) return
      rows.set(sessionId, running)
      // Only the stop matters: while work runs no save can be DONE, so
      // false→true is not a moment worth a check.
      if (known && !running) arm()
    },
  }

  return { observable, sealRows }
}
