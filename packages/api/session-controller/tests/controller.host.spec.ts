import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAttemptId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import SessionController from '../src/index.ts'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

const defaults = {
  defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

describe('SessionController facade', () => {
  it('does not require the Tools service', () => {
    expect(SessionController.inject).not.toContain('tools')
  })

  it('keeps assistant stream observation live while list initialization awaits', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await mountAgentLoopTestHarness(ctx)
    const gateway: Partial<TypertGatewayService> = { getPendingRemoteEvents: () => [] }
    ctx.provide('typertGateway', gateway as TypertGatewayService)
    const session = ctx.sessions.create(SessionId('assistant-interleave'), { meta: { cwd: '/workspace' } })
    const partial: Partial<Agent> = { id: session.id, session, status: 'running', ctx }
    const agent = partial as Agent
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const original = ctx.sessionProjections.register.bind(ctx.sessionProjections)
    let first = true
    vi.spyOn(ctx.sessionProjections, 'register').mockImplementation(async (...args: Parameters<typeof original>) => {
      if (first) {
        first = false
        entered.resolve(undefined)
        await gate.promise
      }
      return original(...args)
    })
    const mounting = createSessionTestController(ctx, defaults)
    await entered.promise
    // An Agent start racing the list read must not be lost before the controller publishes.
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'start', attemptId: LlmAttemptId('boot-attempt'), revision: 1, turn: 1, step: 1 },
    })
    gate.resolve(undefined)
    const controller = await mounting
    const frames = controller.follow({
      address: { kind: 'session', sessionId: session.id }, assistantStream: true,
    }, new AbortController().signal)[Symbol.asyncIterator]()
    await expect(frames.next()).resolves.toMatchObject({
      value: { type: 'snapshot', assistantStream: { revision: 1 } },
    })
    await frames.return?.(undefined)
  })

  it('serves passive reads, subscriptions and waits through its plain controllers', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await mountAgentLoopTestHarness(ctx)
    const gateway: Partial<TypertGatewayService> = { getPendingRemoteEvents: () => [] }
    ctx.provide('typertGateway', gateway as TypertGatewayService)
    const controller = await createSessionTestController(ctx, defaults)
    const sessionId = SessionId('passive-facade')
    ctx.sessions.create(sessionId, { meta: { cwd: '/workspace' } })
    const address = { kind: 'session' as const, sessionId }
    const signal = new AbortController().signal

    await expect(controller.events({ address }, signal)).resolves.toMatchObject({ records: [], hasMore: false })
    const historyFrames = controller.observeEvent({ address }, signal)[Symbol.asyncIterator]()
    await expect(historyFrames.next()).resolves.toMatchObject({ value: { type: 'ready' } })
    await historyFrames.return?.(undefined)
    const projectionFrames = controller.observeProjections({ sessionId }, signal)[Symbol.asyncIterator]()
    await expect(projectionFrames.next()).resolves.toMatchObject({ value: { type: 'ready' } })
    await projectionFrames.return?.(undefined)
    await expect(controller.state({ sessionId }, signal))
      .resolves.toMatchObject({ active: false, running: false, queue: null })
    const stateFrames = controller.observeState({ sessionId }, signal)[Symbol.asyncIterator]()
    await expect(stateFrames.next()).resolves.toMatchObject({ value: { active: false } })
    await stateFrames.return?.(undefined)
    await expect(controller.wait({ sessionId, afterSeq: -1, maxMessages: 10, timeoutMs: 50 }, signal))
      .resolves.toMatchObject({ reason: 'idle' })
  })

  it('owns Host service methods and publishes Agent lifecycle projections', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await mountAgentLoopTestHarness(ctx)
    const sessionId = SessionId('controller-session')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      cwd: '/workspace',
      isSeeded: false,
    }
    const events: SessionEvent[] = []
    const inspect = vi.fn(() => Promise.resolve({
      meta: header,
      inheritedEventCount: SessionLogOffset(0),
      events,
    }))
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([header]),
      inspect,
    }) as never)
    let uploadResolver: ((sessionId: SessionId) => Promise<Agent>) | undefined
    ctx.provide('fileUploads', {
      registerAgentResolver: (resolve: (sessionId: SessionId) => Promise<Agent>) => {
        uploadResolver = resolve
        return () => {}
      },
      resolve: () => undefined,
      bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
      retirePrompt: () => {},
    } as never)
    const controller = await createSessionTestController(ctx, defaults)
    const status = vi.fn()
    const failure = vi.fn()
    const activity = vi.fn()
    ctx.on('api-session/status', status)
    ctx.on('api-session/error', failure)
    ctx.on('api-session/activity', activity)

    const session = ctx.sessions.create(sessionId, { meta: header })
    const agent = {
      id: sessionId,
      session,
      status: 'idle',
      ctx,
    } as Agent
    await ctx.agents.register(agent)
    const resolveUploadAgent = (id: SessionId): Promise<Agent> => {
      if (uploadResolver === undefined) throw new Error('file upload resolver was not registered')
      return uploadResolver(id)
    }
    await expect(resolveUploadAgent(sessionId)).resolves.toBe(agent)
    const activationError = new RemoteError('session/not-found', 'missing upload session', { sessionId })
    vi.spyOn(
      (controller as unknown as { agents: ApiSessionAgentController }).agents,
      'resolveAgent',
    ).mockResolvedValueOnce({ error: activationError })
    await expect(resolveUploadAgent(sessionId)).rejects.toBe(activationError)

    await expect(controller.resolveAgent(sessionId)).resolves.toEqual({ agent })
    ctx.emit('agent/status', { agent, status: 'running' })
    ctx.emit('agent/error', { agent, turn: 1, step: 0, error: new Error('fixture failure') })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'browser prompt' }],
      source: { kind: 'user', rpcId: 'controller-rpc' as never },
    }), { surfaceOp: 'append' })
    expect(status).toHaveBeenCalledWith(sessionId, true)
    expect(failure).toHaveBeenCalledWith(sessionId, expect.stringContaining('fixture failure'))
    expect(activity).toHaveBeenCalledWith(sessionId, expect.any(Number))
    session.append('request/header', {
      header: { config: { provider: 'fixture', model: 'fixture-model' } },
      reason: 'initial',
    })
    expect(ctx.sessionProjections.snapshot(session).values.modelSelection).toEqual({
      lastUsed: { provider: 'fixture', model: 'fixture-model' }, next: { provider: 'fixture', model: 'fixture-model' },
    })
    const unowned = ctx.sessions.create(SessionId('controller-unowned'), {
      meta: { cwd: '/workspace' },
    })
    unowned.append('request/header', {
      header: { config: { provider: 'fixture', model: 'other-model' } },
      reason: 'initial',
    })
    expect(ctx.sessionProjections.snapshot(unowned).values.modelSelection).toEqual({
      lastUsed: { provider: 'fixture', model: 'other-model' }, next: { provider: 'fixture', model: 'other-model' },
    })

    const abort = new AbortController()
    const iterator = controller.follow({
      address: { kind: 'session', sessionId },
    }, abort.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'snapshot', cursor: 2 },
    })
    abort.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it.each(['success', 'domain-error', 'throw'] as const)(
    'promotes a prepared follow observation in the background: %s',
    async (outcome) => {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(AgentRegistry)
      const sessionId = SessionId(`background-${outcome}`)
      const header: SessionHeader = {
        version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd: '/workspace', isSeeded: false,
      }
      ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
        list: () => Promise.resolve([header]),
        inspect: () => Promise.resolve({
          meta: header,
          inheritedEventCount: SessionLogOffset(0),
          events: [],
        }),
      }) as never)
      const controller = await createSessionTestController(ctx, defaults)
      const agents = (controller as unknown as { agents: ApiSessionAgentController }).agents
      const apiError = vi.fn()
      ctx.on('api-session/error', apiError)
      const logError = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
      const live = { id: sessionId, session: { id: sessionId }, ctx, status: 'idle' } as unknown as Agent
      const resolve = vi.spyOn(agents, 'resolveObservedAgent')
      if (outcome === 'success') resolve.mockResolvedValue({ agent: live })
      else if (outcome === 'domain-error') {
        resolve.mockResolvedValue({
          error: new RemoteError('gateway/internal', 'activation unavailable', {}),
        })
      } else {
        resolve.mockRejectedValue(new Error('activation crashed'))
      }
      const abort = new AbortController()
      const iterator = controller.follow({
        address: { kind: 'session', sessionId },
        activate: true,
      }, abort.signal)[Symbol.asyncIterator]()

      await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'snapshot' } })
      const waiting = iterator.next()
      await vi.waitFor(() => { expect(resolve).toHaveBeenCalledOnce() })
      if (outcome === 'domain-error') {
        await vi.waitFor(() => {
          expect(apiError).toHaveBeenCalledWith(sessionId, 'activation unavailable')
        })
      } else if (outcome === 'throw') {
        await vi.waitFor(() => {
          expect(logError).toHaveBeenCalledWith(expect.stringContaining('activation crashed'))
        })
      } else {
        expect(apiError).not.toHaveBeenCalled()
      }
      abort.abort()
      await expect(waiting).resolves.toMatchObject({ done: true })
      await ctx.fiber.dispose()
    },
  )

  it('waits for an admitted background promotion during teardown', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const sessionId = SessionId('background-disposal')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd: '/workspace', isSeeded: false,
    }
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([header]),
      inspect: () => Promise.resolve({
        meta: header,
        inheritedEventCount: SessionLogOffset(0),
        events: [],
      }),
    }) as never)
    const controller = await createSessionTestController(ctx, defaults)
    const agents = (controller as unknown as { agents: ApiSessionAgentController }).agents
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(agents, 'resolveObservedAgent').mockImplementation(async () => {
      started.resolve(undefined)
      await release.promise
      return {
        agent: { id: sessionId, session: { id: sessionId }, ctx, status: 'idle' } as unknown as Agent,
      }
    })
    const iterator = controller.follow({
      address: { kind: 'session', sessionId },
      activate: true,
    }, new AbortController().signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'snapshot' } })
    const waiting = iterator.next()
    await started.promise
    let disposed = false
    const disposal = ctx.fiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    release.resolve(undefined)
    await disposal
    await expect(waiting).resolves.toMatchObject({ done: true })
  })
})

