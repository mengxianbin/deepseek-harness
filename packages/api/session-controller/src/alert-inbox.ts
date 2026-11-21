/**
 * The alert-inbox fold (设计档 `session-revival-v2-alert-inbox-1116.md` §七): the
 * SINGLE writer of `<dsh-home>/alert-inbox.json`. The heartbeat sweep folds the
 * revive state machine's export (`session-revive-v2-state.json` — contract twin
 * of #revive-v2-probe-statemachine-1116's writer) into clustered event-family
 * entries. Clustering happens HERE, on the write side, exactly once: 同因 +
 * 同时段 → 一个事件族 (168 observed attempts fold into 1 entry); the envelope
 * badge and duty-inventory only read the published counts, never re-cluster —
 * ⛔ never a display-layer feature (§七 数据层).
 *
 * Mounted on the existing 15s heartbeat sweep (revive-health precedent): no new
 * process, no new timer, change-only writes (a tick with no flip does not
 * write). Absence of the state export is quiet — 面消失 ≠ 面变坏: until the
 * sibling task lands and the Host restarts, the plane is simply not attached
 * and the badge renders nothing. An unparseable inbox document degrades the
 * badge (`undefined`) and is NEVER clobbered from state: a corrupt file may
 * hold conclusions (结论不能删), so it waits for a human while duty reports the
 * read failure loudly (duty-inventory fail-closed on its side).
 *
 * Three channels are gone — 2026-11-18 改版裁定 C/D supersedes §七 旧三通道:
 * - 客观恢复 (auto-archive) and 超时升级 (escalated) are **retired**: an entry
 *   never disappears on its own; red clears only by a human action.
 * - 人工确认 stays: {@link acknowledgeAlert} marks read (leaves the unread
 *   column, keeps the body), {@link restoreAlert} puts it back, and
 *   {@link setAlertResolution} backfills the conclusion pointer — conclusions
 *   stay readable forever (结论不能删).
 * - **多信源、单写者 (改判 D)**: the m-note restart/death source
 *   (`restart-alert-source.json`, writer = `scripts/dsh/restart-alert-source.py`)
 *   is folded here as category entries — sources deliver, only this module
 *   reads-modifies-writes the box.
 *
 * File-name twins (keep in sync): `session-revive-v2-state.json` with the
 * sibling task's writer (设计档 §七 接口契约) and `alert-inbox.json` with m-note
 * `scripts/dsh/duty-inventory.py` `ALERT_INBOX_PATH`.
 * @module session-controller/alert-inbox
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { AlertInboxReport } from './types.ts'

/** The inbox document filename under the DSH home (twin: m-note duty-inventory.py). */
export const ALERT_INBOX_FILE = 'alert-inbox.json'

/** The revive state machine's export filename (contract twin, 设计档 §七). */
export const REVIVE_V2_STATE_FILE = 'session-revive-v2-state.json'

/** The m-note restart/death source filename (信源契约, 设计档 §七「重启/死因信源契约」). */
export const RESTART_ALERT_SOURCE_FILE = 'restart-alert-source.json'

/** Cooling window (§八 已定: 冷却 10 分钟) — twin of the state machine's cooldown policy. */
export const ALERT_COOLDOWN_MS = 10 * 60 * 1000

// ALERT_ESCALATE_AFTER_MS (超时升级) retired with 改判 C — an unread entry never
// flips on its own; the red is cleared by 已读 only.
// ALERT_FAMILY_WINDOW_MS (同时段聚类) retired with 改判 B — the cluster key is
// the 分类 (one open entry per cause), not a time window.

/** The probe-alarm event cause (§五: 探针持续红 → 清单「可能探针自己坏了」). */
export const PROBE_RED_CAUSE = 'probe-red-alarm'

/** 结论回填 (§七 行动面回路): the investigation's conclusion pointer, written by the action face. */
export interface AlertInboxResolution {
  /** Epoch ms the conclusion was backfilled. */
  readonly at: number
  /** Pointer to the conclusion document / board row (已处理 → 指向结论档/看板行). */
  readonly ref: string
  /** Optional free note beside the pointer. */
  readonly note?: string
}

