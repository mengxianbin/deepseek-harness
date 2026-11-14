/**
 * Derives the workspace browser tree from caller-projected Workspace and
 * Session order. Unassigned Sessions trail under Ungrouped; blank (empty)
 * Sessions stay visible alongside ordinary ones.
 */
import {
  type SessionListState, type SessionSearchResultItem, type SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  SessionCompletionOutcome,
  SessionStatus,
  SessionStatusSnapshot,
} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'

/** Group key for Sessions outside every Workspace. */
export const UNGROUPED_KEY = ''

/**
 * Resolve the Workspace browser group that owns one Session.
 * @param workspaces - authoritative Workspace membership.
 * @param sessionId - Session whose browser group is required.
 * @returns owning Workspace id, or {@link UNGROUPED_KEY} when no Workspace accounts for it.
 */
export function owningGroupKey(
  workspaces: readonly WorkspaceView[],
  sessionId: SessionId,
): string {
  return (workspaces.find(workspace => workspace.sessionIds.includes(sessionId))
    ?.workspaceId as string | undefined) ?? UNGROUPED_KEY
}

/** Pending interaction kinds with dedicated Workspace-row presentation. */
export type SessionPendingInteractionStatus = 'approval' | 'plan-review' | 'question'
type SessionStatuses = SessionStatusSnapshot

function mainSessionId(list: SessionListState): SessionId | undefined {
  return Object.values(list.byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/** One top-level session row in a group or the flat list. */
export interface SessionNode {
  id: SessionId
  /** Stored title, or empty; the renderer localizes blank and unnamed row labels. */
  title: string
  /** The provisional blank session (renderer shows the localized New Session title). */
  blank: boolean
  /** A Session-scoped UI consumer is awaiting this user. */
  pendingInteraction?: SessionPendingInteractionStatus
  running: boolean
  /** Running direct children in the loaded subagent catalog. */
  runningSubagentCount: number
  /** Finished running while not selected and not yet opened (the reminder dot). */
  completed: boolean
  /** Outcome of that unviewed stop: `'failed'` renders the red error reminder. */
  completionOutcome?: SessionCompletionOutcome
  /** Live background jobs this Session owns; omitted while the count is zero. */
  activeJobCount?: number
  /** A durable goal is on the books while the Session is stopped — the wake-up weak mark. */
  pendingWakeup?: true
  /** The status could not be confirmed: the connection is down or reconnecting. */
  statusStale?: true
  /** The Host's status heartbeat went quiet for this Session: the shown status is the last one heard. */
  heartbeatStale?: true
  /** Wall-clock of that last confirmed frame — the stale ring's hover names the interruption's floor age. */
  heartbeatStaleSeconds?: number
  /** The user opened this row while it showed signals: a secondary row-end 已阅 check, never a signal clearer. */
  readMarked?: true
  /**
   * The Session's latest done receipt (collab step2 §二 亮灯层, step4b 件A):
   * verdict plus its 判据自证 for the hover card's third channel; the row dot
   * itself already carries the verdict through `completionOutcome`.
   */
  deliverableReceipt?: { verdict: 'pass' | 'exception'; summary: string; evidence?: readonly string[] }
  /** In the registry-global pin set: leads its section, reorderable only among pinned rows. */
  pinned: boolean
  /** In the registry-global archive set: shown grayed in place and not openable. */
  archived: boolean
  updatedAt: number
  /** Session working directory; absent when the Host reports none or an empty path. */
  cwd?: string
  /**
   * The owning group's short label for this row (collab step3 §6.1 一眼层:
   * title + home label + active time), sourced from the same Workspace title
   * the group header renders; absent for the ungrouped bucket, whose rows the
   * renderer localizes with `group.ungrouped`.
   */
  homeLabel?: string
}

/** Session order selected by the Workspace browser. */
export type SessionOrderBy = 'manual' | 'updated'

/** One workspace group section: header row facts + visible top-level session rows. */
export interface GroupNode {
  /** Group key: the workspace id or {@link UNGROUPED_KEY}. */
  key: string
  /** Backing Workspace id; absent only for the ungrouped bucket. */
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  /** Workspace creation time (epoch ms); absent only for the ungrouped bucket. */
  createdAt: number | undefined
  label: string
  /** Total visible sessions in the group (queued rows included — nothing is extracted anymore). */
  sessionCount: number
  /** Visible members queued red: tier p1, unread failed stops awaiting a ruling (queue-zone-1113). */
  queuedRed: number
  /** Visible members queued yellow: tier p0, rows awaiting the user's reply (queue-zone-1113). */
  queuedYellow: number
  expanded: boolean
  /** The group contains the selected session (active folder tint; supplied here so the renderer never scans). */
  containsCurrent: boolean
  /** Visible session rows (empty while the group is folded). */
  sessions: readonly SessionNode[]
}

/** One flat search row combining list metadata with an optional content match. */
export interface SearchResultNode {
  id: SessionId
  title: string
  workspace: string
  /** A Session-scoped UI consumer is awaiting this user. */
  pendingInteraction?: SessionPendingInteractionStatus
  running: boolean
  /** Running direct children in the loaded subagent catalog. */
  runningSubagentCount: number
  /** Finished running while not selected and not yet opened (the reminder dot). */
  completed: boolean
  /** Outcome of that unviewed stop: `'failed'` renders the red error reminder. */
  completionOutcome?: SessionCompletionOutcome
  /** Live background jobs this Session owns; omitted while the count is zero. */
  activeJobCount?: number
  /** A durable goal is on the books while the Session is stopped — the wake-up weak mark. */
  pendingWakeup?: true
  /** The status could not be confirmed: the connection is down or reconnecting. */
  statusStale?: true
  /** The Host's status heartbeat went quiet for this Session: the shown status is the last one heard. */
  heartbeatStale?: true
  /** Wall-clock of that last confirmed frame — the stale ring's hover names the interruption's floor age. */
  heartbeatStaleSeconds?: number
  /** In the registry-global archive set: shown grayed and not openable. */
  archived: boolean
  snippet?: string
}

/** Bounded merged search projection plus the refine-query hint bit. */
export interface SearchResultSet {
  items: readonly SearchResultNode[]
  hasMore: boolean
}

/** Viewing state consumed by the derivation. */
export interface TreeView {
  expandedGroups: readonly string[]
  /** Browser-local order for Sessions without a backing Workspace account. */
  ungroupedOrder?: readonly string[]
}

interface Group {
  key: string
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  createdAt: number | undefined
  label: string
  sessions: SessionSummary[]
}

/**
 * Directory display label: basename of the path (both separators accepted).
 * Ungrouped-bucket fallback for surfaces without a workspace title.
 * @param cwd - directory path, or undefined for the ungrouped bucket.
 * @returns basename, the raw cwd when it has no basename, or an empty ungrouped marker.
 */
export function workspaceLabel(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return ''
  const base = workspaceTitleOf(cwd)
  return base !== '' ? base : cwd
}

/**
 * Project known Workspace titles by Session identity: the group header's label
 * source, so row-level home labels (collab step3 §6.1 归宿短标), search result
 * labels, and the header itself all read one map instead of re-deriving.
 * @param workspaces - Workspace membership and display labels.
 * @returns the first Workspace title per member Session; loose Sessions are absent.
 */
function workspaceTitleBySession(workspaces: readonly WorkspaceView[]): Map<SessionId, string> {
  const titles = new Map<SessionId, string>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) {
      if (!titles.has(sessionId)) titles.set(sessionId, workspace.title)
    }
  }
  return titles
}

