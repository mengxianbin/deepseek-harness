/**
 * Native answer surface for an intent-less question batch (甲-a, ask-panel-retire-1127).
 *
 * The question text lives in the AI's conversation message (the "问句一行"
 * rule); this takeover keeps only a one-line hint, an auto-growing native
 * textarea, and the submit/skip row — no option tabs, no pager, no record
 * card. The mechanism is unchanged: the composer seat, the draft store, the
 * wait/countdown semantics, the `/` trigger pipeline, and `pending.answer()`
 * all ride the same carrier the generic flow used.
 *
 * Batch assembly (BAD_ANSWER: one entry per question, exactly once):
 * a single question's text fills its `custom`; a multi-question batch carries
 * the text as the batch-level `note` with one empty entry per question.
 */
import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ChangeEvent, type FocusEvent, type KeyboardEvent,
} from 'react'
import { Button, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { classifyComposerEnter } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { ArbitrateKey } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AnswerSurfaceInsert } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { QuestionAnswer, QuestionCardSnapshot, QuestionComposerProps } from './contract/slots.ts'
import type { PendingQuestion } from './contract/slots.ts'
import type { QuestionDraftAnswer, QuestionDraftProgress } from './draft-store.ts'
import { AnswerField, isComposing } from './AnswerField.tsx'
import css from './QuestionComposer.module.css'

/** Displayed feedback: dictionary keys translate at render; wire strings pass through. */
type Feedback = { key: 'error.incomplete' | 'error.unavailable' | 'error.resubmit' | 'status.sent' } | { text: string }

/** A removed card can remain mounted until the composer seat updates. */
const REMOVED_CARD: QuestionCardSnapshot = {
  state: 'open', waitState: 'counting', countdown: undefined, channel: 'none', closed: true,
}

/**
 * Text-field keys the open trigger menu may claim, keyed by KeyboardEvent.key
 * and resolved to the pipeline's arbitration vocabulary.
 */
const ARBITRATE_KEYS: Record<string, ArbitrateKey> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  Enter: 'enter',
  Escape: 'escape',
  Tab: 'tab',
}

/** Accept persisted progress only when it still describes this question batch. */
function isQuestionDraftProgress(value: unknown, questionCount: number): value is QuestionDraftProgress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const progress = value as Record<string, unknown>
  if (typeof progress.index !== 'number' || !Number.isInteger(progress.index)
    || progress.index < 0 || progress.index >= questionCount
    || !Array.isArray(progress.drafts) || progress.drafts.length !== questionCount
    || (progress.wait !== undefined && progress.wait !== 'editing' && progress.wait !== 'waiting')
    || (progress.note !== undefined && typeof progress.note !== 'string')) return false
  return progress.drafts.every((item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
    const draft = item as Record<string, unknown>
    return Array.isArray(draft.selected) && draft.selected.every((label: unknown) => typeof label === 'string')
      && typeof draft.custom === 'string' && typeof draft.skipped === 'boolean'
  })
}

type QuestionInputProps =
  { pending: PendingQuestion }
  & Pick<QuestionComposerProps,
    't' | 'useStore' | 'useQuestionCard' | 'actions' | 'renderSlot' | 'answerTriggers' | 'openAttachment'>

/**
 * Render the native answer takeover for one pending request.
 * @param props - the selector-matched pending carrier plus its slot kit.
 * @returns the one-line hint, the native input, and the submit row.
 */
