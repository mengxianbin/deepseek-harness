// @vitest-environment jsdom
/** Pull flow: boot publish, visibility recheck, failure keeps the previous instant, listener
 * lifetime, and the page-global fallbacks (server-started-at-1117). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startServerStartedAtFlow } from '../src/client/server-started-at-flow.ts'

const ISO = '2026-11-12T21:49:00.000Z'

/** A fetch stand-in answering one canned body per call. */
function fetchStub(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({ ok, status, json: async () => body }))
}

/** A visibility target whose listener the test fires directly. */
function visibilityStub(initial: string) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    target: {
      get visibilityState() { return state },
      addEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.add(listener) },
      removeEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.delete(listener) },
    },
    show() { state = 'visible'; for (const listener of [...listeners]) listener() },
    hide() { state = 'hidden'; for (const listener of [...listeners]) listener() },
    listenerCount: () => listeners.size,
  }
}

/** Flush the fire-and-forget pull chain. */
function tick(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('server start-time pull flow', () => {
  it('publishes the boot instant and pulls again on return to visibility', async () => {
    const fetchImpl = fetchStub({ startedAt: ISO })
    const publish = vi.fn<(startedAt: string) => void>()
    const visibility = visibilityStub('hidden')
    const flow = startServerStartedAtFlow(publish, { fetch: fetchImpl, visibility: visibility.target, warn: vi.fn() })
    await tick()
    expect(fetchImpl).toHaveBeenCalledWith('/api/server/started-at', { method: 'GET' })
    expect(publish).toHaveBeenCalledWith(ISO)

    // A visibilitychange toward hidden must not pull; toward visible must.
    visibility.hide()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    visibility.show()
    await tick()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    flow.dispose()
    expect(visibility.listenerCount()).toBe(0)
    await tick()
    visibility.show()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('keeps the previous instant and warns on a malformed body, a refused status, and a transport failure', async () => {
    const warn = vi.fn()
    const publish = vi.fn<(startedAt: string) => void>()
    const bad = startServerStartedAtFlow(publish, { fetch: fetchStub({ nope: true }), warn })
    await tick()
    expect(publish).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    bad.dispose()
    const refused = startServerStartedAtFlow(publish, { fetch: fetchStub({}, false, 503), warn })
    await tick()
    expect(warn).toHaveBeenCalledTimes(2)
    refused.dispose()
    const broken = startServerStartedAtFlow(publish, {
      fetch: vi.fn(async () => { throw new Error('offline') }),
      warn,
    })
    await tick()
    expect(warn).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('offline'))
    broken.dispose()
  })

  it('rechecks on demand for the reconnect leg', async () => {
    const fetchImpl = fetchStub({ startedAt: ISO })
    const publish = vi.fn<(startedAt: string) => void>()
    const flow = startServerStartedAtFlow(publish, { fetch: fetchImpl, warn: vi.fn() })
    await tick()
    flow.recheck()
    await tick()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith(ISO)
    flow.dispose()
  })

  it('falls back to the page fetch when none is injected', async () => {
    const fetchImpl = fetchStub({ startedAt: ISO })
    vi.stubGlobal('fetch', fetchImpl)
    const publish = vi.fn<(startedAt: string) => void>()
    const flow = startServerStartedAtFlow(publish, { warn: vi.fn() })
    await tick()
    expect(fetchImpl).toHaveBeenCalledWith('/api/server/started-at', { method: 'GET' })
    expect(publish).toHaveBeenCalledWith(ISO)
    flow.dispose()
  })

  it('stays silent when the page has no fetch at all', async () => {
    vi.stubGlobal('fetch', undefined)
    const warn = vi.fn()
    const flow = startServerStartedAtFlow(vi.fn(), { warn })
    await tick()
    expect(warn).not.toHaveBeenCalled()
    flow.dispose()
  })

  it('warns through the page console when no sink is injected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchStub({}, false, 500))
    const flow = startServerStartedAtFlow(vi.fn())
    await tick()
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('HTTP 500'))
    flow.dispose()
  })
})
