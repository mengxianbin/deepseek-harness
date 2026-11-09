/**
 * The `turnOutline` projection unit: a pure fold of `turn/start` boundaries,
 * first human prompts, final assistant responses, and the human interventions
 * inside each Turn into the whole-log turn outline the chat rail renders for
 * turns outside a client's paged event window.
 *
 * `turn/start` — not the prompt `user/message` — anchors each entry because
 * its seq is the load-through target for a jump: the loop logs `turn/start`
 * before the turn's prompt and steps, so a window paged back through that seq
 * contains the whole turn. An intervention never opens a Turn, so it records
 * its own event seq instead and the rail pages through that. Previews mirror
 * the rail's loaded-turn previews (space-joined text blocks, collapsed
 * whitespace, an ellipsis when clipped) with budgets sized to the rail card's
 * clamps — one prompt line, up to three response lines — so a turn shows the
 * same words before and after its events load. The response commits at
 * `turn/end` from a draft of the newest text-bearing assistant message;
 * draft-only and pending-only applies keep the `turns` array's identity, so
 * the identity-gated change feed pushes only when a served value changes.
 *
 * @module @deepseek-ai/dsh-session-turn-outline/projection
 */

import { z } from 'zod'
import type { ZodType } from 'zod'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TurnOutlineEntry, TurnOutlineIntervention, TurnOutlineState } from './types.ts'

/** Prompt budget: one rail-card line (13px over ~276px), ASCII worst case included. */
const PROMPT_PREVIEW_LIMIT = 50
/** Response budget: three rail-card lines (12px over ~276px). */
const RESPONSE_PREVIEW_LIMIT = 120
/** Intervention budget: one rail-card line, the same clamp a prompt preview uses. */
const INTERVENTION_PREVIEW_LIMIT = 50
/**
 * Tool names whose `tool/result` is a human decision. Mirrors the client's
 * `QUESTION_CALL_TOOLS`: the wire boundary forbids sharing that constant with
 * a host package, so a renamed tool costs a mark here and nowhere else.
 */
const ASK_TOOLS: ReadonlySet<string> = new Set(['ask_user_question', 'request_user_input'])
/** Pending ask calls retained; a call whose result never lands must not grow the state. */
const PENDING_ASK_LIMIT = 32
/** Interventions kept per Turn; past it the mark ladder stops growing rather than the wire. */
const INTERVENTION_LIMIT = 64
/** Largest ask `arguments` the fold parses for a preview; larger payloads read as `''`. */
const ASK_ARGUMENTS_LIMIT = 8192

type MessageContent = SessionEvent<'user/message'>['data']['content']

/** Space-join text blocks, collapse whitespace, and cap at `limit` with a trailing ellipsis when clipped. */
function preview(content: MessageContent, limit: number): string {
  let text = ''
  let unread = false
  for (const block of content) {
    if (block.type !== 'text') continue
    if (text.length >= limit * 2) {
      unread = true
      break
    }
    // Per-block bound: the fold runs on every message event, so a single
    // multi-megabyte block must not be concatenated (and regex-normalized)
    // whole for a preview this short.
    const clipped = block.text.length > limit * 2
    const chunk = clipped ? block.text.slice(0, limit * 2) : block.text
    text += text === '' ? chunk : ` ${chunk}`
    if (clipped) {
      unread = true
      break
    }
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`
  return unread ? `${normalized}…` : normalized
}

/** Collapse whitespace and cap `text` at `limit` with a trailing ellipsis when clipped. */
function clip(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`
  return normalized
}

/**
 * The first question's text from an ask tool's `arguments`, so a mark can
 * name the decision it jumps to. Model-supplied JSON is parsed only inside a
 * size bound and only to read one string field; anything else reads as `''`.
 * @param raw - the `tool/call` `arguments` payload.
 * @returns the bounded preview, or `''` when it cannot be derived.
 */
function askPreview(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > ASK_ARGUMENTS_LIMIT) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return ''
  }
  if (typeof parsed !== 'object' || parsed === null) return ''
  const questions: unknown = (parsed as { questions?: unknown }).questions
  if (!Array.isArray(questions)) return ''
  const first: unknown = questions[0]
  if (typeof first !== 'object' || first === null) return ''
  const text = (first as { question?: unknown }).question
  return typeof text === 'string' ? clip(text, INTERVENTION_PREVIEW_LIMIT) : ''
}

const turnOutlineInterventionsSchema: ZodType<readonly TurnOutlineIntervention[]> = z.array(z.object({
  seq: z.number().int().nonnegative().transform(SessionSeq),
  kind: z.enum(['question', 'input']),
  preview: z.string().max(INTERVENTION_PREVIEW_LIMIT),
}).strict()).max(INTERVENTION_LIMIT)

const turnOutlineEntriesSchema: ZodType<readonly TurnOutlineEntry[]> = z.array(z.object({
  turn: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative().transform(SessionSeq),
  prompt: z.string().max(PROMPT_PREVIEW_LIMIT),
  response: z.string().max(RESPONSE_PREVIEW_LIMIT),
  interventions: turnOutlineInterventionsSchema,
}).strict()).superRefine((turns, context) => {
  let previous = -1
  for (const entry of turns) {
    if (entry.turn <= previous) {
      context.addIssue({ code: 'custom', message: 'turn outline entries must be strictly increasing by turn' })
      return
    }
    previous = entry.turn
  }
})

