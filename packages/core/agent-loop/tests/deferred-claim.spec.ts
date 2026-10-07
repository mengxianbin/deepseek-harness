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
 * Durable deferred-claim restoration (D6 / E3) and its α split: the normal
 * abort path now writes the claim back immediately behind a synthetic step
 * sandwich (G1′), while a failed synthetic write still parks it in the
 * `agent/claim-deferred` record — this file covers both paths, their restart
 * and fork lifecycles, and the D-S1 same-source step-number edge. The negative
 * set (gate reject, empty rewrite, discarded queue input) must never re-enter.
 * `cancel.spec` keeps the in-process G5 queue assertions.
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

/**
 * Inject one synthetic write-back failure: the abort sandwich's first append
 * throws, so the turn falls back to the parked defer path (α §6.3 split).
 * @returns restore function; call it before any later real `step/start`.
 */
function failSyntheticWrite(agent: Agent): () => void {
  const session = agent.session as unknown as { append: (type: string, ...rest: unknown[]) => unknown }
  const original = session.append.bind(agent.session)
  session.append = (type: string, ...rest: unknown[]) => {
    if (type === 'step/start') throw new Error('injected synthetic write failure')
    return original(type, ...rest)
  }
  return () => { session.append = original }
}

/**
 * Inject a claim-append failure that lands AFTER the synthetic sandwich is
 * committed: the step stays balanced in the log while the claim parks.
 * @returns restore function.
 */
function failClaimWrite(agent: Agent): () => void {
  const session = agent.session as unknown as { append: (type: string, ...rest: unknown[]) => unknown }
  const original = session.append.bind(agent.session)
  session.append = (type: string, ...rest: unknown[]) => {
    if (type === 'user/message') throw new Error('injected claim write failure')
    return original(type, ...rest)
  }
  return () => { session.append = original }
}

