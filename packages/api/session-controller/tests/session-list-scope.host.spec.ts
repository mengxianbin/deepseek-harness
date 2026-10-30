/**
 * Default row scope and projection trimming of `session/list`
 * (f5-list-thin-1029): archived ids are pre-excluded before any header read,
 * subagent rows are post-selected on their header, and the display-heavy
 * projection keys never reach the wire unless a caller opts back in.
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

describe('session/list default row scope', () => {
  const rows = [
    record(ACTIVE),
    record(SUBAGENT, { origin: 'subagent', parentSession: ACTIVE }),
    record(ARCHIVED),
    record(ARCHIVED_SUBAGENT, { origin: 'subagent', parentSession: ACTIVE }),
  ]

  it('pre-excludes archived ids and post-selects subagent rows by default', async () => {
    const { list, listSessions } = await harness(rows)

    const items = await list.list()

    expect(items.map(item => item.sessionId)).toEqual([ACTIVE])
    const options = listSessions.mock.calls[0]?.[1]
    expect(options?.excludeSessionIds?.has(ARCHIVED)).toBe(true)
    expect(options?.excludeSessionIds?.has(ARCHIVED_SUBAGENT)).toBe(true)
    // Origin exists only in the header: the predicate is the earliest cut.
    expect(options?.select?.(rows[1]?.header as SessionRecord['header'])).toBe(false)
    expect(options?.select?.(rows[0]?.header as SessionRecord['header'])).toBe(true)
  })

  it('includeArchived restores archived rows and lifts the pre-exclusion', async () => {
    const { list, listSessions } = await harness(rows)

    const items = await list.list({ includeArchived: true })

    expect(items.map(item => item.sessionId).sort()).toEqual([ACTIVE, ARCHIVED].sort())
    const options = listSessions.mock.calls[0]?.[1]
    expect(options?.excludeSessionIds).toBeUndefined()
    // Subagent rows stay cut unless their own flag opts in.
    expect(options?.select?.(rows[1]?.header as SessionRecord['header'])).toBe(false)
  })

  it('includeSubagents restores subagent rows and lifts the predicate', async () => {
    const { list, listSessions } = await harness(rows)

    const items = await list.list({ includeSubagents: true })

    expect(items.map(item => item.sessionId).sort()).toEqual([ACTIVE, SUBAGENT].sort())
    const options = listSessions.mock.calls[0]?.[1]
    expect(options?.select).toBeUndefined()
    expect(options?.excludeSessionIds?.has(ARCHIVED)).toBe(true)
  })

  it('both flags together serve the full-corpus consumers', async () => {
    const { list } = await harness(rows)

    const items = await list.list({ includeArchived: true, includeSubagents: true })

    expect(items).toHaveLength(4)
  })
})

describe('session/list projection trimming', () => {
  it('drops the display-heavy keys and keeps the cold-row authorities', async () => {
    const { list } = await harness([record(ACTIVE)], {
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
    })

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
})