/**
 * Project known account members by current Session recency.
 * @param sessionIds - authoritative account membership.
 * @param summaries - current Session summaries; members without a summary are omitted until it arrives.
 * @returns known members newest first, with Session identity as the deterministic tie-break.
 */
export function orderByRecency(
  sessionIds: readonly SessionId[],
  summaries: SessionListState['byId'],
): SessionId[] {
  return sessionIds.flatMap((id) => {
    const summary = summaries[id]
    if (summary === undefined) return []
    return [{ id, rank: summary.updatedAt }]
  })
    .sort((a, b) => {
      if (a.rank !== b.rank) return b.rank - a.rank
      return a.id < b.id ? -1 : 1
    })
    .map(member => member.id)
}

/**
 * Reconcile a browser-local manual order with current account membership.
 * Saved entries retain their relative order; new ordinary members follow them by recency.
 * @param memberIds - authoritative account membership.
 * @param savedOrder - previously saved browser-local order.
 * @param summaries - current Session metadata; unknown new members wait for their summaries.
 * @param rowState - global pin and archive membership; only account members can supplement the order.
 * @returns saved relative positions plus missing members ordered by pin, recency, and archive status.
 */
export function reconcileManualOrder(
  memberIds: readonly SessionId[],
  savedOrder: readonly string[] | undefined,
  summaries: SessionListState['byId'],
  rowState?: Pick<SessionRowState, 'pinnedSessionIds' | 'archivedSessionIds'>,
): SessionId[] {
  const members = new Map(memberIds.map(id => [id as string, id]))
  const included = new Set<string>()
  const ordered: SessionId[] = []
  for (const key of savedOrder ?? []) {
    const id = members.get(key)
    if (id === undefined || included.has(key)) continue
    ordered.push(id)
    included.add(key)
  }
  const archived = new Set(rowState?.archivedSessionIds)
  const pins: SessionId[] = []
  for (const sessionId of rowState?.pinnedSessionIds ?? []) {
    const id = members.get(sessionId)
    if (id === undefined || included.has(id) || archived.has(id) || summaries[id] === undefined) continue
    pins.push(id)
    included.add(id)
  }
  const ordinary: SessionId[] = []
  const archives: SessionId[] = []
  for (const id of orderByRecency([...members.values()].filter(id => !included.has(id)), summaries)) {
    if (archived.has(id)) archives.push(id)
    else ordinary.push(id)
  }
  return [...pins, ...ordered, ...ordinary, ...archives]
}

/**
 * Keep the selected provisional New Session ahead of either base order.
 * @param order - recency or reconciled manual order.
 * @param currentBlank - selected blank Session in this account, when present.
 * @returns a copy with the selected blank first and no duplicate slot.
 */
export function pinCurrentBlank(
  order: readonly SessionId[],
  currentBlank: SessionId | undefined,
): SessionId[] {
  if (currentBlank === undefined) return [...order]
  return [currentBlank, ...order.filter(id => id !== currentBlank)]
}

