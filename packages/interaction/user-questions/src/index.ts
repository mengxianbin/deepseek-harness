/**
 * Service Definition for the user-questions capability seam (`ctx.userQuestions`): a UI-backed service for
 * pausing an agent tool call until the human answers a question. The model-
 * facing tool lives in `@deepseek-ai/dsh-tool-ask-user`; UI packages compose
 * answerers on the Agent-scoped Cordis waterfall.
 *
 * @module @deepseek-ai/dsh-user-questions
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage, HarnessError, type MessageId, type ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import { userQuestionProjectionDefinition } from './projection.ts'
import { TimedQuestionWait } from './timed-wait.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    userQuestions: UserQuestionService
  }
}

import type {
  AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequestEvent, PendingUserQuestion,
} from './types.ts'

export type {
  AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionAttachment, AskUserQuestionIntent,
  AskUserQuestionItem, AskUserQuestionOption, PendingUserQuestion, SettledUserQuestion,
  UserQuestionProjectionView, UserQuestionState,
} from './types.ts'
export { isTimedAskUserQuestionSchema, TIMED_WAIT_PARAMETER } from './projection.ts'

/** Request for a human answer. */
export interface AskUserQuestionRequest extends AskUserQuestionRequestEvent {}

/** Timed ask result returned when the foreground answer window closes. */
export type TimedUserQuestionResult = AskUserQuestionAnswer | { pending: true; callId: ToolCallId }

/** Stable error taxonomy for user-questions failures. */
export class UserQuestionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserQuestionError'
  }
}

function abortedQuestion(cause?: unknown): UserQuestionError {
  return new UserQuestionError(
    'ask_user_question was aborted before the user answered',
    'ASK_ABORTED',
    cause === undefined ? undefined : { cause },
  )
}

/** Pause between re-offers of a durable ask whose answerer disappeared. */
const ANSWERER_REOFFER_MS = 1_500

function reofferDelay(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ANSWERER_REOFFER_MS)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function restoreUserQuestionError(reason: unknown): unknown {
  if (reason instanceof UserQuestionError) return reason
  if (isRecord(reason)
    && reason.name === 'UserQuestionError'
    && typeof reason.message === 'string'
    && typeof reason.code === 'string') {
    return new UserQuestionError(reason.message, reason.code, { cause: reason })
  }
  return reason
}

type QueuedReply = { messageId: MessageId; claimedTurn?: number }

/** Deployment knobs for folding over-long question text out of the card. */
export interface Config {
  /** Per-field character budget for text rendered inline on the card; a longer field folds into an attachment. */
  readonly maxInlineChars: number
  /** Characters of a folded field kept inline as its summary. */
  readonly summaryChars: number
  /** Directory folded report files land in; defaults to `<dsh home>/ask-reports`. */
  readonly reportDir?: string
}

/** Inline marker appended to a summary so a folded field never reads as complete. */
const foldedNote = (chars: number): string => `\n\n…（已折叠：完整内容 ${String(chars)} 字见下方附件）`

/**
 * Default root for folded report files: `$DSH_HOME` (or `~/.dsh`) then
 * `ask-reports`. Mirrors `@deepseek-ai/dsh-home-paths` `resolveDshHome`
 * inline — a value import would need a package link this package does not
 * declare, and this seam stays dependency-light on purpose.
 * @returns the absolute default report directory.
 */
const defaultReportDir = (): string =>
  join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'ask-reports')

/** Cut a field to its inline summary, preferring a line boundary near the limit. */
function foldSummary(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const lastBreak = cut.lastIndexOf('\n')
  return (lastBreak > limit / 2 ? cut.slice(0, lastBreak) : cut).trimEnd()
}

/** Keep a path segment filename-safe on every platform. */
function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
  return safe.length > 0 ? safe : 'unnamed'
}

