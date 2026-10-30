/**
 * Row-cut listing filters (f5-list-thin-1029): `excludeSessionIds` must skip a
 * session from its directory name alone — before any header read — and
 * `select` may only decide after the header read, before the stat.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { logPath } from '../src/format.ts'

const directories: string[] = []
const contexts: Context[] = []

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-list-filter-'))
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
  const failures = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'list-filter fixture cleanup failed')
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

async function writeLog(persistence: SessionPersistence, meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
  const handle = await persistence.create(meta)
  try {
    await handle.append(events)
  } finally {
    await handle.close()
  }
}

/** Materialize one ordinary session (create + one turn + close). */
async function seed(persistence: SessionPersistence, id: string): Promise<SessionId> {
  await writeLog(persistence, header(id), oneTurnLog())
  return SessionId(id)
}

describe('JsonlSessionPersistence.list row-cut filters', () => {
  it('excludeSessionIds skips the directory before any header read', async () => {
    const ctx = contexts[contexts.length - 1] as Context
    const root = directories[directories.length - 1] as string
    const keep = await seed(ctx.sessionPersistence, 'session-keep')
    // A header that throws whenever it is read: listing it without exclusion
    // rejects, so a listing that resolves with the exclusion proved the
    // excluded id's header was never opened.
    const poison = SessionId('session-poisoned')
    const path = logPath(root, '/work', poison, 'none')
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: poison,
      createdAt: 1,
      delegationDepth: 0,
      sandboxMode: 'strict',
    })}\n`)

    await expect(ctx.sessionPersistence.list()).rejects.toThrow('retired policy baseline fields')

    const rows = await ctx.sessionPersistence.list({ excludeSessionIds: new Set([poison]) })
    expect(rows.map(row => row.header.id)).toEqual([keep])
  })

  it('select decides after the header read and drops only the rejected session', async () => {
    const ctx = contexts[contexts.length - 1] as Context
    const keep = await seed(ctx.sessionPersistence, 'session-keep-origin')
    const drop = await seed(ctx.sessionPersistence, 'session-drop-origin')

    const seen: SessionId[] = []
    const rows = await ctx.sessionPersistence.list({
      select: (meta) => {
        seen.push(meta.id)
        return meta.id !== drop
      },
    })

    // The rejected session's header WAS read (the earliest possible cut) and
    // the kept session's row survives.
    expect([...seen].sort()).toEqual([keep, drop].sort())
    expect(rows.map(row => row.header.id)).toEqual([keep])
  })
})
