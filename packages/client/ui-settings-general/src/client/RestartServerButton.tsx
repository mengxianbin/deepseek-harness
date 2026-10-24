/** Restart-server control beside the settings trigger, with its confirm dialog. */
import { useState } from 'react'
import { Button, IconRefreshOutlineMedium, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { RESTART_PATH } from '../restart.ts'
import css from './RestartServerButton.module.css'

/** Copy seat plus the page's restart capability as plain data (no sources). */
export type RestartServerButtonProps = PropsLocale<'settings'> & {
  /** Whether the Host configured a restart command for this page. */
  configured: boolean
  /** Sessions currently running, named in the confirmation copy. */
  runningSessions: number
  /** Expanded sidebar column — the collapsed rail row has no room for the control. */
  wide: boolean
}

/**
 * Small icon button beside the settings trigger: hidden while the Host announced
 * no restart command (or the rail column is collapsed), it confirms through a
 * dialog, dispatches `POST /api/restart` same-origin, and reports the outcome as
 * one static line — the page's existing reconnect machinery absorbs the restart.
 * @param props - localized copy and the page's restart capability as plain data.
 * @returns the control with its dialog; nothing while unavailable or collapsed.
 */
export function RestartServerButton({ t, configured, runningSessions, wide }: RestartServerButtonProps) {
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<'idle' | 'accepted' | 'failed'>('idle')
  if (!wide || !configured) return null

  const openConfirm = (): void => {
    setResult('idle')
    setConfirming(true)
  }
  const closeConfirm = (): void => { setConfirming(false) }
  const dispatch = (): void => {
    setConfirming(false)
    fetch(RESTART_PATH, { method: 'POST' })
      .then((response) => { setResult(response.ok ? 'accepted' : 'failed') })
      .catch(() => { setResult('failed') })
  }
  const description = runningSessions === 0
    ? t('restart.confirm.description.zero')
    : t('restart.confirm.description.some', { n: runningSessions })

  return (
    <>
      <button type="button" className={css.restart} aria-label={t('restart.button')} onClick={openConfirm}>
        <IconRefreshOutlineMedium size={16} />
      </button>
      {result !== 'idle' && (
        <span className={css.notice} role={result === 'failed' ? 'alert' : 'status'}>
          {result === 'accepted' ? t('restart.accepted') : t('restart.failed')}
        </span>
      )}
      <Modal
        open={confirming}
        title={t('restart.confirm.title')}
        description={description}
        closeLabel={t('restart.confirm.cancel')}
        onClose={closeConfirm}
        footer={(
          <>
            <Button variant="outline" onClick={closeConfirm}>{t('restart.confirm.cancel')}</Button>
            <Button variant="primary" data-modal-autofocus onClick={dispatch}>{t('restart.confirm.confirm')}</Button>
          </>
        )}
      />
    </>
  )
}
