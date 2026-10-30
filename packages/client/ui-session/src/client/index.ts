/** Session Controller adapter for React selector hooks and Slot scope data. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  ISessions,
  SessionBinding,
  SessionListState,
  SessionReference,
  SessionRetainInfo,
  SessionSnapshot,
  SessionSummary,
  UseProjection,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { IJobs, JobView } from '@deepseek-ai/dsh-api-job-controller/client'
import type { ConnectionHandle, ConnectionStateSource } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the `goal` SessionProjectionMap key merge the wake-up read names.
import type {} from '@deepseek-ai/dsh-goal/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { AccessEffect, RemoteEndpoint } from '@deepseek-ai/dsh-api-remote-access/client'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import { WeakMapWithValues } from '@deepseek-ai/dsh-util-values'
import { standardHookPropName } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  HostObservable,
  KeyedStandardSource,
  MaybeSnapshotSelectorHook,
  RootStandardSourceContribution,
  ScopedStandardSourceBinding,
  SlotScopeAdapter,
  SnapshotSelectorHook,
  StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only service merge for ctx.slots.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { renderSessionArea } from './session-provider.tsx'

/** Selector hook over the Session Controller list and current selection. */
export type UseSessions = SnapshotSelectorHook<SessionListState>
/** Selector hook over one Session's lifecycle and control state. */
export type SessionSnapshotSelector = SnapshotSelectorHook<SessionSnapshot>
/** Public name for the Session lifecycle selector hook. */
export type UseSession = SessionSnapshotSelector

/** Common identity carried by every Session-scoped pending interaction. */
export interface SessionPendingInteractionBase {
  /** Opaque request identity; a replacement request must use a new key. */
  readonly key: string
  /** Domain-owned presentation discriminator. */
  readonly kind: string
  /** Session whose UI can answer this interaction. */
  readonly sessionId: SessionId
}

/** Declaration-merged map of domain keys to their pending-interaction values. */
export interface SessionPendingInteractionMap {}

/** Union of every pending-interaction value contributed by the assembled Client. */
export type SessionPendingInteraction =
  [keyof SessionPendingInteractionMap] extends [never]
    ? SessionPendingInteractionBase
    : SessionPendingInteractionMap[keyof SessionPendingInteractionMap]

/** How an observed stop ended: a failed run acknowledges differently from a clean one. */
export type SessionCompletionOutcome = 'completed' | 'failed'

/** Whether one roster row counts toward a Session's active-job mark: its own live job (`running`/`stopping`). */
function countsAsActiveOwnJob(job: JobView, sessionId: SessionId): boolean {
  // A roster also carries every unowned job; those belong to no Session row.
  // The live-status vocabulary mirrors JobListAction's dot state in ui-jobs.
  return job.owner === sessionId && (job.status === 'running' || job.status === 'stopping')
}

/** Whether the connection currently withholds confirmation of row status (outage or reconnect). */
function isConnectionStale(state: string | undefined): boolean {
  return state === 'disconnected' || state === 'connecting'
}

/** Independent UI status facts for one Session identity. */
export interface SessionStatus {
  /** Latest known running state; absent until a baseline or event establishes it. */
  readonly running: boolean | undefined
  /** Highest-precedence domain request currently awaiting user interaction. */
  readonly pendingInteraction: SessionPendingInteraction | undefined
  /** Whether an observed stop outside the main view still needs acknowledgement. */
  readonly completionUnread: boolean
  /** Outcome of that unread stop; present exactly while `completionUnread` is true. */
  readonly completionOutcome?: SessionCompletionOutcome
  /**
   * Live background jobs this Session owns; present exactly while the count is
   * positive (a roster the row watches supplies it; no watch, no number).
   */
  readonly activeJobCount?: number
  /**
   * A durable goal is on the books while the Session is stopped — the wake-up
   * weak mark. Present exactly while a list row carries a `goal` projection
   * value and `running` is observed false; clears when the Session runs, the
   * goal leaves the books, or the Session is removed.
   */
  readonly pendingWakeup?: true
  /**
   * The status itself could not be confirmed: the connection is down or
   * reconnecting, so the snapshot on display may be stale. Present for every
   * row while the connection withholds confirmation, absent otherwise.
   */
  readonly statusStale?: true
}

