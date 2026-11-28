import { IconEditOutlineRegular, IconTrashOutlineRegular, IconPinFillRegular, IconPinOutlineRegular, IconUnarchiveOutlineRegular, IconArchiveOutlineRegular, IconBranchOutlineRegular, IconCopyOutlineRegular, IconMailReadOutlineRegular, IconMailUnreadOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionMenu } from './session-actions/SessionMenu.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
/**
 * Workspace plugin, browser half. Two registrations: WorkspaceBrowser fills
 * the sidebar shell's `sidebar.workspaces` hole (the whole browsing region),
 * and WorkspacePicker fills the conversation hero's picker hole
 * (`conversation.hero.workspace` — both hero forms). Both read real Host
 * Workspaces through the global useWorkspaces hook, and each declares its
 * own `single` directory-flow child hole for the composed picker package's
 * client half. WorkspaceBrowser additionally declares the two Session row
 * action lists, and this apply registers the shipped actions — pin,
 * rename, fork, archive, copy ID — into them the way any client plugin
 * would, each with its own behavior, plus the dialogs and the row-action
 * notice into `shell.overlay` (see the contract module doc). It also
 * declares two Session-row seats: the leading decoration a row renders only
 * while its own primary state is idle, and the section the row's hover card
 * renders between its relative time and its trailing status line. Export
 * discipline: packages/client/AGENTS.md.
 */
import type {} from '@deepseek-ai/dsh-client-product-analytics/client'
import type { Context } from '@deepseek-ai/cordis'
import type { SyncedConfig } from '@deepseek-ai/dsh-client-config/types'
import type { WorkspaceNavigationConfig } from '../types.ts'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions, SessionForkError } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  IWorkspaces, SessionActivity, WorkspaceArchiveError, WorkspaceId, WorkspaceSnapshot,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { RemoteEndpoint } from '@deepseek-ai/dsh-api-remote-access/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the Controller service merges.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the Session root standard-hook merge (the Context.uiSession
// face the 灯门对账 read uses rides this same augmentation,
// archive-seal-falsered-1116 段3).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the useSessionStatus root standard-hook merge.
import type {} from '@deepseek-ai/dsh-client-ui-session-status/client'
import {
  type ArchiveSessionInjected, type DirectoryFlowSlotName, type ForkSessionInjected, menuOpenStateFactory, type PinSessionInjected,
  type SessionArchiveConfirmInjected, type SessionArchiveConfirmRequest,
  type RenameSessionInjected, type RowToast, type RowToastInjected, type RowToastState, type SessionRenameDialogInjected,
  type WorkspaceActionRequest, type SessionIdInjected, type WorkspaceBrowserInjected, type WorkspacePickerInjected,
} from './contract/slots.ts'
import { createWorkspaceShortcutControls, installWorkspaceShortcuts } from './shortcuts.ts'
import { UiWorkspaceService } from './navigation.ts'
import { createWorkspaceViewStore } from './stores.ts'
import { WorkspaceBrowser } from './rows/WorkspaceBrowser.tsx'
import { ArchiveSessionRowButton, SessionArchiveConfirmDialog } from './session-actions/ArchiveSession.tsx'
import {
  archiveOverrideRequest, isGreenSeal, isStaleSeal, postArchiveOverride, requestSealCheck, STALE_SEAL,
  type SessionSealInfo,
} from './session-actions/seal.ts'
import type { SessionSealState } from '@deepseek-ai/dsh-api-session-controller/types'
import { derive } from './session-actions/derived.ts'
import { registerSessionMenus } from './session-actions/context-menus.tsx'
// FORK archive-seal-light-1101: the row lamps' C1 store (one handle created
// here in apply, shared through the browser's inject face — no module-level handle).
// mergeHostSeals rides along for the 灯门对账 read (archive-seal-falsered-1116 段3).
import { createSealLightStore, mergeHostSeals } from './session-actions/seal-light.ts'
import { PinSessionRowButton } from './session-actions/PinSession.tsx'
import { SessionRenameDialog } from './session-actions/RenameSession.tsx'
import { RowActionToast } from './session-actions/RowActionToast.tsx'
import { registerToasts } from './toast/register.ts'
import { WorkspacePicker, WorkspacePickerFactory } from './WorkspacePicker.tsx'
import { frozenSnapshot, previewSnapshot, subscribeFrozen, subscribePreview } from './session-actions/fsm-freeze.ts'
import { syncFreezeBlocks } from './session-actions/freeze-block.ts'
import { en, ja, es, fr, de, ru, pt, zh, type WorkspaceKey } from './locales.ts'

