import { IconPaperPlaneOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './FeedbackEntry.module.css'

/**
 * The account feature's share of the sidebar ⋯-menu seat
 * (FORK sidebar-foot-1027): the Feishu questionnaire row the account "More"
 * menu carried out of the sidebar when the launcher replaced it (FORK
 * dsh-local settings-launcher, 2026-10-21) — without it `contactUs()` kept
 * its operation and its context sampling but no mounted surface ever issued
 * the click. The row joins the same low-frequency seat the pairing and
 * remote-access rows moved into; the id doubles as the analytics
 * `menu_name` for `sidebar_more` clicks.
 *
 * The wide column renders it inside the ⋯ menu, where ui-sidebar's shared
 * `.moreActions [data-slot] button` rule paints the whole row (icon plus the
 * `aria-label` text drawn through `::after`) — this component therefore
 * renders the icon only. The collapsed rail has no ⋯ menu, so the local
 * stylesheet claims the `[data-wide='rail']` form as a foot icon beside the
 * sibling actions.
 */
export interface FeedbackEntryInjected {
  /** Opens the external support questionnaire with the account, build and environment sampled by this click. */
  contactUs: () => void
}

/** Props: the seat's column state, the injected questionnaire opener, and the dictionary translator. */
export type FeedbackEntryProps = FeedbackEntryInjected & PropsLocale<'settings.account'> & {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/**
 * Render the questionnaire trigger for the sidebar ⋯-menu seat (and its rail
 * form).
 * @param props - the seat's column state, the injected questionnaire opener and the dictionary translator.
 * @returns the trigger button; the questionnaire opens in a new browser tab on click.
 */
export function FeedbackEntry({ wide, contactUs, t }: FeedbackEntryProps) {
  const label = t('contactUs')
  return (
    <button
      type="button"
      className={css.trigger}
      data-wide={wide ? 'wide' : 'rail'}
      data-dsh-part="feedback-entry"
      aria-label={label}
      title={label}
      onClick={contactUs}
    >
      <IconPaperPlaneOutlineMedium size={16} />
    </button>
  )
}
