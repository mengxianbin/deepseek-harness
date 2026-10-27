/**
 * Restart disposition state and judgment (P3, design §四): the auto-restart
 * feature flag (default off), the client running-count attestation slot, the
 * in-flight dispatch lock shared by the manual route and the automatic fork,
 * and the pure decision that keeps the automatic path fail-closed.
 *
 * The flag is an environment switch — `DSH_AUTO_RESTART=1` opts in, any other
 * value (including absence) keeps the automatic restart dark, so shipping the
 * code changes nothing until the user explicitly enables it (T2 handover
 * point). The attestation carries the browser's own `countRunningSessions`
 * reading: the disposition only dispatches when the host's count and the
 * client's last report agree at zero (P11 对账判据「不一致即阻断」); a
 * missing, stale, or non-zero report holds. The lock makes the manual
 * `POST /api/restart` button and the automatic fork single-dispatch: whoever
 * claims first dispatches, the other side answers with the existing 202 state
 * and spawns nothing (design §四 P10 竞态).
 * @module @deepseek-ai/dsh-client-ui-settings-general/restart-disposition
 */

/** Environment variable enabling the automatic restart fork; off unless exactly `1`. */
export const AUTO_RESTART_ENV = 'DSH_AUTO_RESTART'

/** How long a client attestation stays usable for the fork decision (P11 建议窗). */
export const ATTESTATION_MAX_AGE_MS = 90_000

/**
 * Read the automatic-restart flag: enabled only when the environment carries
 * exactly `1`; absent, empty, or any other value means off (default-off 实证).
 * @param env - Environment to read (production: `process.env`).
 * @returns Whether the automatic restart fork may dispatch.
 */
export function autoRestartEnabled(env: { readonly [name: string]: string | undefined }): boolean {
  return env[AUTO_RESTART_ENV] === '1'
}

/** One client running-count report: what the browser counted, when it said so. */
export interface RunningCountAttestation {
  /** The client's `countRunningSessions` value at report time. */
  readonly count: number
  /** Report time in epoch milliseconds. */
  readonly at: number
}

let attestation: RunningCountAttestation | undefined

/**
 * Record the client's latest running-count report; malformed reports are
 * dropped (a bad body must never unlock the automatic path).
 * @param raw - Unvalidated `runningCount` from the recheck request body.
 * @param at - Report time; defaults to now.
 */
export function recordClientRunningCount(raw: unknown, at: number = Date.now()): void {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return
  attestation = { count: raw, at }
}

/**
 * The raw attestation slot, freshness not applied — the pure judgment owns
 * the freshness window so its stale branch stays reachable and testable.
 * @returns The last recorded report; `undefined` before the first one.
 */
export function currentClientAttestation(): RunningCountAttestation | undefined {
  return attestation
}

/**
 * The latest usable client attestation.
 * @param now - Current time; defaults to now.
 * @param maxAgeMs - Freshness bound; defaults to {@link ATTESTATION_MAX_AGE_MS}.
 * @returns The attestation when present and fresh; `undefined` otherwise.
 */
export function latestClientAttestation(
  now: number = Date.now(),
  maxAgeMs: number = ATTESTATION_MAX_AGE_MS,
): RunningCountAttestation | undefined {
  if (attestation === undefined) return undefined
  if (now - attestation.at > maxAgeMs) return undefined
  return attestation
}

/**
 * How long one claim blocks re-dispatch (D, 2026-10-26 修订 design §四 P10：
 * 原「进程生命周期一次性锁」在派发失败时把按钮锁死到进程重启——事故实证
 * 12:57 派发未起内层，4 次重点全被 in-flight 吞掉）。60s 依据：派发→内层起
 * 1-2s、起→kill 落地 1-3s，kill 最坏 3 轮 ~30s——进程活着即重启仍在途；
 * 进程活过 60s = 上次派发没成事，放行重试。TTL 到点自动释放 = 锁只防抖、不锁死。
 */
export const DISPATCH_CLAIM_TTL_MS = 60_000

let dispatchClaimedAt: number | undefined

/** Drop the attestation slot and the dispatch claim; tests only. */
export function resetDispositionStateForTest(): void {
  attestation = undefined
  dispatchClaimedAt = undefined
}

/**
 * Claim the one restart dispatch slot; the manual route and the automatic
 * fork both pass through here, so exactly one of them spawns per claim window.
 * @param now - current time in epoch milliseconds; defaults to `Date.now()`.
 * @returns True when the caller now owns the dispatch; false when a claim is
 *   still fresh (the caller must not spawn).
 */
export function claimRestartDispatch(now: number = Date.now()): boolean {
  if (dispatchClaimedAt !== undefined && now - dispatchClaimedAt < DISPATCH_CLAIM_TTL_MS) return false
  dispatchClaimedAt = now
  return true
}

/**
 * Whether a fresh restart-dispatch claim exists (the TTL window has not run out).
 * @param now - current time in epoch milliseconds; defaults to `Date.now()`.
 */
export function restartDispatchClaimed(now: number = Date.now()): boolean {
  return dispatchClaimedAt !== undefined && now - dispatchClaimedAt < DISPATCH_CLAIM_TTL_MS
}

/** Why the fork did or did not dispatch; every hold reason is fail-closed. */
export type RestartDispositionAction =
  | 'dispatch'
  | 'hold:flag-off'
  | 'hold:count-unavailable'
  | 'hold:running'
  | 'hold:no-attestation'
  | 'hold:stale-attestation'
  | 'hold:mismatch'

/** One disposition decision over its data facts (no I/O, no side effects). */
export interface RestartDispositionDecision {
  /** Dispatch the restart, or hold with the fail-closed reason. */
  readonly action: RestartDispositionAction
}

/** Everything the disposition judges; every field is a machine fact. */
export interface RestartDispositionInputs {
  /** The auto-restart flag as read from the environment. */
  readonly enabled: boolean
  /** The host's running count (P11 host 口径); `undefined` when the count was unavailable. */
  readonly hostRunningCount: number | undefined
  /** The client's latest attestation, freshness already applied by the caller. */
  readonly attestation: RunningCountAttestation | undefined
  /** Current time in epoch milliseconds. */
  readonly now: number
}

/**
 * Judge the automatic-restart fork from its data facts. Pure: identical
 * inputs give the identical decision. Every uncertainty — flag off, count
 * unavailable, sessions running, no / stale / disagreeing client report —
 * holds instead of dispatching (设计 §四「不一致即阻断」).
 * @param inputs - Flag, host count, client attestation, and the clock reading.
 * @returns `dispatch` only when the flag is on, the host count is zero, and a
 *   fresh client attestation agrees at zero; otherwise a `hold:*` reason.
 */
export function judgeRestartDisposition(inputs: RestartDispositionInputs): RestartDispositionDecision {
  if (!inputs.enabled) return { action: 'hold:flag-off' }
  if (inputs.hostRunningCount === undefined) return { action: 'hold:count-unavailable' }
  if (inputs.hostRunningCount > 0) return { action: 'hold:running' }
  if (inputs.attestation === undefined) return { action: 'hold:no-attestation' }
  if (inputs.now - inputs.attestation.at > ATTESTATION_MAX_AGE_MS) return { action: 'hold:stale-attestation' }
  if (inputs.attestation.count !== 0) return { action: 'hold:mismatch' }
  return { action: 'dispatch' }
}
