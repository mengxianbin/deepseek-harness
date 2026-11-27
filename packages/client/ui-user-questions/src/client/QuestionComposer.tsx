import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type ChangeEvent, type FocusEvent, type KeyboardEvent, type MouseEvent, type RefObject,
} from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular, IconChevronUpOutlineRegular, IconCloseOutlineRegular,
  IconEditOutlineRegular, MarkdownText, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArbitrateKey } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AnswerSurfaceInsert } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { classifyComposerEnter } from '@deepseek-ai/dsh-client-shortcuts/client'
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

/** Long copy the user expanded on one question: the question itself or an option description by index. */
interface ExpandedCopy {
  /** Index of the question the expansions belong to. */
  readonly index: number
  /** Expanded copy of that question: `'question'` or an option index. */
  readonly copies: ReadonlySet<'question' | number>
}

const NOTHING_EXPANDED: ExpandedCopy['copies'] = new Set()

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

/**
 * Implicit draft selection the user still submits: every marked choice of a
 * multi-select question, or a marked first choice of a single-select question.
 */
function recommendedOptions(question: PendingQuestion['questions'][number]): string[] {
  const labels = (question.options ?? []).map(option => option.label)
  const candidates = question.multiSelect === true ? labels : labels.slice(0, 1)
  return candidates.filter(label => parseRecommendedLabel(label).recommended)
}

/** Accept persisted progress only when it still describes this question batch. */
function isQuestionDraftProgress(value: unknown, questionCount: number): value is QuestionDraftProgress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const progress = value as Record<string, unknown>
  if (typeof progress.index !== 'number' || !Number.isInteger(progress.index)
    || progress.index < 0 || progress.index >= questionCount
    || !Array.isArray(progress.drafts) || progress.drafts.length !== questionCount
    || (progress.wait !== undefined && progress.wait !== 'editing' && progress.wait !== 'waiting')
    // Card-level remark (ask-focus-restore-1125 裁定 D): optional string;
    // records written before the field still validate.
    || (progress.note !== undefined && typeof progress.note !== 'string')) return false
  return progress.drafts.every((item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
    const draft = item as Record<string, unknown>
    return Array.isArray(draft.selected) && draft.selected.every((label: unknown) => typeof label === 'string')
      && typeof draft.custom === 'string' && typeof draft.skipped === 'boolean'
  })
}

