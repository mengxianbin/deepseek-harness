/** Cold-safe Session list and search projection. */

import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-workspace'
import { SessionQueryError, type SessionRecord, type SessionSearchCursor } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './types.ts'
import type {
  SessionLastReceipt, SessionLastTurnOutcome, SessionLastTurnOutcomeKind, SessionListMetadata,
  SessionListRequest, SessionProjectionHints, SessionProjectionValues,
  SessionSearchItem,
  SessionSearchValue, SessionSummary,
} from './types.ts'

const SEARCH_PROVIDER_CALL_LIMIT = 100
const SESSION_SEARCH_QUERY_MAX_CHARS = 500
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/** One listed cold row owed a consumer-owned refold: its header witness plus the listed format classification. */
type ColdRepairCue = Pick<SessionRecord, 'header' | 'formatStatus'>

/**
 * Cold refold attempts allowed per Session per process. A `stateVersion` move
 * needs a code change (and a restart) to happen again, so a retry loop buys
 * nothing beyond a bounded second and third try for a transient read failure.
 */
const COLD_REPAIR_ATTEMPT_LIMIT = 3


/**
 * Projection keys a `trimHeavyProjections` list omits: every reader of these
 * keys opens its Session first (an exact `session/projections` baseline then
 * carries them), so a thin listing never needs to pay their bytes. The trim
 * is opt-in (f5-contract-a2-1030): an untrimmed listing keeps them all.
 * `title`, `subagentCatalog`, `goal`, `agentPreset`, `subagent`, and
 * `subagentTiming` are deliberately absent from this set — cold rows are
 * their only source.
 */
const SESSION_LIST_OMITTED_PROJECTION_KEYS: ReadonlySet<string> = new Set([
  'contextBreakdown',
  'contextPressure',
  'inbox',
  'sessionStats',
  'tokenUsage',
  'turnOutline',
])

const sessionListMetadataSchema: z.ZodType<SessionListMetadata> = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

/**
 * End reasons the row marker has a stable meaning for; plugin-merged variants stay folded away.
 * `interrupted` reads red with `error`: the crash closer ends a reply that
 * never finished (chat renders its task-stopped row), so a row that stayed
 * silent through the restart hid exactly the残局 the marker exists to surface.
 */
const LAST_TURN_OUTCOME_KINDS = ['completed', 'error', 'aborted', 'blocked', 'interrupted'] as const

const lastTurnOutcomeSchema: z.ZodType<SessionLastTurnOutcome | null> = z.object({
  kind: z.enum(LAST_TURN_OUTCOME_KINDS),
  at: z.number(),
}).nullable()

/**
 * Advance the durable last-turn-outcome projection by one committed event.
 *
 * The row-level failure marker has to survive a page refresh and a Host
 * restart (collab step2 §7.2), which a client-side unread map cannot: it lives
 * only in memory and is cleared the moment the row becomes the main view.
 * Folding the fact from `turn/end` makes the transcript the single source, so
 * a failure stays visible until a later turn supersedes it.
 *
 * @param state - outcome before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced outcome value.
 */
export function applyLastTurnOutcome(
  state: SessionLastTurnOutcome | null,
  event: SessionEvent,
): SessionLastTurnOutcome | null {
  if (event.type !== 'turn/end') return state
  const kind = event.data.reason.kind
  if (!(LAST_TURN_OUTCOME_KINDS as readonly string[]).includes(kind)) return state
  const outcomeKind = kind as SessionLastTurnOutcomeKind
  const next: SessionLastTurnOutcome = { kind: outcomeKind, at: event.time }
  return state !== null && state.kind === outcomeKind && state.at === next.at ? state : next
}

/** 验章 verdicts the receipt light has a stable rendering for. */
const RECEIPT_VERDICTS = ['pass', 'exception'] as const

const lastReceiptSchema = z.object({
  verdict: z.enum(RECEIPT_VERDICTS),
  summary: z.string(),
  evidence: z.array(z.string()).optional(),
  at: z.number(),
}).nullable() as unknown as z.ZodType<SessionLastReceipt | null>

/**
 * Advance the durable done-receipt projection by one committed event
 * (collab step2 §二 亮灯层, step4b 件A).
 *
 * The 待收讫 light has to survive a page refresh and a Host restart, which a
 * client-side unread map cannot; folding `deliverables/receipt` makes the
 * transcript the single source (板行 `[x]` stays the authority layer, this is
 * only the light). A new receipt supersedes the old one; the next turn's start
 * clears it — new work replaces the old close-out claim.
 *
 * @param state - receipt before the event.
 * @param event - next committed Session event.
 * @returns the original, advanced, or cleared receipt value.
 */
