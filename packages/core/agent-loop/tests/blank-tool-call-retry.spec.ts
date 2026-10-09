import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { NonEmptyToolCallIdError, SessionId, type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/**
 * Make the next `assistant/message` appends fail at the append site — the
 * exact rejection `Session.append` raises for a blank tool-call id — while
 * every other append passes through. `times` bounds the injections:
 * 1 = a single poisoned reply (self-heal case), Infinity = persistent
 * model degradation. The poisoned row never enters the log, which is what
 * makes the loop's single re-issue idempotent.
 */
function poisonAssistantMessages(session: Session, error: Error, times: number): void {
  const original = session.append.bind(session) as (...args: unknown[]) => unknown
  let thrown = 0
  ;(session as unknown as { append: (...args: unknown[]) => unknown }).append = (...args: unknown[]) => {
    if (args[0] === 'assistant/message' && thrown < times) {
      thrown += 1
      throw error
    }
    return original(...args)
  }
}

function go(): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
}

describe('blank tool-call rejection — one bounded re-issue (2026-10-09)', () => {
  it('re-issues the step request once and commits the well-formed reply', async () => {
    const adapter = new MockAdapter([textResponse('poisoned'), textResponse('recovered')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('blank-retry-recover'), { provider: 'mock', model: 'mock' })
    let errors = 0
    ctx.on('agent/error', () => { errors += 1 })
    poisonAssistantMessages(agent.session, new NonEmptyToolCallIdError('injected blank tool-call id'), 1)

    agent.followup(go())
    await agent.whenIdle()

    // Exactly one re-issue: the loop spent a second request and no more.
    expect(adapter.requests).toHaveLength(2)
    const messages = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages)).toContain('recovered')
    // The poisoned attempt never entered the durable log (idempotence premise).
    expect(JSON.stringify(messages)).not.toContain('poisoned')
    // Self-healed: the turn never failed, so no terminal agent/error fired.
    expect(errors).toBe(0)
    const turnEnd = agent.session.snapshotEvents().find(event => event.type === 'turn/end')
    expect(turnEnd).toBeDefined()
    expect(JSON.stringify(turnEnd)).not.toContain('"error"')
  })

  it('gives up after the single retry when the rejection persists', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('blank-retry-gives-up'), { provider: 'mock', model: 'mock' })
    let errors = 0
    ctx.on('agent/error', () => { errors += 1 })
    poisonAssistantMessages(agent.session, new NonEmptyToolCallIdError('injected blank tool-call id'), Number.POSITIVE_INFINITY)

    agent.followup(go())
    await agent.whenIdle()

    // Cap = 1: two requests total, then the failure surfaces (防连环空烧).
    expect(adapter.requests).toHaveLength(2)
    expect(errors).toBe(1)
    const turnEnd = agent.session.snapshotEvents().find(event => event.type === 'turn/end')
    expect(turnEnd).toMatchObject({ data: { reason: { kind: 'error' } } })
    // Neither poisoned attempt reached the log.
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(0)
  })

  it('does not re-issue other append failures', async () => {
    const adapter = new MockAdapter([textResponse('only')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('blank-retry-narrow'), { provider: 'mock', model: 'mock' })
    let errors = 0
    ctx.on('agent/error', () => { errors += 1 })
    poisonAssistantMessages(agent.session, new Error('disk full'), Number.POSITIVE_INFINITY)

    agent.followup(go())
    await agent.whenIdle()

    // The guard is narrow: only blank tool-call rejections re-issue.
    expect(adapter.requests).toHaveLength(1)
    expect(errors).toBe(1)
    const turnEnd = agent.session.snapshotEvents().find(event => event.type === 'turn/end')
    expect(turnEnd).toMatchObject({ data: { reason: { kind: 'error' } } })
  })
})
