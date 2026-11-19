/**
 * The alert-inbox envelope badge + 双栏面板 (设计档 `session-revival-v2-alert-inbox-1116.md`
 * §七, alert-inbox-signal-face-1116 + **2026-11-18 改版裁定 A/C**): the 工作区
 * section header's sibling seat AFTER the 安康盾 — two dimensions, two seats
 * (盾灯 = mechanism health, 信封 = pending alert entries), never one slot.
 *
 * **改判 A supersedes the old "signal-only, no click" note**: the envelope is
 * now a button that opens the two-column mailbox —
 *   未读栏  = every unread entry (the badge predicate `unread && !archived`),
 *             `lastAt` descending, 【已读】 flips it out;
 *   最近24h = every entry whose `lastAt` fell in the trailing 24h (read ones
 *             included — 误点不丢 / 过夜可见), `lastAt` descending, 【恢复】
 *             flips it back into 未读.
 * 24h is a VIEW window, never a storage bound; neither column auto-clears
 * (改判 C: 已读 / 恢复 are the only two moves).
 *
 * Data rides the health frame (`report.alertInbox.entries` = the two columns'
 * union, sorted `lastAt` desc — the fold's write side already clustered). After
 * a successful action the response's fresh report replaces the local draft, so
 * the panel and badge flip immediately instead of waiting for the next 15s
 * heartbeat tick; the next frame then confirms the same truth (单写者不变).
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

/** One row of either column: the class name, its window count + last hit, one action. */
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

/** The two columns (改判 A): 未读 ∪ 最近24h, both `lastAt` descending. */
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
  return (
    <Modal
      open
      onClose={onClose}
      className={css.panel as string}
      title={unread.length > 0 ? t('alertInbox.unread').replace('{n}', String(unread.length)) : t('alertInbox.clear')}
      closeLabel={t('alertInbox.close')}
    >
      <div className={css.columns}>
        <section className={css.column} data-alert-inbox-column="unread">
          <h4 className={css.heading}>{t('alertInbox.column.unread')}</h4>
          {unread.length === 0
            ? <p className={css.empty}>{t('alertInbox.empty.unread')}</p>
            : <ul className={css.list}>{unread.map(entry => (
              <AlertInboxRow key={entry.id} entry={entry} t={t} onAction={onAction} />
            ))}</ul>}
        </section>
        <section className={css.column} data-alert-inbox-column="recent">
          <h4 className={css.heading}>{t('alertInbox.column.recent')}</h4>
          {recent.length === 0
            ? <p className={css.empty}>{t('alertInbox.empty.recent')}</p>
            : <ul className={css.list}>{recent.map(entry => (
              <AlertInboxRow key={entry.id} entry={entry} t={t} onAction={onAction} />
            ))}</ul>}
        </section>
      </div>
    </Modal>
  )
}

/**
 * Render the envelope badge beside the shield.
 * @param props - the health hook plus the sidebar locale seat.
 * @returns the badge element tree (plus the panel once opened), or null without
 *   a health source or an attached inbox plane (quiet absence, never a broken render).
 */
export function AlertInboxBadge({ useSessionHealth, t }: AlertInboxBadgeProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<readonly AlertInboxEntryView[] | null>(null)
  const health = useSessionHealth?.(value => value)
  if (health === undefined) return null
  const inbox = health.report?.alertInbox
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
