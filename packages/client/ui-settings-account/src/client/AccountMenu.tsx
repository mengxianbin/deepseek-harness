/** Sidebar settings launcher and the account surfaces that ride behind it. */
import { useEffect, useRef, useState } from 'react'
import { IconSettingsOutlineMedium, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountSectionInjected } from './AccountSection.tsx'
import { SignInDialog } from './SignInDialog.tsx'
import { AccountNoticeStack } from './AccountNotice.tsx'
import css from './AccountMenu.module.css'

/** Account launcher composed by the settings shell. */
export type AccountMenuProps = PropsRuntime<'settings.launcher'> & PropsLocale<'settings.account'> & InjectFace<AccountSectionInjected>

/**
 * FORK dsh-local (settings-launcher, 2026-10-21): the sidebar launcher is no
 * longer the account "More" menu — it IS the settings button that menu opened
 * as its first row: the gear glyph opens the panel on one click
 * (aria-haspopup=dialog, the shell-owned shortcut rides the button and its
 * tooltip), and the menu's remaining entries (feedback, sign-in, sign-out)
 * leave the sidebar with the menu. The account side effects this seat
 * hosts — the bonus notice stack, the credential toasts, the shared sign-in
 * dialog, and the refresh on a Settings entry — stay put.
 * FORK dsh-local (sidebar-footer-ui-1026, 2026-10-26): the wide column drops
 * the visible 设置/Settings label — the gear is icon-only; the accessible
 * name and the hover tooltip keep the copy.
 * @param props - sidebar geometry, settings navigation and account operations.
 * @returns the settings trigger plus the account dialogs and notices behind it.
 */
export function AccountMenu({
  subscribeSessionExpired, subscribeModelSignInRequired, wide, settingsShortcut, openSettings, openOnboarding, settingsOpen,
  useAccount, useTheme, refreshAccount, bonusNoticeShown, bonusNoticeDismissed,
  showLogin, start, cancel, t,
}: AccountMenuProps) {
  const anchor = useRef<HTMLDivElement>(null)
  // The launcher outlives the panel, so a false-to-true edge is one Settings entry:
  // re-renders, section switches and tab switches inside one open must not read again.
  const settingsWasOpen = useRef(false)
  useEffect(() => {
    if (settingsOpen && !settingsWasOpen.current) void refreshAccount()
    settingsWasOpen.current = settingsOpen
  }, [refreshAccount, settingsOpen])
  const account = useAccount(state => state)
  const colorScheme = useTheme(snapshot => snapshot.active.colorScheme)
  const signedIn = account.view?.status === 'credential-stored'
  const [signInNotice, setSignInNotice] = useState(0)
  useEffect(() => subscribeModelSignInRequired?.(() => { setSignInNotice(value => value + 1) }), [subscribeModelSignInRequired])
  const [expiryNotice, setExpiryNotice] = useState(false)
  useEffect(() => subscribeSessionExpired?.(() => { setExpiryNotice(true) }), [subscribeSessionExpired])
  return <div ref={anchor} className={css.root}>
    {signInNotice > 0 && <Toast key={signInNotice} text={t('modelSignInRequired')} onDone={() => { setSignInNotice(0) }} />}
    {expiryNotice && <Toast text={t('sessionExpired')} onDone={() => { setExpiryNotice(false) }} />}
    {signedIn && !account.desktopOnboardingVisible && !account.onboarding && account.notices && <AccountNoticeStack
      notices={account.notices}
      anchor={anchor} title={t('bonusNoticeTitle')} closeLabel={t('close')}
      onShown={bonusNoticeShown} onDismiss={bonusNoticeDismissed} />}
    <Tooltip label={t('settings')} shortcutKeys={settingsShortcut?.keys} delayMs={500} disabled={settingsOpen}>
      <button
        type="button"
        className={wide ? css.trigger : `${css.trigger} ${css.rail}`}
        aria-label={t('settings')}
        aria-keyshortcuts={settingsShortcut?.aria}
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        onClick={() => { openSettings() }}
      >
        <IconSettingsOutlineMedium size={wide ? 16 : 18} />
      </button>
    </Tooltip>
    {account.loginVisible && !account.onboarding && <SignInDialog account={account} colorScheme={colorScheme}
      start={start} cancel={cancel} t={t}
      close={() => { showLogin(false) }} useApiKey={() => { showLogin(false); openOnboarding('deepseek-official') }} />}
  </div>
}
