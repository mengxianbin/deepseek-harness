/**
 * The archive-seal row light's data layer (FORK archive-seal-light-1101): the
 * browser-side store over contract C1 the row lamps read (design ruling
 * `seal-light-landing-ruling`, archive-seal-light.md §五 行灯层).
 *
 * Policy, all of it design-sourced:
 * - **Who is asked** — exactly the rows whose light is mounted: visible,
 *   non-archived, non-blank Session rows (design §三 对象 / §六.6 归档态行
 *   不请求). A row joining or leaving that set raises a check.
 * - **When** — an id-set change, or one row's `running` flip either way
 *   (2026-11-06 修订, seal-light-running-dark-1106): true→false is the moment
 *   a save can turn green (设计点名的最可能变绿时刻); false→true is the moment
 *   the verdict on screen turns stale, so the reading refreshes instead of
 *   holding the previous turn's answer through the run — the original premise
 *   「while work runs no save can be DONE」 was disproved by a fake sentinel
 *   answering DONE for a whole run (活样本 = `session-c879796c`, 2026-11-06).
 *   No resident polling: a settled check with no new trigger never re-arms itself.
 * - **Pace** — at least {@link SEAL_LIGHT_THROTTLE_MS} between two checks and
 *   one in flight at a time (throttle + single flight, 任务书节流 ≥2 秒).
 * - **Failure** — `null` from `requestSealCheck` stamps every asked row
 *   `UNKNOWN` (fail-visible since seal-light-host-state-1109 ④, superseding
 *   the old fail-dark clear): 「查失败」 must not paint the same dark as
 *   「未收口」, so the lamp renders the amber dashed unreadable ring instead of
 *   silence, while the relay gate keeps failing closed (`UNKNOWN !== DONE`).
 *   The failure still starts an exponential cooldown, and `seal.ts` warns once
 *   per failed attempt, so the cooldown is what keeps a page lifetime from
 *   turning into a warning flood while 单1's endpoint is still absent
 *   (当前预期常态): the same failure state costs one warning per backoff
 *   window, never one per flip.
 *
 * The handle is created in `apply` and shared through the browser's inject
 * face (no module-level handle — packages/client/AGENTS.md store discipline);
 * rows reach it only as the injected `hooks.sealLight` snapshot plus the
 * plain `sealRows` observer.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionSealState } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SealLightSnapshot, SealRowObserver } from '../contract/slots.ts'
import { requestSealCheck, type SessionSealInfo, type SessionSealVerdict } from './seal.ts'

/** The stamp a failed check leaves on every asked row (④): the lamp renders it as the amber dashed unreadable ring. */
const UNREADABLE_SEAL: SessionSealInfo = { verdict: 'UNKNOWN' }

/** The six-value vocabulary this build understands; a newer token reads as UNKNOWN (fail-visible, never silent). */
const SEAL_VERDICTS: ReadonlySet<string> = new Set<SessionSealVerdict>([
  'DONE', 'N_A', 'UNSEALED', 'NEUTRAL', 'LEGACY', 'UNKNOWN',
])

/** Content equality for one verdict row: maps hold fresh objects per frame. */
function sameSealInfo(left: SessionSealInfo | undefined, right: SessionSealInfo | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  return left.verdict === right.verdict
    && left.detail === right.detail
    && left.followUpCount === right.followUpCount
}

/** Content equality for two snapshots; identity-equal inputs are equal. */
function sameSealMaps(left: SealLightSnapshot, right: SealLightSnapshot): boolean {
  if (left === right) return true
  if (left.size !== right.size) return false
  for (const [id, seal] of left) {
    if (!sameSealInfo(seal, right.get(id))) return false
  }
  return true
}

