/** Client Session status table: running state, the effective pending interaction, and shared reading reminders. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionBinding, SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only service merge for ctx.slots.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {
  SessionCompletionOutcome, SessionDeliverableReceipt, SessionPendingInteraction, SessionStatus as HostSessionStatus,
} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionSealState } from '@deepseek-ai/dsh-api-session-controller/types'
// Retains ui-session's Context and Slot prop declarations for every consumer of this face.
export type {} from '@deepseek-ai/dsh-client-ui-session/client'
export type { SessionCompletionOutcome } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionReadModel } from './model.ts'

/** Independent UI status facts for one Session identity. */
export interface SessionStatus {
  /** Latest known running state; absent until a baseline or event establishes it. */
  readonly running: boolean | undefined
  /** Highest-precedence domain request currently awaiting user interaction. */
  readonly pendingInteraction: SessionPendingInteraction | undefined
  /**
   * Host-confirmed unread completion or explicit unread mark; an unacknowledged completion of the open Session the
   * visible, focused main view retains is not shown until the view leaves it.
   */
  readonly completionUnread: boolean
  /** Latest unread completion ended with an execution error this Host observed. */
  readonly completionFailed: boolean
  /** Outcome of that unread stop; present exactly while `completionUnread` is true. */
  readonly completionOutcome?: SessionCompletionOutcome
  /**
   * The failed stop was a shutdown cutting work off mid-flight
   * (session-status-icon-redesign-1118 §三): the Host died with this Session's
   * own open turn, a subagent child, or a background job still running, so an
   * all-clean green would report work that is gone. Present exactly while
   * `completionOutcome` is `'failed'` and the cause is the cut; an ordinary
   * turn failure omits it and keeps the row's default label (红点不带子原因).
   */
  readonly completionInterrupted?: true
  /**
   * Live background jobs this Session owns; present exactly while the count is
   * positive (a roster the row watches supplies it; no watch, no number).
   */
  readonly activeJobCount?: number
  /**
   * A durable, still-owed goal is on the books while the Session is stopped —
   * the wake-up weak mark. Present exactly while a list row carries a `goal`
   * projection value whose phase is not `complete` and `running` is observed
   * false; clears when the Session runs, the goal leaves the books or
   * completes, or the Session is removed.
   */
  readonly pendingWakeup?: true
  /**
   * The status itself could not be confirmed: the connection is down or
   * reconnecting, so the snapshot on display may be stale. Present for every
   * row while the connection withholds confirmation, absent otherwise.
   */
  readonly statusStale?: true
  /**
   * The Host's periodic status heartbeat stopped arriving for this Session
   * (collab step2 §4.2): the shown status is the last one that did arrive and
   * can no longer be confirmed. Present for the stale Session alone, absent
   * while heartbeats keep arriving — and never for a row that has received no
   * frame at all in this connection (collab step4b 件E).
   */
  readonly heartbeatStale?: true
  /**
   * Rounded seconds since the last confirmed Host frame behind `heartbeatStale`
   * (collab step3 §5.1: the hover names how long the shown last-known state has
   * gone unconfirmable). Re-folded on the heartbeat tick, so the age counts up
   * without any other event.
   */
  readonly heartbeatStaleSeconds?: number
  /**
   * The user opened this Session's row (点名) while its signals were showing, a
   * pure observation with zero state side effects (collab step1 §2.6, step3
   * §四): the signals stay lit and only this secondary row-end check records
   * "I saw it". Drops the moment any signed fact changes — a new event clears
   * the read mark automatically.
   */
  readonly readMarked?: true
  /**
   * The Session's latest done receipt (collab step2 §二 亮灯层, step4b 件A):
   * the Host folds `deliverables/receipt` from the transcript, so the 待收讫
   * light survives refreshes and restarts; the board row `[x]` stays the
   * authority layer. Carried with its 判据自证 for the hover card.
   */
  readonly deliverableReceipt?: SessionDeliverableReceipt
  /**
   * The Host's latest archive-seal verdict for this Session
   * (seal-light-host-state-1109 裁点2A/3A): pushed on `api-session/status`
   * frames, reconciled against `SessionSummary.projections.seal` on every
   * list read, and re-sent by the Host's 15s sweep — the status icon's three
   * insurances applied to the row lamp's channel. Absent while the Host holds
   * no verdict (registering unit absent or no record folded yet).
   */
  readonly seal?: SessionSealState
}

/** Current UI status indexed by Session identity. */
export type SessionStatusSnapshot = ReadonlyMap<SessionId, SessionStatus>
/** Selector hook over the unified Session UI status snapshot. */
export type UseSessionStatus = SnapshotSelectorHook<SessionStatusSnapshot>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    useSessionStatus: UseSessionStatus
  }
}