/** One clustered event family (§七 条目字段: 起止时刻 / 影响对象 / 处置与消耗 / 自愈方式 / 追查会话 id). */
export interface AlertInboxEntry {
  readonly id: string
  /** The cluster key (同因): failure form, stop reason, or {@link PROBE_RED_CAUSE}. */
  readonly cause: string
  /** First observed attempt of the family (起). */
  readonly startedAt: number
  /** Last observed attempt; freezes at archive (止). */
  readonly lastAt: number
  /** Archive stamp; null while open (止时刻). */
  readonly endedAt: number | null
  /** First delivery into the inbox — escalation counts from here; null while internal (未投递). */
  readonly deliveredAt: number | null
  /** 影响对象: every session that fed this family. */
  readonly sessionIds: readonly string[]
  /** 处置与消耗: failure observations folded into this family (复活几次的聚类计数). */
  readonly attempts: number
  /** 处置与消耗: summed failure tokens. */
  readonly tokens: number
  /** 自愈方式: `auto` (网络恢复) / `relay` (接力) / `manual` (人工介入); null while unresolved. */
  readonly heal: string | null
  /** 关联追查会话 id — the action face links it when an investigation starts. */
  readonly investigationSessionId: string | null
  /** Unread = 未处理 (the badge count; duty 对账基准). */
  readonly unread: boolean
  /** Archived = in the mailbox archive. Never a physical delete (结论不能删). */
  readonly archived: boolean
  /** 超时升级 flag — **retired (改判 C)**: kept in the shape for document
   *  compatibility, always false; red clears only through 已读. */
  readonly escalated: boolean
  /** 结论回填; null until the action face backfills. */
  readonly resolution: AlertInboxResolution | null
}

/** Per-session ingest watermark (bounded to sessions present in the current state export). */
export interface SeenFact {
  /** The highest `lastFailureAt` this fold has already turned into an attempt event. */
  readonly failureAt: number
  /** Whether the probe alarm was already observed high (a rise = one event). */
  readonly probeRed: boolean
}

/** The alert-inbox document shape (writer = this module; reader = duty-inventory). */
export interface AlertInboxDocument {
  /** Epoch ms of the last content change (change-only stamp; 0 until the first flip). */
  readonly at: number
  readonly seen: Readonly<Record<string, SeenFact>>
  readonly entries: readonly AlertInboxEntry[]
}

/** The sibling task's state-export session record (设计档 §七 契约形状; fields typed `unknown` — the fold judges what it can read). */
export interface ReviveV2SessionState {
  readonly probe?: unknown
  readonly probeRedSince?: unknown
  readonly probeRedAlarmed?: unknown
  readonly zeroCostStrikes?: unknown
  readonly relayDepth?: unknown
  readonly progressRetry?: unknown
  readonly stopped?: unknown
  readonly lastFailureAt?: unknown
  readonly lastFailureForm?: unknown
  readonly lastFailureTokens?: unknown
  readonly episodeSpentTokens?: unknown
  readonly relaySessionId?: unknown
  readonly lastSuccessAt?: unknown
}

/** The sibling task's state-export document (`{ at, sessions: { <id>: record } }`). */
export interface ReviveV2StateDocument {
  readonly at?: unknown
  readonly sessions?: unknown
}

/** One fact object inside the restart-alert-source document (信源契约, 设计档 §七). */
export interface RestartAlertSourceFact {
  readonly lastAt?: unknown
  readonly count24h?: unknown
  readonly rle24?: unknown
}

/** The m-note source document (`{ at, schema, facts: { <cause>: fact } }`, pull 型). */
export interface RestartAlertSourceDocument {
  readonly at?: unknown
  readonly schema?: unknown
  readonly facts?: unknown
}

/** One fold's outcome: the next document plus whether its content flipped. */
export interface AlertInboxFoldResult {
  readonly doc: AlertInboxDocument
  /** The `seen` + `entries` payload differs from the base (`at`-excluded canonical compare). */
  readonly changed: boolean
}

