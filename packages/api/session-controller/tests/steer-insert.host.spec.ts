/**
 * End-to-end delivery semantics for the session-send wire's `mode` field,
 * over the REAL agent loop and a scripted MockAdapter that captures every
 * LLM request body (steer-insert-1121):
 *
 * - busy Session + `mode: 'steer'` — the steered message enters the model
 *   context at the running turn's next step boundary (same turn, second
 *   request), not before;
 * - busy Session + `mode: 'queue'` — the queued message does NOT jump the
 *   turn: it is claimed only when a fresh turn starts after the current one
 *   (queue default regression);
 * - idle Session + `mode: 'steer'` — the pre-existing wake-turn semantics
 *   survive the wire unchanged (steer on an idle agent opens a prompt turn).
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createSessionTestRemote } from './test-remote.ts'
import type { TestSessionRemote } from './test-remote.ts'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'

let nextRequestId = 1
function promptRequest(payload: Omit<SessionPromptRequest, 'requestId'>): SessionPromptRequest {
  return {
    ...payload,
    requestId: `steer-insert-${String(nextRequestId++)}` as SessionRequestId,
  }
}

interface SteerHarness {
  readonly ctx: Context
  readonly remote: TestSessionRemote
  readonly adapter: MockAdapter
}

function waitForIdle(ctx: Context, sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent, status }) => {
      if (agent.id === sessionId && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function harness(script: ConstructorParameters<typeof MockAdapter>[0]): Promise<SteerHarness> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const remote = await createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
    cwd: '/tmp',
  })
  return { ctx, remote, adapter }
}

async function createSession(remote: TestSessionRemote): Promise<SessionId> {
  const created = await remote.create({})
  if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
  return created.value.sessionId
}

describe('session-send delivery mode over the real loop', () => {
  it('injects a steer at the running turn boundary and holds the queue until a fresh turn', async () => {
    // Three model calls: the opening step, the boundary step that must read
    // the steered message, and the fresh turn that must read the queue.
    const { ctx, remote, adapter } = await harness([
      textResponse('step one'),
      textResponse('step two'),
      textResponse('step three'),
    ])
    const sessionId = await createSession(remote)

    // Hold the first pre-step so the Session is verifiably busy (running)
    // while both deliveries arrive.
    const entered = Promise.withResolvers<undefined>()
    const decision = Promise.withResolvers<PreStepDecision>()
    let firstProposal = true
    let claimed: UserMessage[] = []
    ctx.on('agent/pre-step', async ({ messages }) => {
      if (!firstProposal) return { kind: 'enter', messages }
      firstProposal = false
      claimed = messages
      entered.resolve(undefined)
      return decision.promise
    })

    const idle = waitForIdle(ctx, sessionId)
    const opened = await remote.prompt(promptRequest({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'initial prompt' }],
    }))
    expect(opened).toMatchObject({ ok: true, value: { accepted: true } })
    await entered.promise
    const agent = ctx.agents.get(sessionId)
    expect(agent?.status).toBe('running')

    // Busy: both deliveries land in the inbox while the turn is mid-flight.
    const steered = await remote.prompt(promptRequest({
      sessionId,
      mode: 'steer',
      content: [{ type: 'text', text: 'steer-marker' }],
    }))
    const queued = await remote.prompt(promptRequest({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'queue-marker' }],
    }))
    expect(steered).toMatchObject({ ok: true, value: { accepted: true } })
    expect(queued).toMatchObject({ ok: true, value: { accepted: true } })

    decision.resolve({ kind: 'enter', messages: claimed })
    await idle

    expect(adapter.requests).toHaveLength(3)
    const [first, boundary, fresh] = adapter.requests
    const bodies = adapter.requests.map(request => JSON.stringify(request.messages))
    // Opening step: neither delivery has been claimed yet.
    expect(bodies[0]).toContain('initial prompt')
    expect(bodies[0]).not.toContain('steer-marker')
    expect(bodies[0]).not.toContain('queue-marker')
    // Busy injection: the steer enters THIS turn at the step boundary, and
    // the queue still has not jumped the turn.
    expect(bodies[1]).toContain('steer-marker')
    expect(bodies[1]).not.toContain('queue-marker')
    // Queue regression: only a fresh turn after the current one consumes it.
    expect(bodies[2]).toContain('queue-marker')
    // Sanity: three distinct requests, all served in order.
    expect(first).toBeDefined()
    expect(boundary).toBeDefined()
    expect(fresh).toBeDefined()
  })

  it('keeps the wake-turn semantics for a steer delivered to an idle Session', async () => {
    const { ctx, remote, adapter } = await harness([textResponse('idle steer reply')])
    const sessionId = await createSession(remote)
    const idle = waitForIdle(ctx, sessionId)

    const steered = await remote.prompt(promptRequest({
      sessionId,
      mode: 'steer',
      content: [{ type: 'text', text: 'idle-steer-marker' }],
    }))
    expect(steered).toMatchObject({ ok: true, value: { accepted: true } })
    await idle

    expect(adapter.requests).toHaveLength(1)
    const body = JSON.stringify(adapter.requests[0]?.messages)
    expect(body).toContain('idle-steer-marker')
  })

  it('delivers a queue prompt to an idle Session as an immediate turn (queue default unchanged)', async () => {
    const { ctx, remote, adapter } = await harness([textResponse('idle queue reply')])
    const sessionId = await createSession(remote)
    const idle = waitForIdle(ctx, sessionId)

    // The wire's absent-mode default resolves to queue at the dsh-web route
    // (pinned there); the queue semantic itself lands here unchanged: an idle
    // Session opens a turn at once.
    const queued = await remote.prompt(promptRequest({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'idle-queue-marker' }],
    }))
    expect(queued).toMatchObject({ ok: true, value: { accepted: true } })
    await idle

    expect(adapter.requests).toHaveLength(1)
    const body = JSON.stringify(adapter.requests[0]?.messages)
    expect(body).toContain('idle-queue-marker')
  })
})