/** Current UI status indexed by Session identity. */
export type SessionStatusSnapshot = ReadonlyMap<SessionId, SessionStatus>
/** Selector hook over the unified Session UI status snapshot. */
export type UseSessionStatus = SnapshotSelectorHook<SessionStatusSnapshot>

/** Selector hook for explicit or surrounding-Provider Session reference counts. */
export interface UseSessionRetainInfo {
  /**
   * Read the complete retain information for an explicit Session identity.
   * @param sessionId - Session identity to inspect without retaining it.
   * @returns current local reference counts, or absence while the source is unavailable.
   */
  (sessionId: SessionId): SessionRetainInfo | undefined
  /**
   * Select from the retain information for an explicit Session identity.
   * @param sessionId - Session identity to inspect without retaining it.
   * @param selector - projection over the current value.
   * @param equal - optional selected-value equality.
   * @returns selected value.
   */
  <Selected>(
    sessionId: SessionId,
    selector: (value: SessionRetainInfo | undefined) => Selected,
    equal?: (left: Selected, right: Selected) => boolean,
  ): Selected
  /**
   * Select from the surrounding Provider's Session retain information.
   * @param selector - projection receiving absence outside a Session binding.
   * @param equal - optional selected-value equality.
   * @returns selected value.
   */
  <Selected>(
    selector: (value: SessionRetainInfo | undefined) => Selected,
    equal?: (left: Selected, right: Selected) => boolean,
  ): Selected
}

/** Publish one pending interaction and define how plugin teardown delegates it. */
export type PendingInteractionPublisher<T extends SessionPendingInteractionBase> = (
  interaction: T,
  delegate: () => Promise<void>,
) => () => void

interface PendingInteractionEntry<T> {
  readonly interaction: T
  readonly delegate: () => Promise<void>
}

class PendingInteractionDomain<T extends SessionPendingInteractionBase> {
  private readonly values = new Map<string, PendingInteractionEntry<T>>()

  constructor(
    readonly precedence: (interaction: T) => number,
    private readonly changed: () => void,
  ) {}

  valuesSnapshot(): readonly T[] {
    return [...this.values.values()].map(entry => entry.interaction)
  }

  publish(interaction: T, delegate: () => Promise<void>): () => void {
    if (this.values.has(interaction.key)) {
      throw new Error(`ui-session: duplicate pending interaction key '${interaction.key}'`)
    }
    this.values.set(interaction.key, { interaction, delegate })
    this.changed()
    let active = true
    return () => {
      if (!active) return
      active = false
      if (!this.values.delete(interaction.key)) return
      this.changed()
    }
  }

