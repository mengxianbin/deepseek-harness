/** Served-page cookie-refresh heartbeat: cadence, visibility, and expiry reporting. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REFRESH_PATH } from '../src/connect-protocol.ts'
import {
  AUTH_EXPIRED_EVENT,
  resolveCookieRefresh,
  startCookieRefresh,
} from '../src/client/cookie-refresh.ts'

class VisibilityProbe extends EventTarget {
  visibilityState = 'hidden'

  set(state: string): void {
    this.visibilityState = state
    this.dispatchEvent(new Event('visibilitychange'))
  }
}

/** Flush the attempt promise chain without depending on timers. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve()
}

interface Harness {
  readonly fetch: ReturnType<typeof vi.fn>
  readonly onExpired: ReturnType<typeof vi.fn>
  readonly interval: { handler?: () => void; ms?: number; cancelled: boolean }
  readonly visibility: VisibilityProbe
  readonly dispose: () => void
  respond(status: number): void
  fail(): void
}

function harness(intervalMs = 1_000): Harness {
  const interval: Harness['interval'] = { cancelled: false }
  const visibility = new VisibilityProbe()
  let resolveNext: ((value: { status: number }) => void) | undefined
  let rejectNext: (() => void) | undefined
  const fetch = vi.fn(() => new Promise<{ status: number }>((resolve, reject) => {
    resolveNext = resolve
    rejectNext = reject
  }))
  const onExpired = vi.fn()
  const dispose = startCookieRefresh({ intervalMs }, onExpired, {
    fetch,
    setInterval: (handler, ms) => {
      interval.handler = handler
      interval.ms = ms
      return () => { interval.cancelled = true }
    },
    visibility,
  })
  return {
    fetch,
    onExpired,
    interval,
    visibility,
    dispose,
    respond: (status) => {
      const resolve = resolveNext
      resolveNext = undefined
      rejectNext = undefined
      if (resolve === undefined) throw new Error('no refresh attempt is in flight')
      resolve({ status })
    },
    fail: () => {
      const fail = rejectNext
      resolveNext = undefined
      rejectNext = undefined
      if (fail === undefined) throw new Error('no refresh attempt is in flight')
      fail()
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('resolveCookieRefresh', () => {
  it('accepts a positive finite interval and rejects every malformed declaration', () => {
    expect(resolveCookieRefresh({ intervalMs: 1_000 })).toEqual({ intervalMs: 1_000 })
    for (const value of [
      undefined,
      null,
      'x',
      [],
      {},
      { intervalMs: 0 },
      { intervalMs: -1 },
      { intervalMs: Number.NaN },
      { intervalMs: Number.POSITIVE_INFINITY },
      { intervalMs: '1000' },
    ]) {
      expect(resolveCookieRefresh(value)).toBeUndefined()
    }
  })
})

describe('startCookieRefresh', () => {
  it('refreshes at start and once per interval, silently ignoring non-401 outcomes', async () => {
    const probe = harness()
    await settle()
    expect(probe.fetch).toHaveBeenCalledExactlyOnceWith(REFRESH_PATH, { method: 'GET' })
    expect(probe.interval.ms).toBe(1_000)

    probe.respond(204)
    await settle()
    expect(probe.onExpired).not.toHaveBeenCalled()

    probe.interval.handler!()
    await settle()
    expect(probe.fetch).toHaveBeenCalledTimes(2)
    probe.respond(500)
    await settle()
    expect(probe.onExpired).not.toHaveBeenCalled()

    probe.interval.handler!()
    await settle()
    probe.respond(204)
    await settle()
    expect(probe.fetch).toHaveBeenCalledTimes(3)
    probe.dispose()
    expect(probe.interval.cancelled).toBe(true)
  })

  it('reports a 401 exactly once with a window event and a console error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    const dispatched = vi.fn()
    browser.addEventListener(AUTH_EXPIRED_EVENT, dispatched)
    const probe = harness()
    await settle()

    probe.respond(401)
    await settle()
    expect(probe.onExpired).toHaveBeenCalledOnce()
    expect(dispatched).toHaveBeenCalledOnce()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('session expired'))

    probe.interval.handler!()
    await settle()
    probe.respond(401)
    await settle()
    expect(probe.onExpired).toHaveBeenCalledOnce()
    expect(dispatched).toHaveBeenCalledOnce()
  })

  it('swallows network failures and retries on the next interval', async () => {
    const probe = harness()
    await settle()
    probe.fail()
    await settle()
    expect(probe.onExpired).not.toHaveBeenCalled()
    probe.interval.handler!()
    await settle()
    expect(probe.fetch).toHaveBeenCalledTimes(2)
    probe.respond(204)
    await settle()
  })

  it('skips an interval tick while an attempt is still in flight', async () => {
    const probe = harness()
    await settle()
    probe.interval.handler!()
    expect(probe.fetch).toHaveBeenCalledOnce()
    probe.respond(204)
    await settle()
  })

  it('refreshes on return to visibility only after a full interval has elapsed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const probe = harness(60_000)
    await settle()
    probe.respond(204)
    await settle()
    expect(probe.fetch).toHaveBeenCalledOnce()

    probe.visibility.set('visible')
    expect(probe.fetch).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(60_000)
    probe.visibility.set('hidden')
    expect(probe.fetch).toHaveBeenCalledOnce()
    probe.visibility.set('visible')
    await settle()
    expect(probe.fetch).toHaveBeenCalledTimes(2)
    probe.respond(204)
    await settle()
  })

  it('is a no-op when fetch or timer surfaces are missing', () => {
    vi.stubGlobal('fetch', undefined)
    const withoutFetch = startCookieRefresh({ intervalMs: 1 }, vi.fn(), { setInterval: () => () => {} })
    withoutFetch()
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('setInterval', undefined)
    vi.stubGlobal('clearInterval', undefined)
    const withoutTimer = startCookieRefresh({ intervalMs: 1 }, vi.fn(), { fetch: async () => ({ status: 204 }) })
    withoutTimer()
  })

  it.each([{ withWindow: true }, { withWindow: false }])(
    'runs on default page surfaces, skips dispatch without a ready window ($withWindow), and clears its timer',
    async ({ withWindow }) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      vi.stubGlobal('fetch', vi.fn(async () => ({ status: 401 })))
      vi.stubGlobal('CustomEvent', undefined)
      if (withWindow) vi.stubGlobal('window', new EventTarget())

      const dispose = startCookieRefresh({ intervalMs: 3_600_000 })
      await settle()

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('session expired'))
      dispose()
    },
  )
})
