/** Restart-server control beside the settings trigger, with its confirm dialog and restart-signal lamp. */
import { useState } from 'react'
import clsx from 'clsx'
import { Button, IconRefreshOutlineMedium, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { RESTART_PATH, type RestartSignalView } from '../restart.ts'
import css from './RestartServerButton.module.css'

/** Copy seat plus the page's restart capability as plain data (no sources). */
export type RestartServerButtonProps = PropsLocale<'settings'> & {
  /** Whether the Host configured a restart command for this page. */
  configured: boolean
  /** Sessions currently running, named in the confirmation copy. */
  runningSessions: number
  /** Expanded sidebar column — the collapsed rail renders the compact dot-button (FORK rail-restart-entry-1030). */
  wide: boolean
  /** Latest restart-signal judgment; `undefined` before the first delivery renders nothing. */
  signal?: RestartSignalView | undefined
}

/** Pad a clock component to two digits for the tooltip's `HH:mm` start stamp. */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * A running build's age as at most two localized levels — days+hours,
 * hours+minutes, minutes+seconds, seconds alone — assembled from the
 * elapsed-unit copy seats (build-timer-tooltip-1101).
 * @param t - localized copy seat of the `settings` namespace.
 * @param elapsedMs - non-negative milliseconds since the build started.
 * @returns the localized elapsed phrase, e.g. `37 分钟` / `1 h 5 min`.
 */
export function restartBuildElapsed(t: PropsLocale<'settings'>['t'], elapsedMs: number): string {
  const totalMinutes = Math.floor(elapsedMs / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const seconds = Math.floor((elapsedMs % 60_000) / 1000)
  const unit = (kind: 'sec' | 'min' | 'hour' | 'day', n: number): string =>
    t(`restart.signal.building.elapsed.${kind}`, { n })
  if (totalMinutes >= 24 * 60) {
    const days = Math.floor(hours / 24)
    const restHours = hours % 24
    return restHours === 0 ? unit('day', days) : `${unit('day', days)} ${unit('hour', restHours)}`
  }
  if (hours > 0) {
    return minutes === 0 ? unit('hour', hours) : `${unit('hour', hours)} ${unit('min', minutes)}`
  }
  if (totalMinutes > 0) {
    return seconds === 0 ? unit('min', totalMinutes) : `${unit('min', totalMinutes)} ${unit('sec', seconds)}`
  }
  return unit('sec', Math.max(seconds, 1))
}

/**
 * The one next-step copy for a judgment; `OK` and the client-only
 * `CLIENT_UPDATED` state have no lamp and never reach this function.
 * @param t - localized copy seat of the `settings` namespace.
 * @param signal - latest judgment.
 * @param now - current epoch milliseconds for the BUILDING elapsed age; the
 *   default keeps production callers (render-time) honest while tests pin it.
 * @returns the single next-step line the tooltip, confirm dialog, and rail dot all carry.
 */
export function restartSignalCopy(t: PropsLocale<'settings'>['t'], signal: RestartSignalView, now: number = Date.now()): string {
  switch (signal.state) {
    case 'INIT': return t('restart.signal.init')
    case 'BUILDING': return buildingSignalCopy(t, signal, now)
    case 'BUILD_FAILED': return t('restart.signal.buildFailed')
    case 'NEED_BUILD': return t('restart.signal.needBuild')
    case 'NEED_RESTART': return signal.reason === 'config'
      ? t('restart.signal.needRestart.config')
      : t('restart.signal.needRestart.built')
    /* v8 ignore next -- OK and CLIENT_UPDATED are filtered before the copy seat; the switch needs its total form. */
    default: return ''
  }
}

/**
 * The BUILDING line: the plain `Building…` copy while the Host delivered no
 * readable start time, otherwise `Building · HH:mm · <elapsed>` from it —
 * local clock, and the age clamped at zero so clock skew never prints a
 * negative (build-timer-tooltip-1101).
 * @param t - localized copy seat of the `settings` namespace.
 * @param signal - the BUILDING judgment.
 * @param now - current epoch milliseconds.
 * @returns the timer-tooltip line.
 */
function buildingSignalCopy(t: PropsLocale<'settings'>['t'], signal: RestartSignalView, now: number): string {
  if (signal.startedAt === undefined) return t('restart.signal.building')
  const started = Date.parse(signal.startedAt)
  if (!Number.isFinite(started)) return t('restart.signal.building')
  const start = new Date(started)
  const time = `${pad2(start.getHours())}:${pad2(start.getMinutes())}`
  const elapsed = restartBuildElapsed(t, Math.max(now - started, 0))
  return t('restart.signal.building.since', { time, elapsed })
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
 * The restart-signal lamp rides the same control (FORK dsh-local
 * sidebar-footer-ui-1026, 2026-10-26 — design §角标条款修订: the wide column
 * no longer prints a copy pill): a lit judgment (INIT/BUILDING/BUILD_FAILED/
 * NEED_BUILD/NEED_RESTART) lights the BUTTON itself, the hover/focus tooltip
 * carries the one next-step line, and the confirm dialog repeats it as its
 * first sentence; the collapsed rail renders the same control as a compact
 * dot-button — dark it is the refresh glyph, a lit judgment swaps in the
 * status dot — and a click there opens the identical confirm dialog, so a
 * restart is reachable without expanding the sidebar
 * (FORK rail-restart-entry-1030, 2026-10-30 用户选 A). `OK` and the
 * client-only `CLIENT_UPDATED` state (F5/HMR territory, design §二) render
 * nothing in both states.
 * @param props - localized copy, the page's restart capability, and the latest judgment as plain data.
 * @returns the control with its dialog and lamp; nothing while unavailable.
 */
export function RestartServerButton({ t, configured, runningSessions, wide, signal }: RestartServerButtonProps) {
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<'idle' | 'accepted' | 'failed' | 'busy'>('idle')
  if (!configured) return null
  const lit = lampLit(signal)
  const copy = lit ? restartSignalCopy(t, signal) : ''
  const openConfirm = (): void => {
    setResult('idle')
    setConfirming(true)
  }
  const closeConfirm = (): void => { setConfirming(false) }
  const dispatch = (): void => {
    setConfirming(false)
    fetch(RESTART_PATH, { method: 'POST' })
      .then((response) => {
        // 409 = in-flight claim refusal (D): another dispatch owns the slot —
        // report it honestly as "busy" instead of a fake success or a false failure.
        if (response.status === 409) { setResult('busy'); return }
        setResult(response.ok ? 'accepted' : 'failed')
      })
      .catch(() => { setResult('failed') })
  }
  const sessionsLine = runningSessions === 0
    ? t('restart.confirm.description.zero')
    : t('restart.confirm.description.some', { n: runningSessions })
  // The lit judgment leads the confirm copy (二级层同样显示重启原因).
  const description = lit ? `${copy} ${sessionsLine}` : sessionsLine
  // Lit: the button's accessible name and hover tooltip carry the reason;
  // dark: the plain control name.
  const label = lit ? copy : t('restart.button')

  return (
    <>
      <Tooltip label={label} delayMs={500} side={wide ? 'top' : 'right'}>
        <button
          type="button"
          className={clsx(css.restart, wide ? css.restartWide : css.restartRail, lit && css.restartLit)}
          aria-label={label}
          data-restart-signal={lit ? signal.state : undefined}
          onClick={openConfirm}
        >
          {wide || !lit
            ? <IconRefreshOutlineMedium size={wide ? 16 : 14} />
            : <span className={css.signalDot} aria-hidden="true" />}
        </button>
      </Tooltip>
      {result !== 'idle' && (
        <span className={css.notice} role={result === 'failed' ? 'alert' : 'status'}>
          {result === 'accepted' ? t('restart.accepted') : result === 'busy' ? t('restart.busy') : t('restart.failed')}
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