declare module '@deepseek-ai/dsh-client-ui-session/client' {
  interface UiSessionService {
    /** Session status table; a plugin that reads it injects `uiSession.sessionStatus`. */
    readonly sessionStatus: UiSessionStatus
  }
}

/**
 * Session status table provided as the `uiSession.sessionStatus` service and read as `ctx.uiSession.sessionStatus`.
 * Completion reminders come from the Host reading records shared by every Client of one Host; the
 * [package reference](../../README.md#use-this-package) states when each field is set and cleared.
 */
export class UiSessionStatus extends Service implements HostObservable<SessionStatusSnapshot> {
  private readonly running = new Map<SessionId, boolean>()
  private statusSnapshot: SessionStatusSnapshot = new Map()
  private viewedBinding: SessionBinding | undefined
  private viewedOpenState: string | undefined
  private releaseViewed = (): void => {}
  private readonly statusListeners = new Set<() => void>()
  /**
   * Package-internal Client copy of the Host reading records, which the reading installer follows into.
   * @internal
   */
  readonly reading: SessionReadModel
  /** Whether reading marks can be sent: the current Host reading baseline has arrived. */
  readonly readingReady: HostObservable<boolean>

  /**
   * @param ctx - Client root context; its generated `sessionStatus` Remote namespace sends reading marks.
   * @param sessions - Controller-owned Session catalog and bindings.
   * @param pendingInteractions - effective pending request by Session, published by ui-session.
   */
  constructor(
    ctx: Context,
    private readonly sessions: Pick<ISessions, 'list' | 'binding'>,
    private readonly pendingInteractions: HostObservable<ReadonlyMap<SessionId, SessionPendingInteraction>>,
    /**
     * Fork status engine's raw table (ui-session's controller): the source of
     * the rich per-Session facts (outcome, jobs, heartbeat, seal) this face
     * folds into every published row. Captured by `apply()` before this
     * Service registers under `uiSession.sessionStatus`; absent when the fork
     * engine is not loaded, which restores the reading-only table.
     */
    private readonly forkTable?: HostObservable<ReadonlyMap<SessionId, HostSessionStatus>>,
  ) {
    super(ctx, 'uiSession.sessionStatus')
    const reading = new SessionReadModel(ctx.remote.sessionStatus)
    this.reading = reading
    this.readingReady = {
      getSnapshot: () => reading.state.getSnapshot().ready,
      subscribe: listener => reading.state.subscribe(listener),
    }
    ctx.effect(() => {
      const disposeStatus = sessions.list.subscribe(() => { this.reconcileStatus() })
      const disposeRemoteStatus = ctx.remote.$on('api-session/status', (sessionId, running) => {
        this.observeRunning(sessionId, running)
      })
      const disposePending = pendingInteractions.subscribe(() => { this.publishStatus() })
      const disposeReading = reading.state.subscribe(() => { this.publishStatus() })
      const disposeView = watchViewVisibility(() => { this.publishStatus() })
      const disposeFork = this.forkTable?.subscribe(() => { this.publishStatus() }) ?? (() => {})
      this.reconcileStatus()
      return () => {
        disposeStatus()
        disposeRemoteStatus()
        disposePending()
        disposeReading()
        disposeView()
        disposeFork()
        this.releaseViewed()
      }
    }, 'session-status: Session status table')
  }

  /**
   * Read the current status table; the reference changes only when a status fact changes.
   * @returns status by Session identity.
   */
  readonly getSnapshot: () => SessionStatusSnapshot = () => this.statusSnapshot