  /** Remove every pending value and return the operations that settle their owners. */
  release(): readonly (() => Promise<void>)[] {
    const delegates = [...this.values.values()].map(entry => entry.delegate)
    this.values.clear()
    return delegates
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotScopeTargetMap {
    session: SessionReference
  }

  interface GlobalStandardProps {
    /** Session list and current selection. */
    useSessions: UseSessions
    useSessionStatus: UseSessionStatus
    useSessionRetainInfo: UseSessionRetainInfo
    /** Whether the current Peer may call `action` on one Session resource. */
    useSessionAccess: (sessionId: SessionId, action: RemoteEndpoint) => boolean
    /**
     * Keep one Session's background-job roster current while its row renders;
     * the roster feeds `SessionStatus.activeJobCount`. Rows call it on mount
     * and release on unmount; reference-counted, a no-op when the bundle
     * carries no jobs service. Optional: a composition without ui-session's
     * root props (direct-render tests, minimal assemblies) simply lacks it.
     */
    watchSessionJobs?: (sessionId: SessionId) => () => void
  }

  interface SessionStandardProps {
    /** Current Session lifecycle and control state. */
    useSession: SessionSnapshotSelector
    /** Current Session identity. */
    sessionId: SessionId
    /** Host-computed projection values addressed by projection key. */
    useProjection: UseProjection
    /** Whether the current Peer may call `action` on this Session resource. */
    useAccess: (action: RemoteEndpoint) => boolean
  }

  interface SessionMaybeStandardProps {
    /** Current Session state, absent while no Session is selected. */
    useSession: MaybeSnapshotSelectorHook<SessionSnapshot>
    /** Current Session identity, absent while no Session is selected. */
    sessionId: SessionId | undefined
    /** Host-computed projection values; every key is absent without a Session. */
    useProjection: UseProjection
    /** The bound Session's access answer; `undefined` without a Session, which callers treat as not allowed. */
    useAccess: (action: RemoteEndpoint) => boolean | undefined
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    mainView: unknown
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session Controller adapter and session-scoped source registry. */
    uiSession: UiSession
  }
}

type SessionSourceRoster = readonly string[] | undefined
type StandardMemberKind = 'hook' | 'keyed hook' | 'prop'

type SessionSourceRecord<Roster extends SessionSourceRoster, Value> =
  Roster extends readonly string[] ? Readonly<Record<Roster[number], Value>> : never

/** Bare values produced by one Session-scoped source contribution. */
export interface SessionSourceContribution<
  Hooks extends SessionSourceRoster = SessionSourceRoster,
  KeyedHooks extends SessionSourceRoster = SessionSourceRoster,
  Props extends SessionSourceRoster = SessionSourceRoster,
> {
  readonly hooks?: SessionSourceRecord<Hooks, HostObservable<unknown>>
  readonly keyedHooks?: SessionSourceRecord<KeyedHooks, KeyedStandardSource>
  readonly props?: SessionSourceRecord<Props, unknown>
}

/** Static roster and per-Session resolver for one standard-props contribution. */
export interface SessionSourceDescriptor<
  Hooks extends SessionSourceRoster = SessionSourceRoster,
  KeyedHooks extends SessionSourceRoster = SessionSourceRoster,
  Props extends SessionSourceRoster = SessionSourceRoster,
> {
  readonly hooks?: Hooks
  readonly keyedHooks?: KeyedHooks
  readonly props?: Props
  /**
   * Resolve every declared member for one Session binding.
   * @param binding - Controller-owned Session binding.
   * @returns all declared bare sources and stable props.
   */
  resolve(binding: SessionBinding): SessionSourceContribution<
    NoInfer<Hooks>,
    NoInfer<KeyedHooks>,
    NoInfer<Props>
  >
}

interface RuntimeSessionSourceContribution {
  readonly hooks?: Readonly<Record<string, HostObservable<unknown>>>
  readonly keyedHooks?: Readonly<Record<string, KeyedStandardSource>>
  readonly props?: Readonly<Record<string, unknown>>
}

interface RuntimeSessionSourceDescriptor {
  readonly hooks?: readonly string[]
  readonly keyedHooks?: readonly string[]
  readonly props?: readonly string[]
  resolve(binding: SessionBinding): RuntimeSessionSourceContribution
}

type RuntimePendingDomain = PendingInteractionDomain<SessionPendingInteractionBase>

interface MaterializedBinding {
  readonly owner: SessionBinding
  readonly source: BindingSource
  readonly release: () => void
}

interface BindingSource extends HostObservable<StandardSourceBinding> {
  value: StandardSourceBinding
  readonly listeners: Set<() => void>
}

const BUILTIN_SOURCE = {
  hooks: ['session'],
  keyedHooks: ['projection'],
  props: ['sessionId'],
  resolve: binding => ({
    hooks: { session: binding.session },
    keyedHooks: { projection: key => binding.session.projections.faceOf(key) },
    props: { sessionId: binding.sessionId },
  }),
} satisfies SessionSourceDescriptor<
  readonly ['session'],
  readonly ['projection'],
  readonly ['sessionId']
>

/** Session-scoped source roster and renderer adapter. */
export class UiSession extends Service {
  private readonly descriptors: RuntimeSessionSourceDescriptor[] = [
    BUILTIN_SOURCE,
  ]
  private readonly bindings = new WeakMapWithValues<SessionBinding, MaterializedBinding>()
  private readonly absent: BindingSource
  private readonly current: BindingSource
  private readonly pendingDomains: RuntimePendingDomain[] = []
  private pendingSnapshot: ReadonlyMap<SessionId, SessionPendingInteractionBase> = new Map()
  /**
   * The host's objective blocked-on-the-user kinds, carried by status events:
   * card-free attention facts that fill sessions no pending domain holds, so
   * an unanswered question stays amber across views, tabs, and read receipts
   * until it settles (2026-10-28 design ruling: attention never rides read state).
   */
  private readonly attention = new Map<SessionId, string>()
  private readonly running = new Map<SessionId, boolean>()
  private readonly unreadStops = new Map<SessionId, SessionCompletionOutcome>()
  private readonly observedFailures = new Set<SessionId>()
  private statusSnapshot: SessionStatusSnapshot = new Map()
  private readonly statusListeners = new Set<() => void>()
  private mainRetainId: SessionId | undefined
  private disposeMainRetain = (): void => {}
  private active = true
  /** Root source combining running, pending-interaction, and completion-reminder facts. */
  readonly sessionStatus: HostObservable<SessionStatusSnapshot> = {
    getSnapshot: () => this.statusSnapshot,
    subscribe: (listener) => {
      this.statusListeners.add(listener)
      return () => { this.statusListeners.delete(listener) }
    },
  }
  /** Renderer-facing adapter for `session` and `session-maybe` scopes. */
  readonly adapter: SlotScopeAdapter