/** Narrow a Host-carried verdict (opaque string) into this build's vocabulary; unknown tokens read UNKNOWN. */
function sealInfoOf(state: SessionSealState): SessionSealInfo {
  const verdict: SessionSealVerdict = SEAL_VERDICTS.has(state.verdict)
    ? state.verdict as SessionSealVerdict
    : 'UNKNOWN'
  return {
    verdict,
    ...(state.detail === undefined ? {} : { detail: state.detail as NonNullable<SessionSealInfo['detail']> }),
    ...(state.followUpCount === undefined ? {} : { followUpCount: state.followUpCount }),
  }
}

/**
 * Overlay the Host's status-carried seal verdicts (seal-light-host-state-1109
 * 裁点2A 推腿 + 裁点3A 对账腿, both folded into `SessionStatus.seal` by
 * ui-session) over the C1 pull snapshot the store holds. Host truth wins
 * whenever it carries a readable verdict; a row the Host holds nothing for
 * keeps the pull's value (the pull chain stays the coverage fallback —
 * 拉取链退役未裁).
 *
 * The one exception (seal-lamp-consistency-1114, brief §② A): a Host record
 * that could not be read is not a reading. When `UNKNOWN` (a decode-fail
 * record or any unreadable stamp) meets a pull snapshot that already holds a
 * C1 `DONE`, the unreadable record loses its claim to press and the lamp
 * paints the pull's green — the same C1 source the archive gate reads at
 * click time, so lamp and gate answer alike instead of the amber-over-green
 * split the user reported (2026-11-14). This extends the existing no-value
 * rule ("Host 无值行留拉取值") to "no *readable* value" without touching
 * Host-wins for real verdicts: every other Host verdict still presses, a
 * failed pull still stamps UNKNOWN on both legs, and a row the pull holds
 * nothing for still takes the Host stamp — fail-visible and fail-closed on
 * all three paths, green reachable only from a real C1 DONE.
 * Returns the input snapshot identity when nothing changes, so React
 * subscribers see no spurious republish.
 * @param store - the C1 pull snapshot.
 * @param statuses - the status snapshot rows, structural to avoid depending
 *   on ui-session's concrete type here.
 * @returns the merged snapshot the row lamps paint from.
 */
export function mergeHostSeals(
  store: SealLightSnapshot,
  statuses: ReadonlyMap<SessionId, { readonly seal?: SessionSealState }>,
): SealLightSnapshot {
  let next: Map<SessionId, SessionSealInfo> | undefined
  for (const [id, status] of statuses) {
    if (status.seal === undefined) continue
    const info = sealInfoOf(status.seal)
    // seal-lamp-consistency-1114: an unreadable record yields to a real C1
    // DONE in the pull snapshot (brief §② A — non-reversal: this extends
    // 「Host 无值行留拉取值」to "no readable value", Host-wins for real
    // verdicts is untouched).
    if (info.verdict === 'UNKNOWN' && store.get(id)?.verdict === 'DONE') continue
    if (sameSealInfo(store.get(id), info)) continue
    next ??= new Map(store)
    next.set(id, info)
  }
  return next ?? store
}

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
      // Fail-visible (seal-light-host-state-1109 ④, supersedes fail-dark):
      // an unreadable answer stamps every asked row UNKNOWN instead of
      // clearing the map. 熄灯伪装成未收口 is the exact failure this单 cures —
      // the lamp paints the amber dashed "unreadable" ring (unknown ≠
      // not-ready), rows outside this check keep what they last proved, and
      // the relay gate still fails closed because UNKNOWN !== DONE.
      const next = new Map(seals)
      for (const id of ids) next.set(id, UNREADABLE_SEAL)
      if (!sameSealMaps(seals, next)) {
        seals = next
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
      // Both flips are worth a check (2026-11-06 running 短路): true→false is
      // when a save can turn green; false→true is when the verdict on screen
      // goes stale — the old premise 「while work runs no save can be DONE」
      // was disproved by a fake sentinel answering DONE for a whole run, so a
      // start re-checks too and the lamp stops painting the previous turn's
      // reading while work runs (seal-light-running-dark-1106).
      arm()
    },
  }

  return { observable, sealRows }
}
