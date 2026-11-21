/**
 * Start-time route: `GET /api/server/started-at` rides Connection's
 * authenticated exact-fetch fence like the other settings routes — it answers
 * this process's own start instant as `no-store` JSON that never moves for
 * the life of the process, other methods stay natural 404s, and the shared
 * resolver refuses every malformed body (server-started-at-1117).
 */
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { describe, expect, it } from 'vitest'
import { registerServerStartedAt } from '../src/server-started-at-host.ts'
import { SERVER_STARTED_AT_PATH, resolveServerStartedAt } from '../src/server-started-at.ts'

/** Fresh context, real Connection fetch registry, and request helpers over the start-time route. */
function fixture() {
  const ctx = new Context()
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const handler = connection.createSharedFetchHandler('/api')
  const get = () => handler.fetch(new Request(`http://localhost${SERVER_STARTED_AT_PATH}`, { method: 'GET' }),
    connection.browserPeer)
  const post = () => handler.fetch(new Request(`http://localhost${SERVER_STARTED_AT_PATH}`, { method: 'POST' }),
    connection.browserPeer)
  return { ctx, get, post }
}

describe('server start-time route', () => {
  it('answers this process start instant as no-store JSON that never moves', async () => {
    const { ctx, get } = fixture()
    registerServerStartedAt(ctx)
    const response = await get()
    expect(response.status).toBe(200)
    // A cached answer would show a previous process's start — the exact lie
    // the route exists to prevent.
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as { startedAt: string }
    const startedAt = Date.parse(body.startedAt)
    expect(Number.isFinite(startedAt)).toBe(true)
    // The captured instant is the process start: within test-run tolerance of
    // the uptime-derived reading taken now.
    const expected = Date.now() - process.uptime() * 1000
    expect(Math.abs(startedAt - expected)).toBeLessThan(10_000)
    // Registration captured it once: a second answer is the same instant.
    expect(await (await get()).json()).toEqual(body)
  })

  it('keeps other methods on the natural 404 path', async () => {
    const { ctx, post } = fixture()
    registerServerStartedAt(ctx)
    expect((await post()).status).toBe(404)
  })
})

describe('resolveServerStartedAt', () => {
  it('accepts a readable ISO instant', () => {
    expect(resolveServerStartedAt({ startedAt: '2026-11-12T21:49:00.000Z' })).toBe('2026-11-12T21:49:00.000Z')
  })

  it.each([
    ['a non-object body', 'nope'],
    ['null', null],
    ['an array', []],
    ['a missing seat', {}],
    ['a non-string seat', { startedAt: 42 }],
    ['an unreadable instant', { startedAt: 'yesterday' }],
  ])('refuses %s and keeps the previous instant unpublished', (_label, value) => {
    expect(resolveServerStartedAt(value)).toBeUndefined()
  })
})
