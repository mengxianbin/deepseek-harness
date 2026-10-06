import { describe, expect, it, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'
/**
 * Durable deferred-claim restoration (D6 / E3): the `agent/claim-deferred`
 * record written beside the in-memory defer, its idempotent-by-id projection
 * fold across a real restart and a fork seed, and the negative set (gate
 * reject, empty rewrite, discarded queue input) that must never re-enter
 * through it. `cancel.spec` keeps the in-process G5 queue assertions.
 * @module dsh-agent-loop/tests/deferred-claim
 */

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

/** Plain in-memory harness for fork/seed lifecycles. */
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

/** Persistent harness for restart lifecycles (two contexts share one root). */
async function mount(root: string, adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

async function persistentHarness(adapter: MockAdapter): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-deferred-claim-'))
  dirs.push(root)
  return { ctx: await mount(root, adapter), root }
}

function prompt(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function send(agent: Agent, text: string) {
  agent.followup(prompt(text))
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** All user-message texts recorded in the log. */
function userTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'user/message')
    .flatMap(event => event.type === 'user/message' ? event.data.content : [])
    .flatMap(block => block.type === 'text' ? [block.text] : [])
}

function deferEvents(agent: Agent) {
  return agent.session.snapshotEvents().filter(event => event.type === 'agent/claim-deferred')
}

/** Park one virgin claim: the waking send claims synchronously, the cancel lands in the claim-to-materialize window. */
async function parkClaim(agent: Agent, text: string): Promise<void> {
  send(agent, text)
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  await agent.whenIdle()
}

describe('durable deferred claims', () => {
  it('a restart restores the parked claim behind the system head (G2) with an ignorable record', async () => {
    const { ctx: first, root } = await persistentHarness(new MockAdapter([]))
    const sessionId = SessionId('deferred-restart')
    const agent = await first.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })

    await parkClaim(agent, 'parked across restart')

    // The claim left a durable, skip-safe record instead of dying with the process.
    const parked = deferEvents(agent)
    expect(parked).toHaveLength(1)
    expect(parked[0]).toMatchObject({ ignorable: true })
    expect(parked[0]?.data.turn).toBe(1)
    expect(parked[0]?.data.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : [])).toEqual(['parked across restart'])
    expect(userTexts(agent)).toEqual([])
    await first.fiber.dispose()

    // Lifecycle 2: a brand-new process over the same root resumes the session.
    const adapter = new MockAdapter([textResponse('resumed reply')])
    const ctx = await mount(root, adapter)
    const resumed = (await ctx.agents.resume({
      resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    const idle = waitForIdle(ctx, resumed)
    send(resumed, 'wake after restart')
    await idle

    // Materialized behind the system head, once, and read by the model.
    expect(userTexts(resumed)).toEqual(['parked across restart', 'wake after restart'])
    const messages = adapter.requests.at(-1)?.messages ?? []
    expect(messages[0]?.role).toBe('system')
    expect(JSON.stringify(messages)).toContain('parked across restart')
    expect(JSON.stringify(messages).indexOf('parked across restart'))
      .toBeLessThan(JSON.stringify(messages).indexOf('wake after restart'))
  })

  it('a claim that materialized before the restart is not restored twice', async () => {
    const { ctx: first, root } = await persistentHarness(new MockAdapter([textResponse('first reply')]))
    const sessionId = SessionId('deferred-idempotent')
    const agent = await first.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })

    await parkClaim(agent, 'materialized once')
    expect(userTexts(agent)).toEqual([])
    const idleInProcess = waitForIdle(first, agent)
    send(agent, 'wake in process')
    await idleInProcess
    expect(userTexts(agent)).toEqual(['materialized once', 'wake in process'])
    await first.fiber.dispose()

    const adapter = new MockAdapter([textResponse('second reply')])
    const ctx = await mount(root, adapter)
    const resumed = (await ctx.agents.resume({
      resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    const idle = waitForIdle(ctx, resumed)
    send(resumed, 'again')
    await idle

    // The id already has its `user/message`, so the fold restores nothing.
    expect(userTexts(resumed)).toEqual(['materialized once', 'wake in process', 'again'])
    expect(deferEvents(resumed)).toHaveLength(1)
  })

  it('a fork seed restores the parked claim into the child', async () => {
    const ctx = await harness(new MockAdapter([textResponse('fork reply')]))
    const agent = await ctx.agentLoop.create(SessionId('deferred-fork-source'), { provider: 'mock', model: 'mock' })

    await parkClaim(agent, 'parked into fork')
    expect(userTexts(agent)).toEqual([])

    const child = await ctx.agents.create({
      sessionId: SessionId('deferred-fork-child'),
      agentOptions: { provider: 'mock', model: 'mock' },
      seed: [...agent.session.snapshotEvents()],
    })
    const idle = waitForIdle(ctx, child.agent)
    send(child.agent, 'fork wake')
    await idle

    expect(userTexts(child.agent)).toEqual(['parked into fork', 'fork wake'])
    expect(child.agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(2)
  })

  it('a gate-rejected prompt leaves no defer record and never returns after a restart', async () => {
    const { ctx: first, root } = await persistentHarness(new MockAdapter([]))
    const sessionId = SessionId('deferred-reject')
    const agent = await first.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })
    first.on('agent/pre-step', async ({ turn }, next): Promise<PreStepDecision> =>
      turn === 1 ? { kind: 'reject' } : next())

    send(agent, 'blocked prompt')
    await agent.whenIdle()

    expect(userTexts(agent)).toEqual([])
    expect(deferEvents(agent)).toEqual([])
    await first.fiber.dispose()

    const adapter = new MockAdapter([textResponse('wake reply')])
    const ctx = await mount(root, adapter)
    const resumed = (await ctx.agents.resume({
      resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    const idle = waitForIdle(ctx, resumed)
    send(resumed, 'wake')
    await idle

    expect(userTexts(resumed)).toEqual(['wake'])
    expect(JSON.stringify(adapter.requests.at(-1)?.messages)).not.toContain('blocked prompt')
  })

  it('an empty rewrite leaves no defer record and never returns after a restart', async () => {
    const { ctx: first, root } = await persistentHarness(new MockAdapter([]))
    const sessionId = SessionId('deferred-empty-rewrite')
    const agent = await first.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })
    first.on('agent/pre-step', async ({ turn }, next): Promise<PreStepDecision> =>
      turn === 1 ? { kind: 'enter', messages: [] } : next())

    send(agent, 'rewritten to nothing')
    await agent.whenIdle()

    expect(userTexts(agent)).toEqual([])
    expect(deferEvents(agent)).toEqual([])
    await first.fiber.dispose()

    const adapter = new MockAdapter([textResponse('wake reply')])
    const ctx = await mount(root, adapter)
    const resumed = (await ctx.agents.resume({
      resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    const idle = waitForIdle(ctx, resumed)
    send(resumed, 'wake')
    await idle

    expect(userTexts(resumed)).toEqual(['wake'])
    expect(JSON.stringify(adapter.requests.at(-1)?.messages)).not.toContain('rewritten to nothing')
  })

  it('discarded queue input (canceled) leaves no defer record and never returns after a restart', async () => {
    const { ctx: first, root } = await persistentHarness(new MockAdapter([]))
    const sessionId = SessionId('deferred-canceled')
    const agent = await first.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })

    // Queue without waking, then discard it: the splice carries `outcome: 'canceled'`.
    agent.inbox.append('next-turn', prompt('discarded before claim'))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().some(event =>
      event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')).toBe(true)

    expect(userTexts(agent)).toEqual([])
    expect(deferEvents(agent)).toEqual([])
    await first.fiber.dispose()

    const adapter = new MockAdapter([textResponse('wake reply')])
    const ctx = await mount(root, adapter)
    const resumed = (await ctx.agents.resume({
      resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    const idle = waitForIdle(ctx, resumed)
    send(resumed, 'wake')
    await idle

    expect(userTexts(resumed)).toEqual(['wake'])
    expect(JSON.stringify(adapter.requests.at(-1)?.messages)).not.toContain('discarded before claim')
  })
})