/** One attempt observation derived from a state-export flip. */
interface AttemptEvent {
  readonly sessionId: string
  readonly at: number
  readonly cause: string
  readonly tokens: number
}

const EMPTY_DOC: AlertInboxDocument = { at: 0, seen: {}, entries: [] }

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function slug(cause: string): string {
  return cause.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'event'
}

function readSessions(state: ReviveV2StateDocument): Record<string, unknown> {
  const sessions = state.sessions
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return {}
  return sessions as Record<string, unknown>
}

function asSession(raw: unknown): ReviveV2SessionState | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as ReviveV2SessionState
    : undefined
}

/** Canonical entry spelling — the change-only compare is order-independent of the writer's key order. */
function canonicalEntry(entry: AlertInboxEntry): AlertInboxEntry {
  return {
    id: entry.id,
    cause: entry.cause,
    startedAt: entry.startedAt,
    lastAt: entry.lastAt,
    endedAt: entry.endedAt,
    deliveredAt: entry.deliveredAt,
    sessionIds: entry.sessionIds,
    attempts: entry.attempts,
    tokens: entry.tokens,
    heal: entry.heal,
    investigationSessionId: entry.investigationSessionId,
    unread: entry.unread,
    archived: entry.archived,
    escalated: entry.escalated,
    resolution: entry.resolution,
  }
}

function canonicalPayload(doc: Pick<AlertInboxDocument, 'seen' | 'entries'>): string {
  return JSON.stringify({ seen: sortedFacts(doc.seen), entries: doc.entries.map(canonicalEntry) })
}

function normalizeResolution(raw: unknown): AlertInboxResolution | null | undefined {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { at, ref, note } = raw as { at?: unknown; ref?: unknown; note?: unknown }
  // The conclusion pointer is the one field a fold must never guess at: a
  // document whose `ref` is not a string is not ours to rewrite (结论不能删).
  if (typeof ref !== 'string') return undefined
  return {
    at: numberOr(at, 0),
    ref,
    ...(typeof note === 'string' ? { note } : {}),
  }
}

function normalizeEntry(raw: unknown): AlertInboxEntry | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const entry = raw as Record<string, unknown>
  if (typeof entry.id !== 'string' || entry.id === '') return undefined
  // Redness/ownership bits must be exactly as written — a fold may neither
  // invent a red nor fake a green from a mistyped flag.
  if (typeof entry.unread !== 'boolean' || typeof entry.archived !== 'boolean' || typeof entry.escalated !== 'boolean') return undefined
  if (!Array.isArray(entry.sessionIds)) return undefined
  const resolution = normalizeResolution(entry.resolution)
  if (resolution === undefined) return undefined
  if (entry.investigationSessionId !== undefined && entry.investigationSessionId !== null && typeof entry.investigationSessionId !== 'string') return undefined
  const startedAt = numberOr(entry.startedAt, 0)
  return {
    id: entry.id,
    cause: typeof entry.cause === 'string' ? entry.cause : 'unknown',
    startedAt,
    lastAt: numberOr(entry.lastAt, startedAt),
    endedAt: typeof entry.endedAt === 'number' ? entry.endedAt : null,
    deliveredAt: typeof entry.deliveredAt === 'number' ? entry.deliveredAt : null,
    sessionIds: entry.sessionIds.filter((id): id is string => typeof id === 'string'),
    attempts: numberOr(entry.attempts, 0),
    tokens: numberOr(entry.tokens, 0),
    heal: typeof entry.heal === 'string' ? entry.heal : null,
    investigationSessionId: typeof entry.investigationSessionId === 'string' ? entry.investigationSessionId : null,
    unread: entry.unread,
    archived: entry.archived,
    escalated: entry.escalated,
    resolution,
  }
}

/**
 * Parse an on-disk document into the canonical shape.
 * @returns the document, or `undefined` when the payload is not a document
 *   this writer owns (caller must then degrade quietly and never clobber it).
 */