  /**
   * @param ctx - Client root context.
   * @param sessions - Controller-owned Session object layer.
   * @param jobs - Read-only background-job rosters; absent when the bundle carries no jobs service.
   * @param connectionState - Connection recovery state; absent outside a connected assembly.
   */
  constructor(
    ctx: Context,
    private readonly sessions: ISessions,
    private readonly jobs?: IJobs,
    private readonly connectionState?: ConnectionStateSource,
  ) {
    super(ctx, 'uiSession')
    this.absent = createBindingSource(this.materializeAbsent())
    this.current = createBindingSource(this.absent.value)
    this.adapter = {
      current: this.current,
      bindingSource: target => this.bindingSource(target),
      renderArea: renderSessionArea,
    }

    ctx.effect(() => {
      const disposeList = sessions.list.subscribe(() => { this.publishMain() })
      const disposeStatus = sessions.list.subscribe(() => { this.reconcileStatus() })
      const disposeRemoteStatus = ctx.remote.$on('api-session/status', (sessionId, running, attention) => {
        this.observeRunning(sessionId, running)
        this.observeAttention(sessionId, attention)
      })
      const disposeRemoteError = ctx.remote.$on('api-session/error', (sessionId) => {
        this.observeFailure(sessionId)
      })
      // Optional read-only sources: their snapshot changes re-fold the status
      // facts that read them (job counts, the stale flag).
      const disposeJobs = this.jobs?.state.subscribe(() => { this.publishStatus() })
      const disposeConnection = this.connectionState?.subscribe(() => { this.publishStatus() })
      this.publishMain()
      this.reconcileStatus()
      return () => {
        this.active = false
        disposeList()
        disposeStatus()
        disposeRemoteStatus()
        disposeRemoteError()
        disposeJobs?.()
        disposeConnection?.()
        this.disposeMainRetain()
        const records = [...this.bindings.values]
        this.bindings.clear()
        for (const record of records) record.release()
      }
    }, 'ui-session: Session binding projection')
  }

  /**
   * Keep one Session's background-job roster current for as long as the caller
   * (a rendered Session row) holds the release. Reference-counted by the
   * client jobs service, so a row and the open session's header panel share
   * one stream; without a jobs service this is a no-op and no count appears.
   * @param sessionId - Session whose owned live jobs feed `activeJobCount`.
   * @returns the release for this watcher.
   */
  watchSessionJobs(sessionId: SessionId): () => void {
    return this.jobs?.watchRows(sessionId) ?? (() => {})
  }

  /**
   * Resolve a stable renderer source for an owned Session reference or explicit absence.
   * @param reference - active reference supplied by the Provider owner, or absence.
   * @returns the binding source, which falls back to the absent projection when its generation ends.
   * @throws when the reference does not belong to the active Controller generation.
   */
  bindingSource(reference: SessionReference | undefined): HostObservable<StandardSourceBinding> {
    if (!this.active) return this.absent
    if (reference === undefined) return this.absent
    const owner = reference.binding
    if (this.sessions.binding(reference.sessionId) !== owner) {
      throw new Error('ui-session: Session reference is not active in this Controller')
    }
    return this.sourceFor(owner)
  }