/** `ctx.userQuestions`: validation plus the scoped answerer waterfall. */
export class UserQuestionService extends TypertRemoteService {
  static Config: z<Config> = z.object({
    maxInlineChars: z.number().step(1).min(200).default(1_500),
    summaryChars: z.number().step(1).min(80).default(600),
    // Schemastery validates a present value and passes on absence — no
    // `.optional()` exists here; an absent reportDir means the default root.
    reportDir: z.string(),
  })
  private readonly waits = new Map<Agent, Map<ToolCallId, TimedQuestionWait>>()
  private readonly queuedReplies = new WeakMap<Session, Map<ToolCallId, QueuedReply>>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'userQuestions')
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(userQuestionProjectionDefinition)
    })
    ctx.effect(() => () => {
      for (const calls of this.waits.values()) {
        for (const wait of calls.values()) wait.close(abortedQuestion())
      }
      this.waits.clear()
    }, 'userQuestions: foreground waits')
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const source = message.source
      if (source.kind !== 'user-question-reply') return
      const calls = this.queuedReplies.get(agent.session) ?? new Map<ToolCallId, QueuedReply>()
      const reply = calls.get(source.callId)
      if (reply === undefined) {
        calls.set(source.callId, { messageId: message.id, claimedTurn: turn })
        this.queuedReplies.set(agent.session, calls)
      } else if (reply.messageId === message.id) {
        reply.claimedTurn = turn
      }
    }, { global: true })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const source = message.source
      if (source.kind === 'user-question-reply') this.releaseReply(agent.session, source.callId, message.id)
    }, { global: true })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'user/message') {
        const source = event.data.source
        if (source.kind === 'user-question-reply') this.releaseReply(session, source.callId, event.data.id)
      } else if (event.type === 'turn/end') {
        const calls = this.queuedReplies.get(session)
        if (calls === undefined) return
        for (const [callId, reply] of calls) {
          if (reply.claimedTurn === event.data.turn) calls.delete(callId)
        }
      }
    }, { global: true })
  }

  private releaseReply(session: Session, callId: ToolCallId, messageId: MessageId): void {
    const calls = this.queuedReplies.get(session)
    if (calls?.get(callId)?.messageId !== messageId) return
    calls.delete(callId)
  }

  private assertLiveRoot(agent: Agent): void {
    const agents = this.ctx.get('agents')
    if (agents === undefined || agents.get(agent.id) !== agent) {
      throw new UserQuestionError(
        'human interaction requires the exact live calling agent when an agent is supplied',
        'CALLER_NOT_LIVE')
    }
    if (!agents.roots().includes(agent)) {
      throw new UserQuestionError(
        'human interaction is unavailable while the calling agent is owned by another live agent; '
        + "include the unresolved question or decision in the child agent's final result",
        'DELEGATED_CALLER')
    }
  }

  private continued(agent: Agent): readonly PendingUserQuestion[] {
    const state = this.ctx.get('sessionProjections')?.stateOf(agent.session, 'userQuestions')
    return (state?.questions.active ?? []).filter(question => question.state === 'continued')
  }

  /**
   * Answer a continued question. The reply is steered into the agent as a
   * user message whose source names the call; that message is also the
   * record that closes the question in the projection.
   * @param agent - Live root agent for the owning Session.
   * @param callId - Continued question identity.
   * @param answer - Complete structured answer batch, one item per question of the call.
   * @returns Whether the question is still continued; an accepted reply stays
   *   queued until the agent admits its user message.
   * @throws {UserQuestionError} `BAD_ANSWER` when the batch does not name each
   *   question of the call exactly once, or `REPLY_QUEUED` when a reply is
   *   already waiting for admission.
   */
  @Remote
  answer(agent: Agent, callId: ToolCallId, answer: AskUserQuestionAnswer): boolean {
    this.assertLiveRoot(agent)
    const question = this.continued(agent).find(item => item.callId === callId)
    if (question === undefined) return false
    const queued = this.queuedReplies.get(agent.session)
    const matches = (message: UserMessage): boolean =>
      message.source.kind === 'user-question-reply' && message.source.callId === callId
    if (queued?.has(callId) || agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)) {
      throw new UserQuestionError('a reply is already queued for this question', 'REPLY_QUEUED')
    }
    // The gateway validated the batch's shape from the type; the model-facing
    // contract also promises one item per question, which only this owner of
    // the asked questions can check before the batch reaches the model.
    const answered = new Set(answer.answers.map(item => item.id))
    if (answered.size !== answer.answers.length
      || question.questions.length !== answer.answers.length
      || !question.questions.every(item => answered.has(item.id))) {
      throw new UserQuestionError(
        `the answer batch for ${callId} must name each of its ${String(question.questions.length)} questions exactly once`,
        'BAD_ANSWER')
    }
    const message = createUserMessage({
      source: { kind: 'user-question-reply', callId, outcome: 'answered' },
      content: [{
        type: 'text',
        text: JSON.stringify({
          kind: 'answer_to_pending_question', tool: 'ask_user_question', callId,
          questions: question.questions, answers: answer.answers,
        }),
      }],
    })
    const calls = queued ?? new Map<ToolCallId, QueuedReply>()
    calls.set(callId, { messageId: message.id })
    this.queuedReplies.set(agent.session, calls)
    try {
      agent.steer(message)
    } catch (error: unknown) {
      this.releaseReply(agent.session, callId, message.id)
      throw error
    }
    return true
  }

  /**
   * Let one answer UI hold a live timed wait. Closing the stream releases its claim.
   * @param agent - Live root agent owning the question.
   * @param callId - Foreground tool call to attach to.
   * @param signal - Remote stream cancellation, including Client disconnect.
   * @returns One Host-computed remaining duration, or no frames once the wait ended.
   */
  @Remote({ mode: 'stream' })
  async *attachWait(agent: Agent, callId: ToolCallId, signal: AbortSignal): AsyncIterable<{ remainingMs: number }> {
    this.assertLiveRoot(agent)
    const wait = this.waits.get(agent)?.get(callId)
    if (wait !== undefined) yield* wait.attach(signal)
  }

  /**
   * Foreground wait whose first settlement the Client decides: the Client
   * rejects with `ASK_TIMED_OUT` when its countdown ends, and this method maps
   * that code to the pending result.
   * @param request - Questions, live owner agent, and abort signal.
   * @param callId - Tool call identity the Client card is keyed by.
   * @param timeoutMs - Positive foreground wait in milliseconds.
   * @returns The answer when it arrives inside the window, otherwise a pending
   *   result, also when no connected Client claimed the request by the deadline.
   * @throws {UserQuestionError} `BAD_TIMEOUT` for a non-integer, non-positive,
   *   or oversized wait.
   */
  async askTimed(
    request: AskUserQuestionRequest & { agent: Agent },
    callId: ToolCallId,
    timeoutMs: number,
  ): Promise<TimedUserQuestionResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new UserQuestionError('timeout must fit a positive platform timer', 'BAD_TIMEOUT')
    }
    this.assertLiveRoot(request.agent)
    const calls = this.waits.get(request.agent) ?? new Map<ToolCallId, TimedQuestionWait>()
    if (calls.has(callId)) throw new UserQuestionError('the question call already has a foreground wait', 'DUPLICATE_WAIT')
    const wait = new TimedQuestionWait(Date.now() + timeoutMs, request.signal,
      new UserQuestionError('ask_user_question timed out before the user answered', 'ASK_TIMED_OUT'))
    calls.set(callId, wait)
    this.waits.set(request.agent, calls)
    try {
      try {
        return await this.ask({ ...request, signal: wait.signal, wait: { callId, timed: true } })
      } catch (error) {
        if (wait.signal.aborted) throw wait.signal.reason
        if (error instanceof UserQuestionError && error.code === 'NO_PROVIDER') {
          await wait.done
          throw wait.signal.reason
        }
        throw error
      }
    } catch (error) {
      if (error instanceof UserQuestionError && error.code === 'ASK_TIMED_OUT') return { pending: true, callId }
      if (wait.signal.aborted) throw abortedQuestion(error)
      throw error
    } finally {
      wait.close(abortedQuestion())
      calls.delete(callId)
      if (calls.size === 0) this.waits.delete(request.agent)
    }
  }

  /**
   * Fold every question whose text fields exceed the inline budget into an
   * attachment: the over-long fields are written whole into one report file
   * under the report directory, and the question keeps a summary plus the
   * file path. A question carrying a presentation intent keeps its text
   * verbatim — plan-review renders its own scrollable panel — and a fold
   * whose file cannot be written keeps the original question, so the fold is
   * a presentation default that never loses or rejects content.
   * @param questions - validated question batch about to reach an answerer.
   * @param sessionId - owning Session id when one is known, for the file's directory.
   * @returns the batch as the card should present it.
   */
  private async foldLongQuestions(
    questions: readonly AskUserQuestionItem[],
    sessionId: string | undefined,
  ): Promise<readonly AskUserQuestionItem[]> {
    const { maxInlineChars, summaryChars } = this.config
    const folded: AskUserQuestionItem[] = []
    let directory: string | undefined
    let stamp: string | undefined
    for (const question of questions) {
      if (question.intent !== undefined || question.attachment !== undefined) {
        folded.push(question)
        continue
      }
      const options = question.options ?? []
      const over: { field: string; text: string }[] = []
      const scan = (field: string, text: string): void => {
        if (text.length > maxInlineChars) over.push({ field, text })
      }
      scan('question', question.question)
      if (question.detail !== undefined) scan('detail', question.detail)
      if (question.header !== undefined) scan('header', question.header)
      for (const [index, option] of options.entries()) {
        scan(`option[${String(index)}].label`, option.label)
        if (option.description !== undefined) scan(`option[${String(index)}].description`, option.description)
      }
      if (over.length === 0) {
        folded.push(question)
        continue
      }
      try {
        directory ??= join(this.config.reportDir ?? defaultReportDir(), safeSegment(sessionId ?? 'no-session'))
        stamp ??= new Date().toISOString().replace(/[:.]/g, '-')
        await mkdir(directory, { recursive: true })
        const path = join(directory, `${stamp}-${safeSegment(question.id)}.md`)
        const body = over.map(field => `## ${field.field}\n\n${field.text}`).join('\n\n')
        await writeFile(path, `# ask_user_question folded content\n\n${body}\n`, 'utf8')
        const chars = over.reduce((total, field) => total + field.text.length, 0)
        const overFields = new Set(over.map(field => field.field))
        const summaryOf = (text: string): string => `${foldSummary(text, summaryChars)}${foldedNote(text.length)}`
        const nextOptions = options.map((option, index) => ({
          label: overFields.has(`option[${String(index)}].label`) ? summaryOf(option.label) : option.label,
          ...option.description !== undefined && overFields.has(`option[${String(index)}].description`)
            ? { description: summaryOf(option.description) }
            : {},
        }))
        folded.push({
          ...question,
          question: overFields.has('question') ? summaryOf(question.question) : question.question,
          ...question.detail !== undefined && overFields.has('detail') ? { detail: summaryOf(question.detail) } : {},
          ...question.header !== undefined && overFields.has('header') ? { header: summaryOf(question.header) } : {},
          ...nextOptions.length > 0 ? { options: nextOptions } : {},
          attachment: { path, chars },
        })
      } catch (error) {
        // A fold is a presentation default: when the report cannot be
        // written, the question stays exactly as the asker spelled it.
        console.error('[user-questions] folded report write failed:', error)
        folded.push(question)
      }
    }
    return folded
  }

  /**
   * Ask the scoped answerer waterfall and wait for the user's answer.
   *
   * When a caller supplies an agent, human interaction is valid only for the
   * exact live runtime root. Runtime ownership, not durable session lineage,
   * decides this boundary: an owned child has no human answerer and would
   * block forever, while a lineage-bearing session resumed as a new runtime
   * root may ask normally.
   *
   * A request that carries its call id outlives an answerer that disappears
   * mid-wait: when no answerer accepts, the waterfall is re-offered until one
   * takes it again or the signal aborts, so a page reload or client rebuild
   * no longer settles the call as `NO_PROVIDER`.
   *
   * @param request Questions, owner agent, and abort signal.
   * @returns The answer chosen or typed by the human.
   * @throws {UserQuestionError} code `ASK_ABORTED` when the supplied signal
   *   is already or becomes aborted, `CALLER_NOT_LIVE` when a supplied agent
   *   is not the registry's exact live instance, or `DELEGATED_CALLER` when
   *   that live agent is owned by another agent.
   */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (request.signal?.aborted) {
      throw abortedQuestion()
    }
    if (request.questions.length === 0) {
      throw new UserQuestionError('ask_user_question requires at least one question', 'EMPTY_QUESTIONS')
    }
    const agent = request.agent
    if (agent !== undefined) this.assertLiveRoot(agent)
    // A presentation intent asserts two things the types cannot: that the
    // named approve label is one of this question's own options, and that a
    // plan-review carries the plan it is a review of. A UI honouring the
    // intent answers with that label, and shows that detail as the plan, so
    // either gap would put a choice the asker never offered — or an approval of
    // something invisible — in front of the user. Caught at the asker, where
    // the mistake is, rather than in each UI.
    for (const question of request.questions) {
      const intent = question.intent
      if (intent === undefined) continue
      if (!(question.options ?? []).some(option => option.label === intent.approve)) {
        throw new UserQuestionError(
          `question ${question.id} declares intent ${intent.kind} whose approve label `
          + `${JSON.stringify(intent.approve)} names none of its options`,
          'BAD_INTENT')
      }
      if (question.detail === undefined) {
        throw new UserQuestionError(
          `question ${question.id} declares intent ${intent.kind} without the detail it reviews`,
          'BAD_INTENT')
      }
    }
    // Presentation fold, after validation and before dispatch: over-long
    // text fields become a summary plus a file attachment, so the card never
    // becomes the reading surface for a long report.
    const questions = await this.foldLongQuestions(
      request.questions,
      agent === undefined ? undefined : String(agent.session.id),
    )
    const presented: AskUserQuestionRequest = { ...request, questions: [...questions] }
    const noAnswerer = () => Promise.reject(new UserQuestionError(
      'no user-questions answerer accepted the request',
      'NO_PROVIDER',
    ))
    const dispatch = () => (agent === undefined
      ? this.ctx.waterfall('user-questions/request', presented, noAnswerer)
      : this.ctx.waterfall(
        scopeTarget(agent, agent),
        'user-questions/request',
        { ...presented, agent },
        noAnswerer,
      ))
    try {
      // A durable ask — one carrying its call id — must outlive an answerer
      // that disappears while the question is in flight: a page reload, tab
      // close, or client HMR rebuild delegates every live waterfall, and the
      // fallback would otherwise settle the call as NO_PROVIDER before the
      // answerer could return. Re-dispatch until one takes the request again;
      // the abort signal still ends the wait.
      while (true) {
        try {
          return await dispatch()
        } catch (error) {
          if (request.wait?.callId === undefined
            || !(error instanceof UserQuestionError && error.code === 'NO_PROVIDER')) {
            throw error
          }
          if (request.signal?.aborted) throw abortedQuestion(error)
          await reofferDelay(request.signal)
          if (request.signal?.aborted) throw abortedQuestion(error)
        }
      }
    } catch (error) {
      const restored = restoreUserQuestionError(error)
      if (restored instanceof UserQuestionError) throw restored
      if (request.signal?.aborted) {
        throw abortedQuestion(error)
      }
      throw restored
    }
  }
}

export default UserQuestionService
