import { describe, expect, it } from 'vitest'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { ChatConversationViewNode } from '../src/client/contract/chat-nodes.ts'
import type { ChatSnapshot } from '../src/client/contract/snapshot.ts'
import {
  ChatSnapshotBuilder, ROW_CLOCK_GAP_MS, RowClockProjector,
} from '../src/client/conversation-nodes/chat-snapshot-builder.ts'

function userNode(anchorSeq: number, time: number): ChatConversationViewNode {
  return {
    key: `user:${anchorSeq}`, id: String(anchorSeq), kind: 'user', target: 'chat', anchorSeq,
    visibility: 'visible', location: { kind: 'session' },
    data: { kind: 'user', seq: anchorSeq, time, content: [{ type: 'text', text: 'hi' }], source: null },
  }
}

function assistantNode(anchorSeq: number, time: number): ChatConversationViewNode {
  return {
    key: `assistant:${anchorSeq}`, id: String(anchorSeq), kind: 'assistant-step', target: 'chat', anchorSeq,
    visibility: 'visible', location: { kind: 'session' },
    data: { status: 'settled', turn: 1, step: 1, blocks: [], time },
  }
}

function toolNode(anchorSeq: number, time: number): ChatConversationViewNode {
  return {
    key: `tool:${anchorSeq}`, id: String(anchorSeq), kind: 'tool-call', target: 'chat', anchorSeq,
    visibility: 'visible', location: { kind: 'session' },
    data: {
      root: {
        kind: 'tool-result', seq: anchorSeq, time, callId: `call-${anchorSeq}`, name: 'bash',
        args: PartialArguments.fromText('{}'),
        call: { name: 'bash', argsRaw: '{}' },
        callTime: time, content: [], isError: false, subCalls: [],
      },
    },
  }
}

function turnErrorNode(anchorSeq: number, time: number): ChatConversationViewNode {
  return {
    key: `turn-error:${anchorSeq}`, id: String(anchorSeq), kind: 'turn-error', target: 'chat', anchorSeq,
    visibility: 'visible', location: { kind: 'session' },
    data: { kind: 'turn-error', seq: anchorSeq, time, turn: 1, step: 0, message: 'boom' },
  }
}

/** An untimed disclosure row: it must neither clock nor break the gap chain. */
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

function clockOf(nodes: readonly ChatConversationViewNode[], key: string): number | undefined {
  return nodes.find(node => node.key === key)?.clock
}

describe('always-visible row clock stamping', () => {
  it('clocks key rows from their own event time regardless of the gap', () => {
    const stamped = new RowClockProjector().replace([
      userNode(1, 1_000), toolNode(2, 2_000), turnErrorNode(3, 3_000),
    ])
    expect(clockOf(stamped, 'tool:2')).toBe(2_000)
    expect(clockOf(stamped, 'turn-error:3')).toBe(3_000)
    // The opening row has no previous timed row to measure against.
    expect(clockOf(stamped, 'user:1')).toBeUndefined()
  })

  it('opens a clock only from a loaded gap of at least ten minutes', () => {
    const near = new RowClockProjector().replace([
      userNode(1, 0), assistantNode(2, ROW_CLOCK_GAP_MS - 1),
    ])
    expect(clockOf(near, 'assistant:2')).toBeUndefined()
    const far = new RowClockProjector().replace([
      userNode(1, 0), assistantNode(2, ROW_CLOCK_GAP_MS),
    ])
    expect(clockOf(far, 'assistant:2')).toBe(ROW_CLOCK_GAP_MS)
  })

  it('lets untimed rows pass through the chain without clocking', () => {
    const stamped = new RowClockProjector().replace([
      userNode(1, 0), processNode(2), assistantNode(3, ROW_CLOCK_GAP_MS),
    ])
    expect(clockOf(stamped, 'turn-process:2')).toBeUndefined()
    expect(clockOf(stamped, 'assistant:3')).toBe(ROW_CLOCK_GAP_MS)
  })

  it('re-stamps unchanged rows to the same reference', () => {
    const input = [userNode(1, 0), toolNode(2, 2_000), assistantNode(3, ROW_CLOCK_GAP_MS)]
    const first = new RowClockProjector().replace(input)
    const second = new RowClockProjector().replace(first)
    expect(second).toEqual(first)
    second.forEach((node, index) => {
      expect(node).toBe(first[index])
    })
  })

  it('drops a stored neighbor clock when a new row splits the gap', () => {
    const builder = new ChatSnapshotBuilder()
    const timeline = { turnOrder: [] as readonly number[], turns: new Map() }
    const settled: ChatSnapshot = builder.replace({
      nodes: [userNode(1, 0), assistantNode(3, ROW_CLOCK_GAP_MS * 2)],
      timeline,
    })
    expect(settled.nodes.get('assistant:3')?.clock).toBe(ROW_CLOCK_GAP_MS * 2)
    const applied = builder.apply({
      upserts: [userNode(2, 700_000)],
      timeline,
    })
    // The inserted row opens its own 11m40s clock and leaves the old row
    // only 5m20s behind it, so the old clock must come off.
    expect(applied.nodes.get('user:2')?.clock).toBe(700_000)
    expect(applied.nodes.get('assistant:3')?.clock).toBeUndefined()
  })
})
