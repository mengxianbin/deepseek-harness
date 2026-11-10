/**
 * Row scope and projection trimming of `session/list`
 * (F′ default flip, session-list-full-slim-1110 P2): the default request
 * serves the thin first-party listing — no archived rows, no
 * subagent-origin rows, heavy hint columns trimmed — and explicit flags
 * widen back (`includeArchived: true` / `includeSubagents: true` restore
 * rows cut at their earliest layer, `trimHeavyProjections: false` restores
 * the heavy columns). The pre-f5 full corpus (f5-contract-a2-1030) is now
 * an explicit all-true request, never the omission.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionListQueryOptions, SessionRecord } from '@deepseek-ai/dsh-session-query'
import { ApiSessionList } from '../src/list.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  vi.restoreAllMocks()
  try {
    await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  } finally {
    contexts.clear()
  }
})

const ARCHIVED = SessionId('session-archived')
const ACTIVE = SessionId('session-active')
const SUBAGENT = SessionId('session-sub')
const ARCHIVED_SUBAGENT = SessionId('session-archived-sub')

function record(id: SessionId, extra: Record<string, unknown> = {}): SessionRecord {
  return {
    header: {
      version: 4,
      id,
      createdAt: 1000,
      isSeeded: false,
      cwd: '/work',
      ...extra,
    },
    live: false,
    persisted: true,
    formatStatus: 'current',
  }
}

async function harness(
  records: readonly SessionRecord[],
  projections: Record<string, Record<string, unknown>> = {},
  subagentIds: ReadonlySet<SessionId> = new Set([SUBAGENT, ARCHIVED_SUBAGENT]),
) {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  ctx.provide('workspaceRegistry', {
    get archivedSessionIds() { return [ARCHIVED, ARCHIVED_SUBAGENT] },
    get subagentSessionIds() { return subagentIds },
  } as never)
  const listSessions = vi.fn(async (
    _signal?: AbortSignal,
    options?: SessionListQueryOptions,
  ): Promise<SessionRecord[]> => records.filter((row) => {
    if (options?.excludeSessionIds?.has(row.header.id)) return false
    if (options?.select !== undefined && !options.select(row.header)) return false
    return true
  }))
  ctx.provide('sessionQuery', { listSessions } as never)
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: (meta: SessionRecord['header']) => ({
      asOfSeq: -1,
      values: projections[meta.id] ?? { title: 'fixture' },
    }),
    cachedPredecessorTitle: () => undefined,
    staleSnapshotKeys: () => [],
  } as never)
  const list = new ApiSessionList(ctx, 16)
  return { ctx, list, listSessions }
}

describe('session/list row scope', () => {
  const rows = [
    record(ACTIVE),
    record(SUBAGENT, { origin: 'subagent', parentSession: ACTIVE }),
    record(ARCHIVED),
    record(ARCHIVED_SUBAGENT, { origin: 'subagent', parentSession: ACTIVE }),
  ]

  it('serves the thin first-party listing by default (F′ flip)', async () => {
    const { list, listSessions } = await harness(rows)

    const items = await list.list()

    expect(items.map(item => item.sessionId)).toEqual([ACTIVE])
    // Omission is now a row cut: both registry sets feed the pre-exclusion
    // set and the header predicate runs as the correctness backstop.
    const options = listSessions.mock.calls[0]?.[1]
    expect(options?.excludeSessionIds?.has(ARCHIVED)).toBe(true)
    expect(options?.excludeSessionIds?.has(ARCHIVED_SUBAGENT)).toBe(true)
    expect(options?.excludeSessionIds?.has(SUBAGENT)).toBe(true)
    expect(options?.select?.(rows[1]?.header as SessionRecord['header'])).toBe(false)
    expect(options?.select?.(rows[0]?.header as SessionRecord['header'])).toBe(true)
  })

  it('an explicit includeArchived:false matches the omitted default for archived rows', async () => {
    const { list, listSessions } = await harness(rows)

    const items = await list.list({ includeArchived: false })

    // Subagents stay cut by their own omitted default.
    expect(items.map(item => item.sessionId)).toEqual([ACTIVE])
    const options = listSessions.mock.calls[0]?.[1]
    expect(options?.excludeSessionIds?.has(ARCHIVED)).toBe(true)
    expect(options?.excludeSessionIds?.has(ARCHIVED_SUBAGENT)).toBe(true)
    expect(options?.select).toBeDefined()
  })

  it('an explicit includeArchived:true restores archived rows before any header read', async () => {
    const { list, listSessions } = await harness(rows)

    const items = await list.list({ includeArchived: true })

    expect(items.map(item => item.sessionId).sort()).toEqual([ACTIVE, ARCHIVED].sort())
    const options = listSessions.mock.calls[0]?.[1]
    // Archived ids leave the pre-exclusion set; subagent ids stay in it
    // (their own flag keeps the omitted default cut), so the archived
    // subagent stays excluded as a subagent even with archives widened.
    expect(options?.excludeSessionIds?.has(ARCHIVED)).toBe(false)
    expect(options?.excludeSessionIds?.has(SUBAGENT)).toBe(true)
    expect(options?.excludeSessionIds?.has(ARCHIVED_SUBAGENT)).toBe(true)
    expect(options?.select?.(rows[1]?.header as SessionRecord['header'])).toBe(false)
  })

  it('an explicit includeSubagents:true restores subagent rows and drops the header predicate', async () => {
    const { list, listSessions } = await harness(rows)

    const items = await list.list({ includeSubagents: true })

    expect(items.map(item => item.sessionId).sort()).toEqual([ACTIVE, SUBAGENT].sort())
    const options = listSessions.mock.calls[0]?.[1]
    // Subagent ids leave the pre-exclusion set; archived ids stay in it.
    expect(options?.excludeSessionIds?.has(SUBAGENT)).toBe(false)
    expect(options?.excludeSessionIds?.has(ARCHIVED)).toBe(true)
    // Nothing left for the predicate to cut.
    expect(options?.select).toBeUndefined()
  })

  it('falls back to the header predicate alone when the registry index has not seen a subagent id', async () => {
    const { list, listSessions } = await harness(rows, {}, new Set())

    const items = await list.list({ includeArchived: true, includeSubagents: false })

    expect(items.map(item => item.sessionId).sort()).toEqual([ACTIVE, ARCHIVED].sort())
    const options = listSessions.mock.calls[0]?.[1]
    // Empty subagent index, archived widened: nothing to pre-exclude, the
    // post-read predicate still cuts.
    expect(options?.excludeSessionIds?.size).toBe(0)
    expect(options?.select?.(rows[1]?.header as SessionRecord['header'])).toBe(false)
    expect(options?.select?.(rows[0]?.header as SessionRecord['header'])).toBe(true)
  })

  it('full-corpus consumers pass every flag explicitly (all-true request)', async () => {
    const { list, listSessions } = await harness(rows)

    const items = await list.list({ includeArchived: true, includeSubagents: true, trimHeavyProjections: false })

    expect(items).toHaveLength(4)
    const options = listSessions.mock.calls[0]?.[1]
    expect(options?.excludeSessionIds).toBeUndefined()
    expect(options?.select).toBeUndefined()
  })
})

describe('session/list projection trimming', () => {
  const heavyFixture = {
    [ACTIVE]: {
      title: 'keep me',
      goal: 'keep goal',
      subagentCatalog: [{ id: SessionId('child'), createdAt: 1, mode: 'continuable' as const, label: 'child' }],
      agentPreset: 'standard',
      tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      contextPressure: { pressureTokens: 1, projectedTokens: 2, contextWindow: 100 },
      contextBreakdown: { systemTokens: 1, toolsTokens: 2, messageTokens: 3 },
      sessionStats: { turns: 1 },
      inbox: { 'next-turn': [], 'next-step': [] },
      turnOutline: [{ turn: 1, prompt: 'heavy outline text' }],
    },
  }

  it('drops the display-heavy keys by default (F′ flip) and keeps the cold-row authorities', async () => {
    const { list } = await harness([record(ACTIVE)], heavyFixture)

    const [item] = await list.list()
    const values = item?.projections?.values as Record<string, unknown>

    for (const key of ['tokenUsage', 'contextPressure', 'contextBreakdown', 'sessionStats', 'inbox', 'turnOutline']) {
      expect(values).not.toHaveProperty(key)
    }
    expect(values).toHaveProperty('title', 'keep me')
    expect(values).toHaveProperty('subagentCatalog')
    expect(values).toHaveProperty('goal')
    expect(values).toHaveProperty('agentPreset')
  })

  it('an explicit trimHeavyProjections:false restores every hint key', async () => {
    const { list } = await harness([record(ACTIVE)], heavyFixture)

    const [item] = await list.list({ trimHeavyProjections: false })
    const values = item?.projections?.values as Record<string, unknown>

    for (const key of ['tokenUsage', 'contextPressure', 'contextBreakdown', 'sessionStats', 'inbox', 'turnOutline']) {
      expect(values).toHaveProperty(key)
    }
  })
})
