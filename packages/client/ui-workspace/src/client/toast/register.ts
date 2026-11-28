/** Business-owned mappings into the keyed Workspace Toast slot. */
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RowToastActions, WorkspaceViewStoreHandle } from '../contract/slots.ts'
import type { ArchiveToastInjected, ToastDisplayInjected } from '../contract/toast.ts'
import { ArchiveToastEntry, ToastEntry, WorkspaceToast } from './Toast.tsx'

/** Register notice presentations with their business-owned display fields and actions.
 * @param ctx - Workspace plugin context.
 * @param viewStore - Viewing store, read only by archive notices.
 * @param actions - Archive, stale-continue, endorsement-retry, and source-opening callbacks.
 */
export function registerToasts(
  ctx: Context,
  viewStore: WorkspaceViewStoreHandle,
  actions: Pick<RowToastActions, 'undoArchive' | 'showArchived' | 'openForkSource' | 'continueSealedArchive' | 'retrySealedArchive'>,
): void {
  const archiveFilterAction: ArchiveToastInjected['filterAction'] = (t, dismiss) => ({
    prefix: t('toast.archivedOr'), label: t('toast.archivedFilter'),
    onClick: () => { dismiss(); actions.showArchived() },
  })
  ctx.slots.registerFactory({ name: 'workspace.toast.content', scope: 'root' }, WorkspaceToast)
  ctx.slots.inject('workspace.toast', function* () {
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'readingFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'readingFailed'> => ({
        display: (_notice, t) => ({ text: t('toast.readingFailed'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'readingFailed'>>)

    yield ctx.slots.register({
      name: 'workspace.toast', key: 'sessionIdCopied', locale: 'workspace',
      inject: (): ToastDisplayInjected<'sessionIdCopied'> => ({
        display: (_notice, t) => ({ text: t('toast.sessionIdCopied'), tone: 'success' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'sessionIdCopied'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'sessionIdCopyFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'sessionIdCopyFailed'> => ({
        display: (_notice, t) => ({ text: t('toast.sessionIdCopyFailed'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'sessionIdCopyFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'pinFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'pinFailed'> => ({
        display: (_notice, t) => ({ text: t('toast.pinFailed'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'pinFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'unpinFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'unpinFailed'> => ({
        display: (_notice, t) => ({ text: t('toast.unpinFailed'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'unpinFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'archivedNotOpenable', locale: 'workspace',
      inject: (): ToastDisplayInjected<'archivedNotOpenable'> => ({
        display: (_notice, t) => ({ text: t('toast.archivedNotOpenable'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'archivedNotOpenable'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'defaultWorkspaceFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'defaultWorkspaceFailed'> => ({
        display: (_notice, t) => ({ text: t('defaultWorkspace.failed'), tone: 'warning' }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'defaultWorkspaceFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'shortcutForkFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'shortcutForkFailed'> => ({
        display: (notice, t) => ({
          text: t(notice.reason === 'unavailable' ? 'shortcut.noCompletedTurn' : 'shortcut.forkFailed'), tone: 'plain',
        }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'shortcutForkFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'createFailed', locale: 'workspace',
      inject: (): ToastDisplayInjected<'createFailed'> => ({
        display: (notice, t) => ({ text: t('toast.createFailed', { message: notice.message }), tone: 'warning', holdMs: 6000 }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'createFailed'>>)
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'forkRequiresOpen', locale: 'workspace',
      inject: (): ToastDisplayInjected<'forkRequiresOpen'> => ({
        display: (notice, t, dismiss) => ({
          text: t('toast.forkRequiresOpen'), tone: 'warning', holdMs: 6000,
          actions: [{ label: t('toast.openForkSource'), onClick: () => { dismiss(); actions.openForkSource(notice.sessionId) } }],
        }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'forkRequiresOpen'>>)
    for (const key of ['archived', 'stoppedAndArchived'] as const) {
      yield ctx.slots.register({
        name: 'workspace.toast', key, locale: 'workspace', store: viewStore,
        inject: (): ArchiveToastInjected => ({
          display: (notice, t, dismiss) => ({
            text: notice.message ?? t(`toast.${notice.kind}`), tone: notice.tone ?? 'success', holdMs: 6000,
            actions: [{ label: t('toast.archivedUndo'), onClick: () => { dismiss(); actions.undoArchive(notice.sessionId) } }],
          }),
          filterAction: archiveFilterAction,
        }),
      }, ArchiveToastEntry)
    }
    // FORK archive-seal-gate-ui-1028: the stale tier's one-line prompt —
    // information with one action, never a dialog (ruling `stale-tier`).
    // The long hold keeps the click reachable; ignoring it archives nothing.
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'sealStale', locale: 'workspace',
      inject: (): ToastDisplayInjected<'sealStale'> => ({
        display: (notice, t, dismiss) => ({
          text: t('toast.sealStale', { n: notice.followUpCount ?? 0 }),
          tone: 'warning',
          holdMs: 10_000,
          actions: [{
            label: t('toast.sealStaleContinue'),
            onClick: () => { dismiss(); actions.continueSealedArchive(notice.sessionId, notice.followUpCount) },
          }],
        }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'sealStale'>>)
    // archive-seal-falsered-1116 段3 灯门对账: the lamp paints green while the
    // click-time endorsement recheck answered no-endorsement — the split that
    // used to drop straight into the unsealed force dialog. The one-line
    // notice offers the retry; its action re-runs the gate (green archives
    // quietly, a still-red answer then reaches the force dialog — the escape
    // hatch stays open), so the prompt never seals the force path shut.
    yield ctx.slots.register({
      name: 'workspace.toast', key: 'sealEndorseRetry', locale: 'workspace',
      inject: (): ToastDisplayInjected<'sealEndorseRetry'> => ({
        display: (notice, t, dismiss) => ({
          text: t('toast.sealEndorseRetry'),
          tone: 'warning',
          holdMs: 10_000,
          actions: [{
            label: t('toast.sealEndorseRetryAction'),
            onClick: () => { dismiss(); actions.retrySealedArchive(notice.sessionId) },
          }],
        }),
      }),
    }, ToastEntry<PropsRuntime<'workspace.toast', 'sealEndorseRetry'>>)
  })
}
