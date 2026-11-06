/**
 * Recheck route: `POST /api/stamp-recheck` rides Connection's authenticated
 * exact-fetch fence like the restart dispatch — the fresh judgment answers
 * as JSON with its restart branch, a gather failure answers 500 with one
 * stderr line, a gather past the deadline answers the last judgment (504
 * with none) instead of hanging (stamp-recheck-cache-timeout-1107), and other
 * methods stay natural 404s.
 */
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerRestartSignal } from '../src/restart-signal-host.ts'
import { latestClientAttestation, resetDispositionStateForTest } from '../src/restart-disposition.ts'
import type { RestartSignalJudgment } from '../src/restart-signal.ts'
import { RECHECK_PATH } from '../src/restart.ts'

afterEach(() => {
  vi.restoreAllMocks()
  resetDispositionStateForTest()
})

/** Fresh context, real Connection fetch registry, and request helpers over `/api/stamp-recheck`. */
function fixture() {
  const ctx = new Context()
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const handler = connection.createSharedFetchHandler('/api')
  const post = (body?: string) => handler.fetch(new Request(`http://localhost${RECHECK_PATH}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
  }), connection.browserPeer)
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

  it('carries the build-start time with a BUILDING judgment (build-timer-tooltip-1101)', async () => {
    const { ctx, post } = fixture()
    registerRestartSignal(ctx, {
      collect: async () => ({ state: 'BUILDING', startedAt: '2026-11-01T13:36:21.476Z', detail: 'fixture' }),
    })
    expect(await (await post()).json()).toEqual({ state: 'BUILDING', startedAt: '2026-11-01T13:36:21.476Z' })
  })

  it('omits the start time on a BUILDING judgment without one', async () => {
    const { ctx, post } = fixture()
    registerRestartSignal(ctx, { collect: async () => ({ state: 'BUILDING', detail: 'fixture' }) })
    expect(await (await post()).json()).toEqual({ state: 'BUILDING' })
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

  it('answers the last computed judgment when the gather hangs past the deadline', async () => {
    const { ctx, post } = fixture()
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const hung: RestartSignalJudgment = {
      state: 'BUILDING',
      startedAt: '2026-11-06T19:30:17.345Z',
      detail: 'previous computation',
    }
    registerRestartSignal(ctx, {
      collect: () => new Promise<RestartSignalJudgment>(() => {}),
      timeoutMs: 5,
      lastJudgment: () => hung,
    })
    const started = Date.now()
    const response = await post()
    // The answer lands on the deadline, not on the (never-settling) gather:
    // bounded wait, no throw, no 70s hang.
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ state: 'BUILDING', startedAt: '2026-11-06T19:30:17.345Z' })
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('timed out after 5ms'))
  })

  it('answers 504 at the deadline when no judgment exists yet', async () => {
    const { ctx, post } = fixture()
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    registerRestartSignal(ctx, {
      collect: () => new Promise<RestartSignalJudgment>(() => {}),
      timeoutMs: 5,
      lastJudgment: () => undefined,
    })
    const response = await post()
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: 'restart-signal recheck timed out' })
    // Without a last judgment the line names the bare timeout (no "answering with").
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('timed out after 5ms'))
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

  it('records the client running-count attestation from the recheck body (P3)', async () => {
    const { ctx, post } = fixture()
    registerRestartSignal(ctx, { collect: async () => ({ state: 'OK', detail: 'fixture' }) })
    const response = await post(JSON.stringify({ runningCount: 4 }))
    expect(response.status).toBe(200)
    await vi.waitFor(() => {
      expect(latestClientAttestation()?.count).toBe(4)
      expect(typeof latestClientAttestation()?.at).toBe('number')
    })
  })

  it('keeps the previous attestation on a malformed body and still answers the judgment', async () => {
    const { ctx, post } = fixture()
    registerRestartSignal(ctx, { collect: async () => ({ state: 'OK', detail: 'fixture' }) })
    await post(JSON.stringify({ runningCount: 0 }))
    await vi.waitFor(() => { expect(latestClientAttestation()?.count).toBe(0) })
    const response = await post('{not json')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ state: 'OK' })
    expect(latestClientAttestation()?.count).toBe(0)
  })

  it('ignores a body whose runningCount is not a clean count', async () => {
    const { ctx, post } = fixture()
    registerRestartSignal(ctx, { collect: async () => ({ state: 'OK', detail: 'fixture' }) })
    await post(JSON.stringify({ runningCount: -2 }))
    await post(JSON.stringify({ runningCount: 1.5 }))
    await post(JSON.stringify({ runningCount: '7' }))
    expect(latestClientAttestation()).toBeUndefined()
  })
})