describe('SessionController attention status', () => {
  it('carries the objective attention fold on every status emission and refreshes on question changes', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // The attention fold reads the projection registry structurally: a stand-in
    // registry proves the emission contract without the registering unit.
    // FORK/upstream (0.2.2-alpha.2): AgentRegistry now declares
    // static inject=['sessionProjections'], so the stand-in must be provided
    // BEFORE AgentRegistry mounts — otherwise `ctx.agents` never instantiates.
    let questionActive = true
    let listener: ((session: { readonly id: SessionId }, key: string) => void) | undefined
    ctx.provide('sessionProjections', {
      // The controller registers its own projections at construction; the
      // stand-in accepts them without a fold of its own. Keyed reads: the
      // status emitters ask `userQuestions` (attention) and `seal`
      // (seal-light-host-state-1109) structurally, and each key must answer
      // in its own shape.
      register: () => () => {},
      stateOf: (_session: unknown, key: string) => key === 'userQuestions'
        ? { questions: { active: questionActive ? [{}] : [] } }
        : null,
      onChanged: (registered: typeof listener) => {
        listener = registered
        return () => { listener = undefined }
      },
    } as never)
    await ctx.plugin(AgentRegistry)
    const sessionId = SessionId('attention-session')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      cwd: '/workspace',
      isSeeded: false,
    }
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([header]),
      inspect: () => Promise.resolve({ meta: header, inheritedEventCount: SessionLogOffset(0), events: [] }),
    }) as never)
    await createSessionTestController(ctx, defaults)
    const status = vi.fn()
    ctx.on('api-session/status', status)

    const session = ctx.sessions.create(sessionId, { meta: header })
    const agent = { id: sessionId, session, status: 'idle', ctx } as Agent
    await ctx.agents.register(agent)

    ctx.emit('agent/status', { agent, status: 'running' })
    expect(status).toHaveBeenLastCalledWith(sessionId, true, 'question')

    // The question settles without an Agent status flip: the projection change
    // stream is the trigger that refreshes attention.
    // The settled question omits the attention argument entirely (86d9091a28:
    // an explicit `undefined` arg is not lossless JSON for the Remote forwarder).
    questionActive = false
    listener?.(session, 'userQuestions')
    expect(status).toHaveBeenLastCalledWith(sessionId, true)

    // Other projection keys never re-emit status.
    const emissions = status.mock.calls.length
    listener?.(session, 'someOtherProjection')
    expect(status).toHaveBeenCalledTimes(emissions)

    // A reopened question rides the next ordinary status emission too.
    questionActive = true
    ctx.emit('agent/status', { agent, status: 'running' })
    expect(status).toHaveBeenLastCalledWith(sessionId, true, 'question')
    await ctx.fiber.dispose()
  })
})

