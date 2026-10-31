/**
 * The done-receipt projection fold (collab step2 §二 亮灯层, step4b 件A):
 * the transcript is the single source of the 待收讫 light — a receipt lands,
 * supersedes, and clears the way the Host rebuilds it after any restart.
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyLastReceipt } from '../src/list.ts'

const event = (data: Extract<SessionEvent, { type: 'deliverables/receipt' }>['data'], time = 100) =>
  ({ type: 'deliverables/receipt', time, data }) as SessionEvent

describe('applyLastReceipt', () => {
  it('records a pass receipt with its self-certification', () => {
    const next = applyLastReceipt(null, event({ turn: 1, callId: 'c1' as never, verdict: 'pass', summary: 'commit abc; gates green', evidence: ['abc'] }))
    expect(next).toEqual({ verdict: 'pass', summary: 'commit abc; gates green', evidence: ['abc'], at: 100 })
  })

  it('a later receipt supersedes the old one and an empty evidence list stays absent', () => {
    const first = applyLastReceipt(null, event({ turn: 1, callId: 'c1' as never, verdict: 'pass', summary: 'first' }))
    const second = applyLastReceipt(first, event({ turn: 3, callId: 'c2' as never, verdict: 'exception', summary: 'second', evidence: [] }, 200))
    expect(second).toEqual({ verdict: 'exception', summary: 'second', at: 200 })
  })

  it('the next turn start clears the receipt — new work replaces the close-out claim', () => {
    const receipt = applyLastReceipt(null, event({ turn: 1, callId: 'c1' as never, verdict: 'pass', summary: 'done' }))
    const start = { type: 'turn/start', time: 300, data: { turn: 2 } } as SessionEvent
    expect(applyLastReceipt(receipt, start)).toBeNull()
    // A null state passes through untouched.
    expect(applyLastReceipt(null, start)).toBeNull()
  })

  it('ignores unrelated events and malformed verdicts (fail-closed)', () => {
    const receipt = applyLastReceipt(null, event({ turn: 1, callId: 'c1' as never, verdict: 'pass', summary: 'done' }))
    expect(applyLastReceipt(receipt, { type: 'turn/end', time: 400, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent)).toBe(receipt)
    expect(applyLastReceipt(receipt, event({ turn: 2, callId: 'c2' as never, verdict: 'forged' as never, summary: 'bad' }, 500))).toBe(receipt)
  })
})