  /**
   * Keep `callback`'s effects installed while the current Peer may call
   * `action` on one Session resource, with the semantics of
   * `ctx.remoteAccess.whenAccess`: `useSessionAccess` answers the same
   * question during render.
   * @param sessionId - the Session resource the guarded effects depend on.
   * @param action - endpoint action the guarded effects depend on.
   * @param callback - creates one disposer or an iterable of disposers.
   * @returns idempotent disposer owned by the caller's Cordis fiber.
   */
  whenAccess(sessionId: SessionId, action: RemoteEndpoint, callback: () => AccessEffect): () => void {
    // `ctx.get` traces the service to the caller's Context, which then owns the controller.
    const access = this.ctx.get('remoteAccess')
    /* v8 ignore next -- this plugin injects remoteAccess, so the service is active while uiSession is reachable. */
    if (access === undefined) throw new Error('ui-session: whenAccess requires the remoteAccess service')
    return access.whenResourceAccess('session', sessionId, action, callback)
  }

  /**
   * Register one Session-scoped standard-source contribution.
   * @param descriptor - static member roster and per-binding resolver.
   * @returns disposer owned by the caller's Cordis fiber.
   */
  provide<
    const Hooks extends SessionSourceRoster = undefined,
    const KeyedHooks extends SessionSourceRoster = undefined,
    const Props extends SessionSourceRoster = undefined,
  >(descriptor: SessionSourceDescriptor<Hooks, KeyedHooks, Props>): () => void {
    const runtimeDescriptor = descriptor as unknown as RuntimeSessionSourceDescriptor
    const dispose = this.ctx.effect(() => {
      this.descriptors.push(runtimeDescriptor)
      try {
        this.rebuildBindings()
      } catch (error) {
        this.descriptors.pop()
        throw error
      }
      return () => {
        const index = this.descriptors.indexOf(runtimeDescriptor)
        this.descriptors.splice(index, 1)
        this.rebuildBindings()
      }
    }, 'uiSession.provide()')
    return () => { void dispose() }
  }

  /**
   * Register one pending-interaction domain and return its publication function.
   * Domain teardown first removes its visible values, then delegates and awaits
   * every still-active owner request.
   * @param precedence - deterministic cross-domain precedence; larger values win.
   * @returns a function that publishes one interaction and its teardown delegation.
   */
  registerPendingInteraction<T extends SessionPendingInteractionBase>(
    precedence: (interaction: T) => number,
  ): PendingInteractionPublisher<T> {
    const domain = new PendingInteractionDomain(precedence, () => {
      this.publishPendingInteractions()
    })
    const runtimeDomain = domain as unknown as RuntimePendingDomain
    this.ctx.effect(() => {
      this.pendingDomains.push(runtimeDomain)
      this.publishPendingInteractions()
      return async () => {
        const delegates = domain.release()
        const index = this.pendingDomains.indexOf(runtimeDomain)
        this.pendingDomains.splice(index, 1)
        this.publishPendingInteractions()
        await Promise.allSettled(delegates.map(delegate => Promise.resolve().then(delegate)))
      }
    }, 'uiSession.registerPendingInteraction()')
    return (interaction, delegate) => domain.publish(interaction, delegate)
  }

  private rebuildBindings(): void {
    const absent = this.materializeAbsent()
    const updates = [...this.bindings.values].map(record => ({
      source: record.source,
      value: this.materialize(record.owner),
    }))
    this.absent.value = absent
    for (const { source, value } of updates) source.value = value
    notifySubscribers(this.absent.listeners, '[ui-session] absent binding')
    for (const { source } of updates) {
      notifySubscribers(source.listeners, '[ui-session] Session binding')
    }
    this.publishMain()
  }

  private sourceFor(owner: SessionBinding): BindingSource {
    const cached = this.bindings.get(owner)
    if (cached !== undefined) return cached.source
    const record = this.createMaterializedBinding(owner)
    this.bindings.set(owner, record)
    return record.source
  }

