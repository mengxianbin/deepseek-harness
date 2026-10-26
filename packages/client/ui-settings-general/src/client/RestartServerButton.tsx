/** Restart-server control beside the settings trigger, with its confirm dialog and restart-signal badge. */
import { useState } from 'react'
import { Button, IconRefreshOutlineMedium, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { RESTART_PATH, type RestartSignalView } from '../restart.ts'
import css from './RestartServerButton.module.css'

/** Copy seat plus the page's restart capability as plain data (no sources). */
export type RestartServerButtonProps = PropsLocale<'settings'> & {
  /** Whether the Host configured a restart command for this page. */
  configured: boolean
  /** Sessions currently running, named in the confirmation copy. */
  runningSessions: number
  /** Expanded sidebar column — the collapsed rail row shows only the signal dot. */
  wide: boolean
  /** Latest restart-signal judgment; `undefined` before the first delivery renders nothing. */
  signal?: RestartSignalView | undefined
}

/**
 * The one next-step copy for a judgment; `OK` and the client-only
 * `CLIENT_UPDATED` state have no badge and never reach this function.
 * @param t - localized copy seat of the `settings` namespace.
 * @param signal - latest judgment.
 * @returns the single next-step line the badge and dot both carry.
 */
export function restartSignalCopy(t: PropsLocale<'settings'>['t'], signal: RestartSignalView): string {
  switch (signal.state) {
    case 'INIT': return t('restart.signal.init')
    case 'BUILDING': return t('restart.signal.building')
    case 'BUILD_FAILED': return t('restart.signal.buildFailed')
    case 'NEED_BUILD': return t('restart.signal.needBuild')
    case 'NEED_RESTART': return signal.reason === 'config'
      ? t('restart.signal.needRestart.config')
      : t('restart.signal.needRestart.built')
    /* v8 ignore next -- OK and CLIENT_UPDATED are filtered before the copy seat; the switch needs its total form. */
    default: return ''
  }
}

/** Whether a judgment wears the restart lamp at all. */
function lampLit(signal: RestartSignalView | undefined): signal is RestartSignalView {
  return signal !== undefined && signal.state !== 'OK' && signal.state !== 'CLIENT_UPDATED'
}

/**
 * Small icon button beside the settings trigger: hidden while the Host
 * announced no restart command, it confirms through a dialog, dispatches
 * `POST /api/restart` same-origin, and reports the outcome as one static
 * line — the page's existing reconnect machinery absorbs the restart.
 *
 * The restart-signal badge rides the same control: in the expanded column a
 * lit judgment (INIT/BUILDING/BUILD_FAILED/NEED_BUILD/NEED_RESTART) shows as
 * a dot-prefixed copy pill after the button; in the collapsed rail a lit
 * judgment shows as a standalone dot carrying the same copy as its accessible
 * name. `OK` and the client-only `CLIENT_UPDATED` state (F5/HMR territory,
 * design §二) render nothing.
 * @param props - localized copy, the page's restart capability, and the latest judgment as plain data.
 * @returns the control with its dialog and badge; nothing while unavailable.
 */
export function RestartServerButton({ t, configured, runningSessions, wide, signal }: RestartServerButtonProps) {
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<'idle' | 'accepted' | 'failed'>('idle')
  if (!configured) return null
  const lit = lampLit(signal)
  const copy = lit ? restartSignalCopy(t, signal) : ''
  if (!wide) {
    if (!lit) return null
    return (
      <span
        className={css.signalDot} role="status" aria-label={copy} title={copy}
        data-restart-signal={signal.state}
      />
    )
  }

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
      {lit && (
        <span className={css.signalBadge} role="status" data-restart-signal={signal.state}>
          <span className={css.signalBadgeDot} aria-hidden="true" />
          {copy}
        </span>
      )}
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
