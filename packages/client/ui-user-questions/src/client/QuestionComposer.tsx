import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ChangeEvent, type FocusEvent, type KeyboardEvent, type MouseEvent, type RefObject,
} from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular, IconChevronUpOutlineRegular, IconCloseOutlineRegular,
  IconEditOutlineRegular, MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArbitrateKey } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AnswerSurfaceInsert } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { planReviewOf, type QuestionAnswer, type QuestionCardSnapshot, type QuestionComposerProps } from './contract/slots.ts'
import type { PendingQuestion } from './contract/slots.ts'
import type { QuestionDraftAnswer, QuestionDraftProgress } from './draft-store.ts'
import { PlanReviewPanel } from './PlanReviewPanel.tsx'
import css from './QuestionComposer.module.css'

/**
 * Displayed feedback: validation feedback is stored as a dictionary KEY and
 * translated at render, so already-shown feedback follows a locale switch;
 * runtime failure messages (finished strings from the wire) pass through
 * verbatim.
 */
type Feedback = { key: 'error.incomplete' | 'error.unanswered' | 'error.unavailable' | 'error.resubmit' | 'status.sent' } | { text: string }

/** A removed card can remain mounted until the composer seat updates. */
const REMOVED_CARD: QuestionCardSnapshot = {
  state: 'open', waitState: 'counting', countdown: undefined, channel: 'none', closed: true,
}

/**
 * Split the conventional recommendation suffix without changing the answer value.
 * @param label - Original option label returned if selected.
 * @returns Display label plus recommendation state.
 */
export function parseRecommendedLabel(label: string): { label: string; recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i
  return suffix.test(label)
    ? { label: label.replace(suffix, ''), recommended: true }
    : { label, recommended: false }
}

/** Only a marked first choice is an implicit draft; the user still submits it. */
function recommendedFirstOption(question: PendingQuestion['questions'][number]): string | undefined {
  const label = question.options?.[0]?.label
  return label !== undefined && parseRecommendedLabel(label).recommended ? label : undefined
}

/** Accept persisted progress only when it still describes this question batch. */
function isQuestionDraftProgress(value: unknown, questionCount: number): value is QuestionDraftProgress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const progress = value as Record<string, unknown>
  if (typeof progress.index !== 'number' || !Number.isInteger(progress.index)
    || progress.index < 0 || progress.index >= questionCount
    || !Array.isArray(progress.drafts) || progress.drafts.length !== questionCount
    || (progress.wait !== undefined && progress.wait !== 'editing' && progress.wait !== 'waiting')) return false
  return progress.drafts.every((item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
    const draft = item as Record<string, unknown>
    return Array.isArray(draft.selected) && draft.selected.every((label: unknown) => typeof label === 'string')
      && typeof draft.custom === 'string' && typeof draft.skipped === 'boolean'
  })
}

/** Return whether a text-field key event belongs to an active IME composition. */
function isComposing(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  // keyCode 229 is the legacy IME-composition signal engines emit without isComposing.
  return event.nativeEvent.isComposing || Reflect.get(event.nativeEvent, 'keyCode') === 229
}

/**
 * Text-field keys the open trigger menu may claim, keyed by KeyboardEvent.key
 * and resolved to the pipeline's arbitration vocabulary. Tab resolves to
 * `tabBack` when Shift rides along; keys absent from the map (Space, plain
 * characters) are the field's own and never reach arbitration.
 */
const ARBITRATE_KEYS: Record<string, ArbitrateKey> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  Enter: 'enter',
  Escape: 'escape',
  Tab: 'tab',
}

/**
 * FORK dsh-local (occlusion-fold): the share of the viewport a takeover must
 * occupy before losing attention folds it. The card's own cap is
 * viewport-relative (`min(60vh, 520px)`), so the line that counts as
 * "blocking the conversation" is too: below it the transcript still has room
 * and a fold would only cost the reader their place.
 */
const OCCLUSION_FOLD_RATIO = 0.3