/** Return whether a key event belongs to an active IME composition. */
function isComposing(event: KeyboardEvent<HTMLElement>): boolean {
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
 * Enter breaks a line, over a hidden mirror that owns the height.
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
  const descriptionIdPrefix = useId()
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
      return {
        selected: answer !== undefined ? [...answer.selected] : review === undefined ? recommendedOptions(item) : [],
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
  // The card-level remark (题外话) rides the same progress record, so page
  // turns and picks below carry it without a second store.
  const note = storedProgress?.note ?? ''
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
  // FORK dsh-local (ask-keys-focus, 2026-11-17 裁定): one fold reason only —
  // `autoFolded` follows attention. A pointerdown or focusin that lands
  // outside the card frame folds the open card to its strip; focus back into
  // the frame, or a press on the strip of an auto-folded card, lifts it. The
  // manual minimize toggle and its pinned choice are gone with the button
  // (2026-11-17 裁定 A1/A2). A freshly presented question always starts
  // unfolded: the fold only ever fires on a card-external gesture, so the
  // question is seen before it ever loses focus. The busy submission keeps
  // its card up so the state it disabled stays readable.
  const [autoFolded, setAutoFolded] = useState(false)
  const collapsed = autoFolded
  // The card-level remark box (ask-focus-restore-1125 裁定 D): open state is
  // local chrome — the TEXT lives in the progress record above, so closing the
  // box, turning pages, or a Client restart never loses it. A restored non-
  // empty remark opens the box so its content is visible on remount.
  const [noteOpen, setNoteOpen] = useState(() => (storedProgress?.note ?? '') !== '')
  const noteRef = useRef<HTMLTextAreaElement>(null)
  // Set by the footer toggle, consumed by the layout effect below: the box is
  // not mounted at click time, so the seat has to be granted after it renders.
  const noteFocusRef = useRef(false)
  const frameRef = useRef<HTMLDivElement>(null)
  // FORK dsh-local (ask-keys-focus, 2026-11-17 裁定): whether focus was last
  // held inside this card. An index change that unmounts the focused option
  // drops `document.activeElement` to the body; the layout effect below only
  // restores focus into the new question when it was this card that held it,
  // so focus parked on a pager button or outside the card is never stolen.
  const focusInCard = useRef(false)
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
  // FORK dsh-local (ask-focus-restore-1125, 2026-11-25 裁定 C): 底钉 capture —
  // called BEFORE a keystroke's growth lands, it records whether the body
  // scrollport sat at (within a line of) its bottom, arming the layout effect
  // below to pin it there once the field grows. A body the user scrolled up
  // from is left alone: scrolling away is the signal to keep reading the
  // choices, and the next keystroke must not yank them back (守卫).
  const bodyPinnedRef = useRef<boolean | null>(null)
  const captureBodyPin = (): void => {
    const surface = answerSurface.current
    bodyPinnedRef.current = surface === null
      ? null
      : surface.scrollHeight - surface.scrollTop - surface.clientHeight <= 8
  }
  // Every navigation write stays in bounds and drafts mirrors questions 1:1.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const question = questions[index]!
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const draft = drafts[index]!
  const hasOptions = (question.options?.length ?? 0) > 0
  // Folded long-content attachment; the opener exists only where a Sidebar is reachable.
  const attachment = question.attachment
  // CSS decides which copy is clipped; only the user's expansions are state,
  // and they apply only while their question is the one shown.
  const [expandedCopy, setExpandedCopy] = useState<ExpandedCopy>({ index, copies: NOTHING_EXPANDED })
  const expanded = expandedCopy.index === index ? expandedCopy.copies : NOTHING_EXPANDED

  const questionToggleLabel = t(expanded.has('question') ? 'text.collapse' : 'text.expand')

  const toggleCopy = (copy: 'question' | number): void => {
    const copies = new Set(expanded)
    if (!copies.delete(copy)) copies.add(copy)
    setExpandedCopy({ index, copies })
  }

  const replaceProgress = (nextIndex: number, nextDrafts: QuestionDraftAnswer[]): void => {
    if (nextIndex !== index) {
      // Another question starts at its top with its long copy collapsed.
      if (answerSurface.current !== null) answerSurface.current.scrollTop = 0
      setExpandedCopy({ index: nextIndex, copies: NOTHING_EXPANDED })
    }
    actions.replace(pending.key, {
      index: nextIndex,
      drafts: nextDrafts,
      ...(waitDisposition.current === undefined ? {} : { wait: waitDisposition.current }),
      // The remark rides every navigation write so no page turn drops it.
      ...(note === '' ? {} : { note }),
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

  // FORK dsh-local (ask-keys-focus, 2026-11-17 裁定 A2, supersedes
  // occlusion-fold): attention leaving the card — a pointerdown or focusin
  // that lands anywhere outside the frame — folds the open card to its header
  // strip so the transcript reclaims the space. There is no viewport-share
  // gate anymore: the fold is edge-triggered on the gesture, not
  // level-triggered on focus, so a freshly presented question that never held
  // the keyboard (an options card autofocuses nothing) stays up until someone
  // actually reaches outside it. Any engagement back inside (the frame's own
  // focus handler below) unfolds it again. A busy submission keeps its card.
  useEffect(() => {
    if (collapsed || busy !== null) return
    const frame = frameRef.current
    if (frame === null) return
    const outside = (target: EventTarget | null): boolean =>
      target instanceof Element && !frame.contains(target)
    const onGesture = (event: Event): void => {
      if (outside(event.target)) setAutoFolded(true)
    }
    document.addEventListener('pointerdown', onGesture, true)
    document.addEventListener('focusin', onGesture, true)
    return () => {
      document.removeEventListener('pointerdown', onGesture, true)
      document.removeEventListener('focusin', onGesture, true)
    }
  }, [collapsed, busy])

  // Unfold paths: focus entering the card, or a press on the header strip of
  // an auto-folded card. Buttons are excluded — the close action must not
  // flash the card open on its way out.
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
  // (a single-select draft keeps its selection beside the insert, as
  // `draftCustom` does), captures the body pin before the insert grows the
  // field, and parks the caret behind the insert for the layout effect below
  // to restore. `keep` (chained completion) has no answer-field meaning and
  // is ignored.
  useEffect(() => {
    insertRef.current = (text, span) => {
      if (span.draftRev !== revRef.current) return false
      const el = textRef.current
      if (el === null || el.disabled) return false
      const current = el.value
      if (span.start < 0 || span.start > span.end || span.end > current.length) return false
      const next = current.slice(0, span.start) + text + current.slice(span.end)
      if (next === current) return true
      captureBodyPin()
      updateDraft(item => ({
        ...item,
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
    // FORK dsh-local (ask-deselect-1126, 2026-11-26 裁定 A): a single-select
    // pick is removable — clicking the option that is already picked clears it
    // (and stays on this question instead of stepping on). Any other pick keeps
    // replacing the selection, and custom keeps coexisting (2026-11-25 裁定 B
    // untouched). Multi-select already toggled, so it is out of this branch.
    const deselecting = question.multiSelect !== true
      && draft.selected.length === 1
      && draft.selected[0] === label
    updateDraft((current) => {
      if (question.multiSelect === true) {
        const selected = current.selected.includes(label)
          ? current.selected.filter(item => item !== label)
          : [...current.selected, label]
        return { ...current, selected, skipped: false }
      }
      // FORK dsh-local (ask-focus-restore-1125, 2026-11-25 裁定 B): a
      // single-select pick no longer clears a typed custom answer — selected
      // and custom coexist (the protocol always allowed both; multi-select
      // was already this shape).
      return { ...current, selected: deselecting ? [] : [label], skipped: false }
    }, !deselecting && question.multiSelect !== true && index < questions.length - 1 ? index + 1 : index)
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
          // FORK dsh-local (ask-focus-restore-1125, 2026-11-25 裁定 B): a
          // single-select answer keeps its selection alongside a typed custom
          // (the old exclusivity dropped `selected` whenever custom was set).
          selected: value.selected,
          ...(custom === '' ? {} : { custom }),
        }
      }),
      // FORK dsh-local (ask-focus-restore-1125, 2026-11-25 裁定 D): the
      // card-level remark rides the same submission; blank leaves it out.
      ...(note.trim() === '' ? {} : { note: note.trim() }),
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

  // Shared by the inline custom field and the optionless one: typing never
  // clears a selection — selected and custom coexist (2026-11-25 裁定 B,
  // both question shapes). The shared composer gesture pair decides (same
  // authority as the message input): Enter breaks a line through the
  // browser's own insertion; Shift/Ctrl+Enter continues the flow. The body
  // pin is captured before the growth lands (裁定 C).
  const draftCustom = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const value = event.target.value
    captureBodyPin()
    updateDraft(current => ({
      ...current,
      custom: value,
      skipped: false,
    }))
  }

  const continueFromCustom = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isComposing(event)) return
    const gesture = classifyComposerEnter(event)
    if (gesture === 'newline' || gesture === 'none') return
    event.preventDefault()
    continueFlow()
  }

  // The remark box's own seat (ask-focus-restore-1125 裁定 D): the same
  // composer gesture pair as the answer field — Enter breaks a line, Shift/
  // Ctrl+Enter continues the flow — but no trigger pipeline: the '/' menu
  // belongs to the answer surface, never to this box. The write goes through
  // its own store call because the note value differs from the render's.
  const updateNote = (value: string): void => {
    engage()
    captureBodyPin()
    actions.replace(pending.key, {
      index,
      drafts,
      ...(waitDisposition.current === undefined ? {} : { wait: waitDisposition.current }),
      ...(value === '' ? {} : { note: value }),
    })
    setError(null)
  }

  const toggleNote = (): void => {
    if (!noteOpen) noteFocusRef.current = true
    setNoteOpen(open => !open)
  }

  // Menu arbitration first: a key the open '/' menu claims (arrows, Escape,
  // Tab, or Enter settling the highlight) never reaches the flow's continue
  // gesture — a highlighted pick inserts its text instead of advancing.
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

  // FORK dsh-local (ask-keys-focus, 2026-11-17 裁定 A4): PageUp/PageDown walk
  // the questions from anywhere in the card — the keydown bubbles up from the
  // focused option, answer field, or the frame itself — through the same
  // motion the pager buttons use. Out of range is a plain no-op: the last
  // question's PageDown never submits (the flow advances through its own
  // gesture), a busy submission does not turn the page, a folded card has no
  // body to scroll, and IME composition keeps its keys. Only a page we
  // actually turn prevents the default scroll of the card body / page.
  //
  // FORK dsh-local (ask-ctrl-arrow-nav-1123): the same frame keydown also owns
  // the ring — Ctrl+↑/↓ walk the option rows and the answer field as parallel
  // seats, wrap in both directions, and claim the key only when a seat
  // actually takes focus (a locked card, a folded card, or a field with
  // nowhere to go leaves the key to the browser). The '/' menu's arbitration
  // runs first in the field's own handler: a key it claimed is already
  // defaultPrevented by the time it bubbles here, so the menu keeps priority.
  const frameKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      if (isComposing(event)) return
      if (collapsed || busy !== null) return
      const next = event.key === 'PageUp' ? index - 1 : index + 1
      if (next < 0 || next >= questions.length) return
      event.preventDefault()
      replaceProgress(next, drafts)
      setError(null)
      return
    }
    const ringKey = (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
    if (!ringKey) return
    if (isComposing(event)) return
    if (collapsed || busy !== null) return
    // The field's '/' arbitration ran first and claimed this key (open menu):
    // the menu keeps priority, the ring never sees a key it already prevented.
    if (event.defaultPrevented) return
    const frame = frameRef.current
    if (frame === null) return
    const rows = [...frame.querySelectorAll<HTMLElement>('[data-option-row]')]
    const field = frame.querySelector<HTMLTextAreaElement>('textarea')
    const seats = rows.length + (field === null ? 0 : 1)
    if (seats === 0) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const rowIndex = rows.findIndex(row => row.contains(target))
    // Off the ring (frame, pager, header): forward enters at the first seat,
    // backward enters at the last — the same wrap the ends use.
    const from = rowIndex >= 0 ? rowIndex : field !== null && field.contains(target) ? rows.length : -1
    const step = event.key === 'ArrowDown' ? 1 : -1
    const to = from < 0 ? (step > 0 ? 0 : seats - 1) : (from + step + seats) % seats
    const nextRow = to < rows.length ? rows[to] : undefined
    // Landing on the seat already holding focus (a one-seat ring) keeps the
    // key native: an optionless card has no ring to walk, so its field keeps
    // the browser's own paragraph jump.
    if (nextRow === undefined ? field === null || field.contains(document.activeElement) : nextRow.contains(document.activeElement)) return
    if (nextRow !== undefined) {
      const button = nextRow.querySelector<HTMLButtonElement>('button')
      if (button === null || button.disabled) return
      event.preventDefault()
      button.focus()
      return
    }
    if (field === null || field.disabled) return
    event.preventDefault()
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
    trackCaret()
  }

  // FORK dsh-local (ask-ctrl-arrow-nav-1123, supersedes ask-option-arrows-1118
  // bare-arrow walk): the option row keeps only the Tab path — Tab / Shift+Tab
  // leave the option list in one press by skipping the option buttons to the
  // nearest other control — while a bare ↑/↓ is claimed for nothing but the
  // page scroll: focus never moves off the row (the ring is Ctrl+↑/↓ at the
  // frame level now, and the answer field keeps its own bare arrows for the
  // caret plus the '/' arbitration). Modified keys, IME composition, and a
  // folded-away body stay native; a locked card still suppresses the scroll
  // but has no enabled seat to hand focus to, so focus stays put.
  const optionRowKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isComposing(event)) return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Tab') return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (event.key === 'Tab') {
      const frame = frameRef.current
      if (frame === null) return
      const focusables = [...frame.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), a[href]')]
      const from = focusables.indexOf(target)
      if (from < 0) return
      const step = event.shiftKey ? -1 : 1
      let landing: HTMLElement | undefined
      for (let cursor = from + step; cursor >= 0 && cursor < focusables.length; cursor += step) {
        const candidate = focusables[cursor]
        if (candidate === undefined || candidate.matches('[role="radio"], [role="checkbox"]')) continue
        landing = candidate
        break
      }
      if (landing === undefined) return
      event.preventDefault()
      landing.focus()
      return
    }
    if (event.shiftKey) return
    event.preventDefault()
  }

  // FORK dsh-local (ask-keys-focus, 2026-11-17 裁定 A5): when the page moves
  // under the keyboard — a single-select choice auto-advancing, or any other
  // index change — and the option that held focus unmounted with it, focus
  // falls to the body; hand it back to the new question so a run of Enter
  // keeps flowing. Focus that stayed on a real element (pager button, answer
  // field, the frame itself) is left alone, and the in-card lease keeps a
  // card that never held focus from grabbing it.
  // FORK dsh-local (ask-ctrl-arrow-nav-1123, 裁定 q-pagefocus 已选中项优先):
  // the landing is the question's FIRST SELECTED option — drafts and their
  // selections survive the page turn, so returning to a question restores the
  // keyboard to the choice that was already made instead of the first row
  // (which read as "my previous choice was forgotten"). No selection, or a
  // locked card (busy/review) whose options are disabled, falls back to the
  // first enabled option exactly as before; a multi-select lands on its
  // first checked option in document order.
  useLayoutEffect(() => {
    if (!focusInCard.current || collapsed) return
    const active = document.activeElement
    if (active !== null && active !== document.body) return
    const frame = frameRef.current
    if (frame === null) return
    const options = [...frame.querySelectorAll<HTMLButtonElement>('[data-option-row] button[aria-checked]')]
    const selected = options.find(button => button.getAttribute('aria-checked') === 'true' && !button.disabled)
    const landing = selected
      ?? frame.querySelector<HTMLButtonElement>('[data-option-row] button:not([disabled])')
    landing?.focus()
  }, [index, collapsed])

  // FORK dsh-local (ask-focus-restore-1125, 2026-11-25 裁定 A): the fold
  // unmounts the card body, so a field with content loses its caret and both
  // scroll positions on the way down. Content-gated restore ladder on
  // re-entry: when the card unfolds over a non-empty draft, focus lands back
  // in the answer field at the END of the text, the body scrollport sits at
  // its bottom, and the field's own scroll sits at its bottom — writing
  // resumes where it stopped. An empty field keeps the original landing (the
  // remembered option or the frame): there is nothing to resume. The ladder
  // runs only on a fold→unfold transition; page turns keep their own
  // scroll-to-top in `replaceProgress` and stay untouched here. Declared
  // after the focus-follow effect so its landing wins when both apply.
  const wasCollapsedRef = useRef(autoFolded)
  useLayoutEffect(() => {
    const reentered = wasCollapsedRef.current && !collapsed
    wasCollapsedRef.current = collapsed
    if (!reentered || draft.custom === '') return
    const field = textRef.current
    if (field !== null && !field.disabled) {
      field.focus()
      field.setSelectionRange(field.value.length, field.value.length)
    }
    const surface = answerSurface.current
    if (surface !== null) surface.scrollTop = surface.scrollHeight
    if (field !== null) field.scrollTop = field.scrollHeight
  }, [collapsed, draft.custom])

  // FORK dsh-local (ask-focus-restore-1125, 2026-11-25 裁定 C): after the
  // field grows, pin the body scrollport to its bottom when it sat at its
  // bottom before this keystroke — a long answer then pushes its choices out
  // of view as it grows instead of scrolling itself in a six-line well. Only
  // the capture taken on the keystroke arms the pin: a body the user scrolled
  // up from (or a page turn that reset it to its top) never gets yanked back.
  useLayoutEffect(() => {
    const pinned = bodyPinnedRef.current
    bodyPinnedRef.current = null
    if (pinned !== true) return
    const surface = answerSurface.current
    if (surface !== null) surface.scrollTop = surface.scrollHeight
  }, [draft.custom])

  // Opening the remark box from the footer seats the keyboard in it on the
  // render that mounts it (the box does not exist at click time). A fold
  // leaves `noteOpen` untouched, so re-entry never re-runs this — the
  // fold-reentry ladder above keeps owning re-entry focus.
  useLayoutEffect(() => {
    if (!noteFocusRef.current) return
    noteFocusRef.current = false
    noteRef.current?.focus()
  }, [noteOpen])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      data-question-key={pending.key}
      data-composer-card=""
      data-question-folded={autoFolded ? '' : undefined}
      // Focus containment (FORK occlusion-fold focus-escape, 2026-10-26
      // sensor / found 2026-11-12): the frame takes click-focus (tabindex -1,
      // the same pattern the InputBar card uses) so a press on the card's
      // non-focusable copy — question title, option prose, markdown detail —
      // keeps focus HERE. Without it Chrome hands that focus to the nearest
      // focusable ancestor, the transcript scrollport (tabIndex 0), and the
      // attention sensor's focusin leg below reads it as leaving the card:
      // pressing the long text to read/select it would fold the card under
      // the reader's cursor (observed as "the long text toggles itself").
      tabIndex={-1}
      // Any engagement inside the card lifts an auto-fold; focus here also
      // records the in-card lease the focus-follow effect reads.
      onFocus={() => {
        focusInCard.current = true
        if (autoFolded) setAutoFolded(false)
      }}
      // The lease ends only when focus moves to a real element outside: a
      // focus that fell to the body (the focused option unmounted) keeps it,
      // which is exactly when the focus-follow effect needs it.
      onBlur={(event) => {
        if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) focusInCard.current = false
      }}
      onKeyDown={frameKeyDown}
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
          {/* FORK occlusion-fold-1026: upstream (0.2.2 keep-long-questions-answerable)
              moved the title into the body while expanded and keeps it in the strip
              only while minimized; here the auto-fold shows the same strip, so the
              title rides `collapsed` — and the section's aria-labelledby keeps
              resolving while folded. */}
          {(question.header !== undefined || collapsed) && (
            <div className={css.headingBlock}>
              {question.header !== undefined && <div className={css.eyebrow}>{question.header}</div>}
              {collapsed && (
                <h2 className={css.title} id={`question-${pending.key}-${String(index)}`}>
                  {question.question}
                </h2>
              )}
            </div>
          )}
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
              <div className={css.questionTitle} data-expanded={expanded.has('question') || undefined}>
                <h2
                  className={clsx(css.title, css.titlePreview)}
                  id={`question-${pending.key}-${String(index)}`}
                >
                  {question.question}
                </h2>
                <Tooltip label={questionToggleLabel} side="top" portal>
                  <button
                    type="button"
                    className={clsx(css.iconButton, css.copyToggle, css.questionToggle)}
                    aria-label={questionToggleLabel}
                    aria-expanded={expanded.has('question')}
                    aria-controls={`question-${pending.key}-${String(index)}`}
                    aria-describedby={`question-${pending.key}-${String(index)}`}
                    onClick={() => { toggleCopy('question') }}
                  >
                    {expanded.has('question') ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
                  </button>
                </Tooltip>
              </div>
              {question.detail !== undefined && (
                <div className={css.detail}><MarkdownText text={question.detail} labels={markdownLabels} /></div>
              )}
              {attachment !== undefined && (
                <div className={css.attachment}>
                  <span className={css.attachmentText}>{t('attachment.folded', { chars: attachment.chars })}</span>
                  {openAttachment !== undefined
                    ? (
                      <Button variant="outline" onClick={() => { openAttachment(attachment.path) }}>
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
                  const hasDescription = option.description !== undefined && option.description.trim() !== ''
                  const descriptionExpanded = expanded.has(optionIndex)
                  const descriptionToggleLabel = t(descriptionExpanded ? 'text.collapse' : 'text.expand')
                  const descriptionId = `${descriptionIdPrefix}-question-${String(index)}-option-${String(optionIndex)}-description`
                  return (
                    <div
                      key={`${option.label}-${String(optionIndex)}`}
                      className={clsx(
                        css.optionRow,
                        !locked && css.optionRowInteractive,
                        // ask-highlight-contrast-1127: multi-select picks were
                        // excluded here, leaving them aria-only and invisible.
                        selected && css.optionSelected,
                      )}
                      data-option-row
                      data-expanded={descriptionExpanded || undefined}
                      onKeyDown={optionRowKeyDown}
                    >
                      <button
                        type="button"
                        className={css.option}
                        role={question.multiSelect === true ? 'checkbox' : 'radio'}
                        aria-checked={selected}
                        aria-label={display.label}
                        aria-describedby={hasDescription ? descriptionId : undefined}
                        disabled={locked}
                        onClick={() => { choose(option.label) }}
                        onKeyDown={(event) => {
                          // FORK dsh-local (ask-keys-focus, 2026-11-17 裁定 A3):
                          // an option's Enter is the shared composer gesture pair,
                          // no longer an any-Enter submit hijack. Bare Enter stays
                          // unprevented so the button's own activation runs
                          // `choose()` (single-select selects and steps on;
                          // multi-select toggles); Shift/Ctrl+Enter is claimed for
                          // the flow (next question, or the batch submit on the
                          // last). IME composition keeps Enter to the IME. Space
                          // is untouched and reaches the same native activation.
                          if (isComposing(event)) return
                          const gesture = classifyComposerEnter(event)
                          if (gesture !== 'submit' && gesture !== 'accelerated') return
                          event.preventDefault()
                          continueFlow()
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
                          <span className={css.optionLine} data-option-line>
                            <span className={css.optionLabel}>{display.label}</span>
                            {display.recommended && (
                              <span className={css.badge}>{t('option.recommended')}</span>
                            )}
                          </span>
                          {hasDescription && (
                            <span id={descriptionId} className={css.description} data-option-description>
                              {option.description}
                            </span>
                          )}
                        </span>
                      </button>
                      {hasDescription && (
                        <Tooltip label={descriptionToggleLabel} side="top" portal>
                          <button
                            type="button"
                            className={clsx(css.iconButton, css.copyToggle, css.descriptionToggle)}
                            aria-label={descriptionToggleLabel}
                            aria-expanded={descriptionExpanded}
                            aria-controls={descriptionId}
                            aria-describedby={descriptionId}
                            onClick={() => { toggleCopy(optionIndex) }}
                          >
                            {descriptionExpanded ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
                          </button>
                        </Tooltip>
                      )}
                    </div>
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

              {/* FORK dsh-local (ask-focus-restore-1125, 2026-11-25 裁定 D):
                  the card-level remark box (题外话): free text that belongs to
                  no single question, opened from the footer toggle and kept
                  across pages in the progress record. Closed it takes no
                  space; a review card has nothing to add. */}
              {review === undefined && noteOpen && (
                <div className={css.noteRow} data-question-note="">
                  <AnswerField
                    variant="inline"
                    value={note}
                    disabled={locked}
                    placeholder={t('note.placeholder')}
                    textRef={noteRef}
                    onChange={(event) => { updateNote(event.target.value) }}
                    // Same gesture pair as the answer field; one shared
                    // handler keeps the pair single-sourced.
                    onKeyDown={continueFromCustom}
                  />
                </div>
              )}
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
                  {/* FORK dsh-local (ask-focus-restore-1125, 裁定 D): the
                      题外话 open/close toggle — the box itself takes no space
                      while closed and empty. */}
                  <Button
                    variant="outline"
                    aria-pressed={noteOpen}
                    disabled={busy !== null}
                    onClick={toggleNote}
                  >
                    {t('note.toggle')}
                  </Button>
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
