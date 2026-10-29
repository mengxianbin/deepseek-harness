/**
 * The archive seal gate (FORK archive-seal-gate-ui-1028): the same-origin
 * seal check every archive entry fronts the Host call with (contract C1,
 * served by the dsh-session-archive plugin host half), and the ledger
 * write-back a confirmed seal archive raises afterwards (contract C4).
 *
 * The gate is fail-open by field decision (2026-10-28, recorded in the
 * dispatch report): the seal service being unreachable, absent (plugin not
 * installed yet), or malformed must not block a human archive — the undo
 * notice and the plugin's observed back-fill remain the existing safety nets.
 * Every such failure still logs `console.warn` so a silent degradation is
 * never invisible.
 *
 * The write-back is the mirror image: it runs only from an archive-success
 * callback (never before, so a failed archive leaves no ghost ledger entry),
 * and its own failure is a console diagnostic — the archive already stands.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Contract C1 verdict vocabulary: the six seal groups. */
export type SessionSealVerdict = 'DONE' | 'N_A' | 'UNSEALED' | 'NEUTRAL' | 'LEGACY' | 'UNKNOWN'

/** Contract C1 `UNSEALED` detail vocabulary; `sentinel-stale` carries `followUpCount`. */
export type SessionSealDetail =
  | 'sentinel-pending'
  | 'save-tail-no-sentinel'
  | 'save-trace-no-sentinel'
  | 'sentinel-stale'

/** One Session's seal verdict as C1 reports it. */
export interface SessionSealInfo {
  /** The six-value group. */
  verdict: SessionSealVerdict
  /** The UNSEALED breakdown, when the server named one. */
  detail?: SessionSealDetail
  /** Messages after the DONE sentinel (stale only). */
  followUpCount?: number
}

/** Contract C4 `POST /archive-override` body. */
export interface ArchiveOverrideRequest {
  /** Session ids the write-back addresses (one id per archive action). */
  ids: readonly SessionId[]
  /** `force` = confirmed red archive; `note` = stale line continued. */
  mode: 'force' | 'note'
  /** Force reason; absent stays absent — the server normalizes empty to `override:no-reason`. */
  reason?: string
  /** Ledger seal token (contract C3 stores it as a string). */
  seal?: string
}

/** Same-origin seal check the plugin host half serves (contract C1). */
const SEAL_CHECK_ROUTE = '/api/dsh-session-archive/seal-check'

/** Same-origin ledger write-back the plugin host half serves (contract C4). */
const ARCHIVE_OVERRIDE_ROUTE = '/api/dsh-session-archive/archive-override'

/** Request ceiling: a stalled seal service must not hold the archive click hostage. */
const SEAL_GATE_TIMEOUT_MS = 5_000

/** The known verdict vocabulary, for response parsing. */
const VERDICTS: ReadonlySet<SessionSealVerdict> = new Set<SessionSealVerdict>([
  'DONE', 'N_A', 'UNSEALED', 'NEUTRAL', 'LEGACY', 'UNKNOWN',
])

/** The known detail vocabulary, for response parsing. */
const DETAILS: ReadonlySet<SessionSealDetail> = new Set<SessionSealDetail>([
  'sentinel-pending', 'save-tail-no-sentinel', 'save-trace-no-sentinel', 'sentinel-stale',
])

/**
 * The stale verdict the one-line notice reports, kept as the single shape the
 * continue action and the `note` write-back share.
 */
export const STALE_SEAL: SessionSealInfo = { verdict: 'UNSEALED', detail: 'sentinel-stale' }

/**
 * Green groups archive exactly like before the gate: quiet action, undo notice.
 * @param seal - the verdict the check answered with.
 * @returns whether the verdict needs no interruption.
 */
export function isGreenSeal(seal: SessionSealInfo): boolean {
  return seal.verdict === 'DONE' || seal.verdict === 'N_A' || seal.verdict === 'NEUTRAL' || seal.verdict === 'LEGACY'
}

/**
 * The stale tier (ruling 2026-10-28 `stale-tier`): a save that reached DONE
 * followed by later chatter — a one-line notice, never the full dialog.
 * @param seal - the verdict the check answered with.
 * @returns whether this is the stale demotion.
 */
export function isStaleSeal(seal: SessionSealInfo): boolean {
  return seal.detail === 'sentinel-stale'
}

