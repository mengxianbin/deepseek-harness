import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

async function setup(): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return { ctx }
}

describe('append-site tool-call identity validation', () => {
  it('rejects blank tool-call identities at the append site', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create(SessionId('blank-tool-call-id'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const assistant = (id: string) => createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId(id), name: 'echo', arguments: '{}' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    })
    const result = (toolCallId: string, callId: string) => ({
      turn: 1, step: 1,
      message: {
        ...createToolResultMessage({ callId: ToolCallId(callId), content: [], isError: false }),
        toolCallId: ToolCallId(toolCallId),
      },
    })

    // A model that emits a blank call id would otherwise poison the log: the
    // released format refuses the row only at the backend flush, leaving a
    // Session that can never be opened or forked again.
    expect(() => session.append('assistant/message', {
      stream: [], turn: 1, step: 1, message: assistant(''),
    }, { surfaceOp: 'append' })).toThrow('requires a nonempty tool call id')
    expect(() => session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId(''), name: 'echo', arguments: '{}',
    })).toThrow('requires a nonempty tool call id')
    expect(() => session.append('tool/result', result('', 'c1'), { surfaceOp: 'append' }))
      .toThrow('requires a nonempty tool call id')
    expect(() => session.append('tool/result', result('c1', ''), { surfaceOp: 'append' }))
      .toThrow('requires a nonempty tool call id')
    expect(() => session.append('tool/result', result('c2', 'c1'), { surfaceOp: 'append' }))
      .toThrow('message has mismatched tool call ids')

    // Nothing reached the log, so the Session stays usable.
    expect(session.seq).toBe(SessionSeq(2))
    expect(() => {
      session.append('assistant/message', { stream: [], turn: 1, step: 1, message: assistant('c1') }, { surfaceOp: 'append' })
      session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'echo', arguments: '{}' })
      session.append('tool/result', result('c1', 'c1'), { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()
  })
})
