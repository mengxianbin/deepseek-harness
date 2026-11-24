/**
 * Server runtime-version tag in the settings trigger row (server-started-at-1117):
 * the wide column's glanceable `<branch>YYMMDD.HHMM` beside the gear (2026-11-24 口径:
 * 启动时刻 = 运行时版本信号，改成版本格式与语义——比时钟格式有区分度；首字母 = 构建期嵌入的
 * 分支名首字母，master→m、prod→p，无分支元数据回退 v——一眼分清当前跑的是哪条线), with the
 * full sentence + live elapsed age on hover — the honest answer to "did the server
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
 * Render the runtime-version tag: the visible `<branch>YYMMDD.HHMM` (branch
 * initial + local start instant in tag form), a
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
  // Runtime version = branch initial + local start instant in tag form
  // (<letter>YYMMDD.HHMM): the one unambiguous signal of what is actually
  // running across the three repos (2026-11-24 口径，判断跨度 = 功能施工窗是否
  // 跨过启动时刻). The letter names the build's branch (master→m, prod→p,
  // 2026-11-24 甲裁「分支首字母取代固定 v」); without branch metadata the plain
  // `v` keeps the tag readable.
  const branch = process.env.DSH_CLIENT_BRANCH
  const branchName = branch !== undefined && branch !== '' ? branch : undefined
  const letter = branchName !== undefined ? branchName.charAt(0) : 'v'
  const version = `${letter}${String(date.getFullYear()).slice(2)}${monthDay.replace('-', '')}.${clock.replace(':', '')}`
  // The full branch name rides along for the reader who wants it: letter for
  // the eye, name for hover/AT (2026-11-24 甲裁「带」).
  const branchNote = branchName !== undefined ? t('serverStart.branch', { branch: branchName }) : ''
  const detail = (): string =>
    t('serverStart.detail', { full, elapsed: restartBuildElapsed(t, Math.max(Date.now() - started, 0)) }) + branchNote
  return (
    <Tooltip label={detail} delayMs={500} side="top">
      <span className={css.stamp} data-server-started-at={startedAt}>
        <span className={css.full}>{t('serverStart.full', { full })}{branchNote}</span>
        <span aria-hidden="true">{t('serverStart.short', { version })}</span>
      </span>
    </Tooltip>
  )
}