  private publishMain(): void {
    if (!this.active) return
    const byId = this.sessions.list.getSnapshot().byId
    const currentId = this.current.value.key as SessionId | undefined
    const currentIsMain = currentId !== undefined
      && (this.sessions.retainInfo(currentId).getSnapshot().retainedBy.mainView ?? 0) > 0
    const nextId = currentIsMain
      ? currentId
      : Object.values(byId).find(candidate => (candidate.retainedBy.mainView ?? 0) > 0)?.id
    this.watchMainRetention(nextId)
    const owner = nextId === undefined ? undefined : this.sessions.binding(nextId)
    const value = owner === undefined ? this.absent.value : this.sourceFor(owner).value
    if (this.current.value === value) return
    this.current.value = value
    notifySubscribers(this.current.listeners, '[ui-session] main binding')
  }

  private watchMainRetention(sessionId: SessionId | undefined): void {
    if (sessionId === this.mainRetainId) return
    this.disposeMainRetain()
    this.mainRetainId = sessionId
    this.disposeMainRetain = sessionId === undefined
      ? () => {}
      : this.sessions.retainInfo(sessionId).subscribe(() => { this.publishMain() })
  }

  private publishPendingInteractions(): void {
    const next = new Map<SessionId, {
      interaction: SessionPendingInteractionBase
      precedence: number
    }>()
    for (const domain of this.pendingDomains) {
      for (const interaction of domain.valuesSnapshot()) {
        const precedence = domain.precedence(interaction)
        const previous = next.get(interaction.sessionId)
        if (previous === undefined || precedence >= previous.precedence) {
          next.set(interaction.sessionId, { interaction, precedence })
        }
      }
    }
    // The host's objective attention fills sessions no domain holds: the
    // blocking fact exists whether or not any tab built the answering card.
    for (const [sessionId, kind] of this.attention) {
      if (next.has(sessionId)) continue
      next.set(sessionId, {
        interaction: { key: `attention:${kind}:${String(sessionId)}`, kind, sessionId },
        precedence: Number.NEGATIVE_INFINITY,
      })
    }
    const projected = new Map(
      [...next].map(([sessionId, value]) => [sessionId, value.interaction] as const),
    )
    if (samePendingInteractions(this.pendingSnapshot, projected)) return
    this.pendingSnapshot = projected
    this.publishStatus()
  }

  /**
   * Fold the host's objective blocked-on-the-user fact into the status: it
   * fills sessions no pending domain holds, never displacing a live card.
   * @param sessionId - Session whose host-reported attention kind refreshed.
   * @param attention - the objective kind while one is active; absent otherwise.
   */
  private observeAttention(sessionId: SessionId, attention: string | undefined): void {
    const previous = this.attention.get(sessionId)
    if (previous === attention) return
    if (attention === undefined) this.attention.delete(sessionId)
    else this.attention.set(sessionId, attention)
    this.publishPendingInteractions()
  }

  private observeRunning(sessionId: SessionId, running: boolean): void {
    const previous = this.running.get(sessionId)
    const beforeBaseline = this.sessions.list.getSnapshot().phase === 'pending'
    this.running.set(sessionId, running)
    if (running) {
      this.unreadStops.delete(sessionId)
      this.observedFailures.delete(sessionId)
    } else {
      const stopped = previous === true || (previous === undefined && beforeBaseline)
      // The failure report arrives before the stop it ends, so the stop reads it here.
      const failed = this.observedFailures.delete(sessionId)
      if (stopped && !this.isMain(sessionId)) {
        this.unreadStops.set(sessionId, failed ? 'failed' : 'completed')
      }
    }
    this.publishStatus()
  }

  /**
   * Record one Host-reported failure so the stop it ends acknowledges as failed.
   * @param sessionId - Session whose Agent reported the failure.
   */
  private observeFailure(sessionId: SessionId): void {
    this.observedFailures.add(sessionId)
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
    for (const id of present) {
      if (this.isMain(id)) this.unreadStops.delete(id)
    }
    if (list.phase === 'ready') {
      for (const id of this.running.keys()) {
        if (present.has(id)) continue
        this.running.delete(id)
        this.unreadStops.delete(id)
        this.observedFailures.delete(id)
        this.attention.delete(id)
      }
    }
    this.publishStatus()
  }

  private isMain(sessionId: SessionId): boolean {
    return (this.sessions.list.getSnapshot().byId[sessionId]?.retainedBy.mainView ?? 0) > 0
  }

