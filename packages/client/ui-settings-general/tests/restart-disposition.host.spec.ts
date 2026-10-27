/**
 * Restart disposition state (P3): the automatic-restart flag stays off unless
 * the environment opts in, the client attestation slot only accepts clean
 * non-negative integers and expires past its freshness window, the dispatch
 * claim is single-shot within its TTL window (D: a failed dispatch must not
 * lock the button for the rest of the process), and the pure judgment holds
 * on every uncertainty.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  ATTESTATION_MAX_AGE_MS,
  AUTO_RESTART_ENV,
  autoRestartEnabled,
  claimRestartDispatch,
  DISPATCH_CLAIM_TTL_MS,
  judgeRestartDisposition,
  latestClientAttestation,
  recordClientRunningCount,
  resetDispositionStateForTest,
  restartDispatchClaimed,
} from '../src/restart-disposition.ts'

afterEach(() => {
  resetDispositionStateForTest()
})

describe('auto-restart flag', () => {
  it('stays off unless the environment says exactly 1 (default-off 实证)', () => {
    expect(autoRestartEnabled({})).toBe(false)
    expect(autoRestartEnabled({ [AUTO_RESTART_ENV]: undefined })).toBe(false)
    expect(autoRestartEnabled({ [AUTO_RESTART_ENV]: '' })).toBe(false)
    expect(autoRestartEnabled({ [AUTO_RESTART_ENV]: '0' })).toBe(false)
    expect(autoRestartEnabled({ [AUTO_RESTART_ENV]: 'true' })).toBe(false)
    expect(autoRestartEnabled({ [AUTO_RESTART_ENV]: 'yes' })).toBe(false)
    expect(autoRestartEnabled({ [AUTO_RESTART_ENV]: '2' })).toBe(false)
    expect(autoRestartEnabled({ [AUTO_RESTART_ENV]: '1 ' })).toBe(false)
    expect(autoRestartEnabled({ [AUTO_RESTART_ENV]: '1' })).toBe(true)
  })
})

describe('client running-count attestation', () => {
  it('records only non-negative integers and ignores malformed reports', () => {
    recordClientRunningCount(3, 1_000)
    recordClientRunningCount(-1, 2_000)
    recordClientRunningCount(1.5, 2_000)
    recordClientRunningCount('2', 2_000)
    recordClientRunningCount(null, 2_000)
    recordClientRunningCount({}, 2_000)
    expect(latestClientAttestation(2_000)).toEqual({ count: 3, at: 1_000 })
  })

  it('drops reports past the freshness window', () => {
    recordClientRunningCount(0, 1_000)
    expect(latestClientAttestation(1_000 + ATTESTATION_MAX_AGE_MS)).toEqual({ count: 0, at: 1_000 })
    expect(latestClientAttestation(1_000 + ATTESTATION_MAX_AGE_MS + 1)).toBeUndefined()
  })

  it('reports nothing before the first record', () => {
    expect(latestClientAttestation(1_000)).toBeUndefined()
  })
})

describe('restart dispatch claim', () => {
  it('lets exactly one claimant own the dispatch while the claim is fresh', () => {
    expect(restartDispatchClaimed()).toBe(false)
    expect(claimRestartDispatch()).toBe(true)
    expect(restartDispatchClaimed()).toBe(true)
    expect(claimRestartDispatch()).toBe(false)
  })

  it('releases the claim after the TTL so a failed dispatch cannot lock the button for the process lifetime (D)', () => {
    const t0 = 1_000_000
    expect(claimRestartDispatch(t0)).toBe(true)
    // Inside the window: still one claimant.
    expect(restartDispatchClaimed(t0 + DISPATCH_CLAIM_TTL_MS - 1)).toBe(true)
    expect(claimRestartDispatch(t0 + DISPATCH_CLAIM_TTL_MS - 1)).toBe(false)
    // At expiry: the claim is gone and a retry may dispatch again.
    expect(restartDispatchClaimed(t0 + DISPATCH_CLAIM_TTL_MS)).toBe(false)
    expect(claimRestartDispatch(t0 + DISPATCH_CLAIM_TTL_MS)).toBe(true)
  })
})

describe('judgeRestartDisposition (fail-closed)', () => {
  const zero = { count: 0, at: 1_000 }
  const base = { enabled: true, hostRunningCount: 0, attestation: zero, now: 6_000 }

  it('holds with the flag off before any other question', () => {
    expect(judgeRestartDisposition({ ...base, enabled: false, hostRunningCount: 5 })).toEqual({ action: 'hold:flag-off' })
  })

  it('holds when the host count is unavailable', () => {
    expect(judgeRestartDisposition({ ...base, hostRunningCount: undefined })).toEqual({ action: 'hold:count-unavailable' })
  })

  it('holds while sessions run — the >0 branch never auto-restarts', () => {
    expect(judgeRestartDisposition({ ...base, hostRunningCount: 2 })).toEqual({ action: 'hold:running' })
  })

  it('holds without a client attestation', () => {
    expect(judgeRestartDisposition({ ...base, attestation: undefined })).toEqual({ action: 'hold:no-attestation' })
  })

  it('holds on a stale attestation', () => {
    expect(judgeRestartDisposition({ ...base, now: 1_000 + ATTESTATION_MAX_AGE_MS + 1 })).toEqual({ action: 'hold:stale-attestation' })
  })

  it('holds when the client count disagrees with the host (不一致即阻断)', () => {
    expect(judgeRestartDisposition({ ...base, attestation: { count: 2, at: 1_000 } })).toEqual({ action: 'hold:mismatch' })
  })

  it('holds when the client says zero but the host counts running sessions', () => {
    expect(judgeRestartDisposition({ ...base, hostRunningCount: 1, attestation: zero })).toEqual({ action: 'hold:running' })
  })

  it('dispatches only when the flag is on, the host count is zero, and a fresh client report agrees', () => {
    expect(judgeRestartDisposition(base)).toEqual({ action: 'dispatch' })
  })
})