const turnOutlineStateSchema: ZodType<TurnOutlineState> = z.object({
  turns: turnOutlineEntriesSchema,
  draft: z.string().max(RESPONSE_PREVIEW_LIMIT),
  pendingAsks: z.array(z.object({
    callId: z.string().max(256),
    preview: z.string().max(INTERVENTION_PREVIEW_LIMIT),
  }).strict()).max(PENDING_ASK_LIMIT),
}).strict()

const EMPTY_OUTLINE: TurnOutlineState = { turns: [], draft: '', pendingAsks: [] }

/** Append one intervention to the newest turn, keeping every other entry's identity. */
function withIntervention(
  state: TurnOutlineState,
  intervention: TurnOutlineIntervention,
  turn: number | undefined,
): TurnOutlineState {
  const last = state.turns.at(-1)
  // A result or message that outlived its Turn lands on no entry: the mark
  // would point at a Turn the reader cannot reach from it.
  if (last === undefined || (turn !== undefined && last.turn !== turn)) return state
  if (last.interventions.length >= INTERVENTION_LIMIT) return state
  return {
    ...state,
    turns: [...state.turns.slice(0, -1), { ...last, interventions: [...last.interventions, intervention] }],
  }
}

/** The `turnOutline` unit registered on `ctx.sessionProjections` (exported for the unit spec). */
export const turnOutlineProjectionDefinition = {
  key: 'turnOutline',
  stateVersion: 3,
  stateSchema: turnOutlineStateSchema,
  init: () => EMPTY_OUTLINE,
  apply: (state, event) => {
    // Every uninteresting event returns the same reference (Object.is gates
    // the drive), and draft-only or pending-only changes keep `turns` identity
    // (the raw-view identity gate then keeps the change feed quiet).
    switch (event.type) {
      case 'turn/start': {
        const last = state.turns.at(-1)
        // Order guard: a boundary that does not advance the turn number keeps
        // the outline sorted, and a retried turn's previews land on the
        // standing entry.
        if (last !== undefined && event.data.turn <= last.turn) return state
        return {
          ...state,
          turns: [...state.turns, {
            turn: event.data.turn, seq: event.seq, prompt: '', response: '', interventions: [],
          }],
          draft: '',
        }
      }
      case 'user/message': {
        // Only the newest turn can still be waiting for its opening human
        // prompt. Every later human message — steering, and a late answer to
        // a decision request — is an intervention inside that Turn.
        const kind: string = event.data.source.kind
        if (kind !== 'user' && kind !== 'user-question-reply') return state
        const last = state.turns.at(-1)
        if (last === undefined) return state
        if (last.prompt === '' && last.interventions.length === 0) {
          // A late answer can open a Turn too; it is not that Turn's prompt text.
          if (kind !== 'user') return state
          const prompt = preview(event.data.content, PROMPT_PREVIEW_LIMIT)
          if (prompt === '') return state
          return {
            ...state,
            turns: [...state.turns.slice(0, -1), { ...last, prompt }],
            draft: state.draft,
          }
        }
        return withIntervention(state, {
          seq: event.seq,
          kind: 'input',
          preview: kind === 'user' ? preview(event.data.content, INTERVENTION_PREVIEW_LIMIT) : '',
        }, undefined)
      }
      case 'tool/call': {
        if (!ASK_TOOLS.has(event.data.name)) return state
        const callId = String(event.data.callId)
        if (state.pendingAsks.some(pending => pending.callId === callId)) return state
        const entry = { callId, preview: askPreview(event.data.arguments) }
        return { ...state, pendingAsks: [...state.pendingAsks, entry].slice(-PENDING_ASK_LIMIT) }
      }
      case 'tool/result': {
        const callId = String(event.data.message.source.callId)
        const index = state.pendingAsks.findIndex(pending => pending.callId === callId)
        if (index < 0) return state
        const pending = state.pendingAsks[index]
        return withIntervention(
          { ...state, pendingAsks: state.pendingAsks.filter((_, at) => at !== index) },
          { seq: event.seq, kind: 'question', preview: pending?.preview ?? '' },
          event.data.turn,
        )
      }
      case 'assistant/message': {
        // Newest text-bearing message wins; the buffer commits at turn/end.
        const draft = preview(event.data.message.content, RESPONSE_PREVIEW_LIMIT)
        if (draft === '' || draft === state.draft) return state
        return { ...state, turns: state.turns, draft }
      }
      case 'turn/end': {
        if (state.draft === '') return state
        const last = state.turns.at(-1)
        if (last === undefined || last.response === state.draft) return { ...state, turns: state.turns, draft: '' }
        return { ...state, turns: [...state.turns.slice(0, -1), { ...last, response: state.draft }], draft: '' }
      }
      default:
        return state
    }
  },
  wire: {
    viewSchema: turnOutlineEntriesSchema,
    view: state => state.turns,
    summary: false,
  },
} satisfies ProjectionDefinition<'turnOutline', TurnOutlineState>