  private publishStatus(): void {
    const list = this.sessions.list.getSnapshot()
    const ids = new Set<SessionId>([
      ...(Object.keys(list.byId) as SessionId[]),
      ...this.running.keys(),
      ...this.pendingSnapshot.keys(),
      ...this.unreadStops.keys(),
      ...this.attention.keys(),
    ])
    const statusStale: true | undefined = this.connectionState !== undefined
      && isConnectionStale(this.connectionState.getSnapshot())
      ? true
      : undefined
    const next = new Map<SessionId, SessionStatus>()
    for (const id of ids) {
      const outcome = this.unreadStops.get(id)
      const roster = this.jobs?.state.getSnapshot().rows[String(id)]
      const activeJobCount = roster === undefined
        ? 0
        : roster.filter(job => countsAsActiveOwnJob(job, id)).length
      const pendingWakeup: true | undefined = list.byId[id]?.projectionValues?.goal != null
        && this.running.get(id) === false
        ? true
        : undefined
      next.set(id, {
        running: this.running.get(id),
        pendingInteraction: this.pendingSnapshot.get(id),
        completionUnread: outcome !== undefined,
        ...(outcome === undefined ? {} : { completionOutcome: outcome }),
        ...(activeJobCount === 0 ? {} : { activeJobCount }),
        ...(pendingWakeup === undefined ? {} : { pendingWakeup }),
        ...(statusStale === undefined ? {} : { statusStale }),
      })
    }
    if (sameSessionStatus(this.statusSnapshot, next)) return
    this.statusSnapshot = next
    notifySubscribers(this.statusListeners, '[ui-session] Session status')
  }

  private createMaterializedBinding(owner: SessionBinding): MaterializedBinding {
    const value = this.materialize(owner)
    this.ctx.slots.bindStoreScope(value)
    const source = createBindingSource(value)
    const releaseEffect = owner.ctx.effect(() => () => {
      if (this.bindings.get(owner) === record) this.bindings.delete(owner)
      source.value = this.absent.value
      notifySubscribers(source.listeners, '[ui-session] Session binding')
      this.publishMain()
    }, `ui-session: binding ${owner.sessionId}`)
    const record: MaterializedBinding = {
      owner,
      source,
      release: () => { void releaseEffect() },
    }
    return record
  }

  private materialize(binding: SessionBinding): ScopedStandardSourceBinding {
    const hooks: Record<string, HostObservable<unknown>> = {}
    const keyedHooks: Record<string, KeyedStandardSource> = {}
    const props: Record<string, unknown> = {}
    const finalProps = new Set<string>()
    for (const descriptor of this.descriptors) {
      const contribution = descriptor.resolve(binding)
      validateContribution(descriptor, contribution)
      copyDeclared('hook', hooks, descriptor.hooks, contribution.hooks, finalProps)
      copyDeclared('keyed hook', keyedHooks, descriptor.keyedHooks, contribution.keyedHooks, finalProps)
      copyDeclared('prop', props, descriptor.props, contribution.props, finalProps)
    }
    const value: ScopedStandardSourceBinding = {
      key: binding.sessionId,
      ctx: binding.ctx,
      hooks,
      keyedHooks,
      props,
    }
    return value
  }

