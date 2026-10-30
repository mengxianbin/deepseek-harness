/**
 * Row scope and projection trimming of `session/list`
 * (f5-contract-a2-1030): the default `{}` request serves the pre-f5 full
 * corpus — archived rows, subagent-origin rows, and untrimmed hints — and
 * only explicit flags cut rows (`includeArchived: false` /
 * `includeSubagents: false`, each cutting at its earliest layer) or trim the
 * heavy columns (`trimHeavyProjections: true`).
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

async function harness(records: readonly SessionRecord[], projections: Record<string, Record<string, unknown>> = {}) {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  ctx.provide('workspaceRegistry', {
    get archivedSessionIds() { return [ARCHIVED, ARCHIVED_SUBAGENT] },
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

  it('serves the full pre-f5 corpus by default with no row-cut options', async () => {
    const { list, listSessions } = await harness(rows)

    const items = await list.list()

    expect(items.map(item => item.sessionId).sort())
      .toEqual([ACTIVE, SUBAGENT, ARCHIVED, ARCHIVED_SUBAGENT].sort())
    // No flag, no filter: the machine only engages on an explicit `false`.
    const options = listSessions.mock.calls[0]?.[1]
    expect(options?.excludeSessionIds).toBeUndefined()
    expect(options?.select).toBeUndefined()
  })

  it('an explicit includeArchived:false pre-excludes archived ids before any header read', async () => {
    const { list, listSessions } = await harness(rows)

    const items = await list.list({ includeArchived: false })

    expect(items.map(item => item.sessionId).sort()).toEqual([ACTIVE, SUBAGENT].sort())
    const options = listSessions.mock.calls[0]?.[1]
    expect(options?.excludeSessionIds?.has(ARCHIVED)).toBe(true)
    expect(options?.excludeSessionIds?.has(ARCHIVED_SUBAGENT)).toBe(true)
    // Subagent rows stay in unless their own flag opts out.
    expect(options?.select).toBeUndefined()
  })

  it('an explicit includeSubagents:false post-selects subagent rows on their header', async () => {
    const { list, listSessions } = await harness(rows)

    const items = await list.list({ includeSubagents: false })

    expect(items.map(item => item.sessionId).sort()).toEqual([ACTIVE, ARCHIVED].sort())
    const options = listSessions.mock.calls[0]?.[1]
    expect(options?.excludeSessionIds).toBeUndefined()
    // Origin exists only in the header: the predicate is the earliest cut.
    expect(options?.select?.(rows[1]?.header as SessionRecord['header'])).toBe(false)
    expect(options?.select?.(rows[0]?.header as SessionRecord['header'])).toBe(true)
  })

  it('both explicit cuts restore the thin active first-party listing', async () => {
    const { list } = await harness(rows)

    const items = await list.list({ includeArchived: false, includeSubagents: false })

    expect(items.map(item => item.sessionId)).toEqual([ACTIVE])
  })

  it('explicit true matches the omitted default (full rows)', async () => {
    const { list } = await harness(rows)

    const items = await list.list({ includeArchived: true, includeSubagents: true })

    expect(items).toHaveLength(4)
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

  it('keeps every hint key by default (pre-f5 full columns)', async () => {
    const { list } = await harness([record(ACTIVE)], heavyFixture)

    const [item] = await list.list()
    const values = item?.projections?.values as Record<string, unknown>

    for (const key of ['tokenUsage', 'contextPressure', 'contextBreakdown', 'sessionStats', 'inbox', 'turnOutline']) {
      expect(values).toHaveProperty(key)
    }
  })

  it('drops the display-heavy keys only under trimHeavyProjections:true and keeps the cold-row authorities', async () => {
    const { list } = await harness([record(ACTIVE)], heavyFixture)

    const [item] = await list.list({ trimHeavyProjections: true })
    const values = item?.projections?.values as Record<string, unknown>

    for (const key of ['tokenUsage', 'contextPressure', 'contextBreakdown', 'sessionStats', 'inbox', 'turnOutline']) {
      expect(values).not.toHaveProperty(key)
    }
    expect(values).toHaveProperty('title', 'keep me')
    expect(values).toHaveProperty('subagentCatalog')
    expect(values).toHaveProperty('goal')
    expect(values).toHaveProperty('agentPreset')
  })
})
