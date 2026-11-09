/**
 * The `turnOutline` projection unit: mounting the plugin beside the
 * projection registry serves the whole-log turn outline (turn number,
 * `turn/start` seq, bounded prompt and final-response previews, and the human
 * interventions inside each turn); compositions without the registry are
 * unaffected; unmounting the plugin removes the key (HMR safety). The response
 * buffers as a draft and commits at `turn/end`, and an answered decision
 * request records only once its result lands, so the identity-gated change
 * feed pushes when — and only when — a served value changes. Narrow fold paths
 * with fabricated envelopes (non-human sources, regressive turn numbers,
 * outlived results) run against the exported definition directly.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SessionTurnOutlinePlugin from '@deepseek-ai/dsh-session-turn-outline'
import { turnOutlineProjectionDefinition } from '@deepseek-ai/dsh-session-turn-outline/src/projection.ts'
import type { TurnOutlineEntry, TurnOutlineState } from '@deepseek-ai/dsh-session-turn-outline/types'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test-injector': { kind: 'test-injector' } & ContextFormed
  }
}

async function harness(withOutlinePlugin: boolean): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (withOutlinePlugin) await ctx.plugin(SessionTurnOutlinePlugin)
  return { ctx, session: ctx.sessions.create(SessionId('outlined')) }
}

/** Append one human prompt; returns its seq. */
function appendPrompt(session: Session, text: string): SessionSeq {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/** Append one assembled assistant message with a single text block. */
function appendAssistant(session: Session, turn: number, step: number, text: string): void {
  session.append('assistant/message', {
    stream: [],
    turn,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
}

function endTurn(session: Session, turn: number): SessionSeq {
  return session.append('turn/end', { turn, reason: { kind: 'completed' } }).seq
}

/** Append one decision-request tool call. */
function appendAsk(session: Session, turn: number, callId: string, argumentsRaw: string): SessionSeq {
  return session.append('tool/call', {
    turn, step: 1, callId: ToolCallId(callId), name: 'ask_user_question', arguments: argumentsRaw,
  }).seq
}

/** Append the result answering a call; returns its seq — the mark's anchor. */
function appendResult(session: Session, turn: number, callId: string): SessionSeq {
  return session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text: '{}' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' }).seq
}

function outlineOf(ctx: Context, session: Session): readonly TurnOutlineEntry[] {
  return ctx.sessionProjections.snapshot(session).values.turnOutline as readonly TurnOutlineEntry[]
}

describe('turn outline projection unit', () => {
  it('exposes the turn boundary as a branded event identity', () => {
    expectTypeOf<TurnOutlineEntry['seq']>().toEqualTypeOf<ReturnType<typeof SessionSeq>>()
  })

  it('serves an empty outline before any turn starts', async () => {
    const { ctx, session } = await harness(true)
    expect(outlineOf(ctx, session)).toEqual([])
    expect(ctx.sessionProjections.checkpoint(session).turnOutline)
      .toEqual({ ver: 3, seq: -1, val: { turns: [], draft: '', pendingAsks: [] } })
  })

  it('folds each turn with its boundary seq, first prompt, turn-end response, and later inputs', async () => {
    const { ctx, session } = await harness(true)
    const firstBoundary = session.append('turn/start', { turn: 1 }).seq
    appendPrompt(session, 'hello world')
    const steerSeq = appendPrompt(session, 'a later steer must not replace the prompt')
    appendAssistant(session, 1, 1, 'first draft answer')
    appendAssistant(session, 1, 2, 'final answer of turn one')
    endTurn(session, 1)
    const secondBoundary = session.append('turn/start', { turn: 2 }).seq
    appendPrompt(session, 'second prompt')
    expect(outlineOf(ctx, session)).toEqual([
      {
        turn: 1,
        seq: firstBoundary,
        prompt: 'hello world',
        response: 'final answer of turn one',
        interventions: [{ seq: steerSeq, kind: 'input', preview: 'a later steer must not replace the prompt' }],
      },
      { turn: 2, seq: secondBoundary, prompt: 'second prompt', response: '', interventions: [] },
    ])
  })

  it('keeps the response empty while its turn is still open (draft only commits at turn/end)', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    appendPrompt(session, 'prompt')
    appendAssistant(session, 1, 1, 'streamed but unsettled')
    expect(outlineOf(ctx, session)[0]?.response).toBe('')
    expect(ctx.sessionProjections.checkpoint(session).turnOutline?.val).toMatchObject({ draft: 'streamed but unsettled' })
    endTurn(session, 1)
    expect(outlineOf(ctx, session)[0]?.response).toBe('streamed but unsettled')
  })

  it('reads a bounded slice of one oversized text block instead of the whole payload', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `giant ${'g'.repeat(500_000)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    appendAssistant(session, 1, 1, `answer ${'a'.repeat(500_000)}`)
    endTurn(session, 1)
    const entry = outlineOf(ctx, session)[0]
    expect(entry?.prompt).toMatch(/^giant g+…$/)
    expect(entry?.prompt).toHaveLength(50)
    expect(entry?.response).toMatch(/^answer a+…$/)
    expect(entry?.response).toHaveLength(120)
  })

  it('collapses whitespace and caps previews at their card budgets with an ellipsis', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [
        { type: 'text', text: `  spaced\n\nprompt\t${'p'.repeat(80)}` },
        { type: 'text', text: 'never reached past the budget' },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    appendAssistant(session, 1, 1, `answer ${'r'.repeat(200)}`)
    endTurn(session, 1)
    const entry = outlineOf(ctx, session)[0]
    expect(entry?.prompt).toMatch(/^spaced prompt p+…$/)
    expect(entry?.prompt).toHaveLength(50)
    expect(entry?.response).toMatch(/^answer r+…$/)
    expect(entry?.response).toHaveLength(120)
  })

  it('ignores non-human user/message sources and pre-turn prompts', async () => {
    const { ctx, session } = await harness(true)
    appendPrompt(session, 'queued before any turn')
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'injected context' }],
      source: { kind: 'test-injector', form: 'relay' },
    }), { surfaceOp: 'append' })
    expect(outlineOf(ctx, session)).toEqual([
      { turn: 1, seq: 1, prompt: '', response: '', interventions: [] },
    ])
  })

  it('pushes once per served change: boundary, prompt, intervention, and settled response', async () => {
    const { ctx, session } = await harness(true)
    const changes: { seq: SessionSeq; last: TurnOutlineEntry | undefined }[] = []
    ctx.sessionProjections.onChanged((_session, key, value, seq) => {
      if (key !== 'turnOutline') return
      changes.push({ seq, last: (value as readonly TurnOutlineEntry[]).at(-1) })
    })
    const boundarySeq = session.append('turn/start', { turn: 1 }).seq
    session.append('step/start', { turn: 1, step: 1 })
    const promptSeq = appendPrompt(session, 'hello')
    const steerSeq = appendPrompt(session, 'second human message in the same turn')
    appendAssistant(session, 1, 1, 'draft one')
    appendAssistant(session, 1, 2, 'draft two')
    session.append('step/end', { turn: 1, step: 2 })
    const endSeq = endTurn(session, 1)
    expect(changes.map(change => change.seq)).toEqual([boundarySeq, promptSeq, steerSeq, endSeq])
    expect(changes.at(-2)?.last?.interventions).toHaveLength(1)
    expect(changes.at(-1)?.last?.response).toBe('draft two')
  })

  it('keeps quiet on a draftless turn end and an empty in-turn prompt', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    // Whitespace-only prompt text normalizes to nothing: the entry stays unlabeled.
    appendPrompt(session, ' \t  ')
    endTurn(session, 1)
    expect(outlineOf(ctx, session)).toEqual([{ turn: 1, seq: 0, prompt: '', response: '', interventions: [] }])
  })

  it('bounds preview reading and keeps repeated or empty drafts quiet (fabricated envelopes)', () => {
    const def = turnOutlineProjectionDefinition
    const assistant = (blocks: readonly unknown[]): SessionEvent => ({
      type: 'assistant/message',
      seq: SessionSeq(9),
      time: 0,
      data: { message: { content: blocks } },
    }) as unknown as SessionEvent
    const base: TurnOutlineState = {
      turns: [{ turn: 1, seq: SessionSeq(0), prompt: 'p', response: '', interventions: [] }],
      draft: '',
      pendingAsks: [],
    }
    // Non-text blocks are skipped; whitespace-heavy short blocks cross the raw
    // reading bound early, so the collapsed (short) draft still marks the
    // unread remainder with an ellipsis.
    const airy = Array.from({ length: 40 }, (_, index) => ({ type: 'text', text: `w${String(index)}${' '.repeat(20)}` }))
    const buffered = def.apply(base, assistant([{ type: 'tool-call' }, ...airy]))
    expect(buffered.draft.startsWith('w0 w1 ')).toBe(true)
    expect(buffered.draft.endsWith('…')).toBe(true)
    expect(buffered.draft.length).toBeLessThan(120)
    // The same draft again, or a text-free message, changes nothing.
    expect(def.apply(buffered, assistant([{ type: 'tool-call' }, ...airy]))).toBe(buffered)
    expect(def.apply(buffered, assistant([{ type: 'text', text: '   ' }]))).toBe(buffered)
    // A draft with no entry to commit into clears itself at the boundary…
    const end = {
      type: 'turn/end',
      seq: SessionSeq(11),
      time: 0,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as unknown as SessionEvent
    expect(def.apply({ turns: [], draft: 'orphan', pendingAsks: [] }, end))
      .toEqual({ turns: [], draft: '', pendingAsks: [] })
    // …and a re-settled identical response keeps the entries' identity.
    const settled: TurnOutlineState = {
      turns: [{ turn: 1, seq: SessionSeq(0), prompt: 'p', response: 'done', interventions: [] }],
      draft: 'done',
      pendingAsks: [],
    }
    const recommitted = def.apply(settled, end)
    expect(recommitted.turns).toBe(settled.turns)
    expect(recommitted.draft).toBe('')
  })

  it('skips a boundary that does not advance the turn number (fabricated envelope)', () => {
    const state: TurnOutlineState = {
      turns: [{ turn: 2, seq: SessionSeq(5), prompt: 'kept', response: '', interventions: [] }],
      draft: '',
      pendingAsks: [],
    }
    const regressive = {
      type: 'turn/start',
      seq: SessionSeq(9),
      time: 0,
      data: { turn: 2 },
    } as unknown as SessionEvent
    expect(turnOutlineProjectionDefinition.apply(state, regressive)).toBe(state)
  })

  it('folds turns already in the log when the plugin mounts late (lazy cell build)', async () => {
    const { ctx, session } = await harness(false)
    session.append('turn/start', { turn: 1 })
    appendPrompt(session, 'pre-mount prompt')
    await ctx.plugin(SessionTurnOutlinePlugin)
    expect(outlineOf(ctx, session)).toEqual([{ turn: 1, seq: 0, prompt: 'pre-mount prompt', response: '', interventions: [] }])
  })

  it('has no key without the plugin and drops it when the plugin unloads (HMR safety)', async () => {
    const { ctx, session } = await harness(false)
    expect('turnOutline' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    const fiber = await ctx.plugin(SessionTurnOutlinePlugin)
    session.append('turn/start', { turn: 1 })
    expect('turnOutline' in ctx.sessionProjections.snapshot(session).values).toBe(true)
    await fiber.dispose()
    expect('turnOutline' in ctx.sessionProjections.snapshot(session).values).toBe(false)
  })

  it('rejects a persisted checkpoint whose turns are not strictly increasing', async () => {
    const { ctx, session } = await harness(true)
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    const row = checkpoint.turnOutline
    expect(row).toBeDefined()
    expect(() => ctx.sessionProjections.restore({
      ...checkpoint,
      turnOutline: {
        ...row!,
        val: {
          turns: [
            { turn: 2, seq: 1, prompt: '', response: '', interventions: [] },
            { turn: 2, seq: 4, prompt: '', response: '', interventions: [] },
          ],
          draft: '',
          pendingAsks: [],
        },
      },
    }, [], SessionLogOffset(0), session.header, session.inheritedEventCount)).toThrow(/strictly increasing/)
    expect(() => ctx.sessionProjections.restore({
      ...checkpoint,
      turnOutline: {
        ...row!,
        val: {
          turns: [
            { turn: 1, seq: 1, prompt: 'ok', response: 'done', interventions: [] },
            { turn: 2, seq: 4, prompt: '', response: '', interventions: [] },
          ],
          draft: '',
          pendingAsks: [],
        },
      },
    }, [], SessionLogOffset(0), session.header, session.inheritedEventCount)).not.toThrow()
  })

  it('anchors an answered decision request on its result, not its call', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    appendPrompt(session, 'choose a direction')
    appendAsk(session, 1, 'call-q', JSON.stringify({ questions: [{ id: 'q0', question: 'Ship it now?' }] }))
    const resultSeq = appendResult(session, 1, 'call-q')
    expect(outlineOf(ctx, session)[0]?.interventions).toEqual([
      { seq: resultSeq, kind: 'question', preview: 'Ship it now?' },
    ])
  })

  it('pushes nothing while a decision request waits for its result', async () => {
    const { ctx, session } = await harness(true)
    const changes: SessionSeq[] = []
    ctx.sessionProjections.onChanged((_session, key, _value, seq) => {
      if (key !== 'turnOutline') return
      changes.push(seq)
    })
    const boundarySeq = session.append('turn/start', { turn: 1 }).seq
    const promptSeq = appendPrompt(session, 'choose')
    appendAsk(session, 1, 'call-open', '{"questions":[{"id":"q0","question":"Still deciding?"}]}')
    expect(changes).toEqual([boundarySeq, promptSeq])
    expect(outlineOf(ctx, session)[0]?.interventions).toEqual([])
  })

  it('marks no result that was never a decision request', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    appendPrompt(session, 'run something')
    session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('call-shell'), name: 'bash', arguments: '{"command":"ls"}',
    })
    appendResult(session, 1, 'call-shell')
    expect(outlineOf(ctx, session)[0]?.interventions).toEqual([])
  })

  it('degrades an unparseable decision request to a mark with no preview', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    appendPrompt(session, 'choose')
    appendAsk(session, 1, 'call-bad', 'not json at all')
    const resultSeq = appendResult(session, 1, 'call-bad')
    expect(outlineOf(ctx, session)[0]?.interventions).toEqual([
      { seq: resultSeq, kind: 'question', preview: '' },
    ])
  })

  it('records a late decision answer as an input intervention with no preview (fabricated envelope)', () => {
    const def = turnOutlineProjectionDefinition
    const base: TurnOutlineState = {
      turns: [{ turn: 1, seq: SessionSeq(0), prompt: 'p', response: '', interventions: [] }],
      draft: '',
      pendingAsks: [],
    }
    const reply = {
      type: 'user/message',
      seq: SessionSeq(7),
      time: 0,
      data: {
        source: { kind: 'user-question-reply', callId: 'call-late' },
        content: [{ type: 'text', text: '{"answers":[{"id":"q0","selected":"a"}]}' }],
      },
    } as unknown as SessionEvent
    expect(def.apply(base, reply).turns[0]?.interventions)
      .toEqual([{ seq: SessionSeq(7), kind: 'input', preview: '' }])
  })

  it('records nothing for a result that outlived its turn (fabricated envelope)', () => {
    const def = turnOutlineProjectionDefinition
    const base: TurnOutlineState = {
      turns: [{ turn: 1, seq: SessionSeq(0), prompt: 'p', response: '', interventions: [] }],
      draft: '',
      pendingAsks: [{ callId: 'call-stale', preview: '' }],
    }
    const stale = {
      type: 'tool/result',
      seq: SessionSeq(9),
      time: 0,
      data: { turn: 4, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'call-stale' } } },
    } as unknown as SessionEvent
    const applied = def.apply(base, stale)
    expect(applied.turns[0]?.interventions).toEqual([])
    expect(applied.pendingAsks).toEqual([])
  })
})
