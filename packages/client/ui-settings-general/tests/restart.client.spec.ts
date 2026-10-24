/** Browser restart reads: the capability page global and the running count. */
import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { resolveRestartCapability } from '../src/restart.ts'
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
