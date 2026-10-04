/**
 * Degradation signal: count consecutive blank tool-call rejections and inject
 * an explicit notice once they repeat, so "the model is degenerating — switch
 * or stop" reaches the user instead of living only in vanishing toasts.
 * @module @deepseek-ai/dsh-agent/degradation-notice
 */

import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { NonEmptyToolCallIdError, type Session } from '@deepseek-ai/dsh-session'
import type { PreStepDecision } from './runtime-types.ts'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'tool-degradation': { kind: 'tool-degradation' } & ContextFormed
  }
}

/**
 * Consecutive blank tool-call rejections before the notice fires.
 * 2 = the first rejection gets a chance to self-heal; the second consecutive
 * one is reported as a pattern rather than an isolated glitch.
 */
export const DEGRADATION_NOTICE_THRESHOLD = 2

/**
 * Walk an AggregateError / `cause` chain for a blank tool-call rejection.
 * The turn boundary can wrap the append failure (recovery append failing on
 * the same poisoned row), so the classifier must see through one wrapper level.
 * @param error - candidate failure from `agent/error`.
 * @param depth - recursion guard; wrapper chains are shallow by construction.
 * @returns whether this failure (or one it wraps) is a blank tool-call rejection.
 */
function isBlankToolCallRejection(error: unknown, depth = 0): boolean {
  if (error instanceof NonEmptyToolCallIdError) return true
  if (depth >= 5 || error === null || typeof error !== 'object') return false
  if (error instanceof AggregateError) {
    return error.errors.some(nested => isBlankToolCallRejection(nested, depth + 1))
  }
  const cause = (error as { cause?: unknown }).cause
  return cause === undefined ? false : isBlankToolCallRejection(cause, depth + 1)
}

function degradationNotice(consecutive: number) {
  const count = String(consecutive)
  return createUserMessage({
    content: [{
      type: 'text' as const,
      text: `[model degradation: ${count} consecutive malformed tool-call${consecutive === 1 ? '' : 's'} rejected in this session; consider switching models or ending the session]`,
    }],
    source: {
      kind: 'tool-degradation',
      form: 'notice',
      summary: boundContextSummary(`malformed tool-call ×${count}`),
    },
  })
}

/**
 * Count consecutive blank tool-call rejections for one live Agent and inject
 * a durable notice into the next admitted turn once they reach
 * {@link DEGRADATION_NOTICE_THRESHOLD}. A successful model settlement resets
 * the count, so an isolated glitch never reports. Registration rides the
 * agent scope: listeners unregister with the agent's own teardown.
 *
 * @param agentCtx - the live Agent's scoped context.
 * @param session - session whose events settle/reset the count.
 * @returns Disposer for all scoped listeners.
 */
export function installDegradationNotice(agentCtx: Context, session: Session): () => void {
  let consecutive = 0
  let pending = false

  const disposeError = agentCtx.on('agent/error', ({ error }) => {
    if (!isBlankToolCallRejection(error)) return
    consecutive += 1
    if (consecutive >= DEGRADATION_NOTICE_THRESHOLD) pending = true
  })

  // A committed assistant/message proves the model produced a well-formed
  // attempt again; any earlier streak is history, not a pattern.
  const disposeSettle = agentCtx.on('session/event', (subject, event) => {
    if (subject !== session) return
    if (event.type === 'assistant/message') consecutive = 0
  })

  const disposeNotice = agentCtx.on(
    'agent/pre-step',
    async (_payload, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (!pending || decision.kind === 'reject') return decision
      pending = false
      const fired = consecutive
      consecutive = 0
      return { ...decision, messages: [...decision.messages, degradationNotice(fired)] }
    },
    { prepend: true },
  )

  return () => {
    disposeError()
    disposeSettle()
    disposeNotice()
  }
}
