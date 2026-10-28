/** Terminal full-page notice after the cookie heartbeat reports an expired browser session. */
import { createPortal } from 'react-dom'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'shell.overlay' entry).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import css from './AuthExpiredOverlay.module.css'

/** Registrant-private face: this page's one-way auth-expiry latch. */
export type AuthExpiredOverlayInjected = {
  hooks: {
    /** Moves false → true once, when the connection heartbeat reports the expired cookie. */
    authExpired: HostObservable<boolean>
  }
}

/** Overlay props: the root overlay owner share, the `settings` copy, and the injected face. */
export type AuthExpiredOverlayProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<'settings'> & InjectFace<AuthExpiredOverlayInjected>

/**
 * Cover the whole page once the heartbeat proves the cookie is gone: an
 * expired session cannot reconnect, so the notice replaces the app instead of
 * joining its silent retry spinner. Body-ported above the dialog and toast
 * stacks, because every layer below it talks to a Host this page can no longer
 * reach.
 * @param props - The expiry latch and the localized copy.
 * @returns Nothing while the session is alive; otherwise the full-page alert.
 */
export function AuthExpiredOverlay({ useAuthExpired, t }: AuthExpiredOverlayProps) {
  const expired = useAuthExpired(value => value)
  if (!expired) return null
  return createPortal((
    <div className={css.overlay} role="alert">
      <div className={css.card}>
        <p className={css.title}>{t('authExpired.title')}</p>
        <p className={css.hint}>{t('authExpired.hint')}</p>
      </div>
    </div>
  ), document.body)
}
