/**
 * Server start-time stamp in the settings trigger row (server-started-at-1117):
 * the wide column's glanceable `MM-DD HH:mm` beside the gear (no since-word —
 * the stamp itself stays, 2026-11-23 口径: 只去 since 文字), with the full
 * sentence + live elapsed age on hover — the honest answer to "did the server
 * actually restart". Renders nothing without a published instant (the store
 * clears on every reconnect until the fresh answer lands), and the settings
 * owner keeps it out of the collapsed rail.
 */
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { restartBuildElapsed } from './RestartServerButton.tsx'
import css from './ServerStartedAt.module.css'

/** Copy seat plus the published start instant as plain data (no sources). */
export type ServerStartedAtProps = PropsLocale<'settings'> & {
  /** Host process start instant (ISO 8601); `undefined` renders nothing. */
  startedAt?: string | undefined
}

/** Pad a clock component to two digits for the stamp's time parts. */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Render the start-time stamp: the visible short form `MM-DD HH:mm`, a
 * visually-hidden full sentence for assistive technology (static — it never
 * prints a stale elapsed), and a hover tooltip whose label resolves at show
 * time so the elapsed age is current however long the page sat.
 * @param props - localized copy seat plus the published start instant.
 * @returns the stamp element, or nothing while no instant is published.
 */
export function ServerStartedAt({ t, startedAt }: ServerStartedAtProps) {
  if (startedAt === undefined) return null
  const started = Date.parse(startedAt)
  // The wire validator refuses an unreadable instant already; this guard
  // keeps a damaged store from ever printing a broken time string.
  if (!Number.isFinite(started)) return null
  const date = new Date(started)
  const monthDay = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  const full = `${String(date.getFullYear())}-${monthDay} ${clock}:${pad2(date.getSeconds())}`
  const detail = (): string =>
    t('serverStart.detail', { full, elapsed: restartBuildElapsed(t, Math.max(Date.now() - started, 0)) })
  return (
    <Tooltip label={detail} delayMs={500} side="top">
      <span className={css.stamp} data-server-started-at={startedAt}>
        <span className={css.full}>{t('serverStart.full', { full })}</span>
        <span aria-hidden="true">{t('serverStart.short', { time: `${monthDay} ${clock}` })}</span>
      </span>
    </Tooltip>
  )
}
