/**
 * The archive action: a `sidebar.workspaces.session.menu.item` row and a
 * `sidebar.workspaces.session.row.action` button over one injected behavior,
 * plus the `shell.overlay` dialog that confirms stopping a Session's running
 * work before archiving it — and, since FORK archive-seal-gate-ui-1028, the
 * seal confirmation an unsealed Session raises: its status line in human
 * wording, the 30-day auto-delete countdown copy, and the optional
 * force-archive reason field (empty submits; the server normalizes it).
 * The same entries restore an archived row; the notice a successful archive
 * raises and the diagnostics for Host rejections live in the injected
 * callbacks, not here.
 */
import { useState } from 'react'
import type { SessionActivity, SessionActivityItem } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: the family keys each provider merges; a key this program did not compile takes the generic line.
import type {} from '@deepseek-ai/dsh-agent/types'
import type {} from '@deepseek-ai/dsh-jobs/view'
import type {} from '@deepseek-ai/dsh-schedule/client'
import type {} from '@deepseek-ai/dsh-subagent/client'
import {
  Button, IconArchiveOutlineRegular, IconUnarchiveOutlineRegular, MenuItemButton, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ArchiveSessionInjected, SessionArchiveConfirmInjected, SessionArchiveConfirmProps, SessionArchiveConfirmRequest,
  SessionMenuItemProps, SessionRowActionProps,
} from '../contract/slots.ts'
import { isStaleSeal, type SessionSealInfo } from './seal.ts'
import css from '../rows/Rows.module.css'
import browserCss from '../rows/WorkspaceBrowser.module.css'

/**
 * Menu row (order 400): archive, or restore an archived row. Absent while the Session's access
 * snapshot excludes that toggle.
 * @param props - owner share, the archive share, the access Hook, and the menu open state.
 * @returns the row, or nothing when the caller may not toggle this Session's archival.
 */
export function ArchiveSessionMenuItem({
  sessionId, useArchived, useMenuOpenState, useShortcuts, useSessionAccess, archiveSession, unarchiveSession, t,
}: SessionMenuItemProps<ArchiveSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'session.archive'))
  const archived = useArchived(set => set.has(sessionId))
  const allowed = useSessionAccess(sessionId, archived ? 'workspace/unarchiveSession' : 'workspace/archiveSession')
  if (!allowed) return null
  return (
    <MenuItemButton
      shortcut={archived ? undefined : shortcut}
      icon={archived ? <IconUnarchiveOutlineRegular size={14} /> : <IconArchiveOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        ;(archived ? unarchiveSession : archiveSession)(sessionId)
      }}
    >
      {t(archived ? 'menu.unarchiveSession' : 'menu.archiveSession')}
    </MenuItemButton>
  )
}

/**
 * Hover button (order 100): archive, or restore an archived row. Absent while the Session's access
 * snapshot excludes that toggle.
 * @param props - owner share, the access Hook, and the archive share.
 * @returns the button, or nothing when the caller may not toggle this Session's archival.
 */
export function ArchiveSessionRowButton({
  sessionId, useArchived, useSessionAccess, archiveSession, unarchiveSession, t,
}: SessionRowActionProps<ArchiveSessionInjected>) {
  const archived = useArchived(set => set.has(sessionId))
  const allowed = useSessionAccess(sessionId, archived ? 'workspace/unarchiveSession' : 'workspace/archiveSession')
  if (!allowed) return null
  return (
    <Tooltip label={t(archived ? 'actions.unarchive' : 'actions.archive')} side="bottom" align="end" delayMs={500} portal>
      <button
        type="button"
        className={css.iconButton}
        aria-label={t(archived ? 'menu.unarchiveSession' : 'menu.archiveSession')}
        onClick={() => { (archived ? unarchiveSession : archiveSession)(sessionId) }}
      >
        {archived ? <IconUnarchiveOutlineRegular size={14} /> : <IconArchiveOutlineRegular size={14} />}
      </button>
    </Tooltip>
  )
}

