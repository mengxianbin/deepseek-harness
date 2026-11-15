/**
 * Header-frame memo (archive-inline-inventory-1111 刀①): an artifact whose
 * stat-derived revision is unchanged serves its previous translation, so a
 * listing over an untouched home pays one stat per session instead of the
 * open + first-frame decompress + parse (96% of `list()` before this memo);
 * a changed revision re-reads. The no-re-read half is observed on the
 * translation seam itself — a content-level probe cannot preserve the
 * stat identity (ctime moves with every write), so the spy is the honest
 * instrument here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { logPath } from '../src/format.ts'

const directories: string[] = []
const contexts: Context[] = []

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-header-frame-memo-'))
  directories.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
})

afterEach(async () => {
  const results = await Promise.allSettled(contexts.map(ctx => ctx.fiber.dispose()))
  contexts.length = 0
  for (const dir of directories) await rm(dir, { recursive: true, force: true })
  directories.length = 0
  vi.restoreAllMocks()
  const failures = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'header-frame-memo fixture cleanup failed')
})

function header(id: string, extra: Record<string, unknown> = {}): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1000,
    isSeeded: false,
    cwd: '/work',
    ...extra,
  }
}

/** Materialize one ordinary session (create + one turn + close). */
async function seed(persistence: SessionPersistence, id: string): Promise<SessionId> {
  const handle = await persistence.create(header(id))
  try {
    await handle.append(oneTurnLog())
  } finally {
    await handle.close()
  }
  return SessionId(id)
}

/**
 * Count translations of header frames — the private seam the memo guards.
 * Private is a compile-time notion; the spy observes the real call either way.
 */
function spyOnTranslations(persistence: SessionPersistence) {
  const backend = persistence as unknown as {
    translateGenerationHeader: (...args: never[]) => Promise<unknown>
  }
  return vi.spyOn(backend, 'translateGenerationHeader')
}

describe('JsonlSessionPersistence header-frame memo', () => {
  it('serves an unchanged artifact from the memo without reopening it', async () => {
    const ctx = contexts[contexts.length - 1] as Context
    await seed(ctx.sessionPersistence, 'session-warm')
    const translate = spyOnTranslations(ctx.sessionPersistence)

    // The cold listing translates the header once and memoizes the outcome
    const first = await ctx.sessionPersistence.list()
    expect(first.map(row => row.header.id)).toEqual(['session-warm'])
    expect(translate).toHaveBeenCalledTimes(1)

    // The warm listing pays one stat and serves the memo: no second
    // open + decompress + parse for an artifact nothing touched
    const second = await ctx.sessionPersistence.list()
    expect(second.map(row => row.header.id)).toEqual(['session-warm'])
    expect(second[0]?.header.createdAt).toBe(first[0]?.header.createdAt)
    expect(translate).toHaveBeenCalledTimes(1)
  })

  it('re-reads the header once the artifact changes', async () => {
    const ctx = contexts[contexts.length - 1] as Context
    const root = directories[directories.length - 1] as string
    const id = await seed(ctx.sessionPersistence, 'session-mutable')
    const cold = await ctx.sessionPersistence.list()
    expect(cold.map(row => row.header.id)).toEqual([id])
    const translate = spyOnTranslations(ctx.sessionPersistence)

    // One append moves size and timestamps → the stat-derived revision
    // misses, so the next listing translates again
    await appendFile(logPath(root, '/work', id, 'none'), `${JSON.stringify({ type: 'session/marker', id: 'memo-test' })}\n`)
    const warm = await ctx.sessionPersistence.list()
    expect(warm.map(row => row.header.id)).toEqual([id])
    expect(translate).toHaveBeenCalledTimes(1)
  })
})