function normalizeDocument(payload: unknown): AlertInboxDocument | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { at, seen, entries } = payload as { at?: unknown; seen?: unknown; entries?: unknown }
  if (!Array.isArray(entries)) return undefined
  const normalizedSeen: Record<string, SeenFact> = {}
  if (seen !== undefined) {
    if (typeof seen !== 'object' || seen === null || Array.isArray(seen)) return undefined
    for (const [sessionId, fact] of Object.entries(seen)) {
      if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) return undefined
      const { failureAt, probeRed } = fact as { failureAt?: unknown; probeRed?: unknown }
      normalizedSeen[sessionId] = {
        failureAt: numberOr(failureAt, 0),
        probeRed: probeRed === true,
      }
    }
  }
  const normalizedEntries: AlertInboxEntry[] = []
  for (const raw of entries) {
    const entry = normalizeEntry(raw)
    // One unreadable entry means the whole document may hold a conclusion we
    // would destroy by rewriting — refuse, degrade the badge, let duty shout.
    if (entry === undefined) return undefined
    normalizedEntries.push(entry)
  }
  return {
    at: numberOr(at, 0),
    seen: normalizedSeen,
    entries: normalizedEntries,
  }
}

function uniqueId(entries: readonly AlertInboxEntry[], at: number, cause: string): string {
  const base = `fam-${at}-${slug(cause)}`
  let id = base
  let suffix = 2
  while (entries.some(entry => entry.id === id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  return id
}

function makeEntry(
  entries: readonly AlertInboxEntry[],
  fields: {
    cause: string
    at: number
    sessionId: string
    attempts: number
    tokens: number
  },
): AlertInboxEntry {
  return {
    id: uniqueId(entries, fields.at, fields.cause),
    cause: fields.cause,
    startedAt: fields.at,
    lastAt: fields.at,
    endedAt: null,
    deliveredAt: null,
    sessionIds: [fields.sessionId],
    attempts: fields.attempts,
    tokens: fields.tokens,
    heal: null,
    investigationSessionId: null,
    unread: false,
    archived: false,
    escalated: false,
    resolution: null,
  }
}

function deliver(entry: AlertInboxEntry, now: number): AlertInboxEntry {
  if (entry.deliveredAt !== null) return entry
  return { ...entry, deliveredAt: now, unread: true }
}

/**
 * Cluster one attempt event: **分类 (改判 B)** — one OPEN entry per cause; a
 * new cause starts its own family. The old 同时段 window is retired: sorting IS
 * the heat signal (`lastAt` refresh floats the class to the top) and the counts
 * live in `attempts`.
 */
function applyAttempt(entries: readonly AlertInboxEntry[], event: AttemptEvent): AlertInboxEntry[] {
  let target: AlertInboxEntry | undefined
  for (const entry of entries) {
    if (entry.archived || entry.cause !== event.cause) continue
    if (target === undefined || entry.lastAt > target.lastAt) target = entry
  }
  if (target === undefined) {
    return [...entries, makeEntry(entries, {
      cause: event.cause,
      at: event.at,
      sessionId: event.sessionId,
      attempts: 1,
      tokens: event.tokens,
    })]
  }
  return entries.map(entry => entry === target
    ? {
      ...entry,
      startedAt: Math.min(entry.startedAt, event.at),
      lastAt: Math.max(entry.lastAt, event.at),
      attempts: entry.attempts + 1,
      tokens: entry.tokens + event.tokens,
      sessionIds: entry.sessionIds.includes(event.sessionId)
        ? entry.sessionIds
        : [...entry.sessionIds, event.sessionId],
    }
    : entry)
}

/**
 * Deliver the family that carries this stopped session (§七: `stopped` 非空 =
 * 清单条目触发源). Prefers the open family whose cause matches the stop's
 * cause, then the most recent open family carrying the session; a stop with no
 * open family at all (skew: the export forgot the failure record) starts one
 * with zero observed attempts rather than swallowing the stop.
 */
function deliverFamily(
  entries: readonly AlertInboxEntry[],
  sessionId: string,
  cause: string,
  now: number,
): readonly AlertInboxEntry[] {
  const containing = entries.filter(entry => !entry.archived && entry.sessionIds.includes(sessionId))
  const target = containing.find(entry => entry.cause === cause)
    ?? containing.reduce<AlertInboxEntry | undefined>(
      (best, entry) => best === undefined || entry.lastAt > best.lastAt ? entry : best,
      undefined,
    )
  if (target !== undefined) return entries.map(entry => (entry === target ? deliver(entry, now) : entry))
  // Skew fallback: a stop whose failure record no open family carries (the
  // export forgot it) starts one rather than swallowing the stop. But an
  // ACKED/finished family for this session is NOT a reason to be red again —
  // a persistent `stopped` must not resurrect a filed entry every tick; only a
  // fresh family (fed by a fresh failure) may re-deliver.
  if (entries.some(entry => entry.sessionIds.includes(sessionId))) return entries
  const created = makeEntry(entries, { cause, at: now, sessionId, attempts: 0, tokens: 0 })
  return [...entries, deliver(created, now)]
}

/**
 * 客观恢复 verdict — **retired (改判 C)**: entries never auto-archive. Kept out
 * of the fold on purpose; a future reader must not resurrect the channel.
 */

/**
 * Pull-型信源 fact ingestion (改判 D, 设计档 §七「重启/死因信源契约」): one OPEN
 * category entry per fact key. Re-occurrence refreshes `lastAt` (浮顶) and
 * replaces the window count; **it never flips `unread`** — the red is cleared
 * by 已读 and re-armed only by 恢复 (human hands own both directions), so a
 * recurring class a human already read stays read until they restore it.
 */
function deliverSourceFact(
  entries: readonly AlertInboxEntry[],
  cause: string,
  lastAt: number,
  count: number,
  now: number,
): readonly AlertInboxEntry[] {
  const existing = entries.find(entry => entry.cause === cause && entry.sessionIds.length === 0)
  if (existing !== undefined) {
    return entries.map(entry => (entry === existing
      ? {
        ...entry,
        startedAt: Math.min(entry.startedAt, lastAt),
        lastAt: Math.max(entry.lastAt, lastAt),
        // 类内计数 = 本窗读数（count24h / rle24），刷新而非累加 —— 逐次证据留各源日志。
        attempts: count,
      }
      : entry))
  }
  const created: AlertInboxEntry = {
    id: uniqueId(entries, lastAt, cause),
    cause,
    startedAt: lastAt,
    lastAt,
    endedAt: null,
    deliveredAt: now,
    sessionIds: [],
    attempts: count,
    tokens: 0,
    heal: null,
    investigationSessionId: null,
    unread: true,
    archived: false,
    escalated: false,
    resolution: null,
  }
  return [...entries, created]
}

/** Parse the source document into `[cause, { lastAt, count }]` facts (tolerant reader). */
function readSourceFacts(source: RestartAlertSourceDocument): Array<[string, { lastAt: number; count: number }]> {
  const raw = source.facts
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
  const out: Array<[string, { lastAt: number; count: number }]> = []
  for (const cause of Object.keys(raw as Record<string, unknown>).sort()) {
    const fact = (raw as Record<string, unknown>)[cause]
    if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) continue
    const candidate = fact as RestartAlertSourceFact
    const lastAt = numberOr(candidate.lastAt, 0)
    if (lastAt <= 0) continue
    const count = numberOr(candidate.rle24, numberOr(candidate.count24h, 0))
    out.push([cause, { lastAt, count }])
  }
  return out
}

/**
 * Pure fold of one state export against the current document.
 * @param state - the parsed `session-revive-v2-state.json`, or `undefined` when
 *   absent/unreadable (quiet — ingest skips).
 * @param base - the parsed `alert-inbox.json`, or `undefined` when absent.
 * @param now - fold clock (injectable for tests).
 * @param source - the parsed `restart-alert-source.json` (pull 型信源, 改判 D),
 *   or `undefined` when absent — quiet, never broken.
 * @returns the next document, or `undefined` when no input exists (the
 *   plane is not attached — quiet, never broken).
 */
export function foldAlertInbox(
  state: ReviveV2StateDocument | undefined,
  base: AlertInboxDocument | undefined,
  now: number,
  source?: RestartAlertSourceDocument,
): AlertInboxFoldResult | undefined {
  if (state === undefined && base === undefined && source === undefined) return undefined
  let entries: readonly AlertInboxEntry[] = base?.entries ?? []
  let seen: Record<string, SeenFact> = { ...(base?.seen ?? {}) }

  if (state !== undefined) {
    const sessions = readSessions(state)
    // --- ingest: state flips into attempt events; the watermark is rebuilt
    // from the CURRENT export only (bounded file; a graduated session drops
    // out and would re-ingest its stamp once — accepted, count-only drift).
    const nextSeen: Record<string, SeenFact> = {}
    const events: AttemptEvent[] = []
    for (const sessionId of Object.keys(sessions).sort()) {
      const session = asSession(sessions[sessionId])
      if (session === undefined) continue
      const previous = seen[sessionId] ?? { failureAt: 0, probeRed: false }
      const failureAt = numberOr(session.lastFailureAt, 0)
      const cause = stringOr(session.lastFailureForm) ?? stringOr(session.stopped) ?? 'unknown'
      if (failureAt > previous.failureAt) {
        events.push({ sessionId, at: failureAt, cause, tokens: numberOr(session.lastFailureTokens, 0) })
      }
      const probeRed = session.probeRedAlarmed === true
      if (probeRed && !previous.probeRed) {
        events.push({
          sessionId,
          at: numberOr(session.probeRedSince, 0) || failureAt || now,
          cause: PROBE_RED_CAUSE,
          tokens: 0,
        })
      }
      nextSeen[sessionId] = { failureAt: Math.max(failureAt, previous.failureAt), probeRed }
    }
    for (const event of events) entries = applyAttempt(entries, event)

    // --- delivery (投递门槛 = 影响了任务的告警才进): stopped sessions deliver
    // their family; probe-alarm families are born delivered with the rise.
    for (const sessionId of Object.keys(sessions)) {
      const session = asSession(sessions[sessionId])
      if (session === undefined) continue
      const stopped = stringOr(session.stopped)
      if (stopped === undefined) continue
      const cause = stringOr(session.lastFailureForm) ?? stopped
      entries = deliverFamily(entries, sessionId, cause, now)
    }
    entries = entries.map((entry) => {
      if (entry.archived || entry.cause !== PROBE_RED_CAUSE || entry.deliveredAt !== null) return entry
      const alarming = entry.sessionIds.some(
        id => asSession(sessions[id])?.probeRedAlarmed === true,
      )
      return alarming ? deliver(entry, now) : entry
    })

    // 客观恢复 auto-archive **retired (改判 C)**: a completed turn is context
    // for the reader, never a deletion — the entry stays until 已读.
    seen = nextSeen
  }

  // --- 信源接入 (改判 D, 信源契约): restart/death facts deliver category entries.
  if (source !== undefined) {
    for (const [cause, fact] of readSourceFacts(source)) {
      entries = deliverSourceFact(entries, cause, fact.lastAt, fact.count, now)
    }
  }

  // 超时升级 **retired (改判 C)**: no entry ever flips on its own; the red
  // clears through 已读 only and re-arms through 恢复.

  const changed = canonicalPayload({ seen, entries }) !== canonicalPayload(base ?? EMPTY_DOC)
  const doc: AlertInboxDocument = {
    at: changed ? now : (base?.at ?? 0),
    seen: sortedFacts(seen),
    entries,
  }
  return { doc, changed }
}

/** Canonical key order for the persisted watermark (stable file bytes → change-only stays quiet). */
function sortedFacts(source: Readonly<Record<string, SeenFact>>): Record<string, SeenFact> {
  const out: Record<string, SeenFact> = {}
  for (const key of Object.keys(source).sort()) {
    const fact = source[key]
    if (fact !== undefined) out[key] = fact
  }
  return out
}

/** 双栏视图窗 (改判 A): the right column is a 24h VIEW, never a storage bound. */
const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000

function reportOf(doc: AlertInboxDocument, now: number): AlertInboxReport {
  const open = doc.entries.filter(entry => entry.unread && !entry.archived)
  const cutoff = now - REPORT_WINDOW_MS
  // 两栏并集（未读全量 ∪ 24h 内全部含已读）按 lastAt 逆序 —— 排序即热度 (改判 B)。
  const entries = doc.entries
    .filter(entry => (entry.unread && !entry.archived) || entry.lastAt >= cutoff)
    .sort((left, right) => right.lastAt - left.lastAt)
    .map(entry => ({
      id: entry.id,
      cause: entry.cause,
      lastAt: entry.lastAt,
      count: entry.attempts,
      unread: entry.unread,
      archived: entry.archived,
    }))
  return {
    at: doc.at,
    unread: open.length,
    escalated: open.filter(entry => entry.escalated).length,
    total: doc.entries.length,
    entries,
  }
}

/**
 * One sweep tick: read both documents, fold, write `alert-inbox.json` only on a
 * content flip (temp + rename, revive-health writer style), publish the counts.
 * @param now - fold clock (injectable for tests).
 * @returns the badge/duty counts, or `undefined` when the plane is not
 *   attached (neither document exists) or the inbox document is unreadable
 *   (degrade quietly — never clobber a possibly conclusion-bearing file).
 */
export function syncAlertInbox(now = Date.now()): AlertInboxReport | undefined {
  const inboxPath = dshHomePath(ALERT_INBOX_FILE)
  let raw: string | undefined
  try {
    raw = readFileSync(inboxPath, 'utf8')
  } catch (error) {
    // Absence = quiet (the plane may simply not be written yet); any other
    // read error = we cannot judge the document, so we must not overwrite it.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
  }
  let base: AlertInboxDocument | undefined
  if (raw !== undefined) {
    try {
      base = normalizeDocument(JSON.parse(raw))
    } catch {
      return undefined
    }
    if (base === undefined) return undefined
  }
  // The state export is the fold's INPUT: absent or malformed reads as quiet
  // absence (面消失 ≠ 面变坏), the revive-health absence discipline.
  let state: ReviveV2StateDocument | undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(dshHomePath(REVIVE_V2_STATE_FILE), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      state = parsed as ReviveV2StateDocument
    }
  } catch {
    state = undefined
  }
  // 信源 (改判 D): pull 型事实文档 —— absent/malformed reads as quiet absence
  // (面消失 ≠ 面变坏), the same discipline as the revive state export.
  let source: RestartAlertSourceDocument | undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(dshHomePath(RESTART_ALERT_SOURCE_FILE), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      source = parsed as RestartAlertSourceDocument
    }
  } catch {
    source = undefined
  }

  const result = foldAlertInbox(state, base, now, source)
  if (result === undefined) return undefined
  if (result.changed) {
    try {
      const temp = `${inboxPath}.tmp`
      writeFileSync(temp, `${JSON.stringify(result.doc)}\n`, 'utf8')
      renameSync(temp, inboxPath)
    } catch {
      // A failed write leaves duty reading the previous document (loudly
      // consistent with it); the badge keeps the fold's truth for this tick.
    }
  }
  return reportOf(result.doc, now)
}