  private materializeAbsent(): StandardSourceBinding {
    const hooks: Record<string, undefined> = {}
    const keyedHooks: Record<string, undefined> = {}
    const props: Record<string, undefined> = {}
    const finalProps = new Set<string>()
    for (const descriptor of this.descriptors) {
      declareAbsent('hook', hooks, descriptor.hooks, finalProps)
      declareAbsent('keyed hook', keyedHooks, descriptor.keyedHooks, finalProps)
      declareAbsent('prop', props, descriptor.props, finalProps)
    }
    return { key: undefined, hooks, keyedHooks, props }
  }
}

function createBindingSource(value: StandardSourceBinding): BindingSource {
  const source: BindingSource = {
    value,
    listeners: new Set(),
    getSnapshot: () => source.value,
    subscribe: (listener) => {
      source.listeners.add(listener)
      return () => { source.listeners.delete(listener) }
    },
  }
  return source
}

function validateContribution(
  descriptor: RuntimeSessionSourceDescriptor,
  contribution: RuntimeSessionSourceContribution,
): void {
  rejectUndeclared('hook', descriptor.hooks, contribution.hooks)
  rejectUndeclared('keyed hook', descriptor.keyedHooks, contribution.keyedHooks)
  rejectUndeclared('prop', descriptor.props, contribution.props)
}

function rejectUndeclared(
  kind: string,
  declared: readonly string[] | undefined,
  values: Readonly<Record<string, unknown>> | undefined,
): void {
  for (const name of Object.keys(values ?? {})) {
    if (!(declared ?? []).includes(name)) {
      throw new Error(`uiSession.provide: undeclared ${kind} '${name}'`)
    }
  }
}

function copyDeclared<T>(
  kind: StandardMemberKind,
  target: Record<string, T>,
  declared: readonly string[] | undefined,
  values: Readonly<Record<string, T>> | undefined,
  finalProps: Set<string>,
): void {
  for (const name of declared ?? []) {
    claimStandardProp(kind, name, finalProps)
    const value = values?.[name]
    if (value === undefined) throw new Error(`uiSession.provide: missing ${kind} '${name}'`)
    target[name] = value
  }
}

function declareAbsent(
  kind: StandardMemberKind,
  target: Record<string, undefined>,
  declared: readonly string[] | undefined,
  finalProps: Set<string>,
): void {
  for (const name of declared ?? []) {
    claimStandardProp(kind, name, finalProps)
    target[name] = undefined
  }
}

function claimStandardProp(kind: StandardMemberKind, name: string, finalProps: Set<string>): void {
  const propName = kind === 'prop' ? name : standardHookPropName(name)
  if (finalProps.has(propName)) {
    throw new Error(`uiSession.provide: duplicate ${kind} '${name}' at prop '${propName}'`)
  }
  finalProps.add(propName)
}

/** Required Controller, renderer, Remote, and access services. */
export const inject = ['sessions', 'slots', 'remote', 'remoteAccess']

/**
 * Install the Session root source and scoped adapter.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: Context): void {
  // Optional read-only sources: `ctx.get` reports absence rather than failing
  // the status source, so a bundle without either degrades to "no such signal"
  // (no job count, no stale flag) instead of breaking every row's status.
  // The connection cast mirrors ui-settings-general's `ctx.get('connection')`
  // precedent: that key resolves through the untyped `get` overload.
  const jobs = ctx.get('jobs')
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  const service = new UiSession(ctx, ctx.sessions, jobs, connection?.state)
  ctx.slots.provideRoot({
    hooks: {
      sessions: ctx.sessions.list,
      sessionStatus: service.sessionStatus,
    },
    keyedHooks: {
      sessionRetainInfo: key => ctx.sessions.retainInfo(key as SessionId),
      sessionAccess: (sessionId, action) => action === undefined
        ? undefined
        : ctx.remoteAccess.source('session', sessionId, action),
    },
    props: {
      // Rows call this while mounted; the roster it keeps current feeds
      // `activeJobCount`. Stable for the registration's lifetime.
      watchSessionJobs: (sessionId: SessionId): (() => void) => service.watchSessionJobs(sessionId),
    },
  } satisfies RootStandardSourceContribution)
  ctx.slots.installScope('session', service.adapter)
  service.provide({
    keyedHooks: ['access'],
    resolve: binding => ({
      keyedHooks: { access: action => ctx.remoteAccess.source('session', binding.sessionId, action) },
    }),
  })
}

function sameSessionStatus(left: SessionStatusSnapshot, right: SessionStatusSnapshot): boolean {
  if (left.size !== right.size) return false
  for (const [id, status] of left) {
    const candidate = right.get(id)
    if (candidate === undefined
      || candidate.running !== status.running
      || candidate.pendingInteraction !== status.pendingInteraction
      || candidate.completionUnread !== status.completionUnread
      || candidate.completionOutcome !== status.completionOutcome
      || candidate.activeJobCount !== status.activeJobCount
      || candidate.pendingWakeup !== status.pendingWakeup
      || candidate.statusStale !== status.statusStale) return false
  }
  return true
}

function samePendingInteractions(
  left: ReadonlyMap<SessionId, SessionPendingInteractionBase>,
  right: ReadonlyMap<SessionId, SessionPendingInteractionBase>,
): boolean {
  if (left.size !== right.size) return false
  for (const [sessionId, interaction] of left) {
    if (right.get(sessionId) !== interaction) return false
  }
  return true
}
