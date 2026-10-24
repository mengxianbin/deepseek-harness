// @vitest-environment jsdom
/** Recheck flow: boot publish, visibility recheck, failure keeps the badge, listener lifetime,
 * and the P3 attestation (running-count body + NEED_RESTART refresh cadence). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRestartSignalFlow } from '../src/client/restart-signal-flow.ts'
import type { RestartSignalView } from '../src/restart.ts'

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

/** Flush the fire-and-forget recheck chain. */
function tick(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('restart-signal recheck flow', () => {
  it('publishes the boot judgment and rechecks on return to visibility', async () => {
    const fetchImpl = fetchStub({ state: 'NEED_BUILD' })
    const publish = vi.fn<(view: RestartSignalView) => void>()
    const visibility = visibilityStub('hidden')
    const flow = startRestartSignalFlow(publish, { fetch: fetchImpl, visibility: visibility.target, warn: vi.fn() })
    await tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ state: 'NEED_BUILD' })

    // A visibilitychange toward hidden must not recheck; toward visible must.
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

  it('keeps the previous badge and warns on a malformed body, a refused status, and a transport failure', async () => {
    const warn = vi.fn()
    const publish = vi.fn<(view: RestartSignalView) => void>()
    const bad = startRestartSignalFlow(publish, { fetch: fetchStub({ nope: true }), warn })
    await tick()
    expect(publish).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    bad.dispose()
    const refused = startRestartSignalFlow(publish, { fetch: fetchStub({}, false, 503), warn })
    await tick()
    expect(warn).toHaveBeenCalledTimes(2)
    refused.dispose()
    const broken = startRestartSignalFlow(publish, {
      fetch: vi.fn(async () => { throw new Error('offline') }),
      warn,
    })
    await tick()
    expect(warn).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('offline'))
    broken.dispose()
  })

  it('rechecks on demand for the reconnect leg and tolerates a missing fetch surface', async () => {
    const fetchImpl = fetchStub({ state: 'OK' })
    const publish = vi.fn<(view: RestartSignalView) => void>()
    const flow = startRestartSignalFlow(publish, { fetch: fetchImpl, warn: vi.fn() })
    await tick()
    flow.recheck()
    await tick()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({ state: 'OK' })
    flow.dispose()
    const silent = startRestartSignalFlow(publish, { warn: vi.fn() })
    silent.dispose()
  })
})

describe('restart-signal recheck attestation (P3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** Flush the fire-and-forget recheck chain on the fake clock. */
  const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

  it('rides the page running-count on every recheck', async () => {
    const fetchImpl = fetchStub({ state: 'OK' })
    const flow = startRestartSignalFlow(vi.fn(), { fetch: fetchImpl, warn: vi.fn(), runningCount: () => 4 })
    await flush()
    expect(fetchImpl).toHaveBeenCalledWith('/api/stamp-recheck', {
      method: 'POST',
      body: JSON.stringify({ runningCount: 4 }),
      headers: { 'content-type': 'application/json' },
    })
    flow.dispose()
  })

  it('omits the body when no counter is supplied (pre-P3 request shape)', async () => {
    const fetchImpl = fetchStub({ state: 'OK' })
    const flow = startRestartSignalFlow(vi.fn(), { fetch: fetchImpl, warn: vi.fn() })
    await flush()
    expect(fetchImpl).toHaveBeenCalledWith('/api/stamp-recheck', { method: 'POST' })
    flow.dispose()
  })

  it('keeps the attestation fresh while NEED_RESTART shows and stops once the state moves on', async () => {
    let body: unknown = { state: 'NEED_RESTART', reason: 'built' }
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }))
    const flow = startRestartSignalFlow(vi.fn(), { fetch: fetchImpl, warn: vi.fn(), refreshMs: 30_000 })
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    // The state moves on: that tick stops the cadence.
    body = { state: 'OK' }
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    flow.dispose()
  })

  it('dispose cancels the refresh cadence', async () => {
    const fetchImpl = fetchStub({ state: 'NEED_RESTART', reason: 'built' })
    const flow = startRestartSignalFlow(vi.fn(), { fetch: fetchImpl, warn: vi.fn(), refreshMs: 30_000 })
    await flush()
    flow.dispose()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a zero refresh window disables the cadence entirely', async () => {
    const fetchImpl = fetchStub({ state: 'NEED_RESTART', reason: 'built' })
    const flow = startRestartSignalFlow(vi.fn(), { fetch: fetchImpl, warn: vi.fn(), refreshMs: 0 })
    await flush()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    flow.dispose()
  })
})