/**
 * Shared write-side patch: read → apply → atomically rewrite ONLY on a content
 * flip; `false` when the document cannot be trusted or the entry is unknown.
 */
function patchEntry(
  entryId: string,
  inboxPath: string,
  apply: (entry: AlertInboxEntry, now: number) => AlertInboxEntry | undefined,
  now: number,
): boolean {
  let base: AlertInboxDocument
  try {
    const parsed: unknown = JSON.parse(readFileSync(inboxPath, 'utf8'))
    const normalized = normalizeDocument(parsed)
    if (normalized === undefined) return false
    base = normalized
  } catch {
    return false
  }
  let found = false
  const entries = base.entries.map((entry) => {
    if (entry.id !== entryId) return entry
    found = true
    return apply(entry, now) ?? entry
  })
  if (!found) return false
  const next: AlertInboxDocument = { at: now, seen: base.seen, entries }
  // Already in the target state (idempotent re-ack) — no content flip, no write.
  if (canonicalPayload(next) === canonicalPayload(base)) return true
  try {
    const temp = `${inboxPath}.tmp`
    writeFileSync(temp, `${JSON.stringify(next)}\n`, 'utf8')
    renameSync(temp, inboxPath)
    return true
  } catch {
    return false
  }
}

/**
 * 人工确认 channel (§七: 标已读 → 转信箱归档，不物理删): the entry leaves the
 * badge count but stays readable in the archive with `heal = manual`.
 * @param entryId - family id (`fam-…`).
 * @param inboxPath - document location (injectable for tests); defaults to the DSH-home single source.
 * @param now - clock (injectable for tests).
 * @returns whether the entry was found and archived.
 */
