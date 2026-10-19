/**
 * Registry startup-barrier mode (2026-10-20 fork patch, S1): `announce`
 * parks the `agent/created` serial dispatch as the agent's per-agent startup
 * barrier instead of awaiting it, and contains a post-publication listener
 * failure as a warning. The default (flag off) awaited-dispatch contract is
 * pinned by the existing AgentRegistry suite.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'

function stubAgent(rawId: string): Agent {
  const id = SessionId(rawId)
  return {
    id,
    options: {},
    session: Session.create(id),
    inbox: { nextTurn: [], nextStep: [] } as never,
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({}),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

describe('startup-barrier mode', () => {
  it('announce returns before a slow listener settles and parks its settlement as the agent barrier', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry, { startupBarrier: true })
    const release = Promise.withResolvers<undefined>()
    let listenerDone = false
    ctx.on('agent/created', async () => {
      await release.promise
      listenerDone = true
    })
    const agent = stubAgent('barrier-park')
    const detach = ctx.agents.enter(agent, undefined)
    await ctx.agents.announce(agent, 'startup')
    // Announce completed while the listener is still in flight.
    expect(listenerDone).toBe(false)

    // Detach during the parked dispatch stays deferred (announcing contract).
    detach()
    expect(ctx.agents.get(agent.id)).toBe(agent)

    let barrierDone = false
    const barrier = ctx.agents.startupBarrier(agent.id) ?? Promise.resolve()
    const joined = barrier.then(() => { barrierDone = true })
    await Promise.resolve()
    expect(barrierDone).toBe(false)
    release.resolve(undefined)
    await joined
    expect(listenerDone).toBe(true)
    // Settlement ran the announcing release: the deferred detach paired disposal.
    expect(ctx.agents.get(agent.id)).toBeUndefined()
  })

  it('contains a listener failure after publication as a warning instead of a rejection', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry, { startupBarrier: true })
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const heard: string[] = []
    ctx.on('agent/created', () => { throw new Error('late veto') })
    ctx.on('agent/created', () => { heard.push('later listener') })
    const agent = stubAgent('barrier-failure')
    const detach = ctx.agents.enter(agent, undefined)

    // The create path no longer observes the failure as a rejection.
    await expect(ctx.agents.announce(agent, 'startup')).resolves.toBeUndefined()
    await ctx.agents.startupBarrier(agent.id)
    // Serial dispatch semantics are unchanged: the throw skipped the later listener.
    expect(heard).toEqual([])
    expect(warnings).toEqual([
      'agent "barrier-failure": agent/created listener failed after publication: Error: late veto',
    ])
    // The agent stays live — publication already happened.
    expect(ctx.agents.get(agent.id)).toBe(agent)
    detach()
  })

  it('reports no barrier for unknown agents and stays inert with the mode off', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    expect(ctx.agents.startupBarrier(SessionId('unknown'))).toBeUndefined()
  })
})