export function applyLastReceipt(
  state: SessionLastReceipt | null,
  event: SessionEvent,
): SessionLastReceipt | null {
  if (event.type === 'turn/start') return state === null ? state : null
  if (event.type !== 'deliverables/receipt') return state
  const { verdict, summary, evidence } = event.data
  if (!(RECEIPT_VERDICTS as readonly string[]).includes(verdict)) return state
  const next: SessionLastReceipt = {
    verdict,
    summary,
    ...(evidence === undefined || evidence.length === 0 ? {} : { evidence: [...evidence] }),
    at: event.time,
  }
  return state !== null
    && state.verdict === next.verdict
    && state.summary === next.summary
    && state.at === next.at
    && JSON.stringify(state.evidence ?? null) === JSON.stringify(next.evidence ?? null)
    ? state
    : next
}

const imageLimitsSchema = z.object({
  maxImageBytes: z.number().int().positive(),
  maxImagesPerMessage: z.number().int().positive(),
  maxMessageImageBytes: z.number().int().positive(),
  maxImagePixels: z.number().int().positive(),
  maxImageDimension: z.number().int().positive(),
  mediaTypes: z.array(z.string()),
}) as unknown as z.ZodType<ImageAttachmentLimits>

/**
 * Advance the Session-list metadata projection by one committed event.
 * @param state - metadata before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced metadata value.
 */
export function applySessionListMetadata(
  state: SessionListMetadata,
  event: SessionEvent,
): SessionListMetadata {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/**
 * Return the longest prefix containing at most `maximum` Unicode code points.
 * @param value - source text.
 * @param maximum - maximum number of Unicode code points.
 * @returns the source text or its longest allowed prefix.
 */
export function truncateUnicodeCodePoints(value: string, maximum: number): string {
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end)
    count++
    end += codePoint.length
  }
  return value
}

/** Owns list projection registration, bounded cold summaries, and authorized search. */
export class ApiSessionList {
  /**
   * @param ctx - Host context carrying Session, query, persistence, and projection services.
   * @param workSliceMs - Resolved positive integral list-work budget in milliseconds.
   */
  constructor(private readonly ctx: Context, private readonly workSliceMs: number) {}

  /** Session ids with a queued (not yet started) cold refold: one queue entry per id. */
  private readonly repairQueued = new Set<SessionId>()

  /** Cold refold attempts started this process, per Session id. */
  private readonly repairAttempts = new Map<SessionId, number>()

  /** Rows waiting for the serial repair pump, drained off any list request's path. */
  private readonly repairQueue: ColdRepairCue[] = []

  /** The running serial drain, `undefined` while idle. */
  private repairPump: Promise<void> | undefined

  /** Set at teardown: the pump stands down and publishes nothing further. */
  private stopped = false

  /**
   * Acquire projection readers before exposing dependent operations.
   * @returns when all required registrations are ready.
   */
  async initialize(): Promise<void> {
    this.ctx.effect(() => () => {
      this.stopped = true
      this.repairQueue.length = 0
    }, 'apiSessionList.coldRepairStop')

    await this.ctx.sessionProjections.register<'sessionListMetadata', SessionListMetadata>({
      key: 'sessionListMetadata',
      stateSchema: sessionListMetadataSchema,
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: applySessionListMetadata,
      wire: { viewSchema: sessionListMetadataSchema, view: state => state },
      stateVersion: 1,
    })
    await this.ctx.sessionProjections.register<'imageLimits', null>({
      key: 'imageLimits',
      stateSchema: z.null(),
      init: () => null,
      apply: state => state,
      wire: {
        viewSchema: imageLimitsSchema,
        view: () => this.ctx.attachments.imageLimits,
        summary: false,
      },
      stateVersion: 1,
    })
    await this.ctx.sessionProjections.register<'lastTurnOutcome', SessionLastTurnOutcome | null>({
      key: 'lastTurnOutcome',
      stateSchema: lastTurnOutcomeSchema,
      init: () => null,
      apply: applyLastTurnOutcome,
      wire: { viewSchema: lastTurnOutcomeSchema, view: state => state },
      // v2 (task-stopped red dot): the fold now advances on `interrupted`
      // instead of passing the previous outcome through, so v1 rows — which
      // keep the pre-crash value — must refold from the log once.
      stateVersion: 2,
    })
    await this.ctx.sessionProjections.register<'lastReceipt', SessionLastReceipt | null>({
      key: 'lastReceipt',
      stateSchema: lastReceiptSchema,
      init: () => null,
      apply: applyLastReceipt,
      wire: { viewSchema: lastReceiptSchema, view: state => state },
      stateVersion: 1,
    })
  }