export function QuestionInput(props: QuestionInputProps) {
  const { pending, t, useStore, useQuestionCard, actions, renderSlot, answerTriggers, openAttachment } = props
  const questions = pending.questions
  // One line of hint: the batch's question stems, the conversation message
  // above carrying the full text (问句一行 rule).
  const hint = useMemo(() => questions.map(item => item.question).join(' · '), [questions])
  // Folded long-content attachments of this batch, flattened for the chip row.
  const attachments = useMemo(() => questions.flatMap(item => item.attachment === undefined
    ? []
    : [{ id: item.id, path: item.attachment.path, chars: item.attachment.chars }]), [questions])
  const initialDrafts = useMemo<QuestionDraftAnswer[]>(
    () => questions.map(() => ({ selected: [], custom: '', skipped: false })),
    [questions],
  )
  const stored = useStore(state => state.progressByRequest[pending.key])
  const validStored = isQuestionDraftProgress(stored, questions.length) ? stored : undefined
  // The typed answer lives in the first draft slot; a batch submit lifts it
  // into the batch note, a single-question submit into that question's custom.
  const text = validStored?.drafts[0]?.custom ?? ''
  const [busy, setBusy] = useState<'answer' | 'cancel' | null>(null)
  const [error, setError] = useState<Feedback | null>(null)
  const card = useQuestionCard(pending.key, snapshot => snapshot ?? REMOVED_CARD)
  const canSubmit = card.channel !== 'none'
  const locked = busy !== null
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
  const waitDisposition = useRef<'editing' | 'waiting' | undefined>(
    validStored?.wait ?? (text !== '' ? 'editing' : undefined),
  )
  useEffect(() => {
    if (waitDisposition.current === 'waiting') pending.takeTime()
    if (waitDisposition.current === 'editing') pending.engage()
  }, [pending])
  const countdown = card.countdown
  // Focus lease: a focused answer surface freezes a pristine countdown.
  const answerSurface = useRef<HTMLDivElement>(null)
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
  // Trigger-pipeline wiring for the native answer field: same feed shape the
  // generic flow used (insert target / content revision / tracked text).
  const textRef = useRef<HTMLTextAreaElement>(null)
  const revRef = useRef(0)
  const lastTrackedRef = useRef<string | null>(null)
  const pendingCaretRef = useRef<number | null>(null)
  const insertRef = useRef<AnswerSurfaceInsert>(() => false)
  // Body pin: capture before a keystroke grows the field, restore after it.
  const bodyPinnedRef = useRef<boolean | null>(null)
  const captureBodyPin = (): void => {
    const surface = answerSurface.current
    bodyPinnedRef.current = surface === null
      ? null
      : surface.scrollHeight - surface.scrollTop - surface.clientHeight <= 8
  }
  const replaceProgress = (nextText: string): void => {
    const nextDrafts = initialDrafts.map((item, itemIndex) => itemIndex === 0
      ? { ...item, custom: nextText, skipped: false }
      : item)
    actions.replace(pending.key, {
      index: 0,
      drafts: nextDrafts,
      ...(waitDisposition.current === undefined ? {} : { wait: waitDisposition.current }),
    })
  }
  const engage = (): void => {
    if (waitDisposition.current !== undefined) return
    waitDisposition.current = 'editing'
    pending.engage()
  }
  const draftText = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const value = event.target.value
    engage()
    captureBodyPin()
    replaceProgress(value)
    setError(null)
  }
  useEffect(() => {
    insertRef.current = (insertText, span) => {
      if (span.draftRev !== revRef.current) return false
      const el = textRef.current
      if (el === null || el.disabled) return false
      const current = el.value
      if (span.start < 0 || span.start > span.end || span.end > current.length) return false
      const next = current.slice(0, span.start) + insertText + current.slice(span.end)
      if (next === current) return true
      engage()
      captureBodyPin()
      replaceProgress(next)
      pendingCaretRef.current = span.start + insertText.length
      return true
    }
  })
  // Surface lease: while the field is mounted the pipeline runs on the answer
  // surface, so tracks from the hidden InputBar draft are ignored.
  useEffect(() => answerTriggers.attach((insertText, span, keep) => insertRef.current(insertText, span, keep)), [answerTriggers])
  useEffect(() => {
    const el = textRef.current
    const value = el === null ? text : el.value
    if (lastTrackedRef.current !== value) {
      revRef.current += 1
      lastTrackedRef.current = value
    }
    const caret = el === null ? value.length : el.selectionStart
    answerTriggers.track(value, caret, locked ? 'frozen' : 'plain', revRef.current)
  })
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current
    if (caret === null) return
    pendingCaretRef.current = null
    textRef.current?.setSelectionRange(caret, caret)
  })
  const trackCaret = (): void => {
    const el = textRef.current
    if (el === null) return
    answerTriggers.track(el.value, el.selectionStart, locked ? 'frozen' : 'plain', revRef.current)
  }
  useLayoutEffect(() => {
    const pinned = bodyPinnedRef.current
    bodyPinnedRef.current = null
    if (pinned !== true) return
    const surface = answerSurface.current
    if (surface !== null) surface.scrollTop = surface.scrollHeight
    const field = textRef.current
    if (field !== null) field.scrollTop = field.scrollHeight
  }, [text])

  const dismissFlow = (): void => {
    // A tool-call-keyed panel only leaves the seat; nothing is sent.
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

  const sendBatch = (answer: QuestionAnswer): void => {
    if (!canSubmit) {
      setError({ key: 'error.unavailable' })
      return
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

  const submit = (): void => {
    const trimmed = text.trim()
    if (trimmed === '') {
      setError({ key: 'error.incomplete' })
      return
    }
    // BAD_ANSWER: every question exactly once. A single question carries the
    // text as its `custom`; a batch lifts it to the batch-level `note` and
    // leaves one empty entry per question.
    const [first] = questions
    const answers = questions.length === 1 && first !== undefined
      ? [{ id: first.id, selected: [], custom: trimmed }]
      : questions.map(item => ({ id: item.id, selected: [] }))
    sendBatch({
      answers,
      ...(questions.length === 1 ? {} : { note: trimmed }),
    })
  }

  const skip = (): void => {
    sendBatch({ answers: questions.map(item => ({ id: item.id, selected: [] })) })
  }

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
    if (composing) return
    const gesture = classifyComposerEnter(event)
    if (gesture !== 'submit' && gesture !== 'accelerated') return
    event.preventDefault()
    submit()
  }

  return (
    <div
      className={css.frame}
      data-question-key={pending.key}
      data-composer-card=""
      data-question-native=""
    >
      {/* Floating slash-menu anchor for the answer field. */}
      <div className={css.triggerAnchor}>{renderSlot('conversation.composer.overlay', {})}</div>
      <section className={css.card} aria-labelledby={`question-${pending.key}-0`}>
        <header className={css.header}>
          {/* Spacer keeps the action cluster right-aligned (the retired card
              used to carry its title here; the stem lives in the hint below). */}
          <div className={css.headingBlock} />
          <div className={css.headerActions}>
            {countdown !== undefined && card.waitState !== 'waiting' && card.waitState !== 'editing' && card.waitState !== 'continued' && (
              <span className={css.waitStatus}>
                {t(countdown.running ? 'wait.countdown' : 'wait.paused', {
                  seconds: Math.ceil(countdown.remainingMs / 1000),
                })}
              </span>
            )}
            {countdown !== undefined && card.waitState !== 'waiting' && card.waitState !== 'editing' && card.waitState !== 'continued' && (
              <Button variant="outline" className={css.waitButton} onClick={() => {
                waitDisposition.current = 'waiting'
                pending.takeTime()
                replaceProgress(text)
              }}>
                {t('wait.takeTime')}
              </Button>
            )}
            {card.state === 'continued' && <span className={css.waitStatus}>{t('wait.continued')}</span>}
            {countdown !== undefined && (card.waitState === 'waiting' || card.waitState === 'editing') && (
              <span className={css.waitStatus}>{t('wait.held')}</span>
            )}
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

        <div
          ref={answerSurface}
          className={css.body}
          data-question-scroll
          onFocusCapture={focusAnswerSurface}
          onBlurCapture={blurAnswerSurface}
        >
          <div className={css.questionTitle}>
            <h2 className={css.hint} id={`question-${pending.key}-0`}>{hint}</h2>
          </div>
          {attachments.length > 0 && (
            <div className={css.attachment}>
              {attachments.map(item => (
                <span className={css.attachmentText} key={item.id}>
                  {t('attachment.folded', { chars: item.chars })}
                  {openAttachment !== undefined
                    ? (
                      <Button variant="outline" onClick={() => { openAttachment(item.path) }}>
                        {t('attachment.open')}
                      </Button>
                    )
                    : <span className={css.attachmentPath}>{item.path}</span>}
                </span>
              ))}
            </div>
          )}
          <AnswerField
            variant="block"
            value={text}
            disabled={locked}
            autoFocus={canSubmit && countdown === undefined && !locked}
            placeholder={t('custom.placeholder')}
            textRef={textRef}
            onFocus={trackCaret}
            onSelect={trackCaret}
            onChange={draftText}
            onKeyDown={answerKeyDown}
          />
        </div>

        <footer className={css.footer}>
          <div className={css.feedback} role="status">
            {error === null ? null : 'key' in error ? t(error.key) : error.text}
          </div>
          <div className={css.footerActions}>
            <Button variant="outline" disabled={locked} onClick={skip}>
              {t('action.skip')}
            </Button>
            <Button
              variant="primary"
              disabled={locked || text.trim() === '' || !canSubmit}
              onClick={submit}
            >
              {busy === 'answer' ? t('submitting') : t('submit')}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  )
}
