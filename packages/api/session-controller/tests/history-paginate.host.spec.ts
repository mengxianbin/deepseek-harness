/** First-page byte budget for message-aligned pagination (FORK session-switch-warm-1111). */

import { describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { PAGE_BYTE_BUDGET, paginate } from '../src/history.ts'

/** Build a synthetic append-surface message carrying a payload of the given size. */
function userMessage(seq: number, payloadBytes: number): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    surfaceOp: 'append',
    payload: 'x'.repeat(payloadBytes),
  } as unknown as SessionEvent
}

describe('Session history page byte budget', () => {
  it('publishes a 4 MiB default budget', () => {
    expect(PAGE_BYTE_BUDGET).toBe(4 * 1024 * 1024)
  })

  it('cuts at the message boundary once the byte budget is exceeded', () => {
    // Each event serializes to ~1.06 kB; the third counted message pushes the
    // walked total past 2.5 kB, so the cut lands on that message's group start
    // (its own seq: no sources) and keeps it in the page.
    const events = [0, 1, 2, 3].map(seq => userMessage(seq, 1000))
    const page = paginate(events, undefined, 500, SessionSeq(3), undefined, 2500)

    expect(page.events.map(event => event.seq)).toEqual([1, 2, 3])
    expect(page.hasMore).toBe(true)
  })

  it('keeps the newest message even when it alone overflows the budget', () => {
    const events = [userMessage(0, 10_000)]
    const page = paginate(events, undefined, 500, SessionSeq(0), undefined, 10)

    expect(page.events.map(event => event.seq)).toEqual([0])
    expect(page.hasMore).toBe(false)
  })

  it('leaves a page under the budget to the message cap alone', () => {
    const events = [0, 1, 2].map(seq => userMessage(seq, 100))
    const page = paginate(events, undefined, 500, SessionSeq(2), undefined, 2500)

    expect(page.events).toHaveLength(3)
    expect(page.hasMore).toBe(false)
  })

  it('cuts before the whole message group when its sources reach back further', () => {
    // The middle message carries a source event at seq 0; cutting on its budget
    // trip must keep the group whole, so the page starts at seq 0, not seq 1.
    const events = [
      userMessage(0, 1000),
      { ...userMessage(1, 1000), sourceEventSeqs: [SessionSeq(0)] },
      userMessage(2, 1000),
    ] as SessionEvent[]
    const page = paginate(events, undefined, 500, SessionSeq(2), undefined, 2500)

    expect(page.events.map(event => event.seq)).toEqual([0, 1, 2])
    expect(page.hasMore).toBe(false)
  })
})