/**
 * Archived-row visibility choice: the default hides archived rows, `show`
 * mixes them into their kept slots, and `only` restricts the view (and
 * search) to archived rows.
 */
export type ArchivedFilter = 'default' | 'show' | 'only'

/**
 * Ordinary and blank (empty) sessions are both visible; blank rows keep the
 * provisional New Session presentation. Subagent children use their parent
 * header catalog; archived sessions follow the archived filter, while their
 * accounting slots remain either way so unarchiving restores position.
 */
function sessionVisible(
  session: SessionSummary,
  archived: ReadonlySet<SessionId>,
  archivedFilter: ArchivedFilter,
): boolean {
  if (session.origin === 'subagent') return false
  switch (archivedFilter) {
    case 'default':
      return !archived.has(session.id)
    case 'show':
      return true
    case 'only':
      return archived.has(session.id)
    /* v8 ignore next 2 -- closed-union backstop; only reached if the filter is forged */
    default:
      return assertNever(archivedFilter)
  }
}

/** Registry-global row state consumed by every tree derivation. */
export interface SessionRowState {
  /** Registry-global pin ids; pinned rows lead their section in the local order. */
  pinnedSessionIds: readonly SessionId[]
  /** Archive set; members keep their slots and show grayed while visible. */
  archivedSessionIds: readonly SessionId[]
  /** Archived-row visibility choice applied to lists and search alike. */
  archivedFilter: ArchivedFilter
}

/**
 * Keep the visible New Session placeholder first, then partition pinned and
 * ordinary rows without changing either partition's caller order.
 */
function sectionMembers(
  members: readonly SessionSummary[],
  pinned: ReadonlySet<SessionId>,
  archived: ReadonlySet<SessionId>,
): SessionSummary[] {
  const placeholders: SessionSummary[] = []
  const leading: SessionSummary[] = []
  const rest: SessionSummary[] = []
  for (const member of members) {
    if (member.blank) placeholders.push(member)
    else if (!archived.has(member.id) && pinned.has(member.id)) leading.push(member)
    else rest.push(member)
  }
  return [...placeholders, ...leading, ...rest]
}

/**
 * Group member order after the 2026-11-13 ruling (queue-zone-1113): no global
 * segment exists, so queued rows stay inside their group and lead it — red
 * (tier p1) band first, yellow (tier p0) band after, each band newest first —
 * then the ordinary {@link sectionMembers} order (blank placeholder, pinned,
 * state rank, recency). A pinned+queued row appears once, in its queued band
 * (queued beats pinned, mirroring the old 队列段恒在置顶之前 placement).
 * @param members - the group's visible members in caller order.
 * @param queued - queued Session id → tier from {@link deriveQueue}.
 * @param pinned - registry-global pin set.
 * @param archived - registry-global archive set.
 * @returns members in render order.
 */
function queueBandedMembers(
  members: readonly SessionSummary[],
  queued: ReadonlyMap<SessionId, QueueTierId>,
  pinned: ReadonlySet<SessionId>,
  archived: ReadonlySet<SessionId>,
): SessionSummary[] {
  if (queued.size === 0) return sectionMembers(members, pinned, archived)
  const red: SessionSummary[] = []
  const yellow: SessionSummary[] = []
  const rest: SessionSummary[] = []
  for (const member of members) {
    const tier = queued.get(member.id)
    if (tier === 'p1') red.push(member)
    else if (tier === 'p0') yellow.push(member)
    else rest.push(member)
  }
  const byRecency = (left: SessionSummary, right: SessionSummary): number => right.updatedAt - left.updatedAt
  red.sort(byRecency)
  yellow.sort(byRecency)
  return [...red, ...yellow, ...sectionMembers(rest, pinned, archived)]
}

/**
 * A blank session is the selected Workspace's provisional New Session row;
 * its canonical title never enters search (blank rows are query-excluded)
 * and the renderer localizes its display label. Unnamed history also yields an
 * empty title for localization and does not match a directory-name title search.
 */
function sessionTitle(session: SessionSummary): string {
  return session.blank ? '' : (session.title?.trim() ?? '')
}

/** Build one group without projecting session lineage into presentation. */
function buildGroup(
  key: string,
  workspaceId: WorkspaceId | undefined,
  cwd: string | undefined,
  createdAt: number | undefined,
  label: string,
  members: readonly SessionSummary[],
): Group {
  return { key, workspaceId, cwd, createdAt, label, sessions: [...members] }
}

/** Apply a stored Ungrouped order and append newly loose Sessions by recency. */
function orderedUngrouped(
  members: readonly SessionSummary[],
  stored: readonly string[] | undefined,
  summaries: SessionListState['byId'],
): SessionSummary[] {
  const byId = new Map(members.map(session => [session.id as string, session]))
  const ids = stored === undefined
    ? orderByRecency(members.map(session => session.id), summaries)
    : reconcileManualOrder(members.map(session => session.id), stored, summaries)
  return ids.flatMap((id) => {
    const session = byId.get(id)
    /* v8 ignore next -- ids are projected exclusively from the members used to build byId. */
    return session === undefined ? [] : [session]
  })
}

