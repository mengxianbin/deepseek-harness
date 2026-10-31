/**
 * The durable last-turn-outcome projection fold (collab step2 §7.2): the
 * transcript is the single source of the row marker, so the recorded end
 * reason survives a refresh and a Host restart until a later turn supersedes
 * it. The 任务已停止 red-dot ruling (2026-11-01) adds `interrupted` — the
 * crash closer for a turn the DSH process left open — to the reasons the row
 * marker reads: it advances the state like `error` instead of passing the
 * previous outcome through, so the row says so instead of staying silent.
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyLastTurnOutcome } from '../src/list.ts'

const end = (kind: string, time = 100) =>
  ({ type: 'turn/end', time, data: { turn: 1, reason: { kind } } }) as unknown as SessionEvent

describe('applyLastTurnOutcome', () => {
  it('records each end reason the row marker reads, including the crash closer', () => {
    expect(applyLastTurnOutcome(null, end('completed'))).toEqual({ kind: 'completed', at: 100 })
    expect(applyLastTurnOutcome(null, end('error'))).toEqual({ kind: 'error', at: 100 })
    expect(applyLastTurnOutcome(null, end('aborted'))).toEqual({ kind: 'aborted', at: 100 })
    expect(applyLastTurnOutcome(null, end('blocked'))).toEqual({ kind: 'blocked', at: 100 })
    expect(applyLastTurnOutcome(null, end('interrupted'))).toEqual({ kind: 'interrupted', at: 100 })
  })

  it('an interrupted turn supersedes the pre-crash outcome — the row no longer reads the stale mark', () => {
    const clean = applyLastTurnOutcome(null, end('completed'))
    expect(applyLastTurnOutcome(clean, end('interrupted', 200))).toEqual({ kind: 'interrupted', at: 200 })
  })

  it('a later turn end supersedes the interruption — a clean rerun turns the mark over', () => {
    const interrupted = applyLastTurnOutcome(null, end('interrupted'))
    expect(applyLastTurnOutcome(interrupted, end('completed', 300))).toEqual({ kind: 'completed', at: 300 })
  })

  it('ignores unrelated events and plugin-merged end reasons (fail-closed)', () => {
    const interrupted = applyLastTurnOutcome(null, end('interrupted'))
    const other = { type: 'turn/start', time: 200, data: { turn: 2 } } as SessionEvent
    expect(applyLastTurnOutcome(interrupted, other)).toBe(interrupted)
    expect(applyLastTurnOutcome(interrupted, end('forked', 300))).toBe(interrupted)
  })
})