  /**
   * Observe status table changes; a throwing listener is reported without stopping later listeners.
   * @param listener - called after each published change.
   * @returns unsubscribe.
   */
  readonly subscribe: (listener: () => void) => () => void = (listener) => {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  /**
   * Mark one Session read or unread through the latest completion known to this Client.
   * @param sessionId - known Session identity.
   * @param unread - requested reminder state.
   * @throws when reading is not synchronized or the Host or carrier rejects; reconnect to refresh an unknown outcome.
   */
  async mark(sessionId: SessionId, unread: boolean): Promise<void> {
    await this.reading.mark(sessionId, unread)
  }

  private observeRunning(sessionId: SessionId, running: boolean): void {
    this.running.set(sessionId, running)
    this.publishStatus()
  }

  private reconcileStatus(): void {
    const list = this.sessions.list.getSnapshot()
    const present = new Set(Object.keys(list.byId) as SessionId[])
    // Subagent catalog rows and retained subagent fallback rows do not establish Host running state.
    for (const id of list.ids) {
      const row = list.byId[id] as SessionSummary
      const previous = this.running.get(id)
      if (previous === undefined) this.running.set(id, row.running)
      else if (previous !== row.running) this.observeRunning(id, row.running)
    }
    if (list.phase === 'ready') {
      for (const id of this.running.keys()) {
        if (present.has(id)) continue
        this.running.delete(id)
      }
    }
    this.followMainView(list)
    this.publishStatus()
  }

  /** Follow the main-view Session's binding, whose open state decides whether its natural reminder is hidden. */
  private followMainView(list: SessionListState): void {
    const id = Object.values(list.byId).find(row => (row.retainedBy.mainView ?? 0) > 0)?.id
    const binding = id === undefined ? undefined : this.sessions.binding(id)
    if (binding === this.viewedBinding) return
    this.releaseViewed()
    this.viewedBinding = binding
    this.viewedOpenState = binding?.session.getSnapshot().openState
    // Session snapshots change with every streamed event; only the open state affects the table.
    this.releaseViewed = binding?.session.subscribe(() => {
      const openState = binding.session.getSnapshot().openState
      if (openState === this.viewedOpenState) return
      this.viewedOpenState = openState
      this.publishStatus()
    }) ?? (() => {})
  }

  private publishStatus(): void {
    const pending = this.pendingInteractions.getSnapshot()
    const reading = this.reading.state.getSnapshot().items
    const list = this.sessions.list.getSnapshot()
    const fork = this.forkTable?.getSnapshot()
    // The visible, focused main view acknowledges its open Session's completions; hiding them meanwhile avoids a flash.
    const viewing = viewVisible() && this.viewedOpenState === 'open' ? this.viewedBinding?.sessionId : undefined
    const ids = new Set<SessionId>([
      ...(Object.keys(list.byId) as SessionId[]),
      ...this.running.keys(),
      ...pending.keys(),
      ...(Object.keys(reading) as SessionId[]),
      ...(fork?.keys() ?? []),
    ])
    const next = new Map<SessionId, SessionStatus>()
    for (const id of ids) {
      const record = reading[id]
      const forkRow = fork?.get(id)
      const unread = record !== undefined
        && (record.manualUnread || (id !== viewing && record.completedTurn > record.readTurn))
      next.set(id, {
        running: this.running.get(id),
        pendingInteraction: pending.get(id),
        // A Host reading record is the authority the moment one exists; the fork
        // engine's event-based reminder is the fallback for Sessions no record
        // covers yet (and the whole table when the fork engine is absent).
        completionUnread: record !== undefined ? unread : forkRow?.completionUnread ?? false,
        completionFailed: unread && record.failed,
        // Fork engine's rich facts fold in unchanged: outcome, jobs, heartbeat,
        // read mark, deliverable receipt, and the archive seal verdict.
        ...(forkRow?.completionOutcome === undefined ? {} : { completionOutcome: forkRow.completionOutcome }),
        ...(forkRow?.completionInterrupted === undefined ? {} : { completionInterrupted: forkRow.completionInterrupted }),
        ...(forkRow?.activeJobCount === undefined ? {} : { activeJobCount: forkRow.activeJobCount }),
        ...(forkRow?.pendingWakeup === undefined ? {} : { pendingWakeup: forkRow.pendingWakeup }),
        ...(forkRow?.statusStale === undefined ? {} : { statusStale: forkRow.statusStale }),
        ...(forkRow?.heartbeatStale === undefined ? {} : { heartbeatStale: forkRow.heartbeatStale }),
        ...(forkRow?.heartbeatStaleSeconds === undefined ? {} : { heartbeatStaleSeconds: forkRow.heartbeatStaleSeconds }),
        ...(forkRow?.readMarked === undefined ? {} : { readMarked: forkRow.readMarked }),
        ...(forkRow?.deliverableReceipt === undefined ? {} : { deliverableReceipt: forkRow.deliverableReceipt }),
        ...(forkRow?.seal === undefined ? {} : { seal: forkRow.seal }),
      })
    }
    if (sameSessionStatus(this.statusSnapshot, next)) return
    this.statusSnapshot = next
    notifySubscribers(this.statusListeners, '[session-status] Session status')
  }
}

/** Whether the page is visible and focused; without a document there is no view. */
function viewVisible(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()
}

/**
 * Report page visibility and window focus changes.
 * @param changed - called after each change.
 * @returns removes the listeners; a no-op without a document.
 */
function watchViewVisibility(changed: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('visibilitychange', changed)
  window.addEventListener('focus', changed)
  window.addEventListener('blur', changed)
  return () => {
    document.removeEventListener('visibilitychange', changed)
    window.removeEventListener('focus', changed)
    window.removeEventListener('blur', changed)
  }
}

function sameSessionStatus(left: SessionStatusSnapshot, right: SessionStatusSnapshot): boolean {
  if (left.size !== right.size) return false
  for (const [id, status] of left) {
    const candidate = right.get(id)
    if (candidate === undefined
      || candidate.running !== status.running
      || candidate.pendingInteraction !== status.pendingInteraction
      || candidate.completionUnread !== status.completionUnread
      || candidate.completionFailed !== status.completionFailed) return false
  }
  return true
}