/**
 * Group Sessions by Workspace: one group per caller-ordered entity, with
 * members resolved from caller-ordered sessionIds. Sessions outside every
 * Workspace trail in the browser-local Ungrouped order, which falls back to
 * recency before that order is initialized.
 */
function groupByWorkspace(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  archived: ReadonlySet<SessionId>,
  archivedFilter: ArchivedFilter,
  ungroupedOrder: readonly string[] | undefined,
): Group[] {
  const groups: Group[] = []
  const accounted = new Set<SessionId>()
  for (const workspace of workspaces) {
    const members: SessionSummary[] = []
    for (const id of workspace.sessionIds) {
      const summary = list.byId[id]
      if (summary === undefined) continue // account may lead the list pull; the row appears when the summary lands
      accounted.add(id)
      if (!sessionVisible(summary, archived, archivedFilter)) continue
      members.push(summary)
    }
    // The archived-only view lists archives, not the Workspace inventory, so
    // a Workspace without archived Sessions contributes no group.
    if (archivedFilter === 'only' && members.length === 0) continue
    groups.push(buildGroup(
      workspace.workspaceId, workspace.workspaceId, workspace.path,
      Date.parse(workspace.createdAt), workspace.title, members,
    ))
  }
  const stray = list.ids
    .map(id => list.byId[id])
    .filter((s): s is SessionSummary =>
      s !== undefined && !accounted.has(s.id) && sessionVisible(s, archived, archivedFilter))
  if (stray.length > 0) {
    groups.push(buildGroup(
      UNGROUPED_KEY,
      undefined,
      undefined,
      undefined,
      '',
      orderedUngrouped(stray, ungroupedOrder, list.byId),
    ))
  }
  return groups
}

/** Keep navigation presentation independent from domain-owned interaction objects. */
function visiblePendingKind(kind: string | undefined): SessionPendingInteractionStatus | undefined {
  switch (kind) {
    case 'approval':
    case 'plan-review':
    case 'question':
      return kind
    default:
      return undefined
  }
}

function runningChildCount(list: SessionListState, parentId: SessionId, statuses: SessionStatuses): number {
  return list.projectionsBySession[parentId]?.values.subagentCatalog?.reduce(
    (count, child) => count + ((statuses.get(child.id)?.running ?? list.byId[child.id]?.running) === true ? 1 : 0),
    0,
  ) ?? 0
}

function sessionNode(
  s: SessionSummary,
  list: SessionListState,
  statuses: SessionStatuses,
  pinned: ReadonlySet<SessionId>,
  archived: ReadonlySet<SessionId>,
  homeLabel: string,
): SessionNode {
  const status = statuses.get(s.id)
  const pendingInteraction = visiblePendingKind(status?.pendingInteraction?.kind)
  const completionOutcome = status?.completionOutcome
  const activeJobCount = status?.activeJobCount
  const pendingWakeup = status?.pendingWakeup
  const statusStale = status?.statusStale
  const heartbeatStale = status?.heartbeatStale
  const heartbeatStaleSeconds = status?.heartbeatStaleSeconds
  const readMarked = status?.readMarked
  const deliverableReceipt = status?.deliverableReceipt
  return {
    id: s.id,
    title: sessionTitle(s),
    blank: s.blank,
    running: status?.running ?? s.running,
    runningSubagentCount: runningChildCount(list, s.id, statuses),
    completed: status?.completionUnread === true,
    ...(completionOutcome === undefined ? {} : { completionOutcome }),
    ...(activeJobCount === undefined ? {} : { activeJobCount }),
    ...(pendingWakeup === undefined ? {} : { pendingWakeup }),
    ...(statusStale === undefined ? {} : { statusStale }),
    ...(heartbeatStale === undefined ? {} : { heartbeatStale }),
    ...(heartbeatStaleSeconds === undefined ? {} : { heartbeatStaleSeconds }),
    ...(readMarked === undefined ? {} : { readMarked }),
    ...(deliverableReceipt === undefined ? {} : { deliverableReceipt }),
    pinned: !archived.has(s.id) && pinned.has(s.id),
    archived: archived.has(s.id),
    updatedAt: s.updatedAt,
    ...(s.cwd === undefined || s.cwd === '' ? {} : { cwd: s.cwd }),
    ...(homeLabel === '' ? {} : { homeLabel }),
    ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
  }
}

/**
 * Derive the workspace browser groups with every session as a top-level row.
 *
 * Every group shows, except that the archived-only filter drops groups
 * without visible members; sessions populate under expanded groups with
 * pinned rows leading in the selected local order. Blank sessions stay
 * visible (the selected provisional New Session row leads its section);
 * archived sessions keep their slots and appear per the archived filter.
 * Content search lives outside this derivation (see {@link deriveSearchResults}).
 *
 * Queue bands (queue-zone-1113, 2026-11-13 ruling): there is no global
 * 「要我拿主意」 segment anymore — queued rows never leave their group. Inside an
 * expanded group they lead it, red (p1) first and yellow (p0) after, each band
 * newest first, ahead of the ordinary section (blank placeholder, pinned, state
 * rank, recency); a pinned+queued row shows once, in its queued band. Folded
 * groups keep their `queuedRed`/`queuedYellow` counts for the header badge.
 * @param list - sessions list snapshot (`mainView` retention feeds containsCurrent).
 * @param workspaces - real Workspaces in Host group order with caller-projected Session order.
 * @param rowState - registry-global pin and archive sets plus the archived filter.
 * @param statuses - unified UI status by Session.
 * @param view - local expansion arrays.
 * @param queued - every queued Session id → its tier (`'p1'` red / `'p0'` yellow),
 *   from {@link deriveQueue}; empty in compositions that queue nothing.
 * @returns group sections in render order.
 */
