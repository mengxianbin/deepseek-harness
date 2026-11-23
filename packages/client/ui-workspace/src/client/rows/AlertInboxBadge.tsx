/**
 * The alert-inbox envelope badge + 左右 tab 面板 (设计档 `session-revival-v2-alert-inbox-1116.md`
 * §七, alert-inbox-signal-face-1116 + **2026-11-18 改版裁定 A/C** +
 * **2026-11-21 改判 E**): the 工作区 section header's sibling seat AFTER the
 * 安康盾 — two dimensions, two seats (盾灯 = mechanism health, 信封 = pending
 * alert entries), never one slot.
 *
 * **改判 A supersedes the old "signal-only, no click" note; 改判 E supersedes A's
 * two-column presentation**: the envelope opens a LEFT-RIGHT TAB panel —
 *   未读 tab = every unread entry (the badge predicate `unread && !archived`),
 *             `lastAt` descending, 【已读】 flips it out;
 *   最近24h tab = every entry whose `lastAt` fell in the trailing 24h (read ones
 *             included — 误点不丢 / 过夜可见), `lastAt` descending, 【恢复】
 *             flips it back into 未读.
 * One list at a time = each row gets the full width and the timestamp never
 * truncates. Tab labels carry BOTH counts (切走也能看到另一维状态); the default
 * tab is decided AT OPEN from the current state (有未读 → 未读, else → 最近 24h),
 * manual switching is immediate. 24h is a VIEW window, never a storage bound;
 * neither tab auto-clears (改判 C: 已读 / 恢复 are the only two moves).
 *
 * Data rides the health frame (`report.alertInbox.entries` = the two tabs'
 * union, sorted `lastAt` desc — the fold's write side already clustered). After
 * a successful action the response's fresh report replaces the local draft, so
 * the panel and badge flip immediately instead of waiting for the next 15s
 * heartbeat tick; the next frame then confirms the same truth (单写者不变).
 *
 * **首帧占位 (2026-11-23)**: the seat paints from the initial
 * `{ report: undefined }` snapshot as a PLACEHOLDER envelope — the 盾灯同构
 * HealthShield first-snapshot precedent. The host sweep folds a health frame
 * only every 15s and never replays on connect, so without the placeholder the
 * header's envelope seat stays EMPTY for the first seconds after every page
 * load (用户回报「信封图标卡几秒才出现」). The placeholder resolves with the
 * first frame: a real badge when the fold's plane is attached, nothing when it
 * is not (面未接线 quiet absence unchanged — a resolved absence never
 * resurrects the placeholder). Before that frame there is no data to open, so
 * the placeholder is a non-interactive seat: no button, no tab stop.
 *
 * ⛔ never the `question` attention kind (it feeds health's `awaiting` count:
 * lighting it would collide semantically AND inflate the metric).
 */
import { useState } from 'react'
import clsx from 'clsx'
import { Button, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseSessionHealth } from '@deepseek-ai/dsh-client-ui-session/client'
import type { AlertInboxEntryView, AlertInboxReport } from '@deepseek-ai/dsh-api-session-controller/types'
import { ALERT_INBOX_PATH } from './alert-inbox-path.ts'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import css from './AlertInboxBadge.module.css'

type AlertInboxBadgeProps = {
  /**
   * The ui-session health hook (global standard prop), threaded as a slot
   * with `undefined` in it (exactOptionalPropertyTypes rejects an explicitly
   * undefined optional): absent in compositions without ui-session's root
   * props — the seat renders nothing, like HealthShield.
   */
  useSessionHealth: UseSessionHealth | undefined
  t: WorkspaceBrowserProps['t']
}

/** 24h view window (改判 A): matches the fold report's `entries` filter. */
const VIEW_WINDOW_MS = 24 * 60 * 60 * 1000

/** Source classes with a localized name; every other cause falls back to its key. */
const LOCALIZED_CAUSES = new Set(['restart-storm', 'restart-no-reason', 'host-death-unknown'])

function causeLabel(t: WorkspaceBrowserProps['t'], cause: string): string {
  if (!LOCALIZED_CAUSES.has(cause)) return cause
  const label = t(`alertInbox.cause.${cause}` as Parameters<typeof t>[0])
  return label === `alertInbox.cause.${cause}` ? cause : label
}

function stampOf(at: number): string {
  return new Date(at).toLocaleString()
}

type PanelAction = (id: string, action: 'read' | 'restore') => void

/** One row of either tab: the class name, its window count + last hit, one action. */
function AlertInboxRow(
  { entry, t, onAction }: { entry: AlertInboxEntryView; t: WorkspaceBrowserProps['t']; onAction: PanelAction },
) {
  const open = entry.unread && !entry.archived
  return (
    <li className={css.row} data-alert-inbox-entry="" data-unread={open ? '' : undefined}>
      <span className={css.cause}>{causeLabel(t, entry.cause)}</span>
      <span className={css.meta}>
        {t('alertInbox.occurrences').replace('{n}', String(entry.count))}
        {' · '}
        {stampOf(entry.lastAt)}
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => { onAction(entry.id, open ? 'read' : 'restore') }}
      >
        {open ? t('alertInbox.action.read') : t('alertInbox.action.restore')}
      </Button>
    </li>
  )
}

