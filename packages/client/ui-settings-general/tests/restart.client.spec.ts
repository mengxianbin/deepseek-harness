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

  it.each([
    ['absent', undefined],
    ['null', null],
    ['an array', []],
    ['a missing state', { reason: 'config' }],
    ['an unknown state', { state: 'RESTART_SOON' }],
    ['a non-string state', { state: 7 }],
    ['an unknown branch', { state: 'NEED_RESTART', reason: 'someday' }],
  ])('rejects %s', (_label, value) => {
    expect(resolveRestartSignal(value)).toBeUndefined()
  })
})