export function deriveGroups(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  rowState: SessionRowState,
  statuses: SessionStatuses,
  view: TreeView,
  queued: ReadonlyMap<SessionId, QueueTierId> = new Map(),
): GroupNode[] {
  const archived = new Set(rowState.archivedSessionIds)
  const pinned = new Set(rowState.pinnedSessionIds)
  const expandedGroups = new Set(view.expandedGroups)
  const current = mainSessionId(list)
  const currentGroup = current === undefined
    ? undefined
    : owningGroupKey(workspaces, current)
  const groups: GroupNode[] = []
  for (const g of groupByWorkspace(list, workspaces, archived, rowState.archivedFilter, view.ungroupedOrder)) {
    const expanded = expandedGroups.has(g.key)
    const members = g.sessions
    let queuedRed = 0
    let queuedYellow = 0
    for (const member of members) {
      const tier = queued.get(member.id)
      if (tier === 'p1') queuedRed += 1
      else if (tier === 'p0') queuedYellow += 1
    }
    groups.push({
      key: g.key,
      workspaceId: g.workspaceId,
      cwd: g.cwd,
      createdAt: g.createdAt,
      label: g.label,
      sessionCount: members.length,
      queuedRed,
      queuedYellow,
      expanded,
      containsCurrent: g.key === currentGroup,
      sessions: expanded
        ? queueBandedMembers(members, queued, pinned, archived)
          .map(session => sessionNode(session, list, statuses, pinned, archived, g.label))
        : [],
    })
  }
  return groups
}

/**
 * Select complete flat-list membership, independently of archive visibility.
 * @param list - sessions list snapshot.
 * @returns known ordinary Session ids, including archives and blanks.
 */
export function sessionMemberIds(list: SessionListState): SessionId[] {
  return visibleSessionIds(list, [], 'show')
}

/**
 * Select visible flat-list members without deriving row presentation or ordering.
 * @param list - sessions list snapshot.
 * @param archivedSessionIds - registry-global archive set.
 * @param archivedFilter - archived-row visibility choice.
 * @returns known visible Session ids in list order, including ordinary forks and blanks.
 */
export function visibleSessionIds(
  list: SessionListState,
  archivedSessionIds: readonly SessionId[],
  archivedFilter: ArchivedFilter,
): SessionId[] {
  const archived = new Set(archivedSessionIds)
  return list.ids.filter((id) => {
    const s = list.byId[id]
    return s !== undefined && sessionVisible(s, archived, archivedFilter)
  })
}

/**
 * Derive flat rows from the browser's complete ordered Session ids, with
 * pinned rows fronted ahead of the supplied order.
 * @param list - sessions list snapshot used to select the ids.
 * @param sessionIds - complete account members in the selected order, including hidden archives.
 * @param rowState - registry-global pin and archive sets plus the archived filter.
 * @param statuses - unified UI status by Session.
 * @param workspaces - Workspace membership for each row's home label (collab step3
 *   §6.1 归宿短标); empty in compositions without the Workspace baseline.
 * @returns flat rows in sectioned order with current status indicators.
 */
export function deriveFlat(
  list: SessionListState,
  sessionIds: readonly SessionId[],
  rowState: SessionRowState,
  statuses: SessionStatuses,
  workspaces: readonly WorkspaceView[] = [],
): SessionNode[] {
  const archived = new Set(rowState.archivedSessionIds)
  const pinned = new Set(rowState.pinnedSessionIds)
  const homeLabels = workspaceTitleBySession(workspaces)
  const members = sessionIds.flatMap((id) => {
    const session = list.byId[id]
    return session !== undefined && sessionVisible(session, archived, rowState.archivedFilter)
      ? [session]
      : []
  })
  return sectionMembers(members, pinned, archived)
    .map(session => sessionNode(session, list, statuses, pinned, archived, homeLabels.get(session.id) ?? ''))
}

/**
 * Flat-list queue lift (queue-zone-1113, 2026-11-13 ruling): queued rows leave
 * their supplied position and lead the list — the red band (tier p1) first,
 * the yellow band (tier p0) after, each band newest first — while every other
 * row keeps its supplied order untouched. Returns `rows` itself when nothing
 * queued is present, so memo identities stay stable.
 * @param rows - flat rows in the browser's selected order.
 * @param queued - queued Session id → tier from {@link deriveQueue}.
 * @returns rows with the queued bands lifted to the top.
 */
export function liftQueuedRows(
  rows: readonly SessionNode[],
  queued: ReadonlyMap<SessionId, QueueTierId>,
): readonly SessionNode[] {
  if (queued.size === 0) return rows
  const red: SessionNode[] = []
  const yellow: SessionNode[] = []
  const rest: SessionNode[] = []
  for (const row of rows) {
    const tier = queued.get(row.id)
    if (tier === 'p1') red.push(row)
    else if (tier === 'p0') yellow.push(row)
    else rest.push(row)
  }
  if (red.length === 0 && yellow.length === 0) return rows
  const byRecency = (left: SessionNode, right: SessionNode): number => right.updatedAt - left.updatedAt
  red.sort(byRecency)
  yellow.sort(byRecency)
  return [...red, ...yellow, ...rest]
}