  /**
   * Build one current attached-Session summary.
   * @param session - attached Session to summarize.
   * @param trimHeavyProjections - when true, drop the display-heavy projection
   *   keys from the list hints; omitted keeps every value the source holds
   *   (the pre-f5 full-column contract, also used by live summary events).
   * @returns current list metadata and available projections.
   */
  summaryFor(session: Session, trimHeavyProjections = false): SessionSummary {
    const projections = this.projectionsFor(session.header, session, trimHeavyProjections)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: session.id,
      updatedAt: updatedAt(session.header, metadata),
      agentAvailable: this.ctx.agents.get(session.id)?.session === session,
      formatStatus: 'current',
      running: this.ctx.agents.get(session.id)?.status === 'running',
      blank: metadata?.blank ?? session.seq === 0,
      ...listFields(session.header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Read every visible attached and persisted Session without activating an Agent.
   * @param request - row-scope request: the pre-f5 full corpus is the default
   *   again (f5-contract-a2-1030) — omitted flags return archived rows,
   *   subagent-origin rows, and untrimmed hints. An explicit
   *   `includeArchived: false` excludes archived ids from the directory scan
   *   before any header read, an explicit `includeSubagents: false` excludes
   *   subagent ids the same way via the registry's in-memory header index
   *   (with a post-header-read predicate as the correctness backstop), and
   *   `trimHeavyProjections: true` trims the heavy hint columns; the flags are
   *   independent and the thin main-page listing passes all three.
   * @param signal - optional cancellation for persistence reads and summary generation.
   * @returns visible Session summaries ordered by activity.
   */
  async list(request?: SessionListRequest, signal?: AbortSignal): Promise<SessionSummary[]> {
    signal?.throwIfAborted()
    // A2 contract (f5-contract-a2-1030): only an explicit `false` cuts rows
    // and only an explicit `true` trims columns; omission is the full corpus.
    const includeArchived = request?.includeArchived !== false
    const includeSubagents = request?.includeSubagents !== false
    const trimHeavyProjections = request?.trimHeavyProjections === true
    // One consistent exclusion snapshot serves both the directory-level
    // pre-exclusion and every record the listing merges. Subagent ids come
    // from the registry's in-memory header index (built at startup, no I/O),
    // so the common thin listing skips their directory reads entirely; the
    // select predicate below stays as the correctness backstop for any id
    // the index has not seen yet.
    const excludeSessionIds = new Set<SessionId>()
    if (!includeArchived) {
      for (const id of this.ctx.workspaceRegistry.archivedSessionIds) excludeSessionIds.add(id)
    }
    if (!includeSubagents) {
      for (const id of this.ctx.workspaceRegistry.subagentSessionIds) excludeSessionIds.add(id)
    }
    const records = await this.ctx.sessionQuery.listSessions(signal, {
      // Any explicit row cut engages the pre-exclusion set (even when both
      // registry sets are empty), matching the flag-gated presence contract.
      ...(!includeArchived || !includeSubagents ? { excludeSessionIds } : {}),
      // Origin lives only in the header: this predicate runs after the header
      // read and before the stat, the earliest point it can decide. Ids the
      // registry index already knows never reach it (excluded above).
      ...(includeSubagents ? {} : { select: (header: SessionHeader) => header.origin !== 'subagent' }),
    })
    signal?.throwIfAborted()
    const items: SessionSummary[] = []
    const cold: SessionRecord[] = []
    let yieldDeadline = performance.now() + this.workSliceMs
    for (const record of records) {
      signal?.throwIfAborted()
      const live = this.ctx.sessions.get(record.header.id)
      if (live !== undefined) {
        items.push(this.summaryFor(live, trimHeavyProjections))
      } else if (record.header.cwd !== undefined) {
        cold.push(record)
      }
      if (performance.now() >= yieldDeadline) {
        await scheduler.yield()
        signal?.throwIfAborted()
        yieldDeadline = performance.now() + this.workSliceMs
      }
    }
    for (const record of cold) {
      signal?.throwIfAborted()
      items.push(this.summarizeCold(record, trimHeavyProjections))
      // Cueing never blocks (and never throws into) the listing: the row is
      // served above from whatever the cache still holds, while the owed
      // refold runs on the serial pump below.
      this.cueColdRepair(record)
      if (performance.now() >= yieldDeadline) {
        await scheduler.yield()
        signal?.throwIfAborted()
        yieldDeadline = performance.now() + this.workSliceMs
      }
    }
    signal?.throwIfAborted()
    items.sort((left, right) => right.updatedAt - left.updatedAt)
    return items
  }

  private summarizeCold(
    { header, formatStatus }: ColdRepairCue,
    trimHeavyProjections = false,
  ): SessionSummary {
    const projections = this.projectionsFor(header, undefined, trimHeavyProjections)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: header.id,
      updatedAt: updatedAt(header, metadata),
      agentAvailable: false,
      ...(formatStatus === undefined ? {} : { formatStatus }),
      running: false,
      // A large, metadata-less, or inaccessible cache miss remains unknown and visible.
      blank: metadata?.blank ?? false,
      ...listFields(header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Search current visible message content without activating any matching Session.
   * @param query - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  async search(query: string, signal: AbortSignal): Promise<SessionSearchValue> {
    const normalizedQuery = normalizeSearchQuery(query)
    signal.throwIfAborted()
    const provider = this.ctx.get('sessionQuery')
    if (provider === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query',
        {},
      )
    }
    try {
      const visible = await provider.listSessions(signal)
      signal.throwIfAborted()
      const visibleIds = new Set(visible
        .filter(record => record.header.cwd !== undefined)
        .map(record => record.header.id))
      if (visibleIds.size === 0) return { items: [], hasMore: false }
      const authorized: SessionSearchItem[] = []
      const acceptedIds = new Set<SessionId>()
      const seenCursors = new Set<SessionSearchCursor>()
      let cursor: SessionSearchCursor | undefined
      let providerCalls = 0
      let pageLimit = SESSION_SEARCH_RESULT_LIMIT
      while (authorized.length <= SESSION_SEARCH_RESULT_LIMIT) {
        signal.throwIfAborted()
        if (providerCalls >= SEARCH_PROVIDER_CALL_LIMIT) {
          throw new Error(`session search provider exceeded the ${SEARCH_PROVIDER_CALL_LIMIT}-call work budget`)
        }
        providerCalls++
        const requestedCursor = cursor
        const requestedLimit = pageLimit
        let page
        try {
          page = await provider.searchSessions({
            query: normalizedQuery,
            eventFilters: [
              { kind: 'type', values: ['user/message', 'assistant/message'] },
              { kind: 'surface', values: ['current'] },
            ],
            limit: requestedLimit,
            ...(requestedCursor === undefined ? {} : { cursor: requestedCursor }),
          }, { signal })
          signal.throwIfAborted()
        } catch (error: unknown) {
          signal.throwIfAborted()
          if (requestedCursor === undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_INVALID_LIMIT'
            && requestedLimit > 1) {
            pageLimit = Math.max(1, Math.floor(requestedLimit / 2))
            continue
          }
          if (requestedCursor !== undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_STALE_CURSOR') {
            authorized.length = 0
            acceptedIds.clear()
            seenCursors.clear()
            cursor = undefined
            continue
          }
          throw error
        }
        if (page.items.length > requestedLimit) {
          throw new Error(`session search provider returned ${String(page.items.length)} items; maximum is ${String(requestedLimit)}`)
        }
        for (const hit of page.items) {
          if (authorized.length > SESSION_SEARCH_RESULT_LIMIT) continue
          if (!visibleIds.has(hit.header.id)
            || hit.bestMatch.sessionId !== hit.header.id
            || hit.bestMatch.surface !== 'current'
            || !MESSAGE_TYPES.has(hit.bestMatch.type)
            || acceptedIds.has(hit.header.id)) continue
          acceptedIds.add(hit.header.id)
          authorized.push({
            sessionId: hit.header.id,
            snippet: truncateUnicodeCodePoints(hit.bestMatch.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
          })
        }
        if (page.nextCursor !== undefined) {
          if (seenCursors.has(page.nextCursor)) {
            throw new Error('session search provider repeated a continuation cursor')
          }
          seenCursors.add(page.nextCursor)
        }
        if (authorized.length > SESSION_SEARCH_RESULT_LIMIT || page.nextCursor === undefined) break
        cursor = page.nextCursor
      }
      return {
        items: authorized.slice(0, SESSION_SEARCH_RESULT_LIMIT),
        hasMore: authorized.length > SESSION_SEARCH_RESULT_LIMIT,
      }
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED') {
        throw new RemoteError('gateway/cancelled', 'session search was aborted', {})
      }
      throw new RemoteError('gateway/internal', `session search failed: ${String(error)}`, {})
    }
  }

  private projectionsFor(
    header: SessionHeader,
    session: Session | undefined,
    trimHeavyProjections = false,
  ): SessionProjectionHints | undefined {
    try {
      // The registry derives the summary key set from its registrations and
      // hands back one stable set until the key table changes; both faces below
      // serve only those keys, so a list row cannot carry a unit that declares
      // itself summary-excluded.
      const keys = this.ctx.sessionProjections.summaryKeys()
      if (session !== undefined) {
        // The live registry computed the block for this Session: its watermark
        // shares the sequence space of the Session's baselines and frames.
        return hintsOf('sequenced', this.ctx.sessionProjections.cachedSnapshot(session, keys), trimHeavyProjections)
      }
      // A cold row reads the persisted cache by header alone; the cache serves
      // seeded and unseeded lifecycles alike because a listing never seeds a
      // fold. The watermark is the stored record's own.
      const cache = this.ctx.get('sessionProjectionCache')
      return hintsOf(
        'cached',
        cache?.cachedSnapshot(header, keys) ?? cache?.cachedPredecessorTitle(header),
        trimHeavyProjections,
      )
    } catch (error) {
      this.ctx.logger.warn(
        `api-session.list: projection column for "${header.id}" failed; serving the row without it: ${String(error)}`,
      )
      return undefined
    }
  }

  /**
   * Cue the consumer-owned cold refold for one listed row whose stored
   * projection rows exist but can no longer be served — a unit's
   * `stateVersion` moved since they were written (the bump itself says the
   * rows "须重折一次"). Neither owner may do it inline: the cache is log-blind
   * by contract and the listing is zero-I/O and never seeds a fold, so this
   * is where the "fuller read path refolds it" promise is kept. The cue is
   * synchronous, deduped, and bounded; the row keeps serving whatever the
   * cache still holds until the pump reports back.
   * @param record - the cold list record just served.
   */
  private cueColdRepair(record: ColdRepairCue): void {
    const cache = this.ctx.get('sessionProjectionCache')
    if (cache === undefined) return
    const id = record.header.id
    if (this.stopped || this.repairQueued.has(id)) return
    if ((this.repairAttempts.get(id) ?? 0) >= COLD_REPAIR_ATTEMPT_LIMIT) return
    try {
      const stale = cache.staleSnapshotKeys(record.header, this.ctx.sessionProjections.summaryKeys())
      if (stale.length === 0) return
    } catch (error) {
      this.ctx.logger.warn(
        `api-session.list: stale-row probe for "${id}" failed; cold refold skipped: ${String(error)}`,
      )
      return
    }
    this.repairQueued.add(id)
    this.repairQueue.push(record)
    this.startRepairPump()
  }

  /**
   * Drain the repair queue serially: one log read, full fold, checkpoint
   * write-back, and row republish at a time, each between work yields and
   * never inside a list request. A failing row is contained and logged — the
   * attempt count stops a permanently failing Session from being retried on
   * every list pull.
   */
  private startRepairPump(): void {
    if (this.repairPump !== undefined) return
    this.repairPump = (async () => {
      while (!this.stopped) {
        const cue = this.repairQueue.shift()
        if (cue === undefined) return
        this.repairQueued.delete(cue.header.id)
        this.repairAttempts.set(cue.header.id, (this.repairAttempts.get(cue.header.id) ?? 0) + 1)
        try {
          await this.repairColdRow(cue)
        } catch (error) {
          this.ctx.logger.warn(
            `api-session.list: cold projection refold for "${cue.header.id}" failed (the row keeps its stored columns): ${String(error)}`,
          )
        }
        await scheduler.yield()
      }
    })().finally(() => {
      this.repairPump = undefined
      // A cue landing between the loop's last empty check and this clear
      // would otherwise wait for a pump that no longer exists.
      if (!this.stopped && this.repairQueue.length > 0) this.startRepairPump()
    })
  }

  /**
   * Refold one cold Session's projection rows from its stored log, refresh
   * the durable checkpoint, and republish the repaired row. The stored log is
   * the durability witness — `SessionHandle.read` only returns events the
   * backend has accepted — so the cache write-back never runs ahead of the
   * log, exactly the ordering `write()` buys with its flush. A Session that
   * attaches meanwhile owns its own fold and frames, so the repair stands
   * down before it writes and again before it publishes.
   * @param cue - the cold list record queued for repair.
   */
  private async repairColdRow({ header, formatStatus }: ColdRepairCue): Promise<void> {
    const cache = this.ctx.get('sessionProjectionCache')
    const persistence = this.ctx.get('sessionPersistence')
    if (cache === undefined || persistence === undefined) return
    if (this.repairStandDown(header.id)) return
    const handle = await persistence.open(header.id, 'read')
    try {
      const { events } = await handle.read()
      if (this.repairStandDown(handle.header.id)) return
      const repaired = hintsOf('cached', cache.coldSnapshot(handle.header, handle.inheritedEventCount, events), false)
      if (this.repairStandDown(handle.header.id)) return
      const summary = this.summarizeCold(
        // `exactOptionalPropertyTypes`: an absent format status is omitted,
        // never written as an explicit `undefined`.
        formatStatus === undefined ? { header: handle.header } : { header: handle.header, formatStatus },
        false,
      )
      // `api-session/added` is the list row's upsert on every consumer: the
      // refreshed `cached` block fills the keys no sequenced row holds, which
      // is exactly the state a version-bumped cold row is missing.
      this.ctx.emit('api-session/added', repaired === undefined ? summary : { ...summary, projections: repaired })
    } finally {
      await handle.close()
    }
  }

  /**
   * Whether a repair must stand down for this Session: the list service is
   * being disposed, or the Session attached while the repair ran and its own
   * live fold now owns the checkpoint writes and the frames clients hear.
   * @param sessionId - the Session the repair currently works on.
   * @returns `true` when the repair must not write or publish.
   */
  private repairStandDown(sessionId: SessionId): boolean {
    return this.stopped || this.ctx.sessions.get(sessionId) !== undefined
  }
}

/**
 * Wrap one summary projection block as Session-list hints of the named sequence space.
 * The block is the summary key set's values, not every value the source holds.
 * @param kind - which sequence space the block's watermark belongs to.
 * @param block - the block, or `undefined` when no source served one.
 * @param trimHeavyProjections - when true, drop the display-heavy keys (see
 *   `SESSION_LIST_OMITTED_PROJECTION_KEYS`); omitted keeps every value the
 *   source holds — the pre-f5 full-column contract.
 * @returns the hints, or `undefined` when the block is absent or carries no
 * value the list keeps (see `SESSION_LIST_OMITTED_PROJECTION_KEYS`).
 */
function hintsOf(
  kind: SessionProjectionHints['kind'],
  block: ProjectionSnapshot | undefined,
  trimHeavyProjections = false,
): SessionProjectionHints | undefined {
  if (block === undefined || Object.keys(block.values).length === 0) return undefined
  if (!trimHeavyProjections) {
    // Listing hints contain every wire value the source currently holds but
    // remain partial: missing cells and cache rows are never materialized here.
    return { kind, asOfSeq: block.asOfSeq, values: block.values as SessionProjectionValues }
  }
  // Listing hints remain partial: missing cells and cache rows are never
  // materialized here. The display-heavy keys are filtered into a fresh
  // object — the source block is shared with the projection stores and must
  // never be mutated in place.
  const values = Object.fromEntries(
    Object.entries(block.values).filter(([key]) => !SESSION_LIST_OMITTED_PROJECTION_KEYS.has(key)),
  ) as SessionProjectionValues
  if (Object.keys(values).length === 0) return undefined
  return { kind, asOfSeq: block.asOfSeq, values }
}

function normalizeSearchQuery(query: string): string {
  const normalized = query.trim()
  if (normalized.length === 0) {
    throw new RemoteError('gateway/bad-request', 'session search query must not be empty', {})
  }
  if (normalized.length > SESSION_SEARCH_QUERY_MAX_CHARS) {
    throw new RemoteError(
      'gateway/bad-request',
      `session search query must contain at most ${SESSION_SEARCH_QUERY_MAX_CHARS} UTF-16 code units`,
      {},
    )
  }
  if (normalized.includes('\0')) {
    throw new RemoteError('gateway/bad-request', 'session search query must not contain NUL', {})
  }
  return normalized
}

function updatedAt(header: SessionHeader, metadata: SessionListMetadata | undefined): number {
  return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)
}

function listFields(header: SessionHeader): {
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
} {
  return {
    ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
  }
}