export function acknowledgeAlert(
  entryId: string,
  inboxPath = dshHomePath(ALERT_INBOX_FILE),
  now = Date.now(),
): boolean {
  return patchEntry(entryId, inboxPath, (entry, at) => {
    // Already filed and read — idempotent no-op (never re-opens an archive).
    if (entry.archived && !entry.unread) return undefined
    return { ...entry, unread: false, archived: true, endedAt: at, heal: 'manual' }
  }, now)
}

/**
 * 人工【恢复】channel (改判 A/C): the entry returns to the unread column with
 * its body intact (结论不能删 — a backfilled `resolution` rides along). The
 * ONLY way back into the red after 已读: no fold path re-arms `unread`.
 * @param entryId - family id (`fam-…`).
 * @param inboxPath - document location (injectable for tests); defaults to the DSH-home single source.
 * @param now - clock (injectable for tests).
 * @returns whether the entry was found and restored (idempotent when already open).
 */
export function restoreAlert(
  entryId: string,
  inboxPath = dshHomePath(ALERT_INBOX_FILE),
  now = Date.now(),
): boolean {
  return patchEntry(entryId, inboxPath, (entry) => {
    if (!entry.archived && entry.unread) return undefined
    return { ...entry, unread: true, archived: false, endedAt: null, heal: null }
  }, now)
}