/** The free-text answer field shared by both question variants. */
interface AnswerFieldProps {
  /** Visual variant: the custom row's inline column or the optionless question's framed block. */
  variant: 'inline' | 'block'
  /** Current draft text. */
  value: string
  /** Empty-field prompt. */
  placeholder: string
  /** Whether a submission in flight has frozen the field. */
  disabled: boolean
  /** Whether this field takes focus on mount. */
  autoFocus?: boolean
  /** Host hook for trigger-pipeline caret tracking and post-insert caret restore. */
  textRef?: RefObject<HTMLTextAreaElement>
  /** Called when the field takes focus. */
  onFocus?: () => void
  /** Called whenever the selection moves (caret motion re-tracks the trigger pipeline). */
  onSelect?: () => void
  /** Called with each edit of the draft. */
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void
  /** Called with each key press, before the browser's own handling. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}

/**
 * Auto-growing free-text answer: a textarea, so a long answer soft-wraps and
 * Shift+Enter breaks a line, over a hidden mirror that owns the height.
 *
 * The mirror renders the draft plus a trailing newline in normal flow and so
 * sizes the grid row (counting rows by '\n' cannot see soft wraps); the
 * textarea shares that one cell and stretches to it, and `rows={1}` keeps the
 * control's own intrinsic height out of the row sizing so the mirror alone
 * decides. Past the mirror's cap the textarea scrolls itself — it is the only
 * scrollport in the stack, there being no second glyph layer to keep aligned.
 * Mirror and textarea MUST share font, line-height, padding and wrapping rules
 * or the two heights diverge.
 *
 * @param props - visual variant, draft text, and the field's event handlers.
 * @returns The mirrored auto-growing field.
 */
function AnswerField(props: AnswerFieldProps) {
  return (
    <div className={clsx(css.field, props.variant === 'inline' ? css.customInline : css.customBlock)}>
      <div aria-hidden className={css.fieldMirror}>{`${props.value}\n`}</div>
      <textarea
        ref={props.textRef}
        autoFocus={props.autoFocus}
        className={css.fieldInput}
        value={props.value}
        disabled={props.disabled}
        rows={1}
        placeholder={props.placeholder}
        onFocus={props.onFocus}
        onSelect={props.onSelect}
        onChange={props.onChange}
        onKeyDown={props.onKeyDown}
      />
    </div>
  )
}

/**
 * Composer takeover router. Generic-question drafts live in this entry's
 * Session-scoped Slot store, keyed by the pending carrier, so a strict Session
 * entry remount restores the same request without exposing it to another one.
 *
 * One takeover, two presentations: a request that declares a presentation intent this
 * package renders uses that presentation (a plan review is one decision over one
 * plan, not a question set), and every other request takes the generic flow.
 * The routing lives here, at the one entry that owns the composer seat, so
 * neither presentation can claim a request the other is already rendering.
 *
 * @param props - the selector-matched pending question carrier plus the framework standard kit.
 * @returns The question flow, or the intent's own surface, for this request.
 */
export function QuestionComposer(props: QuestionComposerProps) {
  const question = props.matched
  const review = useMemo(() => planReviewOf(question.questions), [question])
  return review === undefined
    ? (
      <QuestionFlow
        key={question.key}
        pending={question}
        t={props.t}
        useStore={props.useStore}
        useQuestionCard={props.useQuestionCard}
        actions={props.actions}
        renderSlot={props.renderSlot}
        answerTriggers={props.answerTriggers}
        {...(props.openAttachment === undefined ? {} : { openAttachment: props.openAttachment })}
      />
    )
    : <PlanReviewPanel key={question.key} pending={question} review={review} t={props.t} renderSlot={props.renderSlot} />
}

type QuestionFlowProps =
  { pending: PendingQuestion }
  & Pick<QuestionComposerProps,
    't' | 'useStore' | 'useQuestionCard' | 'actions' | 'renderSlot' | 'answerTriggers' | 'openAttachment'>

function QuestionFlow({ pending, t, useStore, useQuestionCard, actions, renderSlot, answerTriggers, openAttachment }: QuestionFlowProps) {
  const questions = pending.questions
  // A read-only card built from a settled call's transcript: the same panel
  // over the recorded answers, with nothing left to submit.
  const review = pending.review
  const markdownLabels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied'), toolbarLabels: { codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap') } },
    footnotes: t('markdown.footnotes'),
  }), [t])
  const initialDrafts = useMemo<QuestionDraftAnswer[]>(() => {
    // Recorded answers echo the question ids rather than their order.
    const recorded = new Map((review ?? []).map(answer => [answer.id, answer]))
    return questions.map((item) => {
      const answer = recorded.get(item.id)
      const custom = answer?.custom ?? ''
      const recommended = review === undefined ? recommendedFirstOption(item) : undefined
      return {
        selected: answer === undefined && recommended !== undefined ? [recommended] : [...answer?.selected ?? []],
        custom,
        // A recorded answer with no selection and no custom text was skipped.
        skipped: answer !== undefined && answer.selected.length === 0 && custom === '',
      }
    })
  }, [questions, review])
  const stored = useStore(state => state.progressByRequest[pending.key])
  const validStored = isQuestionDraftProgress(stored, questions.length) ? stored : undefined
  // A review card renders the record itself, so a draft its live card left
  // behind can never surface as an answer; only the page position is restored.
  const storedProgress = review === undefined ? validStored : undefined
  const index = validStored?.index ?? 0
  const drafts = storedProgress?.drafts ?? initialDrafts
  const restoredWait = storedProgress?.wait
    ?? (storedProgress?.drafts.some((item, itemIndex) =>
      item.selected.length !== initialDrafts[itemIndex]?.selected.length
      || item.selected.some((label, labelIndex) => label !== initialDrafts[itemIndex]?.selected[labelIndex])
      || item.custom !== '' || item.skipped) === true
      ? 'editing' : undefined)
  const [busy, setBusy] = useState<'answer' | 'cancel' | null>(null)
  const [error, setError] = useState<Feedback | null>(null)
  const card = useQuestionCard(pending.key, snapshot => snapshot ?? REMOVED_CARD)
  const canSubmit = card.channel !== 'none'
  // The answer surface freezes while a submission is in flight, and for good on
  // a review card: its call has already settled.
  const locked = busy !== null || review !== undefined
  // A waterfall submission is only "sent": the gateway drops an outcome that
  // arrives after another Client settled the event, without telling anyone.
  // The draft therefore survives until the projection closes the card, and a
  // card that flips to continued while a submission is in flight re-arms the
  // controls so the same draft can go through the Remote path.
  const sentVia = useRef<'waterfall' | null>(null)
  useEffect(() => {
    if (sentVia.current !== 'waterfall' || card.state !== 'continued') return
    sentVia.current = null
    setBusy(null)
    setError({ key: 'error.resubmit' })
  }, [card.state])
  useEffect(() => {
    if (card.closed) actions.clear(pending.key)
  }, [actions, card.closed, pending.key])
  useEffect(() => {
    actions.prune(pending.liveKeys())
  }, [actions, pending])
  const waitDisposition = useRef<'editing' | 'waiting' | undefined>(restoredWait)
  useEffect(() => {
    if (waitDisposition.current === 'waiting') pending.takeTime()
    if (waitDisposition.current === 'editing') pending.engage()
  }, [pending])
  // The countdown belongs to the carrier, not to this component: the user can
  // close the panel and reopen it from the tool call row, and a timer that died
  // with the mount would leave the tool call waiting past its deadline.
  const countdown = card.countdown
  // Collapsed to the header strip so the conversation above stays readable
  // while the user decides; answer drafts live in the Session store above.
  const [minimized, setMinimized] = useState(false)
  // FORK dsh-local (occlusion-fold, 2026-10-26): a takeover card the user
  // stepped away from — the press landed outside the frame, or focus left it —
  // folds to the header strip so the transcript reclaims the space; any
  // engagement inside unfolds it again. Orthogonal to the manual minimize by
  // design: `minimized` is the user's pinned choice (only the toggle lifts
  // it), `autoFolded` yields to attention (any inside press or focus lifts
  // it), and the card renders collapsed while either holds. A freshly
  // presented question always starts unfolded — it must be seen. The busy
  // submission keeps its card up so the state it disabled stays readable.
  const [autoFolded, setAutoFolded] = useState(false)
  const collapsed = minimized || autoFolded
  const frameRef = useRef<HTMLDivElement>(null)
  // The free-form textarea autofocuses on first presentation; re-expanding a
  // collapsed question must not steal focus from the expand toggle back into
  // the input, so focus is granted once per question index.
  const focusedQuestions = useRef(new Set<number>())
  const answerSurface = useRef<HTMLDivElement>(null)
  // Trigger-pipeline wiring for the answer field (the pipeline's `answer`
  // surface): the field's textarea; its content revision (content edits bump
  // it, caret motion does not, so pick-time spans stay CAS-valid); the last
  // text tracked; a pending post-insert caret; and the insert target a menu
  // pick dispatches from outside React, rebound after every render.
  const textRef = useRef<HTMLTextAreaElement>(null)
  const revRef = useRef(0)
  const lastTrackedRef = useRef<string | null>(null)
  const pendingCaretRef = useRef<number | null>(null)
  const insertRef = useRef<AnswerSurfaceInsert>(() => false)
  // Every navigation write stays in bounds and drafts mirrors questions 1:1.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const question = questions[index]!
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const draft = drafts[index]!
  const hasOptions = (question.options?.length ?? 0) > 0
  // Folded long-content attachment; the opener exists only where a Sidebar is reachable.
  const attachment = question.attachment

  const replaceProgress = (nextIndex: number, nextDrafts: QuestionDraftAnswer[]): void => {
    actions.replace(pending.key, {
      index: nextIndex,
      drafts: nextDrafts,
      ...(waitDisposition.current === undefined ? {} : { wait: waitDisposition.current }),
    })
  }

  const takeTime = (): void => {
    waitDisposition.current = 'waiting'
    pending.takeTime()
    replaceProgress(index, drafts)
  }

  const engage = (): void => {
    if (waitDisposition.current !== undefined) return
    waitDisposition.current = 'editing'
    pending.engage()
  }

  const focusAnswerSurface = (event: FocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) pending.holdFocus()
  }

  const blurAnswerSurface = (event: FocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) pending.releaseFocus()
  }

  useEffect(() => {
    const release = (): void => { pending.releaseFocus() }
    const refocus = (): void => {
      if (waitDisposition.current === 'editing') {
        pending.engage()
        return
      }
      if (answerSurface.current?.contains(document.activeElement) === true) pending.holdFocus()
    }
    const visibilityChanged = (): void => { if (document.hidden) release(); else refocus() }
    window.addEventListener('blur', release)
    window.addEventListener('focus', refocus)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      release()
      window.removeEventListener('blur', release)
      window.removeEventListener('focus', refocus)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [pending])

  // FORK dsh-local (occlusion-fold): attention reaching for the conversation —
  // a press or a focus that lands in the transcript scroller while this card
  // holds real estate — folds the open card to its header strip so the reader
  // gets the space back. The seat's own furniture (queue dock, InputBar, the
  // card itself) is deliberately out of the trigger set: those are interaction
  // with the composer, not with the transcript, and folding on them would
  // yank the question away mid-gesture. Edge-triggered on the gesture, not
  // level-triggered on focus: a freshly presented question that never held
  // the keyboard (an options card autofocuses nothing) stays up until someone
  // actually reaches for the transcript. A busy submission keeps its card.
  useEffect(() => {
    if (collapsed || busy !== null) return
    const frame = frameRef.current
    if (frame === null) return
    // The transcript scroller owns the seat as a descendant (`composerSeat`
    // sits inside `data-conversation-scroll`), so the seat check carves the
    // composer furniture back out of the transcript reach.
    const transcriptReach = (target: EventTarget | null): boolean =>
      target instanceof Element
      && !frame.contains(target)
      && target.closest('[data-conversation-scroll]') !== null
      && target.closest('[data-composer-seat]') === null
    // Size-gated like the rule it serves: only a card that actually blocks a
    // meaningful share of the viewport folds, so a two-line question stays put
    // while the reader picks at the transcript and the layout never jitters
    // under a card they could already see around.
    const blocksTheTranscript = (): boolean =>
      frame.getBoundingClientRect().height > window.innerHeight * OCCLUSION_FOLD_RATIO
    const onGesture = (event: Event): void => {
      if (transcriptReach(event.target) && blocksTheTranscript()) setAutoFolded(true)
    }
    document.addEventListener('pointerdown', onGesture, true)
    document.addEventListener('focusin', onGesture, true)
    return () => {
      document.removeEventListener('pointerdown', onGesture, true)
      document.removeEventListener('focusin', onGesture, true)
    }
  }, [collapsed, busy])

  // Unfold paths: focus entering the card, or a press on the header strip of
  // an auto-folded card. Buttons are excluded — the toggle lifts the fold
  // through its own handler, and the close action must not flash the card
  // open on its way out. A manually minimized card ignores the strip press —
  // the pinned choice lifts only through the toggle, as it always has.
  const unfoldFromStrip = (event: MouseEvent<HTMLDivElement>): void => {
    if (!autoFolded) return
    if ((event.target as Element).closest('button') !== null) return
    setAutoFolded(false)
  }

  const dismissFlow = (): void => {
    // A tool-call-keyed panel only leaves the seat; nothing is sent and nothing
    // is persisted, and the tool call row brings it back.
    if (pending.dismissal === 'hide') {
      void pending.dismiss()
      return
    }
    if (!canSubmit) {
      setError({ key: 'error.unavailable' })
      return
    }
    setBusy('cancel')
    setError(null)
    sentVia.current = 'waterfall'
    void pending.dismiss()
      .catch((cause: unknown) => {
        sentVia.current = null
        setBusy(null)
        setError({ text: cause instanceof Error ? cause.message : String(cause) })
      })
  }

  const updateDraft = (
    update: (current: QuestionDraftAnswer) => QuestionDraftAnswer,
    nextIndex = index,
  ): void => {
    engage()
    const nextDrafts = drafts.map((item, itemIndex) => itemIndex === index ? update(item) : item)
    replaceProgress(nextIndex, nextDrafts)
    setError(null)
  }

  // The answer surface's insert target: applies a picked plain text over the
  // pick-time span, writes the draft through the same path a typed edit takes
  // (a single-select draft yields its selection to the custom answer, as
  // `draftCustom` does), and parks the caret behind the insert for the layout
  // effect below to restore. `keep` (chained completion) has no answer-field
  // meaning and is ignored.
  useEffect(() => {
    insertRef.current = (text, span) => {
      if (span.draftRev !== revRef.current) return false
      const el = textRef.current
      if (el === null || el.disabled) return false
      const current = el.value
      if (span.start < 0 || span.start > span.end || span.end > current.length) return false
      const next = current.slice(0, span.start) + text + current.slice(span.end)
      if (next === current) return true
      updateDraft(item => ({
        ...item,
        selected: question.multiSelect === true ? item.selected : [],
        custom: next,
        skipped: false,
      }))
      pendingCaretRef.current = span.start + text.length
      return true
    }
  })

  // Surface lease: while the field is mounted the pipeline runs on the answer
  // surface, so tracks from the hidden InputBar draft are ignored; collapsing
  // the takeover detaches, which also closes any open menu.
  useEffect(() => {
    if (collapsed) return
    return answerTriggers.attach((text, span, keep) => insertRef.current(text, span, keep))
  }, [answerTriggers, collapsed])

  // One feed per commit: content edits bump the revision, caret-only motion
  // keeps it, and a locked field tracks frozen — which closes any open menu.
  // Text and caret read from the live element so a store write that just
  // landed is tracked with the text the caret actually sits in.
  useEffect(() => {
    if (collapsed) return
    const el = textRef.current
    const value = el === null ? draft.custom : el.value
    if (lastTrackedRef.current !== value) {
      revRef.current += 1
      lastTrackedRef.current = value
    }
    const caret = el === null ? value.length : el.selectionStart
    answerTriggers.track(value, caret, locked ? 'frozen' : 'plain', revRef.current)
  })

  // A pick writes the store; React then replaces the field value and the
  // caret would collapse to the end — restore it behind the inserted text.
  // Layout, so the track pass above reads the restored caret.
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current
    if (caret === null) return
    pendingCaretRef.current = null
    textRef.current?.setSelectionRange(caret, caret)
  })

  // Caret motion and focus re-track the live text without a revision bump.
  const trackCaret = (): void => {
    if (collapsed) return
    const el = textRef.current
    if (el === null) return
    answerTriggers.track(el.value, el.selectionStart, locked ? 'frozen' : 'plain', revRef.current)
  }

  const choose = (label: string): void => {
    updateDraft((current) => {
      if (question.multiSelect === true) {
        const selected = current.selected.includes(label)
          ? current.selected.filter(item => item !== label)
          : [...current.selected, label]
        return { ...current, selected, skipped: false }
      }
      return { selected: [label], custom: '', skipped: false }
    }, question.multiSelect !== true && index < questions.length - 1 ? index + 1 : index)
  }

  const answered = (item: QuestionDraftAnswer): boolean =>
    item.selected.length > 0 || item.custom.trim() !== ''

  const completed = (item: QuestionDraftAnswer): boolean => answered(item) || item.skipped

  const submitDrafts = (values: QuestionDraftAnswer[]): void => {
    const missing = values.findIndex(item => !completed(item))
    if (missing >= 0) {
      replaceProgress(missing, values)
      setError({ key: 'error.incomplete' })
      return
    }
    if (!canSubmit) {
      setError({ key: 'error.unavailable' })
      return
    }
    const answer: QuestionAnswer = {
      answers: questions.map((item, itemIndex) => {
        const value = values[itemIndex] as QuestionDraftAnswer
        if (value.skipped) return { id: item.id, selected: [] }
        const custom = value.custom.trim()
        return {
          id: item.id,
          selected: custom === '' || item.multiSelect === true ? value.selected : [],
          ...(custom === '' ? {} : { custom }),
        }
      }),
    }
    setBusy('answer')
    setError(null)
    // The external-store render can lag the carrier as a timed call continues.
    // Read the channel used by answer() in this same event turn.
    const channel = pending.snapshot().channel
    sentVia.current = channel === 'waterfall' ? 'waterfall' : null
    void pending.answer(answer)
      .then(() => {
        if (channel !== 'rpc') return
        sentVia.current = null
        setBusy(null)
        setError(null)
        void pending.dismiss().catch(() => { setError({ key: 'status.sent' }) })
      })
      .catch((cause: unknown) => {
        sentVia.current = null
        setBusy(null)
        setError({ text: cause instanceof Error ? cause.message : String(cause) })
      })
  }

  const continueFlow = (): void => {
    if (!answered(draft)) {
      setError({ key: 'error.unanswered' })
      return
    }
    if (index < questions.length - 1) {
      replaceProgress(index + 1, drafts)
      setError(null)
      return
    }
    submitDrafts(drafts)
  }

  // Shared by the inline custom field and the optionless one: a multi-select
  // draft retains checked labels, while a single-select custom answer replaces
  // its selection. Enter continues the flow, Shift+Enter breaks a line.
  const draftCustom = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const value = event.target.value
    updateDraft(current => ({
      ...current,
      selected: question.multiSelect === true ? current.selected : [],
      custom: value,
      skipped: false,
    }))
  }

  const continueFromCustom = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    continueFlow()
  }

  // Menu arbitration first: a key the open '/' menu claims (arrows, Escape,
  // Tab, or Enter settling the highlight) never reaches the flow's Enter
  // continuation — a highlighted pick inserts its text instead of advancing.
  const answerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const composing = isComposing(event)
    const key = ARBITRATE_KEYS[event.key]
    if (key !== undefined) {
      const route = event.key === 'Tab' && event.shiftKey ? 'tabBack' : key
      if (answerTriggers.arbitrate(route, composing) !== 'pass') {
        event.preventDefault()
        return
      }
    }
    continueFromCustom(event)
  }

  const skipQuestion = (): void => {
    engage()
    const nextDrafts = drafts.map((item, itemIndex) => itemIndex === index
      ? { selected: [], custom: '', skipped: true }
      : item)
    replaceProgress(index < questions.length - 1 ? index + 1 : index, nextDrafts)
    setError(null)
    if (index < questions.length - 1) {
      return
    }
    submitDrafts(nextDrafts)
  }

  return (
    <div
      ref={frameRef}
      className={css.frame}
      data-question-key={pending.key}
      data-composer-card=""
      data-question-folded={autoFolded ? '' : undefined}
      // Any engagement inside the card lifts an auto-fold; the manually
      // minimized card ignores it (the strip press below agrees — only the
      // toggle lifts a pinned choice).
      onFocus={() => { if (autoFolded) setAutoFolded(false) }}
      onClick={unfoldFromStrip}
    >
      {/* Floating slash-menu anchor for the answer field: the card clips its
          own scroll, so the overlay seats outside it, sized to the card's
          width (mirrors the InputBar's overlay anchor inside its card). */}
      {!collapsed && (
        <div className={css.triggerAnchor}>{renderSlot('conversation.composer.overlay', {})}</div>
      )}
      <section
        className={clsx(css.card, collapsed && css.cardMinimized)}
        aria-labelledby={`question-${pending.key}-${String(index)}`}
      >
        <header className={css.header}>
          <div className={css.headingBlock}>
            {question.header !== undefined && <div className={css.eyebrow}>{question.header}</div>}
            <h2 className={css.title} id={`question-${pending.key}-${String(index)}`}>
              {question.question}
            </h2>
          </div>
          <div className={css.headerActions}>
            {countdown !== undefined && card.waitState !== 'waiting' && card.waitState !== 'editing' && card.waitState !== 'continued' && (
              <span className={css.waitStatus}>
                {t(countdown.running ? 'wait.countdown' : 'wait.paused', {
                  seconds: Math.ceil(countdown.remainingMs / 1000),
                })}
              </span>
            )}
            {countdown !== undefined && card.waitState !== 'waiting' && card.waitState !== 'editing' && card.waitState !== 'continued' && (
              <Button variant="outline" className={css.waitButton} onClick={takeTime}>
                {t('wait.takeTime')}
              </Button>
            )}
            {card.state === 'continued' && <span className={css.waitStatus}>{t('wait.continued')}</span>}
            {/* A held or frozen countdown says so; a request that never carried
                one waits silently, as the blocking question always has. */}
            {countdown !== undefined && (card.waitState === 'waiting' || card.waitState === 'editing') && (
              <span className={css.waitStatus}>{t('wait.held')}</span>
            )}
            {review !== undefined && <span className={css.waitStatus}>{t('review.status')}</span>}
            <button
              type="button" className={css.iconButton}
              aria-label={t(collapsed ? 'nav.maximize' : 'nav.minimize')}
              title={t(collapsed ? 'nav.maximize' : 'nav.minimize')}
              aria-expanded={!collapsed}
              disabled={busy !== null}
              // One toggle over the union: expanded → pin a manual minimize;
              // collapsed by either reason → lift both (an auto-folded card
              // must not stay folded after the user asks for it back).
              onClick={() => {
                if (collapsed) {
                  setMinimized(false)
                  setAutoFolded(false)
                } else {
                  setMinimized(true)
                }
              }}
            >
              {collapsed ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
            </button>
            <button
              type="button" className={css.iconButton}
              aria-label={t(pending.dismissal === 'hide' ? 'nav.close' : 'nav.cancel')}
              title={t(pending.dismissal === 'hide' ? 'nav.close' : 'nav.cancel')}
              disabled={busy !== null} onClick={dismissFlow}
            >
              <IconCloseOutlineRegular />
            </button>
          </div>
        </header>

        {!collapsed && (
          <>
            <div
              ref={answerSurface}
              className={css.body}
              data-question-scroll
              onFocusCapture={focusAnswerSurface}
              onBlurCapture={blurAnswerSurface}
            >
              {question.detail !== undefined && (
                <div className={css.detail}><MarkdownText text={question.detail} labels={markdownLabels} /></div>
              )}
              {attachment !== undefined && (
                <div className={css.attachment}>
                  <span className={css.attachmentText}>{t('attachment.folded', { chars: attachment.chars })}</span>
                  {openAttachment !== undefined
                    ? (
                      <Button variant="outline" onClick={() => openAttachment(attachment.path)}>
                        {t('attachment.open')}
                      </Button>
                    )
                    : <span className={css.attachmentPath}>{attachment.path}</span>}
                </div>
              )}
              <div className={css.options} role={question.multiSelect === true ? 'group' : 'radiogroup'}>
                {(question.options ?? []).map((option, optionIndex) => {
                  const selected = draft.selected.includes(option.label)
                  const display = parseRecommendedLabel(option.label)
                  return (
                    <button
                      type="button" key={`${option.label}-${String(optionIndex)}`}
                      className={clsx(css.option, selected && question.multiSelect !== true && css.optionSelected)}
                      role={question.multiSelect === true ? 'checkbox' : 'radio'}
                      aria-checked={selected}
                      aria-label={display.label}
                      disabled={locked}
                      onClick={() => { choose(option.label) }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return
                        event.preventDefault()
                        submitDrafts(drafts)
                      }}
                    >
                      {question.multiSelect === true
                        ? (
                          <span className={clsx(css.checkbox, selected && css.checkboxChecked)} aria-hidden="true">
                            {selected && <IconCheckOutlineRegular size={12} />}
                          </span>
                        )
                        : <span className={css.number}>{optionIndex + 1}</span>}
                      <span className={css.optionCopy}>
                        <span className={css.optionLine}>
                          <span className={css.optionLabel}>{display.label}</span>
                          {display.recommended && (
                            <span className={css.badge}>{t('option.recommended')}</span>
                          )}
                          {option.description !== undefined && (
                            <span className={css.description}>{option.description}</span>
                          )}
                        </span>
                      </span>
                    </button>
                  )
                })}

                {review !== undefined && draft.skipped && (
                  <p className={css.reviewNote}>{t('review.skipped')}</p>
                )}

                {/* A review card keeps the free-text field only when the
                    recorded answer used it; an empty disabled box with a
                    placeholder would read as somewhere to type. */}
                {(review === undefined || draft.custom !== '') && (hasOptions
                  ? (
                    <div
                      className={clsx(
                        css.customRow,
                        draft.custom !== '' && css.customRowActive,
                        question.multiSelect !== true && draft.selected.length > 0 && css.customRowYielded,
                      )}
                    >
                      {question.multiSelect === true
                        ? (
                          <span
                            className={clsx(css.checkbox, draft.custom !== '' && css.checkboxChecked)}
                            aria-hidden="true"
                          >
                            {draft.custom !== '' && <IconCheckOutlineRegular size={12} />}
                          </span>
                        )
                        : (
                          <span className={css.number} aria-hidden="true">
                            <IconEditOutlineRegular size={12} />
                          </span>
                        )}
                      <AnswerField
                        variant="inline"
                        value={draft.custom}
                        disabled={locked}
                        placeholder={t('custom.placeholder')}
                        textRef={textRef}
                        onFocus={trackCaret}
                        onSelect={trackCaret}
                        onChange={draftCustom}
                        onKeyDown={answerKeyDown}
                      />
                    </div>
                  )
                  : (
                    <AnswerField
                      // A missing countdown does not imply an indefinite request:
                      // a timed request can still be awaiting its claim's first frame.
                      autoFocus={canSubmit && countdown === undefined && !locked && !focusedQuestions.current.has(index)}
                      variant="block"
                      value={draft.custom}
                      disabled={locked}
                      placeholder={t('custom.placeholder')}
                      textRef={textRef}
                      onFocus={() => { focusedQuestions.current.add(index); trackCaret() }}
                      onSelect={trackCaret}
                      onChange={draftCustom}
                      onKeyDown={answerKeyDown}
                    />
                  ))}
              </div>
            </div>

            <footer className={css.footer}>
              <div className={css.pager}>
                <button
                  type="button" className={css.iconButton} aria-label={t('nav.prev')}
                  disabled={index === 0 || busy !== null}
                  onClick={() => { replaceProgress(index - 1, drafts); setError(null) }}
                >
                  <IconChevronLeftOutlineRegular />
                </button>
                <span className={css.progress}>{index + 1} / {questions.length}</span>
                <button
                  type="button" className={css.iconButton} aria-label={t('nav.next')}
                  disabled={index === questions.length - 1 || busy !== null}
                  onClick={() => { replaceProgress(index + 1, drafts); setError(null) }}
                >
                  <IconChevronRightOutlineRegular />
                </button>
              </div>
              <div className={css.feedback} role="status">
                {error === null ? null : 'key' in error ? t(error.key) : error.text}
              </div>
              {/* A review card has nothing to send: the pager alone walks the record. */}
              {review === undefined && (
                <div className={css.footerActions}>
                  <Button variant="outline" disabled={busy !== null} onClick={skipQuestion}>
                    {t('action.skip')}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={busy !== null || !answered(draft) || (index === questions.length - 1 && !canSubmit)}
                    onClick={continueFlow}
                  >
                    {busy === 'answer'
                      ? t('submitting')
                      : index === questions.length - 1 ? t('submit') : t('action.next')}
                  </Button>
                </div>
              )}
            </footer>
          </>
        )}
      </section>
    </div>
  )
}
