import { useCallback } from 'react'
import { IconQuestionOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent/types'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Also merges the userQuestions key into SessionProjectionMap for useProjection.
import type { AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions/types'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { singleResultText } from '../models/raw-tool-call.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { QuestionToolRow } from '../components/QuestionToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Answer records from result JSON; null when the result is malformed.
 * ask-panel-retire-1127: the record card is retired with the ask panel — the
 * batch still feeds the row's answered-count summary, while the readable
 * record lives in the row's input/output sections and the `question-reply`
 * conversation bubble.
 */
function answerBatchOf(text: string): { answers: AskUserQuestionAnswerItem[] } | null {
  const parsed = parseJson(text)
  if (!isRecord(parsed)) return null
  const answers = parsed.answers
  if (!Array.isArray(answers) || !answers.every(isRecord)) return null
  const entries: AskUserQuestionAnswerItem[] = []
  for (const answer of answers) {
    if (typeof answer.id !== 'string'
      || !Array.isArray(answer.selected)
      || !answer.selected.every(item => typeof item === 'string')
      || (answer.custom !== undefined && typeof answer.custom !== 'string')) return null
    entries.push({
      id: answer.id,
      selected: answer.selected,
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    })
  }
  return { answers: entries }
}

/** Answers from a submitted steer that still awaits admission to a step. */
function queuedAnswerBatch(message: unknown, callId: string): { answers: AskUserQuestionAnswerItem[] } | null {
  if (!isRecord(message) || !Array.isArray(message.content)) return null
  const content: unknown = message.content[0]
  if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') return null
  const parsed = parseJson(content.text)
  if (!isRecord(parsed) || parsed.kind !== 'answer_to_pending_question' || parsed.callId !== callId) return null
  return answerBatchOf(content.text)
}

/** Answered-count summary of one recorded batch. */
function answeredCountSummary(answers: readonly AskUserQuestionAnswerItem[], t: AskQuestionRowProps['t']): string {
  const answered = answers.filter(answer => answer.selected.length > 0 || (answer.custom ?? '') !== '').length
  return t('ask.answered', { answered, total: answers.length })
}

/** Best-effort answered-count summary when strict batch parsing fails. */
function answeredSummary(text: string, t: AskQuestionRowProps['t']): string | null {
  const parsed = parseJson(text)
  if (!isRecord(parsed)) return null
  const answers = parsed.answers
  if (!Array.isArray(answers) || !answers.every(isRecord)) return null
  const answered = answers.filter(a =>
    (Array.isArray(a.selected) && a.selected.length > 0)
    || (typeof a.custom === 'string' && a.custom !== '')).length
  return t('ask.answered', { answered, total: answers.length })
}

/** Whether a successful tool result records a still-answerable timed question. */
function isPendingResult(text: string): boolean {
  const parsed = parseJson(text)
  return isRecord(parsed) && parsed.pending === true && typeof parsed.callId === 'string'
}

/** Injected panel verb for the row's own Session, filled by the optional panel provider. */
interface AskQuestionPanelInjected {
  /**
   * Show one call's answer panel in the composer.
   * @param callId - the row's own `ask_user_question` call.
   * @returns whether a panel for that call was there to show.
   */
  revealPanel: (callId: string) => boolean
}

type AskQuestionRowProps = ToolCallViewProps & PropsLocale<'conversation'> & InjectFace<AskQuestionPanelInjected>

/**
 * Summarizes a pending, answered, cancelled, or interrupted question set.
 * ask-panel-retire-1127: the transcript card and the read-only record panel
 * are retired — the row keeps its summary/state, falls back to the raw
 * input/output sections, and only an answerable call keeps the reopen action.
 */
export function AskQuestionRow({
  callId, toolName, block, inspect, useDisclosure, useProjection, revealPanel, t,
}: AskQuestionRowProps) {
  const model = toolRowModel(toolName, block)
  // The `userQuestions` projection lists exactly the timed calls that can still
  // take an answer — the running ones and the ones the agent continued past —
  // so it, not the recorded result, decides whether this row offers its panel.
  // A recorded pending result stays recorded after the reply, the skip, or the
  // timeout lands, and a legacy blocking call is never listed: its row reads
  // exactly as it did before timed questions existed.
  const answerable = useProjection('userQuestions', view =>
    view?.active.some(row => row.callId === callId) ?? false)
  // The same projection settles every answered timed call with its batch: the
  // one its own result carried, or the one a late reply carried after the
  // result recorded the timeout. A legacy call is never settled there, so its
  // answers come from its result text alone.
  const settled = useProjection('userQuestions', view =>
    view?.settled.find(row => row.callId === callId))
  // A continued call stays answerable until its steered reply is admitted.
  // Select the durable Inbox entry so the queued answers can keep the row's
  // summary accurate during that interval, including after a browser reconnect.
  const queuedReply = useProjection('inbox', (view) => {
    const matches = (message: unknown): boolean => {
      const source = isRecord(message) ? message.source : undefined
      return isRecord(source) && source.kind === 'user-question-reply' && source.callId === callId
    }
    return view?.['next-step'].find(matches) ?? view?.['next-turn'].find(matches)
  })
  const reopen = useCallback(() => revealPanel(callId), [callId, revealPanel])
  // Composer verdicts settle the call as specific UserQuestionErrors
  // (ask_user_question handler): 'ASK_CANCELLED' is the user's own
  // dismissal of the set, 'ASK_ABORTED' is a turn interrupt landing while the
  // question was pending. Both name their verdict instead of the generic
  // failed shape, and the abort keeps the shared stopped (amber) semantics of
  // any other interrupted tool call.
  const code = 'kind' in block ? block.error?.code : undefined
  let summary = model.summary
  let state = model.state
  // An answerable call reopens its panel; everything else reads as a plain row.
  let rowAction: (() => boolean) | undefined
  const rowActionLabel = t('ask.reopen')
  if (code === 'ASK_CANCELLED') {
    summary = t('ask.cancelled')
    state = 'ok'
  } else if (code === 'ASK_ABORTED') {
    summary = t('ask.interrupted')
    state = 'stopped'
  } else if (model.state === 'running') {
    summary = t('ask.waiting')
    if (answerable) rowAction = reopen
  } else if (code === 'TOOL_OUTCOME_UNKNOWN' && (answerable || settled !== undefined)) {
    // Crash repair has no pending result text; the durable question projection
    // still knows whether the interrupted call can take a late answer.
    state = 'ok'
    if (answerable) {
      summary = t('ask.pending')
      rowAction = reopen
    } else if (settled?.answers.length === 0) {
      summary = t('ask.closed')
    } else if (settled !== undefined) {
      summary = answeredCountSummary(settled.answers, t)
    }
  } else if ('kind' in block && model.state === 'ok') {
    const text = singleResultText(block)
    if (text !== undefined) {
      const pending = isPendingResult(text)
      if (pending && answerable) {
        summary = t('ask.pending')
        rowAction = reopen
      } else if (pending && (settled === undefined || settled.answers.length === 0)) {
        summary = t('ask.closed')
      } else {
        // Answered either way: whether the answer beat the timeout is the
        // agent's pacing, not something a reader of the row has to reason
        // about, so a late-answered call reads exactly like an in-time one.
        // The projection's settled record wins over the result text.
        const answers = (settled !== undefined ? { answers: settled.answers } : answerBatchOf(text))?.answers ?? null
        summary = (answers === null ? null : answeredCountSummary(answers, t)) ?? answeredSummary(text, t) ?? model.summary
      }
    }
  }
  if (answerable && queuedReply !== undefined && rowAction === reopen) {
    // A queued reply already owns this call's answer: keep the summary accurate
    // but drop the reopen action — a second submission would reject with
    // REPLY_QUEUED, and the admitted reply lands as its own conversation bubble.
    const batch = queuedAnswerBatch(queuedReply, callId)
    if (batch !== null) summary = answeredCountSummary(batch.answers, t)
    rowAction = undefined
  }
  if (rowAction !== undefined) return (
    <QuestionToolRow useDisclosure={useDisclosure} t={t} summary={summary}
      bodyRaw={model.bodyRaw} output={model.output} state={state} inspect={inspect}
      openPanel={rowAction} panelLabel={rowActionLabel} />
  )
  return (
    <ToolRow
      useDisclosure={useDisclosure}
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={<IconQuestionOutlineRegular />}
      title={t(model.titleKey)}
      summary={summary}
      bodyRaw={model.bodyRaw}
      output={model.output}
      state={state}
      inspect={inspect}
    />
  )
}

/** Registers the ask-user-question conversation row. */
export const askQuestionToolview = {
  name: 'ask-question-toolview',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key: 'ask_user_question', locale: NS,
      // Read per click, not per render: a composition with no question UI
      // provides no panel, and the row then falls back to its own record.
      inject: (sessionId): AskQuestionPanelInjected => ({
        revealPanel: callId => ctx.get('userQuestionPanels')?.reveal(sessionId, callId) ?? false,
      }),
    }, AskQuestionRow))
  },
}
