/**
 * Fixed Alt+Arrow routing into a mounted Chat view's intervention stepping.
 * The chord is reserved here because this plugin owns the shortcut service;
 * the mounted view owns the action it drives.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'

/** Prev/next step sink published by one mounted Chat view. */
export type InterventionStep = (delta: 1 | -1) => void

/**
 * The conversation a chord outside every conversation belongs to: the one
 * occupying the most of the viewport. The transcript is not focusable, so a
 * reader who clicked into it leaves focus on the body, which names no
 * conversation at all.
 * @returns the most visible conversation, or none when nothing is on screen.
 */
function visibleConversation(): HTMLElement | null {
  let best: HTMLElement | null = null
  let bestVisible = 0
  for (const element of document.querySelectorAll<HTMLElement>('[data-conversation-session]')) {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    const visible = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
    if (visible <= bestVisible) continue
    bestVisible = visible
    best = element
  }
  return bestVisible > 0 ? best : null
}

/**
 * Subscribe fixed input to the prev/next intervention step of the Chat view
 * whose conversation the chord belongs to.
 * @param shortcuts - window keyboard arbitration.
 * @param railSteps - step sinks published by mounted views, keyed by Session.
 * @returns disposer releasing the subscription.
 */
export function installInterventionStep(
  shortcuts: Pick<Shortcuts, 'observeFixedInput'>,
  railSteps: ReadonlyMap<SessionId, InterventionStep>,
): () => void {
  return shortcuts.observeFixedInput((input) => {
    if (input.type === 'reset') return
    const { gesture, context } = input
    const delta = gesture.code === 'ArrowUp' ? -1 as const
      : gesture.code === 'ArrowDown' ? 1 as const : null
    if (delta === null || !gesture.alt || gesture.control || gesture.meta || gesture.shift
      || gesture.repeat || gesture.composing || gesture.defaultPrevented) return
    // A dialog owns its keys and a terminal owns the arrow keys.
    if (context.modal !== null || context.region === 'terminal') return
    const scoped = context.target?.closest<HTMLElement>('[data-conversation-session]') ?? null
    // Outside a conversation only a page-region gesture counts: a caret in
    // some other field is not asking to move this transcript.
    if (scoped === null && context.region !== 'page') return
    const occurrence = scoped ?? visibleConversation()
    const sessionId = occurrence?.dataset.conversationSession
    const step = sessionId === undefined ? undefined : railSteps.get(sessionId as SessionId)
    if (step === undefined) return
    input.consume()
    step(delta)
  })
}
