/**
 * Recheck route: `POST /api/stamp-recheck` rides Connection's authenticated
 * exact-fetch fence like the restart dispatch — the fresh judgment answers
 * as JSON with its restart branch, a gather failure answers 500 with one
 * stderr line, and other methods stay natural 404s.
 */
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerRestartSignal } from '../src/restart-signal-host.ts'
import { RECHECK_PATH } from '../src/restart.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Fresh context, real Connection fetch registry, and request helpers over `/api/stamp-recheck`. */
function fixture() {
  const ctx = new Context()
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const handler = connection.createSharedFetchHandler('/api')
  const post = () => handler.fetch(new Request(`http://localhost${RECHECK_PATH}`, { method: 'POST' }),
    connection.browserPeer)
  const get = () => handler.fetch(new Request(`http://localhost${RECHECK_PATH}`, { method: 'GET' }),
    connection.browserPeer)
  return { ctx, post, get }
}

describe('restart-signal recheck route', () => {
  it('answers the fresh judgment as JSON', async () => {
    const { ctx, post } = fixture()
    registerRestartSignal(ctx, { collect: async () => ({ state: 'NEED_RESTART', reason: 'config', detail: 'fixture' }) })
    const response = await post()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ state: 'NEED_RESTART', reason: 'config' })
  })

  it('omits the restart branch on branchless states', async () => {
    const { ctx, post } = fixture()
    registerRestartSignal(ctx, { collect: async () => ({ state: 'OK', detail: 'fixture' }) })
    expect(await (await post()).json()).toEqual({ state: 'OK' })
  })

  it('answers 500 with one stderr line when the gather rejects', async () => {
    const { ctx, post } = fixture()
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    registerRestartSignal(ctx, { collect: async () => { throw new Error('git exploded') } })
    const response = await post()
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'restart-signal recheck failed' })
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('git exploded'))
  })

  it('keeps other methods on the natural 404 path', async () => {
    const { ctx, get } = fixture()
    registerRestartSignal(ctx, { collect: async () => ({ state: 'OK', detail: 'fixture' }) })
    expect((await get()).status).toBe(404)
  })

  it('registers unconditionally, without the restart configuration gate', async () => {
    vi.stubEnv('DSH_WEB_RESTART_COMMAND', undefined)
    const { ctx, post } = fixture()
    registerRestartSignal(ctx, { collect: async () => ({ state: 'INIT', detail: 'fixture' }) })
    expect((await post()).status).toBe(200)
  })
})
