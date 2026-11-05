import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatConversationViewNode } from '../src/client/contract/chat-nodes.ts'
import type { ChatSnapshot } from '../src/client/contract/snapshot.ts'
import {
  ChatSnapshotBuilder, RowClockProjector,
} from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { formatDaySeparator, startOfLocalDay, type DayBreakTranslate } from '../src/client/chat/message-chrome.ts'
import { zh } from '../src/client/locale.ts'

function userNode(anchorSeq: number, time: number): ChatConversationViewNode {
  return {
    key: `user:${anchorSeq}`, id: String(anchorSeq), kind: 'user', target: 'chat', anchorSeq,
    visibility: 'visible', location: { kind: 'session' },
    data: { kind: 'user', seq: anchorSeq, time, content: [{ type: 'text', text: 'hi' }], source: null },
  }
}

/** An untimed disclosure row: it must neither clock nor break the day chain. */
function processNode(anchorSeq: number): ChatConversationViewNode {
  return {
    key: `turn-process:${anchorSeq}`, id: String(anchorSeq), kind: 'turn-process', target: 'chat', anchorSeq,
    visibility: 'visible', location: { kind: 'session' },
    data: {
      turn: 1, controlAnchorSeq: anchorSeq, processStartSeq: anchorSeq,
      answerAnchorSeq: null, answerStep: null, inlineReasoning: false,
      messageCount: 0, toolCallCount: 0, subagentCount: 0,
    },
  }
}

function dayOf(nodes: readonly ChatConversationViewNode[], key: string): number | undefined {
  return nodes.find(node => node.key === key)?.dayBreak
}

const d4morning = new Date(2026, 10, 4, 9, 0).getTime()
const d4night = new Date(2026, 10, 4, 22, 0).getTime()
const d5morning = new Date(2026, 10, 5, 8, 0).getTime()
const d5noon = new Date(2026, 10, 5, 12, 0).getTime()

describe('day separator stamping', () => {
  it('opens a separator only on the first timed row of each new local day', () => {
    const stamped = new RowClockProjector().replace([
      userNode(1, d4morning), userNode(2, d4night), userNode(3, d5morning), userNode(4, d5noon),
    ])
    // The loaded window's opening row has no earlier day to cross.
    expect(dayOf(stamped, 'user:1')).toBeUndefined()
    expect(dayOf(stamped, 'user:2')).toBeUndefined()
    expect(dayOf(stamped, 'user:3')).toBe(startOfLocalDay(d5morning))
    expect(dayOf(stamped, 'user:4')).toBeUndefined()
  })

  it('lets untimed rows pass through the chain without opening a day', () => {
    const stamped = new RowClockProjector().replace([
      userNode(1, d4morning), processNode(2), userNode(3, d5morning),
    ])
    expect(dayOf(stamped, 'turn-process:2')).toBeUndefined()
    expect(dayOf(stamped, 'user:3')).toBe(startOfLocalDay(d5morning))
  })

  it('re-stamps unchanged rows to the same reference', () => {
    const input = [userNode(1, d4morning), userNode(2, d5morning), userNode(3, d5noon)]
    const first = new RowClockProjector().replace(input)
    const second = new RowClockProjector().replace(first)
    second.forEach((node, index) => {
      expect(node).toBe(first[index])
    })
  })

  it('gains the separator on the former opening row when an earlier day loads above', () => {
    const builder = new ChatSnapshotBuilder()
    const timeline = { turnOrder: [] as readonly number[], turns: new Map() }
    const settled: ChatSnapshot = builder.replace({
      nodes: [userNode(1, d5morning), userNode(2, d5noon)],
      timeline,
    })
    expect(settled.nodes.get('user:1')?.dayBreak).toBeUndefined()
    const applied = builder.apply({
      upserts: [userNode(0, d4night)],
      timeline,
    })
    // The older page opens the window unseparated; the day change now lands on
    // the row that used to open it, and the later same-day row stays plain.
    expect(applied.nodes.get('user:0')?.dayBreak).toBeUndefined()
    expect(applied.nodes.get('user:1')?.dayBreak).toBe(startOfLocalDay(d5morning))
    expect(applied.nodes.get('user:2')?.dayBreak).toBeUndefined()
  })

  it('drops a stale separator when the row it opened moves back into one day', () => {
    const builder = new ChatSnapshotBuilder()
    const timeline = { turnOrder: [] as readonly number[], turns: new Map() }
    builder.replace({
      nodes: [userNode(1, d4night), userNode(2, d5morning)],
      timeline,
    })
    // A content-only republish moves row 2 onto row 1's day: no day change left.
    const applied = builder.apply({
      upserts: [{ ...userNode(2, d4night) }],
      timeline,
    })
    expect(applied.nodes.get('user:1')?.dayBreak).toBeUndefined()
    expect(applied.nodes.get('user:2')?.dayBreak).toBeUndefined()
  })
})

describe('day separator labels', () => {
  const t: DayBreakTranslate = makeTranslate(zh)
  const now = new Date(2026, 10, 6, 12, 0).getTime()

  it('reads today and yesterday relative to the render day', () => {
    expect(formatDaySeparator(new Date(2026, 10, 6, 0, 0).getTime(), t, now)).toBe('今天')
    expect(formatDaySeparator(new Date(2026, 10, 5, 0, 0).getTime(), t, now)).toBe('昨天')
  })

  it('falls back to the shared date templates for older days', () => {
    expect(formatDaySeparator(new Date(2026, 10, 4, 0, 0).getTime(), t, now)).toBe('11月4日')
    expect(formatDaySeparator(new Date(2025, 11, 31, 0, 0).getTime(), t, now)).toBe('2025年12月31日')
  })
})