export type { StartSessionOptions, UiWorkspace } from './navigation.ts'
export type {
  DirectoryFlowOwnerProps, DirectoryFlowSlotName, DirectoryPickingHooks, DirectoryPickingInjected,
  MenuOpenState, RowToast, SessionDragType, SessionRenameTarget, SessionRowOwnerProps, UseMenuOpenState, WorkspaceBrowserInjected,
  SessionRowScheduleOwnerProps,
  WorkspaceBrowserProps,
  WorkspacePickerInjected, WorkspacePickerInput, WorkspacePickerProps,
} from './contract/slots.ts'
export type { WorkspaceKey } from './locales.ts'

/** Localized follow-up text for the existing archive notice. */
export interface ArchiveNotice {
  readonly text: string
  readonly tone: 'success' | 'warning'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Replace the archive notice with a localized follow-up description.
     * @param sessionId - Session whose archive has succeeded.
     * @param next - fallback to the remaining notice providers.
     * @mode waterfall
     */
    'workspace/archive-notice'(sessionId: SessionId, next: () => Promise<ArchiveNotice | undefined>): Promise<ArchiveNotice | undefined>
    /**
     * Replace the archive notice when an admitted background operation fails.
     * @param sessionId - Session whose successful archive remains in effect.
     * @param text - localized failure and recovery guidance.
     * @mode emit
     */
    'workspace/archive-followup-failed'(sessionId: SessionId, text: string): void
    /**
     * Restore the plain archive notice when an announced follow-up ended without acting.
     * @param sessionId - Session whose successful archive remains in effect.
     * @mode emit
     */
    'workspace/archive-followup-settled'(sessionId: SessionId): void
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** Selector hook over the pure Workspace Controller snapshot. */
    useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>
    /** Whether the current Peer may call `action` on one Workspace resource. */
    useWorkspaceAccess: (workspaceId: WorkspaceId, action: RemoteEndpoint) => boolean
  }

  interface LocaleNamespaceMap {
    /** The workspace browsing region and pick/create flow copy. */
    workspace: WorkspaceKey
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    workspaceOperation: unknown
    /** FORK session-switch-warm-1111: a replaced main view kept warm for instant switch-back. */
    mainViewWarm: unknown
    /** Recently viewed Sessions kept receiving history after leaving the main view. */
    recentViews: unknown
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'workspace'

/**
 * Required services (cordis fiber inject). The target slots are declared by
 * the ui-sidebar / ui-conversation applies, whose activation order relative
 * to this one is NOT constrained: dsh.client.inject edges are informational
 * (loading/prefetch metadata, never apply sequencing) and neither owner
 * provides a waitable service. apply therefore depends on each slot
 * declaration through `slots.inject()` instead of assuming order.
 * `uiSession.sessionStatus` provides the `useSessionStatus` hook the browser rows render with, so the plugin unloads
 * and reloads with it.
 */
export const inject = ['contextMenus',
  'slots', 'sessions', 'workspaces', 'locale', 'remote', 'remote.directoryPicker', 'layout', 'shortcuts', 'remoteAccess',
  'uiSession', 'uiSession.sessionStatus',
]

/**
 * Register the browser and picker once their slot declarations are on the
 * ledger. Inject factories return plain callbacks; data reads use the
 * framework's global hooks.
 * @param ctx - client root context.
 * @param config - Host-synced navigation configuration.
 */
export function apply(ctx: Context, config: SyncedConfig<WorkspaceNavigationConfig>): void {
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces
  // One viewing-store instance, created here as ui-layout does for its layout
  // store: the browser declares the handle, and the UiWorkspace service writes
  // view order through the same instance the renderer hands the browser.
  const viewHandle = createWorkspaceViewStore()
  const viewInstance = viewHandle.create()
  const viewStore: typeof viewHandle = { ...viewHandle, create: () => viewInstance }
  const rowToast = createSnapshotStore<RowToastState | null>(null)
  let toastSeq = 0
  const notify = (toast: RowToast): void => { rowToast.set({ ...toast, seq: ++toastSeq }) }
  // FORK archive-seal-light-1101: the archive-seal row lamps' store — the
  // browser reads its verdict snapshot through the injected `sealLight` hook
  // and threads its `sealRows` observer to the rows that mount lamps.
  const sealLight = createSealLightStore()
  const uiWorkspace = new UiWorkspaceService(
    ctx, ctx.remote.directoryPicker, workspaces, sessions, viewInstance.actions, notify, config.recentViewLimit,
  )
  ctx.slots.provideRoot({
    hooks: { workspaces: workspaces.list },
    keyedHooks: {
      workspaceAccess: (workspaceId, action) => action === undefined
        ? undefined
        : ctx.remoteAccess.source('workspace', workspaceId, action),
    },
  })
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-workspace: dictionaries')
  // §5.1 输入预冻结（freeze-reclaim 分期5）: a frozen or preview-announced
  // Session's composer carries a block (disabled textarea + reason as the
  // placeholder) until either map releases it — local registry writes only,
  // zero LLM/round-trips; the list subscription re-raises the block when a
  // frozen Session's conversation scope appears later, and disposal clears
  // every block this bridge raised (解冻永可用: the row badge wake flows
  // through the same map, so the input freeze always lifts with it).
  ctx.effect(() => {
    const tracked = new Set<string>()
    const t = ctx.locale.bind(NS)
    const sync = (): void => {
      syncFreezeBlocks(sessions, { frozen: frozenSnapshot(), preview: previewSnapshot() }, tracked, t)
    }
    sync()
    const offFrozen = subscribeFrozen(sync)
    const offPreview = subscribePreview(sync)
    const offList = sessions.list.subscribe(sync)
    return () => {
      offFrozen()
      offPreview()
      offList()
      for (const sessionId of tracked) {
        // The maps key plain route strings; the registry's scope/set faces
        // take the branded SessionId these ids are at runtime.
        const id = sessionId as SessionId
        sessions.scope(id)?.get('conversation')?.blocks.set(id, undefined)
      }
      tracked.clear()
    }
  }, 'ui-workspace: freeze composer blocks')
  const shortcutControls = createWorkspaceShortcutControls()

  const searchSessions: WorkspaceBrowserInjected['searchSessions'] = async (query, signal) => {
    const result = await sessions.search(query, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  // Stable per-surface occupancy sources (the renderer's hook cache keys by
  // source identity): true while the surface's directory-flow hole is filled.
  const flowSource = (hole: DirectoryFlowSlotName): HostObservable<boolean> => ({
    getSnapshot: () => ctx.slots.entries(hole).length > 0,
    subscribe: listener => ctx.slots.subscribe(hole, listener),
  })
  const browserFlowSource = flowSource('sidebar.workspaces.directoryFlow')
  const hostInfo: HostObservable<RemoteHostFacts> = {
    getSnapshot: () => ctx.remote.$host,
    subscribe: listener => ctx.on('connection/reset', listener),
  }
  const pickerFlowSource = flowSource('conversation.hero.workspace.directoryFlow')
  const factoryFlowSource = flowSource('workspace.picker.directoryFlow')
  const openSession: WorkspaceBrowserInjected['open'] = (sessionId) => {
    uiWorkspace.openSession(sessionId)
  }
  // Registry-global sets as Sets, rebuilt only when the Workspace snapshot changes.
  const pinnedSet = derive(workspaces.list, snapshot => new Set<SessionId>(snapshot.pinnedSessionIds))
  const archivedSet = derive(workspaces.list, snapshot => new Set<SessionId>(snapshot.archivedSessionIds))
  const markSession = (sessionId: SessionId, unread: boolean): void => {
    ctx.uiSession.sessionStatus.mark(sessionId, unread).catch(() => { notify({ kind: 'readingFailed' }) })
  }
  // Plugin-private facts the row actions and their overlay surfaces share:
  // the pending rename request and the notice on display. Each business
  // writes through its own injected callback and the surface reads through
  // its bound hook.
  const renameRequest = derive(shortcutControls.state, state => state.renameTarget)
  const archiveRequest = createSnapshotStore<SessionArchiveConfirmRequest | null>(null)
  const requestSessionRename = shortcutControls.rename
  const unarchiveSession = (sessionId: SessionId): void => {
    uiWorkspace.unarchiveSession(sessionId).catch((reason: unknown) => {
      console.warn('session unarchive rejected:', reason)
    })
  }
  const renameSession: SessionRenameDialogInjected['renameSession'] = async (sessionId, title) => {
    const result = await sessions.using(
      sessionId,
      { source: 'workspaceOperation' },
      reference => reference.binding.session.rename(title),
    )
    if (!result.ok) throw new Error(result.error.message)
  }
  const pinInjected = (): PinSessionInjected => ({
    hooks: { pinned: pinnedSet, archived: archivedSet },
    // Pin failures surface as a notice: nothing else on the surface moves, so
    // a silent failure would read as a dead action.
    pinSession: (sessionId) => {
      uiWorkspace.pinSession(sessionId).catch(() => { notify({ kind: 'pinFailed' }) })
    },
    unpinSession: (sessionId) => {
      uiWorkspace.unpinSession(sessionId).catch(() => { notify({ kind: 'unpinFailed' }) })
    },
  })
  ctx.on('workspace/archive-followup-failed', (sessionId, text) => {
    if (archivedSet.getSnapshot().has(sessionId)) notify({ kind: 'archived', sessionId, message: text, tone: 'warning' })
  })
  ctx.on('workspace/archive-followup-settled', (sessionId) => {
    if (archivedSet.getSnapshot().has(sessionId)) notify({ kind: 'archived', sessionId })
  })
  // FORK archive-seal-gate-ui-1028: the ledger write-back (contract C4) a
  // confirmed seal archive raises from the archive-SUCCESS callback alone —
  // never before, so a failed archive leaves no ghost entry. Its own failure
  // is a console diagnostic: the archive already stands, and the plugin's
  // observed back-fill keeps the ledger answerable.
  const recordSealOverride = (sessionId: SessionId, seal: SessionSealInfo, reason?: string): void => {
    void postArchiveOverride(archiveOverrideRequest(sessionId, seal, reason))
  }
  // The quiet archive: the seal gate cleared this Session (green verdict, a
  // blank placeholder, or an unreachable seal service — fail-open), or the
  // operator continued past the stale line. No confirmation; the notice
  // offers undo and the archived filter, and a stale context rides the
  // success callback as its ledger note. The archive notice rides a waterfall
  // so a follow-up provider (the worktree-cleanup leg) can attach its own
  // copy; the plain notice is the base case. Restored from upstream in the
  // merge — the declarations and followup handlers survived, the dispatch had
  // not (merge对账 2026-11-28). FORK session-relay-1106 left with the relay
  // 摘除 (freeze batch): `onHardFailure` had no remaining caller.
  const archiveNotice = async (sessionId: SessionId, kind: 'archived' | 'stoppedAndArchived'): Promise<void> => {
    let message: ArchiveNotice | undefined
    try {
      message = await ctx.waterfall('workspace/archive-notice', sessionId, () => Promise.resolve(undefined))
    } catch (error) {
      console.warn('session archive notice unavailable:', error)
    }
    notify({ kind, sessionId, ...message === undefined ? {} : { message: message.text, tone: message.tone } })
  }
  const archiveQuietly = (sessionId: SessionId, seal?: SessionSealInfo): void => {
    uiWorkspace.archiveSession(sessionId).then(() => {
      if (seal !== undefined) recordSealOverride(sessionId, seal)
      void archiveNotice(sessionId, 'archived')
    }).catch((reason: unknown) => {
      const activity = activeSessionRefusal(reason)
      if (activity === undefined) {
        console.warn('session archive rejected:', reason)
        return
      }
      const displayTitle = sessions.list.getSnapshot().byId[sessionId]?.displayTitle ?? sessionId
      archiveRequest.set({ sessionId, displayTitle, activity, ...(seal === undefined ? {} : { seal }) })
    })
  }
  // FORK archive-seal-gate-ui-1028: every archive entry (menu, row button,
  // shortcut) fronts the Host call with the seal check (contract C1):
  // green or an absent verdict (fail-open) archives quietly like before,
  // stale raises the one-line prompt, red and UNKNOWN open the seal
  // confirmation. A blank placeholder holds no conversation to seal and
  // stays the one click the fork gave it (blank-row-archive-1026).
  // archive-seal-falsered-1116 段2/段3: the ask carries `recheck` (the server
  // re-probes a memoized no-endorsement instead of serving the transcript-
  // stamped red), and a first-encounter split — lamp green × recheck red on
  // `no-endorsement` — raises the one-line retry notice instead of dropping
  // straight into the unsealed force dialog (灯门对账). The retry re-runs this
  // same gate with `retried = true`: green archives quietly, a still-red
  // answer then opens the force dialog, so the escape hatch to a forced
  // archive never seals shut.
  const lampPaintsGreen = (sessionId: SessionId): boolean => {
    // The SAME merge the row lamps paint from (Host status record over the C1
    // pull snapshot), so "green" here is the green the operator sees — the
    // incident's split was Host-leg green × fresh-recheck red.
    const uiSession = ctx.get('uiSession')
    const host = uiSession?.sessionStatus.getSnapshot().get(sessionId)
    const statuses = new Map<SessionId, { readonly seal?: SessionSealState }>()
    if (host !== undefined) statuses.set(sessionId, host)
    return mergeHostSeals(sealLight.observable.getSnapshot(), statuses).get(sessionId)?.verdict === 'DONE'
  }
  const archiveSealGated = (sessionId: SessionId, retried = false): void => {
    if (sessions.list.getSnapshot().byId[sessionId]?.blank === true) {
      archiveQuietly(sessionId)
      return
    }
    void requestSealCheck([sessionId], { recheck: true }).then((results) => {
      const seal = results?.get(sessionId)
      if (seal === undefined || isGreenSeal(seal)) {
        archiveQuietly(sessionId)
        return
      }
      if (isStaleSeal(seal)) {
        notify({
          kind: 'sealStale',
          sessionId,
          ...(seal.followUpCount === undefined ? {} : { followUpCount: seal.followUpCount }),
        })
        return
      }
      if (!retried && seal.detail === 'no-endorsement' && lampPaintsGreen(sessionId)) {
        notify({ kind: 'sealEndorseRetry', sessionId })
        return
      }
      const displayTitle = sessions.list.getSnapshot().byId[sessionId]?.displayTitle ?? sessionId
      archiveRequest.set({ sessionId, displayTitle, activity: [], seal })
    /* v8 ignore start -- requestSealCheck is contracted never to reject (its
       failures become `null` + a warning inside); this rung exists only for a
       future contract break and must never swallow the operator's click. */
    }).catch((reason: unknown) => {
      console.warn('seal check rejected:', reason)
      archiveQuietly(sessionId)
    })
    /* v8 ignore stop */
  }
  const archiveInjected = (): ArchiveSessionInjected => ({
    hooks: { archived: archivedSet },
    // Archive preserves the log and the account position, so a quiet Session
    // needs no confirmation; the notice offers undo and the archived filter.
    // FORK archive-seal-gate-ui-1028 fronts this with the seal check: stale
    // raises the one-line prompt, an unsealed verdict the confirmation, and
    // the Host's refusal for running work still names that work and offers
    // to stop it.
    archiveSession: (sessionId) => { archiveSealGated(sessionId) },
    unarchiveSession,
  })
  installWorkspaceShortcuts(ctx, uiWorkspace, shortcutControls, archiveInjected().archiveSession,
    (reason) => { notify({ kind: 'shortcutForkFailed', reason }) }, markSession)
  const archiveConfirmInjected = (): SessionArchiveConfirmInjected => ({
    hooks: { archiveRequest },
    settleSessionArchive: () => { archiveRequest.set(null) },
    stopAndArchiveSession: async (sessionId, options) => {
      await uiWorkspace.archiveSession(sessionId, { stopActivity: true })
      // The archive succeeded — the only moment the ledger write-back may
      // fire (FORK archive-seal-gate-ui-1028; contract C4).
      if (options !== undefined) recordSealOverride(sessionId, options.seal, options.reason)
      await archiveNotice(sessionId, 'stoppedAndArchived')
    },
  })
  const forkInjected = (): ForkSessionInjected => ({
    forkSession: (sessionId) => {
      uiWorkspace.forkSession(sessionId, (childId) => {
        ctx.get('productAnalytics')?.track('branch_session_click', { session_id: childId, parent_session_id: sessionId, click_position: 'sidebar' })
      }, { allowMigration: false, entry: 'menu' }).catch((error: unknown) => {
        if (error instanceof Error && error.name === 'SessionForkError'
          && (error as SessionForkError).rpcError.code === 'session/migration-required') {
          notify({ kind: 'forkRequiresOpen', sessionId })
          return
        }
        // The list keeps its shape, but a fork that never happened cannot stay
        // silent: the Host refused it (no completed turn, or a source Session
        // it cannot read/validate), so raise the same notice the shortcut path
        // uses and keep the detail in the console for a report.
        console.warn('session fork rejected:', error)
        // Client plugin bundles do not share error-class identity.
        const unavailable = error instanceof Error && error.name === 'SessionForkError'
          && (error as SessionForkError).rpcError.code === 'session/fork-unavailable'
        notify({ kind: 'shortcutForkFailed', reason: unavailable ? 'unavailable' : 'failed' })
      })
    },
  })
  const sessionIdInjected = (): SessionIdInjected => ({
    copySessionId: async (sessionId) => {
      const copied = await writeClipboard(sessionId)
      notify({ kind: copied ? 'sessionIdCopied' : 'sessionIdCopyFailed' })
    },
  })
  const renameInjected = (): RenameSessionInjected => ({ requestSessionRename })
  const renameDialogInjected = (): SessionRenameDialogInjected => ({
    hooks: { renameRequest },
    settleSessionRename: shortcutControls.closeRename,
    renameSession,
  })
  const toastActions = {
    undoArchive: unarchiveSession,
    showArchived: () => {
      viewInstance.actions.setArchivedFilter('show')
      // The default view cuts archived rows client-side (explicit false), so
      // show/only must refetch with them (row-cut).
      void sessions.refresh({ includeArchived: true }).catch((reason: unknown) => {
        console.warn('session list refresh rejected:', reason)
      })
    },
    openForkSource: (sessionId: SessionId) => {
      if (workspaces.list.getSnapshot().archivedSessionIds.includes(sessionId)) {
        notify({ kind: 'archivedNotOpenable' })
        return
      }
      openSession(sessionId)
    },
    // FORK archive-seal-gate-ui-1028: the stale line's one click resumes the
    // archive it paused; the note write-back rides the success callback, and
    // the reported count stays with the verdict for any confirmation later.
    continueSealedArchive: (sessionId: SessionId, followUpCount?: number) => {
      archiveQuietly(sessionId, followUpCount === undefined ? STALE_SEAL : { ...STALE_SEAL, followUpCount })
    },
    // archive-seal-falsered-1116 段3: the endorsement-retry notice's action —
    // re-run the gate with the fresh recheck ask; green archives quietly, and
    // a still-red answer this time (retried) opens the force dialog.
    retrySealedArchive: (sessionId: SessionId) => {
      archiveSealGated(sessionId, true)
    },
  }
  registerToasts(ctx, viewStore, toastActions)
  const rowToastInjected = (): Pick<RowToastInjected, 'hooks' | 'dismissToast'> => ({
    hooks: { toast: rowToast },
    dismissToast: () => { rowToast.set(null) },
  })
  const workspaceActionRequest = createSnapshotStore<WorkspaceActionRequest | null>(null)
  const requestWorkspaceAction = (workspaceId: WorkspaceId, displayTitle: string, action: 'rename' | 'delete'): void => {
    const workspace = workspaces.list.getSnapshot().items.find(row => row.workspaceId === workspaceId)
    if (workspace === undefined || !ctx.remoteAccess.source('workspace', workspaceId, `workspace/${action}`).getSnapshot()) return
    workspaceActionRequest.set({ action, workspaceId, displayTitle, storedTitle: workspace.title })
  }
  ctx.slots.inject('contextMenu.icon', function* () {
    for (const [key, Icon] of Object.entries({
      'workspace.rename': IconEditOutlineRegular, 'workspace.delete': IconTrashOutlineRegular,
      'workspace.pin': IconPinOutlineRegular, 'workspace.unpin': IconPinFillRegular,
      'workspace.archive': IconArchiveOutlineRegular, 'workspace.unarchive': IconUnarchiveOutlineRegular,
      'workspace.fork': IconBranchOutlineRegular, 'workspace.copy': IconCopyOutlineRegular,
      'workspace.markRead': IconMailReadOutlineRegular, 'workspace.markUnread': IconMailUnreadOutlineRegular,
    })) yield ctx.slots.register({ name: 'contextMenu.icon', key }, Icon)
  })
  ctx.effect(() => ctx.contextMenus.register({
    id: 'workspace.rename', target: 'workspace', order: 100,
    resolve: ({ workspaceId, displayTitle }) => ctx.remoteAccess.source('workspace', workspaceId, 'workspace/rename').getSnapshot()
      ? [{ id: 'rename', label: ctx.locale.bind(NS)('rename'), icon: { key: 'workspace.rename' }, run: () => { requestWorkspaceAction(workspaceId, displayTitle, 'rename') } }] : [],
  }), 'workspace: rename menu action')
  ctx.effect(() => ctx.contextMenus.register({
    id: 'workspace.delete', target: 'workspace', order: 300,
    resolve: ({ workspaceId, displayTitle }) => ctx.remoteAccess.source('workspace', workspaceId, 'workspace/delete').getSnapshot()
      ? [{ id: 'delete', label: ctx.locale.bind(NS)('delete.workspace'), icon: { key: 'workspace.delete' }, danger: true, separatorBefore: true,
        run: () => { requestWorkspaceAction(workspaceId, displayTitle, 'delete') } }] : [],
  }), 'workspace: delete menu action')
  const browserInjected = (): WorkspaceBrowserInjected => ({
    settleWorkspaceAction: () => { workspaceActionRequest.set(null) },
    // Explicit group actions keep their target; unscoped New Session inherits
    // the current Session Workspace before the recent-Workspace fallback.
    startSession: (workspaceId, options) => { uiWorkspace.startSession(workspaceId, options) },
    open: openSession,
    searchSessions,
    searchResultLimit: sessions.searchResultLimit,
    // FORK dsh-local (f5-list-states): the sidebar error surface's retry;
    // the archived view passes includeArchived to refetch its rows.
    refreshSessions: (options?: { readonly includeArchived?: boolean }) => {
      void sessions.refresh(options).catch((reason: unknown) => {
        console.warn('session list refresh rejected:', reason)
      })
    },
    requestSessionRename,
    notifyArchivedNotOpenable: () => { notify({ kind: 'archivedNotOpenable' }) },
    renameWorkspace: async (workspaceId, title) => { await workspaces.rename(workspaceId, title) },
    deleteWorkspace: async (workspaceId) => { await workspaces.delete(workspaceId) },
    insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
      await workspaces.insertBefore(workspaceId, beforeWorkspaceId)
    },
    unarchiveSession: async (sessionId) => { await uiWorkspace.unarchiveSession(sessionId) },
    createWorkspace: input => workspaces.create(input),
    requestSearch: shortcutControls.search,
    requestAddWorkspace: shortcutControls.add,
    closeAddWorkspace: shortcutControls.closeAdd,
    setDirectoryBusy: shortcutControls.directoryBusy,
    hooks: {
      workspaceActionRequest, contextMenuTarget: ctx.contextMenus.active, directoryFlow: browserFlowSource, hostInfo,
      workspaceShortcuts: shortcutControls.state, shortcuts: ctx.shortcuts.catalog,
      sealLight: sealLight.observable,
    },
    sealRows: sealLight.sealRows,
  })
  const pickerInjected = (directoryFlow: HostObservable<boolean>) => (): WorkspacePickerInjected => ({
    createWorkspace: input => workspaces.create(input),
    hooks: { directoryFlow },
  })
  // Each registration declares its owned children in the same call; slot
  // injection follows both the owner and declaration HMR lifetimes.
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      children: {
        'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
        'sidebar.workspaces.session.row.action': { kind: 'list', scope: 'root' },
        'sidebar.session.row.leading': { kind: 'list', scope: 'root', inline: true },
        'sidebar.session.row.trailing': { kind: 'list', scope: 'root', inline: true },
        'sidebar.session.row.hover': { kind: 'list', scope: 'root' },
      },
      store: viewStore,
      inject: browserInjected,
      locale: NS,
    },
    WorkspaceBrowser,
  ))
  // The legacy menu list lives under the context-menu content (one declaring
  // parent per slot): SessionMenu renders it inside the session context menu,
  // and its entries read the open state through a hook bound from the row's
  // render occurrence (the owner passes the state pair as hookContext).
  ctx.slots.inject('contextMenu.content', () => ctx.slots.register({
    name: 'contextMenu.content', key: 'session',
    children: { 'sidebar.workspaces.session.menu.item': {
      kind: 'list', scope: 'root', inject: { hooks: { menuOpenState: menuOpenStateFactory, shortcuts: ctx.shortcuts.catalog } },
    } },
  }, SessionMenu))
  registerSessionMenus(ctx, {
    ...pinInjected(), ...archiveInjected(), ...renameInjected(), ...forkInjected(), ...sessionIdInjected(),
    markSession,
  })
  ctx.slots.inject('sidebar.workspaces.session.row.action', function* () {
    yield ctx.slots.register({ name: 'sidebar.workspaces.session.row.action', id: 'archive', order: 100, locale: NS, inject: archiveInjected }, ArchiveSessionRowButton)
    yield ctx.slots.register({ name: 'sidebar.workspaces.session.row.action', id: 'pin', order: 200, locale: NS, inject: pinInjected }, PinSessionRowButton)
  })
  // The surfaces the actions raise live in the frame-wide layer: they must
  // outlive the row menu the action sat in.
  ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register({
      name: 'shell.overlay', id: 'workspace.session-rename', locale: NS, inject: renameDialogInjected,
    }, SessionRenameDialog)
    yield ctx.slots.register({
      name: 'shell.overlay', id: 'workspace.session-archive', locale: NS, inject: archiveConfirmInjected,
    }, SessionArchiveConfirmDialog)
    yield ctx.slots.register({
      name: 'shell.overlay', id: 'workspace.row-toast', inject: rowToastInjected,
      children: { 'workspace.toast': { kind: 'keyed', scope: 'root' } },
    }, RowActionToast)
  })
  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register(
    {
      name: 'conversation.hero.workspace',
      children: { 'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' } },
      inject: pickerInjected(pickerFlowSource),
      locale: NS,
    },
    WorkspacePicker,
  ))
  // The reusable picker depends on no other declaration, so the definition
  // and its directory-flow hole live for this plugin's lifetime.
  ctx.slots.registerFactory({
    name: 'workspace.picker',
    scope: 'root',
    children: { 'workspace.picker.directoryFlow': { kind: 'single', scope: 'root' } },
    inject: pickerInjected(factoryFlowSource),
    locale: NS,
  }, WorkspacePickerFactory)
}

/**
 * The activity a Host `workspace/session-active` refusal reported, or nothing
 * for any other failure. The class identity check goes by name: client plugin
 * bundles do not share error-class identity.
 */
function activeSessionRefusal(reason: unknown): readonly SessionActivity[] | undefined {
  if (!(reason instanceof Error) || reason.name !== 'WorkspaceArchiveError') return undefined
  const { rpcError } = reason as WorkspaceArchiveError
  return rpcError.code === 'workspace/session-active' ? rpcError.details.activity : undefined
}