describe('SessionController seal status (seal-light-host-state-1109 裁点2A)', () => {
  it('carries the seal verdict on frames, fills arg3 with null when there is no attention, and re-emits on the seal key and the 15s sweep', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // The structural registry answers `userQuestions` and `seal` in their own
    // shapes; `seal` starts as a verdict and later folds to null (unit
    // released / no record yet) — the frame then drops back to its old shape.
    let sealValue: { readonly verdict: string; readonly detail?: string } | null = { verdict: 'DONE', detail: 'sentinel-ok' }
    let questionActive = false
    let listener: ((session: { readonly id: SessionId }, key: string) => void) | undefined
    ctx.provide('sessionProjections', {
      register: () => () => {},
      stateOf: (_session: unknown, key: string) => key === 'userQuestions'
        ? { questions: { active: questionActive ? [{}] : [] } }
        : sealValue,
      onChanged: (registered: typeof listener) => {
        listener = registered
        return () => { listener = undefined }
      },
    } as never)
    await ctx.plugin(AgentRegistry)
    const sessionId = SessionId('seal-status-session')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      cwd: '/workspace',
      isSeeded: false,
    }
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([header]),
      inspect: () => Promise.resolve({ meta: header, inheritedEventCount: SessionLogOffset(0), events: [] }),
    }) as never)
    // Fake timers BEFORE the controller mounts so its 15s sweep interval is a
    // fake timer this test can drive (机检④: the sweep traversal re-emits the
    // current truth, verdict included).
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    await createSessionTestController(ctx, defaults)
    const status = vi.fn()
    ctx.on('api-session/status', status)

    const session = ctx.sessions.create(sessionId, { meta: header })
    const agent = { id: sessionId, session, status: 'idle', ctx } as Agent
    await ctx.agents.register(agent)

    // A seal-bearing frame with no attention: arg3 is the null positional
    // placeholder (explicit `undefined` is not lossless JSON), arg4 the verdict.
    ctx.emit('agent/status', { agent, status: 'running' })
    expect(status).toHaveBeenLastCalledWith(sessionId, true, null, { verdict: 'DONE', detail: 'sentinel-ok' })

    // Attention and seal together ride the same frame.
    questionActive = true
    ctx.emit('agent/status', { agent, status: 'running' })
    expect(status).toHaveBeenLastCalledWith(sessionId, true, 'question', { verdict: 'DONE', detail: 'sentinel-ok' })

    // A turn-end record lands: the projection change stream re-emits right away
    // (推腿) instead of waiting for the next sweep.
    sealValue = { verdict: 'UNSEALED', detail: 'sentinel-pending' }
    listener?.(session, 'seal')
    expect(status).toHaveBeenLastCalledWith(sessionId, true, 'question', { verdict: 'UNSEALED', detail: 'sentinel-pending' })

    // Unrelated projection keys never re-emit status.
    const emissions = status.mock.calls.length
    listener?.(session, 'lastTurnOutcome')
    expect(status).toHaveBeenCalledTimes(emissions)

    // The Host holds no verdict (registering unit released): the frame falls
    // back to its pre-seal shape — absent arg reads as "no verdict".
    sealValue = null
    ctx.emit('agent/status', { agent, status: 'running' })
    expect(status).toHaveBeenLastCalledWith(sessionId, true, 'question')

    // 机检④: the 15s sweep re-sends the current truth for every published row —
    // verdict included, no separate seal timer or channel.
    sealValue = { verdict: 'DONE', detail: 'sentinel-ok' }
    questionActive = false
    await vi.advanceTimersByTimeAsync(15_000)
    expect(status).toHaveBeenLastCalledWith(sessionId, true, null, { verdict: 'DONE', detail: 'sentinel-ok' })
    await ctx.fiber.dispose()
  })
})
