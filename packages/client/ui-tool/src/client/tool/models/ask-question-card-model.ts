/** Pure ask-user transcript card data shared by its presenter and renderer. @module */

/** One offered option, marked with whether the recorded answer chose it. */
export interface QuestionCardOption {
  label: string
  /** The asker's own copy for this option; absent when it offered none. */
  description?: string
  /** Whether the recorded answer selected this option. */
  selected: boolean
}

/** One answered question as the transcript card renders it. */
export interface AnsweredQuestionCardItem {
  id: string
  question: string
  answers: readonly string[]
  /** Every option the asker offered, so unchosen choices stay readable too. */
  options: readonly QuestionCardOption[]
}

/** One question still awaiting an answer on the transcript card. */
export interface UnansweredQuestionCardItem {
  id: string
  question: string
  /** Every option the asker offered; none is selected before an answer lands. */
  options: readonly QuestionCardOption[]
}

/** Validated, localized data rendered by the ask-user transcript card. */
export type AskQuestionCardModel =
  | {
    kind: 'answered'
    questions: readonly AnsweredQuestionCardItem[]
    skippedLabel: string
    /**
     * The card-level remark (题外话, ask-focus-restore-1125 裁定 D) the answer
     * carried, with its localized label; absent when none was given or the
     * record predates the field.
     */
    note?: { label: string; text: string }
  }
  | {
    kind: 'unanswered'
    questions: readonly UnansweredQuestionCardItem[]
    verdict: string
  }