/**
 * Merge immediate title/Workspace/Session id substring matches with ranked Host content
 * matches. Local rows lead newest-first, content-only rows retain backend
 * order, and duplicate sessions receive the backend snippet in place.
 * @param list - session metadata authority.
 * @param workspaces - Workspace membership and display labels.
 * @param query - caller text; surrounding whitespace is ignored.
 * @param archivedSessionIds - registry-global archive set (members match per the archived filter).
 * @param archivedFilter - archived-row visibility choice; search follows it.
 * @param statuses - unified UI status by Session.
 * @param content - ranked Host content-search page.
 * @param limit - protocol-owned maximum merged row count.
 * @returns bounded deduplicated flat rows and a refine-query hint bit.
 */
export function deriveSearchResults(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  query: string,
  archivedSessionIds: readonly SessionId[],
  archivedFilter: ArchivedFilter,
  statuses: SessionStatuses,
  content: { items: readonly SessionSearchResultItem[]; hasMore: boolean },
  limit: number,
): SearchResultSet {
  const q = query.trim().toLowerCase()
  if (q === '') return { items: [], hasMore: false }
  const archived = new Set(archivedSessionIds)

  const workspaceBySession = workspaceTitleBySession(workspaces)
  const labelOf = (summary: SessionSummary): string =>
    workspaceBySession.get(summary.id) ?? workspaceLabel(summary.cwd)
  const contentBySession = new Map<SessionId, SessionSearchResultItem>()
  for (const item of content.items) {
    if (!contentBySession.has(item.sessionId)) contentBySession.set(item.sessionId, item)
  }

  const local: SessionSummary[] = []
  for (const id of list.ids) {
    const summary = list.byId[id]
    // Blank placeholders never match a query (their canonical title displays
    // localized, so matching it would tie search to one language).
    if (summary === undefined || summary.blank || !sessionVisible(summary, archived, archivedFilter)) continue
    if (
      sessionTitle(summary).toLowerCase().includes(q)
      || labelOf(summary).toLowerCase().includes(q)
      || summary.id.toLowerCase().includes(q)
    ) {
      local.push(summary)
    }
  }
  const localById = new Map(local.map(summary => [summary.id, summary]))
  const orderedLocal = orderByRecency(local.map(summary => summary.id), list.byId)
    .map(id => localById.get(id) as SessionSummary)

  const ordered: SessionSummary[] = []
  const included = new Set<SessionId>()
  const include = (summary: SessionSummary): void => {
    if (included.has(summary.id)) return
    included.add(summary.id)
    ordered.push(summary)
  }
  for (const summary of orderedLocal) include(summary)
  for (const item of content.items) {
    const summary = list.byId[item.sessionId]
    if (summary !== undefined && !summary.blank && sessionVisible(summary, archived, archivedFilter)) include(summary)
  }

  return {
    items: ordered.slice(0, limit).map((summary) => {
      const match = contentBySession.get(summary.id)
      const status = statuses.get(summary.id)
      const pendingInteraction = visiblePendingKind(status?.pendingInteraction?.kind)
      const completionOutcome = status?.completionOutcome
      const activeJobCount = status?.activeJobCount
      const pendingWakeup = status?.pendingWakeup
      const statusStale = status?.statusStale
      const heartbeatStale = status?.heartbeatStale
      return {
        id: summary.id,
        title: sessionTitle(summary),
        workspace: labelOf(summary),
        running: status?.running ?? summary.running,
        runningSubagentCount: runningChildCount(list, summary.id, statuses),
        ...(pendingInteraction === undefined
          ? {}
          : { pendingInteraction }),
        completed: status?.completionUnread === true,
        ...(completionOutcome === undefined ? {} : { completionOutcome }),
        ...(activeJobCount === undefined ? {} : { activeJobCount }),
        ...(pendingWakeup === undefined ? {} : { pendingWakeup }),
        ...(statusStale === undefined ? {} : { statusStale }),
        ...(heartbeatStale === undefined ? {} : { heartbeatStale }),
        ...(status?.heartbeatStaleSeconds === undefined ? {} : { heartbeatStaleSeconds: status.heartbeatStaleSeconds }),
        archived: archived.has(summary.id),
        ...match === undefined ? {} : { snippet: match.snippet },
      }
    }),
    hasMore: content.hasMore || ordered.length > limit,
  }
}

/** Normalize separators for comparison without interpreting POSIX backslashes as separators. */
function folderPath(path: string): string {
  const windows = /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
  return (windows ? path.replaceAll('\\', '/') : path).replace(/\/+$/, '')
}

/**
 * Find the nearest registered ancestor, excluding the Workspace directory itself.
 * Paths use Host spelling; matching is case-sensitive, like Workspace identity.
 * @param path - Workspace directory.
 * @param parents - registered Workspace directory paths.
 * @returns the owning parent path, or undefined when no parent contains the Workspace.
 */