/**
 * 结论回填 (§七 行动面回路): the investigation writes its conclusion pointer,
 * the entry files itself out of the badge with the conclusion attached — the
 * conclusion lives in the archived entry forever (结论不能删).
 * @param entryId - family id (`fam-…`).
 * @param resolution - `{ at, ref, note? }`; `ref` points at the conclusion doc / board row.
 * @param inboxPath - document location (injectable for tests); defaults to the DSH-home single source.
 * @param now - clock (injectable for tests).
 * @returns whether the entry was found and backfilled.
 */
export function setAlertResolution(
  entryId: string,
  resolution: AlertInboxResolution,
  inboxPath = dshHomePath(ALERT_INBOX_FILE),
  now = Date.now(),
): boolean {
  if (typeof resolution.ref !== 'string' || resolution.ref === '') return false
  return patchEntry(entryId, inboxPath, entry => ({
    ...entry,
    resolution: { ...resolution, at: numberOr(resolution.at, now) },
    unread: false,
    archived: true,
    endedAt: now,
    heal: 'manual',
  }), now)
}

/**
 * Link an investigation session to an entry (§七 关联追查会话 id) so the next
 * reader sees which 追查会话 owns the conclusion.
 * @param entryId - family id (`fam-…`).
 * @param sessionId - the investigation session identity.
 * @param inboxPath - document location (injectable for tests); defaults to the DSH-home single source.
 * @param now - clock (injectable for tests).
 * @returns whether the entry was found and linked.
 */
export function linkInvestigationSession(
  entryId: string,
  sessionId: string,
  inboxPath = dshHomePath(ALERT_INBOX_FILE),
  now = Date.now(),
): boolean {
  if (sessionId === '') return false
  return patchEntry(entryId, inboxPath, entry => ({
    ...entry,
    investigationSessionId: sessionId,
  }), now)
}
