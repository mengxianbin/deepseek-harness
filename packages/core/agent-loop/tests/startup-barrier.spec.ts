/**
 * Startup-barrier mode (2026-10-20 fork patch, S1 session-create latency):
 * with the registry's `startupBarrier` flag on, `agent/created` listeners
 * (SessionStart hooks) park off the create path as a per-agent barrier, and
 * the first turn joins that barrier — bounded by `startupBarrierTimeoutMs` —
 * before claiming input and assembling the first prompt. Covered scenarios:
 * normal wait, timeout release with a warn, and a late injection still
 * landing ahead of the first LLM request.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(
  adapter: MockAdapter,
  loopConfig: { startupBarrierTimeoutMs?: number } = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry, { startupBarrier: true })
  await ctx.plugin(AgentLoop, { agents: [], ...loopConfig })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function prompt(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('startup barrier', () => {
  it('creation returns before a slow listener settles; the first turn waits and claims its injection', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const release = Promise.withResolvers<undefined>()
    let listenerDone = false
    ctx.on('agent/created', async ({ agent }) => {
      await release.promise
      listenerDone = true
      agent.inject(prompt('startup-context'))
    })

    const agent = await ctx.agentLoop.create(SessionId('barrier-normal'), { provider: 'mock', model: 'mock' })
    // The create path no longer waits out the listener chain (S1).
    expect(listenerDone).toBe(false)

    agent.followup(prompt('hello'))
    // The driver is up but the first turn holds at the barrier: no request yet.
    await delay(20)
    expect(adapter.requests).toEqual([])

    release.resolve(undefined)
    await waitForIdle(ctx, agent)
    expect(listenerDone).toBe(true)
    // The injection rode the very first request, ahead of the user prompt.
    expect(adapter.requests).toHaveLength(1)
    const first = JSON.stringify(adapter.requests[0]!.messages)
    expect(first).toContain('startup-context')
    expect(first).toContain('hello')
    expect(first.indexOf('startup-context')).toBeLessThan(first.indexOf('hello'))
  })

  it('releases the first turn after the barrier timeout with a warn when a listener hangs', async () => {
    const adapter = new MockAdapter([textResponse('ok'), textResponse('again')])
    const ctx = await harness(adapter, { startupBarrierTimeoutMs: 60 })
    const hang = Promise.withResolvers<undefined>()
    ctx.on('agent/created', async () => { await hang.promise })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    const agent = await ctx.agentLoop.create(SessionId('barrier-timeout'), { provider: 'mock', model: 'mock' })
    agent.followup(prompt('hello'))
    await waitForIdle(ctx, agent)
    // The hung hook neither blocked the first request forever nor failed it.
    expect(adapter.requests).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('startup barrier still pending after 60ms'))

    // The abandoned barrier is not re-armed: a second turn needs no new bound wait.
    const warnCalls = warn.mock.calls.length
    agent.followup(prompt('second'))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(2)
    expect(warn.mock.calls.length).toBe(warnCalls)

    hang.resolve(undefined)
  })

  it('a SessionStart injection landing after creation still precedes the first LLM request', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    ctx.on('agent/created', async ({ agent }) => {
      await delay(30)
      agent.inject(prompt('late-injected-context'))
    })

    // The prompt is submitted while the listener is still in flight.
    const agent = await ctx.agentLoop.create(SessionId('barrier-late-inject'), { provider: 'mock', model: 'mock' })
    agent.followup(prompt('hello'))
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    const first = JSON.stringify(adapter.requests[0]!.messages)
    expect(first).toContain('late-injected-context')
    expect(first).toContain('hello')
    expect(first.indexOf('late-injected-context')).toBeLessThan(first.indexOf('hello'))
  })
})
