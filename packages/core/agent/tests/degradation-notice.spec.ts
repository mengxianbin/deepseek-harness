import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  agentEvents,
  DEGRADATION_NOTICE_THRESHOLD,
  installDegradationNotice,
  type Agent,
  type PreStepDecision,
} from '../src/index.ts'
import { createUserMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { NonEmptyToolCallIdError, SessionStore, SessionId, type Session } from '@deepseek-ai/dsh-session'

const SIGNAL = new AbortController().signal
const INPUT = createUserMessage({
  content: [{ type: 'text', text: 'continue' }],
  source: { kind: 'user' },
})

async function createHarness() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionStore)
  // Store-attached so appends publish `session/event` (bare Session.create does not).
  const session = ctx.sessions.prepare(SessionId('degradation-notice'))
  ctx.sessions.enter(session)
  const agent = { session } as Agent
  const dispose = installDegradationNotice(ctx, session)
  return { agent, ctx, dispose, session }
}

function fireError(ctx: Context, agent: Agent, error: unknown) {
  agentEvents(ctx, agent).emit('agent/error', { turn: 1, step: 1, error })
}

function settleMessage(session: Session) {
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: MessageId('m-ok'),
      role: 'assistant',
      source: { kind: 'model', provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'ok' }],
    },
    stream: [],
  }, { surfaceOp: 'append' })
}

async function preStep(ctx: Context, agent: Agent) {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { turn: 2, step: 1, messages: [INPUT], signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [INPUT] }),
  )
}

function noticeTexts(decision: PreStepDecision): string[] {
  if (decision.kind === 'reject') return []
  return decision.messages
    .filter(message => message.source.kind === 'tool-degradation')
    .map(message => message.content.map(block => 'text' in block ? block.text : '').join(''))
}

function enteredMessages(decision: PreStepDecision): UserMessage[] {
  if (decision.kind === 'reject') throw new Error('expected the pre-step to enter')
  return decision.messages
}

describe('installDegradationNotice()', () => {
  it('stays silent for a single isolated rejection', async () => {
    const { agent, ctx } = await createHarness()
    fireError(ctx, agent, new NonEmptyToolCallIdError('session event at seq 2 requires a nonempty tool call id'))
    const decision = await preStep(ctx, agent)
    expect(noticeTexts(decision)).toEqual([])
  })

  it('notices on the threshold consecutive rejection and reports the streak', async () => {
    const { agent, ctx } = await createHarness()
    for (let i = 0; i < DEGRADATION_NOTICE_THRESHOLD; i++) {
      fireError(ctx, agent, new NonEmptyToolCallIdError('boom'))
    }
    const decision = await preStep(ctx, agent)
    const notices = noticeTexts(decision)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(`${DEGRADATION_NOTICE_THRESHOLD} consecutive malformed tool-call`)
    expect(notices[0]).toContain('switching models')
    expect(enteredMessages(decision)).toContainEqual(INPUT)
  })

  it('a committed assistant message resets the streak before the threshold', async () => {
    const { agent, ctx, session } = await createHarness()
    fireError(ctx, agent, new NonEmptyToolCallIdError('boom'))
    settleMessage(session)
    fireError(ctx, agent, new NonEmptyToolCallIdError('boom'))
    const decision = await preStep(ctx, agent)
    expect(noticeTexts(decision)).toEqual([])
  })

  it('fires once: the notice clears the pending flag and the streak', async () => {
    const { agent, ctx } = await createHarness()
    for (let i = 0; i < DEGRADATION_NOTICE_THRESHOLD; i++) {
      fireError(ctx, agent, new NonEmptyToolCallIdError('boom'))
    }
    expect(noticeTexts(await preStep(ctx, agent))).toHaveLength(1)
    expect(noticeTexts(await preStep(ctx, agent))).toHaveLength(0)
  })

  it('ignores unrelated errors and classifies wrapped blank-id failures', async () => {
    const { agent, ctx } = await createHarness()
    fireError(ctx, agent, new Error('unrelated network failure'))
    const wrapped = () => new AggregateError(
      [new NonEmptyToolCallIdError('boom')],
      'Step failed and its pending tool results could not be recorded',
    )
    fireError(ctx, agent, wrapped())
    fireError(ctx, agent, wrapped())
    const decision = await preStep(ctx, agent)
    const notices = noticeTexts(decision)
    expect(notices).toHaveLength(1)
    // The unrelated error did not count: the streak is the 2 wrapped ones, not 3.
    expect(notices[0]).toContain('2 consecutive')
  })

  it('a rejected pre-step keeps the pending notice for the next turn', async () => {
    const { agent, ctx } = await createHarness()
    for (let i = 0; i < DEGRADATION_NOTICE_THRESHOLD; i++) {
      fireError(ctx, agent, new NonEmptyToolCallIdError('boom'))
    }
    const rejected = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { turn: 2, step: 1, messages: [], signal: SIGNAL },
      () => Promise.resolve({ kind: 'reject' as const, messages: [] }),
    )
    expect(rejected.kind).toBe('reject')
    const decision = await preStep(ctx, agent)
    expect(noticeTexts(decision)).toHaveLength(1)
  })

  it('dispose removes every listener', async () => {
    const { agent, ctx, dispose } = await createHarness()
    dispose()
    for (let i = 0; i < DEGRADATION_NOTICE_THRESHOLD; i++) {
      fireError(ctx, agent, new NonEmptyToolCallIdError('boom'))
    }
    const decision = await preStep(ctx, agent)
    expect(noticeTexts(decision)).toEqual([])
  })
})