export function owningParentFolder(path: string, parents: readonly string[]): string | undefined {
  const child = folderPath(path)
  let owner: string | undefined
  let length = -1
  for (const parent of parents) {
    const root = folderPath(parent)
    if (root.length > length && child !== root && child.startsWith(`${root}/`)) {
      owner = parent
      length = root.length
    }
  }
  return owner
}

/** One queue tier (classification only since queue-zone-1113 — nothing renders a tier as a segment). */
export interface QueueTier {
  /** Human-queue tier label key: `'p0'` (等回话·被卡, yellow) or `'p1'` (死局/验收例外, red). */
  tier: QueueTierId
  /** Tier rows ordered by recency; severity deliberately stays out of the order. */
  sessions: readonly SessionNode[]
}

/**
 * Queue tier of one queued Session: `'p1'` red (unread failed stop awaiting a
 * ruling) or `'p0'` yellow (awaiting the user's reply). Rendered order is
 * always red first (queue-zone-1113), whatever the internal tier array order.
 */
export type QueueTierId = 'p0' | 'p1'

/** The queue classification: populated tiers plus every queued id with its tier. */
export interface QueueSegment {
  /**
   * Populated tiers in internal tier order (P0 before P1). Since
   * queue-zone-1113 no surface renders them directly — the group bands and
   * the flat lift read `queued` and always paint red before yellow.
   */
  tiers: readonly QueueTier[]
  /**
   * Every queued Session id → its tier. Queued rows never leave their
   * Workspace group (queue-zone-1113); this map is what orders them to the
   * group's top and what the group header badge counts.
   */
  queued: ReadonlyMap<SessionId, QueueTierId>
}

/**
 * Classify the 「要我拿主意」 rows (collab step3 §一 裁定 C · 混合): P0 holds
 * awaiting-interaction rows, P1 holds unread failed stops awaiting a ruling.
 * P1 skips rows currently running (2026-10-31 在跑出队裁定): a re-run is
 * already being handled, yet its previous failure's durable projection only
 * flips when the new turn ends, which used to strand a live run in the queue
 * for its whole duration. P0 keeps its rows regardless — 等回话 outranks. P2
 * (泄漏) and P3 (没在跑) keep no mechanical carrier on this list yet (step3
 * §3.1 marks both 无现行), so they populate nothing rather than guess. Within a
 * tier rows order by recency — severity is a hover/color label and never a
 * queue key (step1 §2.3 终态收敛). Archived and blank rows never queue.
 * Subagent rows never queue either — same rule as `sessionVisible`: they
 * surface through their parent's catalog, never as standalone rows.
 *
 * queue-zone-1113 (2026-11-13 ruling): this is a pure classifier, not a
 * placement. There is no global segment, count bar, or fold — every queued
 * row renders inside its Workspace group, red band first, yellow band after
 * ({@link deriveGroups}), or lifted to the top of the flat list
 * ({@link liftQueuedRows}).
 * @param list - sessions list snapshot.
 * @param statuses - unified UI status by Session.
 * @param archivedIds - registry-global archive set.
 * @param workspaces - Workspace membership for each queued row's home label
 *   (collab step3 §6.1 归宿短标); empty in compositions without the Workspace baseline.
 * @returns the populated tiers plus the queued id → tier map.
 */
export function deriveQueue(
  list: SessionListState,
  statuses: SessionStatuses,
  archivedIds: readonly SessionId[],
  workspaces: readonly WorkspaceView[] = [],
): QueueSegment {
  const archived = new Set(archivedIds)
  const pinned = new Set<SessionId>()
  const homeLabels = workspaceTitleBySession(workspaces)
  const p0: SessionNode[] = []
  const p1: SessionNode[] = []
  for (const id of list.ids) {
    const s = list.byId[id]
    if (s === undefined || s.blank || s.origin === 'subagent' || archived.has(id)) continue
    const node = sessionNode(s, list, statuses, pinned, archived, homeLabels.get(id) ?? '')
    if (node.pendingInteraction !== undefined) p0.push(node)
    // 在跑不出队 (2026-10-31 裁定): a live re-run is being handled, not
    // awaiting a ruling; an unknown running state keeps the row visible.
    else if (!node.running && node.completed && node.completionOutcome === 'failed') p1.push(node)
  }
  const byRecency = (left: SessionNode, right: SessionNode): number => right.updatedAt - left.updatedAt
  p0.sort(byRecency)
  p1.sort(byRecency)
  const tiers: QueueTier[] = []
  const queued = new Map<SessionId, QueueTierId>()
  if (p0.length > 0) {
    tiers.push({ tier: 'p0', sessions: p0 })
    for (const node of p0) queued.set(node.id, 'p0')
  }
  if (p1.length > 0) {
    tiers.push({ tier: 'p1', sessions: p1 })
    for (const node of p1) queued.set(node.id, 'p1')
  }
  return { tiers, queued }
}

/**
 * 回合归属状态序档位 (拍板账⑧, 2026-11-01 修订): the three tiers the ②段
 * sorts by — 已完成 > 静默 > 运行中.
 */
export type RestingState = 'completed' | 'silent' | 'running'

/** Rank of each {@link RestingState}; lower sorts earlier. */
const RESTING_STATE_RANK: Readonly<Record<RestingState, number>> = {
  completed: 0,
  silent: 1,
  running: 2,
}