describe('durable deferred claims', () => {
  it('a restart restores the parked claim behind the system head (G2) with an ignorable record', async () => {
    const { ctx: first, root } = await persistentHarness(new MockAdapter([]))
    const sessionId = SessionId('deferred-restart')
    const agent = await first.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })

    // α split — FAILURE path: the synthetic write-back fails, so the abort
    // falls back to the parked defer that must survive the restart.
    const restore = failSyntheticWrite(agent)
    await parkClaim(agent, 'parked across restart')
    restore()

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

    // α split — FAILURE path: park via an injected synthetic write failure,
    // then restore so the in-process wake can take its real first step.
    const restore = failSyntheticWrite(agent)
    await parkClaim(agent, 'materialized once')
    restore()
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

  it('a fork seed carries the immediately written-back claim into the child', async () => {
    const ctx = await harness(new MockAdapter([textResponse('fork reply')]))
    const agent = await ctx.agentLoop.create(SessionId('deferred-fork-source'), { provider: 'mock', model: 'mock' })

    // α split — NORMAL path (G1′): the claim is written back at once behind
    // the synthetic step sandwich; no defer record exists to seed.
    await parkClaim(agent, 'parked into fork')
    expect(userTexts(agent)).toEqual(['parked into fork'])
    expect(deferEvents(agent)).toEqual([])
    const sandwich = agent.session.snapshotEvents()
      .filter(event => ['turn/start', 'turn/end', 'step/start', 'step/end', 'system/message', 'user/message']
        .includes(event.type))
      .map(event => event.type)
    expect(sandwich).toEqual(['turn/start', 'step/start', 'system/message', 'step/end', 'user/message', 'turn/end'])
    expect(agent.session.surface.nodes.length).toBeGreaterThan(0)

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
    expect(deferEvents(child.agent)).toEqual([])
  })

  it('a virgin abort after a balanced empty step synthesizes the next step number and reads back green (D-S1)', async () => {
    const { ctx: first, root } = await persistentHarness(new MockAdapter([]))
    const sessionId = SessionId('deferred-ds1')
    const agent = await first.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })

    // Land the cancel inside the step, after `step/start` but before input
    // admission: the turn spends a balanced empty step while the surface stays
    // virgin (the D-S1 edge). The sandwich must then take `phase.step + 1`.
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    first.on('agent/request', async (_payload, next) => {
      entered.resolve(undefined)
      await release.promise
      return next()
    })
    send(agent, 'stranded after empty step')
    await entered.promise
    agent.cancel({ kind: 'user' })
    release.resolve(undefined)
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'step/start').map(event => event.data.step)).toEqual([1, 2])
    expect(userTexts(agent)).toEqual(['stranded after empty step'])
    expect(deferEvents(agent)).toEqual([])
    expect(events.filter(event => event.type === 'system/message')).toHaveLength(1)
    await first.fiber.dispose()

    // Read-back green: a fresh process replays the log without corruption.
    const adapter = new MockAdapter([textResponse('recovered')])
    const ctx = await mount(root, adapter)
    const resumed = (await ctx.agents.resume({
      resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    const idle = waitForIdle(ctx, resumed)
    send(resumed, 'wake')
    await idle

    expect(userTexts(resumed)).toEqual(['stranded after empty step', 'wake'])
  })

  it('a claim append failure after the sandwich keeps the step balanced and parks the claim', async () => {
    const ctx = await harness(new MockAdapter([]))
    const agent = await ctx.agentLoop.create(SessionId('deferred-post-sandwich'), { provider: 'mock', model: 'mock' })

    // The synthetic step commits; only the claim write fails. The sandwich
    // must stay balanced in the log and the claim must park (unwritten set).
    const restore = failClaimWrite(agent)
    await parkClaim(agent, 'parked after sandwich failure')
    restore()

    const sandwich = agent.session.snapshotEvents()
      .filter(event => ['step/start', 'step/end', 'system/message', 'user/message', 'agent/claim-deferred']
        .includes(event.type))
      .map(event => event.type)
    expect(sandwich).toEqual(['step/start', 'system/message', 'step/end', 'agent/claim-deferred'])
    expect(userTexts(agent)).toEqual([])
    expect(deferEvents(agent)).toHaveLength(1)

    const idle = waitForIdle(ctx, agent)
    send(agent, 'wake')
    await idle
    expect(userTexts(agent)).toEqual(['parked after sandwich failure', 'wake'])
  })

  it('a mid-loop claim write failure parks only the unwritten tail (no double write)', async () => {
    const ctx = await harness(new MockAdapter([]))
    const agent = await ctx.agentLoop.create(SessionId('deferred-midloop'), { provider: 'mock', model: 'mock' })

    // Turn 1 admits TWO claims via rewrite; the cancel lands inside the step,
    // after admission and before input materialization, so the abort write-back
    // strands both — and the SECOND user/message append fails.
    ctx.on('agent/pre-step', async ({ turn }, next): Promise<PreStepDecision> =>
      turn === 1
        ? { kind: 'enter', messages: [prompt('rewritten one'), prompt('rewritten two')] }
        : next())
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('agent/request', async (_payload, next) => {
      entered.resolve(undefined)
      await release.promise
      return next()
    })
    const session = agent.session as unknown as { append: (type: string, ...rest: unknown[]) => unknown }
    const original = session.append.bind(agent.session)
    let userWrites = 0
    session.append = (type: string, ...rest: unknown[]) => {
      if (type === 'user/message' && ++userWrites === 2) throw new Error('injected mid-loop claim write failure')
      return original(type, ...rest)
    }

    send(agent, 'original claim')
    await entered.promise
    agent.cancel({ kind: 'user' })
    release.resolve(undefined)
    await agent.whenIdle()
    session.append = original

    // Only the first claim reached the log; the unwritten tail parked — the
    // written head must NOT be parked again (double-write guard).
    expect(userTexts(agent)).toEqual(['rewritten one'])
    const parked = deferEvents(agent)
    expect(parked).toHaveLength(1)
    expect(parked[0]?.data.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : [])).toEqual(['rewritten two'])

    const idle = waitForIdle(ctx, agent)
    send(agent, 'after wake')
    await idle
    expect(userTexts(agent)).toEqual(['rewritten one', 'rewritten two', 'after wake'])
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
