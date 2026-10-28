/**
 * List arrival state and pre-list restoration (FORK dsh-local f5-list-states):
 * a failed `session.list` pull is projected to the client snapshot — the
 * sidebar's error surface reads it and a retry starts a fresh pull — and a
 * Client-persisted selection retains before the catalog pull delivers its row.
 *
 * Hand-rolled Remote face on purpose: the assembled roster cannot resolve in
 * this checkout (pnpm 环境债症状②, m-note tasks 2026-10-21), and neither
 * behavior needs a live transport.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionReferenceSource } from '../src/client/index.ts'
import { ClientSessions } from '../src/client/sessions/service.ts'
import type { SessionRemotes } from '../src/client/sessions/remotes.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    listArrivalTestView: unknown
  }
}

const viewSource: SessionReferenceSource = 'listArrivalTestView'
const sid = (value: string): SessionId => value as SessionId
const LISTS = sid('list-state-session')

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** A Host generation source with no reconnects; the fixture never survives a carrier loss. */
const connection: Pick<ConnectionHandle, 'generation'> = {
  generation: {
    getSnapshot: () => undefined,
    subscribe: () => () => {},
  },
}

/**
 * The generated Remote surface reduced to what these paths reach: the list
 * pull, and a follow stream that fails like a terminal wire error (no retry —
 * the open attempt settles as a Remote failure).
 */
function remotes(list: ReturnType<typeof vi.fn>): SessionRemotes {
  const fail = (): Promise<never> => Promise.reject(new RemoteError('gateway/internal', 'fixture unavailable', {}))
  return {
    $stream: (options: never) => new RemoteStream(connection, options),
    commands: { execute: fail },
    session: {
      list,
      follow: () => (async function* () {
        throw new RemoteError('gateway/internal', 'follow unavailable', {})
      })(),
      page: fail,
      projections: () => Promise.resolve({ ok: true, value: null }),
      prompt: fail,
      cancel: fail,
      create: fail,
      fork: fail,
      rename: fail,
    },
    subagents: { prompt: fail, interruptByParent: fail },
  } as unknown as SessionRemotes
}

function bench(list = vi.fn()): { svc: ClientSessions; list: ReturnType<typeof vi.fn> } {
  const ctx = new Context()
  contexts.push(ctx)
  const svc = new ClientSessions(ctx, remotes(list))
  return { svc, list }
}

describe('session list arrival state', () => {
  // FORK dsh-local (f5-list-states): failure axis projected to the list snapshot.
  it('projects a failed pull as list state and recovers through a retry', async () => {
    const { svc, list } = bench()
    list.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('gateway/internal', 'list unavailable', {}),
    })

    await svc.refresh()
    await vi.waitFor(() => {
      expect(svc.list.getSnapshot()).toMatchObject({ state: 'error', phase: 'pending' })
    })
    expect(svc.list.getSnapshot().error).toMatchObject({ code: 'gateway/internal' })

    list.mockResolvedValueOnce({ ok: true, value: { items: [] } })
    await svc.refresh()
    expect(svc.list.getSnapshot()).toMatchObject({ state: 'idle', phase: 'ready', error: null })
  })

  it('keeps the idle axis while the first pull is still in flight', async () => {
    const { svc, list } = bench()
    let release!: () => void
    list.mockReturnValueOnce(new Promise((resolve) => {
      release = () => { resolve({ ok: true, value: { items: [] } }) }
    }))

    const pull = svc.refresh()
    await vi.waitFor(() => {
      expect(svc.list.getSnapshot()).toMatchObject({ state: 'loading', phase: 'pending' })
    })
    release()
    await pull
    expect(svc.list.getSnapshot()).toMatchObject({ state: 'idle', phase: 'ready' })
  })
})

describe('pre-list retain of a persisted selection', () => {
  it('refuses an unknown identity without the persisted flag', () => {
    const { svc } = bench()
    expect(() => svc.retain(LISTS, { source: viewSource })).toThrow('unknown session')
  })

  // FORK dsh-local (f5-list-states, marker: persistedSelection): the trusted
  // retain opens history before session.list delivers the row.
  it('retains an identity the catalog has not listed yet and settles its open', async () => {
    const { svc } = bench()
    const reference = svc.retain(LISTS, { source: viewSource, persistedSelection: true })
    try {
      expect(reference.sessionId).toBe(LISTS)
      expect(svc.binding(LISTS)).toBeDefined()
      expect(svc.retainInfo(LISTS).getSnapshot()).toMatchObject({
        referenceCount: 1,
        retainedBy: { listArrivalTestView: 1 },
      })
      await reference.ready
    } finally {
      reference.release()
    }
    expect(svc.retainInfo(LISTS).getSnapshot()).toMatchObject({ referenceCount: 0, retainedBy: {} })
  })

  // FORK dsh-local (f5-list-states): mainView retention projects a fallback row
  // so ui-session's main-binding scan (byId-driven) resolves the conversation
  // seat before session.list lands; the row is not Host-list membership.
  it('projects a pre-list mainView retention as a fallback list row', async () => {
    const { svc } = bench()
    const reference = svc.retain(LISTS, { source: 'mainView', persistedSelection: true })
    try {
      const snapshot = svc.list.getSnapshot()
      expect(snapshot.ids).toEqual([])
      expect(snapshot.byId[LISTS]).toMatchObject({
        id: LISTS,
        blank: false,
        running: false,
        retainedBy: { mainView: 1 },
      })
      await reference.ready
    } finally {
      reference.release()
    }
    expect(svc.list.getSnapshot().byId[LISTS]).toBeUndefined()
  })
})
