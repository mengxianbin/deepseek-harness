/**
 * Consumer-owned cold projection repair: a listed cold row whose stored
 * projection rows exist but were written at an older unit `stateVersion`
 * queues a bounded refold that reads the stored log, refreshes the durable
 * checkpoint, and republishes the row. This is the path behind a row's
 * durable status dot surviving a Host restart that bumped a projection's
 * fold semantics (the bump itself says the stale rows "须重折一次").
 *
 * The listing stays zero-I/O: the cue is a synchronous in-memory probe, the
 * refold runs serially off the list path, and a Session that attaches meanwhile
 * owns its fold and stands the repair down.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { SessionAccess, SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { createSessionTestRemote, testSessionPersistence } from './test-remote.ts'
import type { SessionSummary } from '../src/types.ts'

const sid = (id: string): SessionId => id as SessionId

function header(id: string, createdAt = 1000): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: sid(id), createdAt, isSeeded: false, cwd: '/proj' }
}

/** One stored log with a completed turn: the durable outcome the row dot reads. */
function conversationEvents(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 800, data: { turn: 1 } },
    {
      type: 'user/message', seq: SessionSeq(1), time: 1200,
      data: createUserMessage({ content: [{ type: 'text', text: 'worked' }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    },
    { type: 'turn/end', seq: SessionSeq(2), time: 1300, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
}

interface RepairHarness {
  ctx: Context
  remote: Awaited<ReturnType<typeof createSessionTestRemote>>
  added: SessionSummary[]
  open: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  staleSnapshotKeys: ReturnType<typeof vi.fn>
  coldSnapshot: ReturnType<typeof vi.fn>
  meta: SessionHeader
  events: SessionEvent[]
}

async function harness(options: {
  readonly meta: SessionHeader
  /** Whether the stored row owes a refold; `false` = rows all still serve. */
  readonly owed?: boolean
  /** Gates the log open, so a test can attach the Session mid-repair. */
  readonly openGate?: Promise<void>
}): Promise<RepairHarness> {
  const { meta } = options
  const events = conversationEvents()
  const read = vi.fn(() => Promise.resolve({ eventState: 'detached' as const, events: structuredClone(events) }))
  const close = vi.fn(() => Promise.resolve())
  const handle = {
    id: meta.id,
    header: structuredClone(meta),
    inheritedEventCount: SessionLogOffset(0),
    access: 'read' as SessionAccess,
    read,
    append: () => Promise.reject(new Error('read handle must not append')),
    flush: () => Promise.reject(new Error('read handle must not flush')),
    close,
    [Symbol.asyncDispose]: close,
  } as unknown as SessionHandle
  const open = vi.fn(async (): Promise<SessionHandle> => {
    if (options.openGate !== undefined) await options.openGate
    return handle
  })
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([structuredClone(meta)]),
    inspect: () => Promise.resolve({ meta: structuredClone(meta), events: structuredClone(events) }),
    open,
  }) as never)
  // The cache double reports the stale cue the real cache reports for a row
  // written at another unit's stateVersion, then stops reporting it once the
  // repair's refold has refreshed the stored row — the production contract.
  let owed = options.owed !== false
  const staleSnapshotKeys = vi.fn((candidate: SessionHeader): readonly string[] =>
    (owed && candidate.id === meta.id ? ['lastTurnOutcome'] : []))
  const coldSnapshot = vi.fn(() => {
    owed = false
    return {
      asOfSeq: SessionSeq(2),
      values: {
        lastTurnOutcome: { kind: 'completed', at: 1300 },
        sessionListMetadata: { blank: false, lastPromptAt: 1200 },
      },
    }
  })
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: () => undefined,
    cachedPredecessorTitle: () => undefined,
    staleSnapshotKeys,
    coldSnapshot,
  } as never)
  const remote = await createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
  })
  const added: SessionSummary[] = []
  ctx.on('api-session/added', (summary) => { added.push(summary) })
  return { ctx, remote, added, open, read, close, staleSnapshotKeys, coldSnapshot, meta, events }
}

describe('cold projection repair (consumer-owned refold)', () => {
  it('refolds a stale cold row from its stored log, refreshes the checkpoint, and republishes the row', async () => {
    const h = await harness({ meta: header('stale-dot') })
    try {
      const listed = await h.remote.list({})
      if (!listed.ok) throw new Error('list failed')
      // The list answers immediately without the log: the row keeps serving
      // whatever the cache still holds (here: no projection column at all).
      const row = listed.value.items.find(item => item.sessionId === h.meta.id)
      expect(row).toBeDefined()
      expect(row !== undefined && 'projections' in row).toBe(false)

      // The owed refold then runs off the list path: durable log in, full
      // fold, checkpoint refresh through the cache's own fold face.
      await vi.waitFor(() => { expect(h.coldSnapshot).toHaveBeenCalledOnce() })
      expect(h.open).toHaveBeenCalledWith(h.meta.id, 'read')
      expect(h.coldSnapshot).toHaveBeenCalledWith(h.meta, SessionLogOffset(0), h.events)
      await vi.waitFor(() => { expect(h.close).toHaveBeenCalledOnce() })

      // The repaired row reaches clients as an upsert carrying the refreshed
      // `cached` block — the values the version-bumped row was missing.
      await vi.waitFor(() => {
        expect(h.added.at(-1)).toMatchObject({
          sessionId: h.meta.id,
          running: false,
          projections: {
            kind: 'cached',
            asOfSeq: 2,
            values: { lastTurnOutcome: { kind: 'completed', at: 1300 } },
          },
        })
      })

      // With the stored row refreshed, the probe owes nothing further: a
      // second list neither re-queues nor re-opens the log.
      const again = await h.remote.list({})
      expect(again.ok).toBe(true)
      expect(h.staleSnapshotKeys).toHaveBeenCalledTimes(2)
      expect(h.open).toHaveBeenCalledOnce()
      expect(h.coldSnapshot).toHaveBeenCalledOnce()
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('stands down before writing or publishing when the Session attaches during the repair', async () => {
    let release!: () => void
    const openGate = new Promise<void>((resolve) => { release = resolve })
    const h = await harness({ meta: header('stale-attached'), openGate })
    try {
      const listed = await h.remote.list({})
      if (!listed.ok) throw new Error('list failed')
      // Repair holds the log open; the Session attaches before it reads back.
      await vi.waitFor(() => { expect(h.open).toHaveBeenCalledOnce() })
      h.ctx.sessions.create(h.meta.id, { meta: { cwd: '/proj', createdAt: h.meta.createdAt } })
      release()
      await vi.waitFor(() => { expect(h.close).toHaveBeenCalledOnce() })

      // The live fold owns the Session from here: no cache write raced it and
      // no cold row republish overwrote its live frames. (`session/created`
      // may republish a `sequenced` row; only the cold block would clash.)
      expect(h.coldSnapshot).not.toHaveBeenCalled()
      expect(h.added.filter(summary => summary.projections?.kind === 'cached')).toEqual([])
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('queues nothing for a row whose stored rows all still serve', async () => {
    const h = await harness({ meta: header('row-current'), owed: false })
    try {
      const listed = await h.remote.list({})
      expect(listed.ok).toBe(true)
      expect(h.staleSnapshotKeys).toHaveBeenCalledOnce()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(h.open).not.toHaveBeenCalled()
      expect(h.coldSnapshot).not.toHaveBeenCalled()
      expect(h.added).toEqual([])
    } finally {
      await h.ctx.fiber.dispose()
    }
  })
})