/**
 * Map one row onto its 回合归属 tier (状态序 mapping 口径, step3 §一 ⑧):
 * - `running` — the ball is under the bot's feet, so the row sinks (防打扰).
 *   Checked first: a durable green dot from a previous turn stays lit while the
 *   next turn runs, and that row is not awaiting my acceptance yet.
 * - otherwise `completionUnread` — the 待收讫 dot is the "waiting on me" state.
 * - otherwise `silent` — stopped with nothing owed to either side.
 * `running` reads the live status when it carries one and falls back to the
 * Host list row, the same precedence `sessionNode` uses for the rendered dot.
 * @param summary - list row carrying the Host running baseline.
 * @param status - live UI status for that row, when one has been published.
 * @returns the row's tier.
 */
export function restingStateOf(
  summary: Pick<SessionSummary, 'running'>,
  status: SessionStatus | undefined,
): RestingState {
  const running = status?.running ?? summary.running
  if (running) return 'running'
  if (status?.completionUnread === true) return 'completed'
  return 'silent'
}

/**
 * Ordering of the rows a group band does not lift (collab step3 §6.2 q6-attr,
 * revised by 拍板账⑧): `f(置顶过渡优先, 状态序[已完成 > 静默 > 运行中], 最后活跃时间)`.
 * Since queue-zone-1113 the queued red/yellow bands sit above whatever this
 * comparator orders (see {@link queueBandedMembers}); the comparator still
 * fixes the order of everything else, queued rows included upstream.
 * Pure: the caller feeds the row facts and holds no second state. The
 * attribute plane is out of the sort key as of 拍板账⑧ — 优先级 no longer
 * ranks anything here; the 属性缺省 hover hint in `rows/Rows.tsx` keeps naming
 * the default placement to the user, which is display only.
 *
 * 排序只在加载/刷新时计算 (取舍记录): the sort is a pure function of the
 * snapshot the caller hands over, so the order changes only when a list or
 * status snapshot lands — never per render tick and never off a relative clock,
 * which is what keeps rows from jittering. A status snapshot *is* a load, so a
 * state transition does move its row once (完成时状态翻转自然上浮 = 状态迁移即
 * 通知); the secondary key is the absolute `updatedAt`, so a moved row never
 * re-shuffles inside its new tier and one transition never moves a row twice.
 * The render phase cannot postpone that single move without holding a stale
 * snapshot, so "只在加载/刷新时计算" is realized as "computed from the
 * snapshot, not from the clock" — recorded here because the tradeoff is a
 * deliberate one rather than an oversight.
 *
 * Reserved slots (四留口子, 槽位已留不接线 — comments only, zero behaviour):
 * ① 红点例外拉起 — a provably hung red-dot row lifts above its own tier;
 * ② 假运行中降级 — a stuck "running" row drops to its true tier;
 * ③ 完成者二级键 — owner-aware tie-break inside 已完成 (needs the bot/human
 * ownership ruling first, so the slot stays empty until then);
 * ④ bot 泳道 — owner lanes that keep bot churn out of human work in-tray.
 * None of the four feeds this comparator yet; adding one is a follow-up task.
 *
 * Manual drag order stays the caller's business (this comparator ranks rows
 * handed to it unsorted).
 * @param left - left row facts.
 * @param right - right row facts.
 * @returns the sort rank: negative when left leads.
 */
export function compareRestingRows(
  left: { readonly pinned: boolean; readonly state: RestingState; readonly updatedAt: number },
  right: { readonly pinned: boolean; readonly state: RestingState; readonly updatedAt: number },
): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
  const rank = RESTING_STATE_RANK[left.state] - RESTING_STATE_RANK[right.state]
  if (rank !== 0) return rank
  return right.updatedAt - left.updatedAt
}

/**
 * Project known account members by 回合归属状态序 then last activity — the
 * real-chain counterpart of {@link orderByRecency} for the default
 * (最近更新) view. Rows without a summary are omitted until it arrives; the
 * id tie-break keeps equal facts deterministic.
 * @param sessionIds - authoritative account membership.
 * @param summaries - current Session summaries.
 * @param statuses - unified UI status by Session, for the 状态序 tier.
 * @param rowState - global pin and archive membership (置顶过渡优先).
 * @returns known members ordered by pin, tier, then newest first.
 */
export function orderByResting(
  sessionIds: readonly SessionId[],
  summaries: SessionListState['byId'],
  statuses: SessionStatusSnapshot,
  rowState?: Pick<SessionRowState, 'pinnedSessionIds' | 'archivedSessionIds'>,
): SessionId[] {
  const pinned = new Set(rowState?.pinnedSessionIds)
  const archived = new Set(rowState?.archivedSessionIds)
  return sessionIds.flatMap((id) => {
    const summary = summaries[id]
    if (summary === undefined) return []
    return [{
      id,
      facts: {
        pinned: pinned.has(id) && !archived.has(id),
        state: restingStateOf(summary, statuses.get(id)),
        updatedAt: summary.updatedAt,
      },
    }]
  })
    .sort((a, b) => {
      const rank = compareRestingRows(a.facts, b.facts)
      if (rank !== 0) return rank
      return a.id < b.id ? -1 : 1
    })
    .map(member => member.id)
}