/**
 * The `shell.overlay` entry: nothing while no confirmation is pending,
 * otherwise one dialog per request (keyed by the Session). Confirming asks
 * the Host to stop the listed work and archive; cancelling leaves the
 * Session running and visible. FORK archive-seal-gate-ui-1028: a request the
 * seal gate raised carries its verdict, and the dialog renders the seal
 * confirmation copy (status line, 30-day countdown, optional reason).
 * @param props - the request hook, its settlement, the stop-and-archive hop, and the locale seat.
 * @returns the open dialog, or null.
 */
export function SessionArchiveConfirmDialog({
  useArchiveRequest, settleSessionArchive, stopAndArchiveSession, t,
}: SessionArchiveConfirmProps) {
  const request = useArchiveRequest(pending => pending)
  if (request === null) return null
  return (
    <ArchiveConfirmForm
      key={request.sessionId}
      request={request}
      stopAndArchiveSession={stopAndArchiveSession}
      onSettle={settleSessionArchive}
      t={t}
    />
  )
}

/** One request's dialog: in-flight and error state die with it. */
function ArchiveConfirmForm({ request, stopAndArchiveSession, onSettle, t }: {
  request: SessionArchiveConfirmRequest
  stopAndArchiveSession: SessionArchiveConfirmInjected['stopAndArchiveSession']
  onSettle: () => void
  t: SessionArchiveConfirmProps['t']
}) {
  const [archiving, setArchiving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  // FORK archive-seal-gate-ui-1028: a red seal verdict runs the seal copy and
  // the optional reason field; a stale verdict (raised through the refusal
  // path) keeps the plain stop-and-archive copy and adds only its status line.
  const seal = request.seal
  const forced = seal !== undefined && !isStaleSeal(seal)
  const close = () => {
    if (archiving) return
    onSettle()
  }
  const confirm = () => {
    setArchiving(true)
    setError(null)
    const hop = seal === undefined
      ? stopAndArchiveSession(request.sessionId)
      : stopAndArchiveSession(
        request.sessionId,
        forced && reason.trim() !== '' ? { seal, reason: reason.trim() } : { seal },
      )
    hop.then(() => {
      setArchiving(false)
      onSettle()
    }).catch((failure: unknown) => {
      setArchiving(false)
      setError(failure instanceof Error ? failure.message : String(failure))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={forced ? t('archive.seal.title') : t('archive.confirm.title')}
      description={forced
        ? t('archive.seal.desc', { title: request.displayTitle })
        : t('archive.confirm.desc', { title: request.displayTitle })}
      footer={(
        <>
          <Button variant="outline" disabled={archiving} onClick={close}>{t('cancel')}</Button>
          <Button
            variant="outline"
            className={browserCss.deleteAction}
            disabled={archiving}
            onClick={confirm}
          >
            {forced ? t('archive.seal.action') : t('archive.confirm.action')}
          </Button>
        </>
      )}
    >
      {seal !== undefined && <div className={browserCss.sealStatus}>{sealStatusLine(seal, t)}</div>}
      {forced && (
        <input
          className={`${browserCss.renameInput} ${browserCss.sealReason}`}
          value={reason}
          aria-label={t('archive.seal.reason')}
          placeholder={t('archive.seal.reason')}
          disabled={archiving}
          onChange={(e) => { setReason(e.target.value); setError(null) }}
        />
      )}
      {request.activity.length > 0 && (
        <ul className={browserCss.archiveActivity} aria-label={t('archive.confirm.activity')}>
          {request.activity.map((entry, index) => (
            <li key={`${entry.kind}-${String(index)}`} title={activityTitle(entry, t)}>{activityLine(entry, t)}</li>
          ))}
        </ul>
      )}
      {archiving && (
        <div className={browserCss.deleteStatus} role="status">
          {forced ? t('archive.seal.pending') : t('archive.confirm.pending')}
        </div>
      )}
      {error !== null && <div className={browserCss.renameError} role="alert">{error}</div>}
    </Modal>
  )
}

/**
 * The seal status line's human wording (FORK archive-seal-gate-ui-1028): each
 * known detail speaks for itself, an UNKNOWN verdict names the indeterminable
 * state, and an UNSEALED verdict the dictionary has no detail line for falls
 * back to the plain group wording.
 * @param seal - the verdict behind the confirmation.
 * @param t - the locale seat.
 * @returns the line shown above the confirm body.
 */
function sealStatusLine(seal: SessionSealInfo, t: SessionArchiveConfirmProps['t']): string {
  if (seal.verdict === 'UNKNOWN') return t('archive.seal.status.unknown')
  switch (seal.detail) {
    case 'sentinel-pending': return t('archive.seal.status.sentinel-pending')
    case 'save-tail-no-sentinel': return t('archive.seal.status.save-tail-no-sentinel')
    case 'save-trace-no-sentinel': return t('archive.seal.status.save-trace-no-sentinel')
    case 'sentinel-stale': return t('archive.seal.status.sentinel-stale', { n: seal.followUpCount ?? 0 })
    default: return t('archive.seal.status.unsealed')
  }
}

/**
 * Display cap for one activity item's name. A job's label is its full command
 * line — frequently multi-line shell source — which, printed verbatim, let a
 * 60-line script fill the dialog past the window (2026-10-09 立项 UX 缺陷).
 * The cap keeps each item to about one dialog line; the unclipped text stays
 * reachable on the row's hover title.
 */
const ACTIVITY_NAME_LIMIT = 96

/**
 * One item's display name: whitespace collapsed to a single line and clipped
 * at {@link ACTIVITY_NAME_LIMIT}. A label that collapses to nothing falls back
 * to the item id, the family's own identity.
 * @param item - the reported activity item.
 * @returns the name shown in the dialog line.
 */
function activityName(item: SessionActivityItem): string {
  const flat = (item.label ?? item.id).replace(/\s+/g, ' ').trim()
  if (flat === '') return item.id
  return flat.length > ACTIVITY_NAME_LIMIT ? `${flat.slice(0, ACTIVITY_NAME_LIMIT - 1)}…` : flat
}

/**
 * The unclipped names of one family's items, whitespace-collapsed so a hover
 * title stays one readable line, or nothing for a family without items (the
 * title attribute is then omitted rather than rendered empty).
 * @param entry - the reported family.
 * @param t - the locale seat.
 * @returns the full text for the row's `title`, or undefined.
 */
function activityTitle(entry: SessionActivity, t: SessionArchiveConfirmProps['t']): string | undefined {
  const items = entry.items ?? []
  if (items.length === 0) return undefined
  return items
    .map(item => ((item.label ?? item.id).replace(/\s+/g, ' ').trim() || item.id))
    .join(t('archive.confirm.listSeparator'))
}

/**
 * One family's line: its count and the items' labels (ids when a family
 * carries no label). A family this dictionary does not know — a provider
 * merged into the kind map — falls through to the generic line.
 */
function activityLine(entry: SessionActivity, t: SessionArchiveConfirmProps['t']): string {
  const items = entry.items ?? []
  const n = items.length
  const names = items.map(activityName).join(t('archive.confirm.listSeparator'))
  const plural = n === 1 ? 'one' : 'other'
  switch (entry.kind) {
    case 'turn': return t('archive.confirm.turn')
    case 'subagent': return t(`archive.confirm.subagents.${plural}`, { n, names })
    case 'job': return t(`archive.confirm.jobs.${plural}`, { n, names })
    case 'schedule': return t(`archive.confirm.schedules.${plural}`, { n, names })
    default: return t(`archive.confirm.other.${plural}`, { kind: entry.kind, n })
  }
}