/**
 * The ledger `seal` string a forced archive carries (C3 stores a string, so
 * the token keeps the condition nameable: detail when the server named one,
 * the verdict group otherwise — e.g. `sentinel-pending` / `UNKNOWN`).
 * @param seal - the verdict behind the confirmation.
 * @returns the ledger token.
 */
export function sealLedgerToken(seal: SessionSealInfo): string {
  return seal.detail ?? seal.verdict
}

/**
 * Build the C4 write-back for one archived Session: `note` pins
 * `seal: "stale"`; `force` carries the verdict token and the operator's
 * reason only when one was typed (empty normalizes server-side to
 * `override:no-reason`, ruling 2026-10-28 `reason-marker`).
 * @param sessionId - the archived Session.
 * @param seal - the verdict the confirmation was about.
 * @param reason - the typed force reason, if any.
 * @returns the request body.
 */
export function archiveOverrideRequest(
  sessionId: SessionId,
  seal: SessionSealInfo,
  reason?: string,
): ArchiveOverrideRequest {
  if (isStaleSeal(seal)) return { ids: [sessionId], mode: 'note', seal: 'stale' }
  const trimmed = reason === undefined ? '' : reason.trim()
  return {
    ids: [sessionId],
    mode: 'force',
    seal: sealLedgerToken(seal),
    ...(trimmed === '' ? {} : { reason: trimmed }),
  }
}

/**
 * Parse one C1 result row; a malformed row is dropped (its Session then reads
 * as absent, which the caller treats as fail-open).
 * @param row - one element of `results`.
 * @returns the parsed id and verdict, or nothing.
 */
function parseSealRow(row: unknown): { id: SessionId; seal: SessionSealInfo } | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const candidate = row as { id?: unknown; verdict?: unknown; detail?: unknown; followUpCount?: unknown }
  if (typeof candidate.id !== 'string' || candidate.id === '') return undefined
  if (typeof candidate.verdict !== 'string') return undefined
  if (!VERDICTS.has(candidate.verdict as SessionSealVerdict)) return undefined
  const seal: SessionSealInfo = { verdict: candidate.verdict as SessionSealVerdict }
  if (typeof candidate.detail === 'string' && DETAILS.has(candidate.detail as SessionSealDetail)) {
    seal.detail = candidate.detail as SessionSealDetail
  }
  if (typeof candidate.followUpCount === 'number' && Number.isFinite(candidate.followUpCount)) {
    seal.followUpCount = candidate.followUpCount
  }
  return { id: candidate.id as SessionId, seal }
}

/**
 * Ask the seal service about one batch of Sessions (contract C1).
 * @param ids - Session ids to classify.
 * @returns the verdicts by id, or `null` when the service failed — the
 * fail-open signal the caller archives quietly on. Never rejects.
 */
export async function requestSealCheck(
  ids: readonly SessionId[],
): Promise<Map<SessionId, SessionSealInfo> | null> {
  if (ids.length === 0) return new Map()
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, SEAL_GATE_TIMEOUT_MS)
  try {
    const response = await fetch(SEAL_CHECK_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
      signal: controller.signal,
    })
    if (!response.ok) {
      console.warn(`seal check rejected: HTTP ${String(response.status)}`)
      return null
    }
    const payload: unknown = await response.json()
    if (typeof payload !== 'object' || payload === null
      || !Array.isArray((payload as { results?: unknown }).results)) {
      console.warn('seal check answered without a results array')
      return null
    }
    const seals = new Map<SessionId, SessionSealInfo>()
    for (const row of (payload as { results: unknown[] }).results) {
      const parsed = parseSealRow(row)
      if (parsed !== undefined) seals.set(parsed.id, parsed.seal)
    }
    return seals
  } catch (reason) {
    console.warn('seal check rejected:', reason)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Write one confirmed archive into the plugin ledger (contract C4).
 * @param request - the write-back body.
 * @returns whether the ledger accepted it; failures warn and answer `false`
 * (the archive itself already stands), and the call never rejects.
 */
export async function postArchiveOverride(request: ArchiveOverrideRequest): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, SEAL_GATE_TIMEOUT_MS)
  try {
    const response = await fetch(ARCHIVE_OVERRIDE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
    if (!response.ok) {
      console.warn(`archive override write-back rejected: HTTP ${String(response.status)}`)
      return false
    }
    return true
  } catch (reason) {
    console.warn('archive override write-back rejected:', reason)
    return false
  } finally {
    clearTimeout(timer)
  }
}
