/** Ask-user transcript rendering from validated plain card data. @module */
import type { AskQuestionCardModel, QuestionCardOption } from '../models/ask-question-card-model.ts'
import css from './AskQuestionCard.module.css'

/**
 * One question's offered options, with the chosen ones marked.
 * @param props - The offered options in asker order.
 * @returns the option list, or nothing when the asker offered no options.
 */
function OptionList({ options }: { options: readonly QuestionCardOption[] }) {
  if (options.length === 0) return null
  return (
    <ul className={css.optionList}>
      {options.map(option => (
        <li className={css.option} key={option.label} data-selected={option.selected || undefined}>
          <span className={css.optionMark} aria-hidden="true">{option.selected ? '✓' : '·'}</span>
          <span className={css.optionText}>
            <span className={css.optionLabel}>{option.label}</span>
            {option.description !== undefined && (
              <span className={css.optionDescription}>{option.description}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Render a validated ask-user transcript from plain card data.
 * @param props - Localized transcript card data.
 * @returns the readable answered or unanswered question list.
 */
export function AskQuestionCard({ card }: { card: AskQuestionCardModel }) {
  if (card.kind === 'unanswered') {
    return (
      <div className={css.card}>
        <p className={css.verdict}>{card.verdict}</p>
        <ul className={css.questionList}>
          {card.questions.map(question => (
            <li className={css.unansweredQuestion} key={question.id}>
              <span className={css.unansweredText}>{question.question}</span>
              <OptionList options={question.options} />
            </li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <dl className={css.card}>
      {card.questions.map(question => (
        <div className={css.item} key={question.id}>
          <dt className={css.question}>{question.question}</dt>
          {question.options.length > 0 && (
            <dd className={css.options}>
              <OptionList options={question.options} />
            </dd>
          )}
          <dd className={css.answer}>
            {question.answers.length === 0
              ? <span className={css.skipped}>{card.skippedLabel}</span>
              : question.answers.map((answer, index) => (
                <span className={css.answerLine} key={`${question.id}-${String(index)}`}>{answer}</span>
              ))}
          </dd>
        </div>
      ))}
    </dl>
  )
}