/** The two tabs (改判 E): 未读 ∪ 最近24h, both `lastAt` descending; one list at a time. */
function AlertInboxPanel(
  { entries, t, onAction, onClose }: {
    entries: readonly AlertInboxEntryView[]
    t: WorkspaceBrowserProps['t']
    onAction: PanelAction
    onClose: () => void
  },
) {
  const byRecency = (left: AlertInboxEntryView, right: AlertInboxEntryView) => right.lastAt - left.lastAt
  const unread = entries.filter(entry => entry.unread && !entry.archived).sort(byRecency)
  const cutoff = Date.now() - VIEW_WINDOW_MS
  const recent = entries.filter(entry => entry.lastAt >= cutoff).sort(byRecency)
  // 改判 E: default tab judged AT OPEN (每次打开按当前 unread 状态); 打开后手动切换即时生效.
  const [tab, setTab] = useState<'unread' | 'recent'>(unread.length > 0 ? 'unread' : 'recent')
  const shown = tab === 'unread' ? unread : recent
  const tabLabel = (key: 'alertInbox.column.unread' | 'alertInbox.column.recent', count: number) =>
    `${t(key)} (${count})`
  return (
    <Modal
      open
      onClose={onClose}
      className={css.panel as string}
      title={unread.length > 0 ? t('alertInbox.unread').replace('{n}', String(unread.length)) : t('alertInbox.clear')}
      closeLabel={t('alertInbox.close')}
    >
      <div className={css.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          id="alert-inbox-tab-unread"
          className={tab === 'unread' ? css.tabActive : css.tab}
          aria-selected={tab === 'unread'}
          data-alert-inbox-tab="unread"
          onClick={() => { setTab('unread') }}
        >
          {tabLabel('alertInbox.column.unread', unread.length)}
        </button>
        <button
          type="button"
          role="tab"
          id="alert-inbox-tab-recent"
          className={tab === 'recent' ? css.tabActive : css.tab}
          aria-selected={tab === 'recent'}
          data-alert-inbox-tab="recent"
          onClick={() => { setTab('recent') }}
        >
          {tabLabel('alertInbox.column.recent', recent.length)}
        </button>
      </div>
      <section data-alert-inbox-tabpanel={tab}>
        {shown.length === 0
          ? <p className={css.empty}>{tab === 'unread' ? t('alertInbox.empty.unread') : t('alertInbox.empty.recent')}</p>
          : <ul className={css.list}>{shown.map(entry => (
            <AlertInboxRow key={entry.id} entry={entry} t={t} onAction={onAction} />
          ))}</ul>}
      </section>
    </Modal>
  )
}

/**
 * Render the envelope badge beside the shield.
 * @param props - the health hook plus the sidebar locale seat.
 * @returns the badge element tree (plus the panel once opened), a placeholder
 *   seat while the first health frame is still pending, or null without a
 *   health source or with a resolved absent inbox plane (quiet absence, never
 *   a broken render).
 */
export function AlertInboxBadge({ useSessionHealth, t }: AlertInboxBadgeProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<readonly AlertInboxEntryView[] | null>(null)
  const health = useSessionHealth?.(value => value)
  if (health === undefined) return null
  const report = health.report
  if (report === undefined) {
    // 首帧占位: the health source exists but no frame has landed yet — seat
    // the envelope NOW (HealthShield's first-snapshot precedent), faint like
    // the clear state. Non-interactive by design: there is no report to open,
    // so it is a labeled span, not a button (no phantom click, no tab stop).
    const loading = t('alertInbox.loading')
    return (
      <span className={clsx(css.badge, css.quiet)} data-alert-inbox-state="loading">
        <Tooltip label={loading} delayMs={500}>
          <span className={clsx(css.glyph, css.placeholder)} role="img" aria-label={loading}>
            <svg
              className={css.envelope}
              viewBox="0 0 16 16"
              width="16"
              height="16"
              aria-hidden="true"
              focusable="false"
            >
              <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" />
              <path d="M2.5 4.5 8 8.75 13.5 4.5" />
            </svg>
          </span>
        </Tooltip>
      </span>
    )
  }
  const inbox = report.alertInbox
  if (inbox === undefined) return null

  const entries = draft ?? inbox.entries
  const unread = draft === null
    ? inbox.unread
    : entries.filter(entry => entry.unread && !entry.archived).length
  const pending = unread > 0
  const label = pending ? t('alertInbox.unread').replace('{n}', String(unread)) : t('alertInbox.clear')

  const act = (id: string, action: 'read' | 'restore'): void => {
    void (async () => {
      try {
        const response = await fetch(ALERT_INBOX_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, action }),
        })
        if (!response.ok) return
        const payload = (await response.json()) as { ok?: boolean; report?: AlertInboxReport | null }
        if (payload.ok === true && payload.report !== null && payload.report !== undefined) {
          // 乐观刷新：动作即刻翻位，不等下一个15s 心跳帧（下一帧会确认同一真相）.
          setDraft(payload.report.entries)
        }
      } catch {
        // 网络失败 = 不翻位（不撒谎）；下一心跳帧带来写侧的真相.
      }
    })()
  }

  return (
    <>
      <span
        className={clsx(css.badge, pending ? css.pending : css.quiet)}
        data-alert-inbox-state={pending ? 'unread' : 'clear'}
      >
        <Tooltip label={label} delayMs={500}>
          <button
            type="button"
            className={css.glyph}
            data-alert-inbox-open=""
            aria-label={label}
            onClick={() => { setDraft(null); setOpen(true) }}
          >
            <svg
              className={css.envelope}
              viewBox="0 0 16 16"
              width="16"
              height="16"
              aria-hidden="true"
              focusable="false"
            >
              <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" />
              <path d="M2.5 4.5 8 8.75 13.5 4.5" />
            </svg>
            {pending && (
              <span className={css.count} data-alert-inbox-count="">{unread}</span>
            )}
          </button>
        </Tooltip>
      </span>
      {open && (
        <AlertInboxPanel
          entries={entries}
          t={t}
          onAction={act}
          onClose={() => { setOpen(false) }}
        />
      )}
    </>
  )
}
