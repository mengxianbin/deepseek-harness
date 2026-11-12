/** Browser restart reads: the capability page global, the running count, and the recheck view. */
import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { RESTART_SIGNAL_STATES, resolveRestartCapability, resolveRestartSignal } from '../src/restart.ts'
import { countRunningSessions } from '../src/client/restart-count.ts'

/** One status entry with only the running fact decided. */
function status(running: boolean | undefined): SessionStatus {
  return { running, pendingInteraction: undefined, completionUnread: false }
}

describe('resolveRestartCapability', () => {
  it('accepts exactly the announced configured marker', () => {
    expect(resolveRestartCapability({ configured: true })).toBe(true)
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['an array', [true]],
    ['a string', 'configured'],
    ['a number', 1],
    ['a missing field', {}],
    ['a non-boolean field', { configured: 'yes' }],
    ['an explicit false', { configured: false }],
  ])('rejects %s', (_label, value) => {
    expect(resolveRestartCapability(value)).toBe(false)
  })
})

describe('countRunningSessions', () => {
  it('counts only Sessions whose running fact is established true', () => {
    const snapshot: SessionStatusSnapshot = new Map([
      [SessionId('running-a'), status(true)],
      [SessionId('running-b'), status(true)],
      [SessionId('stopped'), status(false)],
      [SessionId('baseline-pending'), status(undefined)],
    ])
    expect(countRunningSessions(snapshot)).toBe(2)
  })

  it('counts an empty snapshot as zero', () => {
    expect(countRunningSessions(new Map())).toBe(0)
  })
})

describe('resolveRestartSignal', () => {
  it('accepts every legal state, with a restart branch only when one is named', () => {
    for (const state of RESTART_SIGNAL_STATES) {
      expect(resolveRestartSignal({ state })).toEqual({ state })
    }
    expect(resolveRestartSignal({ state: 'NEED_RESTART', reason: 'config' })).toEqual({ state: 'NEED_RESTART', reason: 'config' })
    expect(resolveRestartSignal({ state: 'NEED_RESTART', reason: 'built' })).toEqual({ state: 'NEED_RESTART', reason: 'built' })
  })

  it('passes a readable BUILDING start time through to the timer tooltip (build-timer-tooltip-1101)', () => {
    expect(resolveRestartSignal({ state: 'BUILDING', startedAt: '2026-11-01T13:36:21.476Z' }))
      .toEqual({ state: 'BUILDING', startedAt: '2026-11-01T13:36:21.476Z' })
  })

  it('passes the linked-drift repository name through for the lamp copy (build-scope-rework-1105 A)', () => {
    expect(resolveRestartSignal({ state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web-worktrees/auto-route-1024' }))
      .toEqual({ state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web-worktrees/auto-route-1024' })
    // Absent stays absent: a main-tree NEED_BUILD keeps the generic copy seat.
    expect(resolveRestartSignal({ state: 'NEED_BUILD' })).toEqual({ state: 'NEED_BUILD' })
  })

  it('passes the data-confirmed linked build pair through as one seat (linked-lamp-twostate-1111)', () => {
    expect(resolveRestartSignal({ state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuild: 'building' }))
      .toEqual({ state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuild: 'building' })
    expect(resolveRestartSignal({ state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuild: 'failed', linkedBuildFailures: 9 }))
      .toEqual({ state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuild: 'failed', linkedBuildFailures: 9 })
    // A count is meaningless beside `building`: the stray half is dropped, never rendered.
    expect(resolveRestartSignal({ state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuild: 'building', linkedBuildFailures: 3 }))
      .toEqual({ state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuild: 'building' })
  })

  it('fails the linked build pair open to the plain linked line (old host, malformed half)', () => {
    // Old-host serialization sample: the seats simply do not exist — the view
    // stays valid and the copy shows the plain linked line, never a crash.
    expect(resolveRestartSignal({ state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web' }))
      .toEqual({ state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web' })
    const plain = { state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web' }
    for (const value of [
      { state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuild: 'maybe' },
      { state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuild: 7 },
      { state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuild: null },
      { state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuild: 'failed' },
      { state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuild: 'failed', linkedBuildFailures: -1 },
      { state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuild: 'failed', linkedBuildFailures: 2.5 },
      { state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuild: 'failed', linkedBuildFailures: '9' },
      { state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuildFailures: 9 },
    ]) expect(resolveRestartSignal(value)).toEqual(plain)
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['an array', []],
    ['a missing state', { reason: 'config' }],
    ['an unknown state', { state: 'RESTART_SOON' }],
    ['a non-string state', { state: 7 }],
    ['an unknown branch', { state: 'NEED_RESTART', reason: 'someday' }],
    ['a non-string build start', { state: 'BUILDING', startedAt: 7 }],
    ['an unreadable build start', { state: 'BUILDING', startedAt: 'yesterday' }],
    ['a non-string linked repo', { state: 'NEED_BUILD', linkedRepo: 7 }],
    ['an empty linked repo', { state: 'NEED_BUILD', linkedRepo: '' }],
  ])('rejects %s', (_label, value) => {
    expect(resolveRestartSignal(value)).toBeUndefined()
  })
})
