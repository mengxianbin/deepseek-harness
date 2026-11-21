/**
 * Coverage for @deepseek-ai/dsh-event-loop-monitor (design
 * event-loop-monitor-1108): the design §二 light table and §三.2 aggregate
 * line as pure-function cases, the slice-overshoot registry (globalThis
 * singleton, window diffing), the channel-c probe through a stand-in
 * webServer (schema, loopback fence, method check), the `disable` quiet
 * absence, fail-loud config, the loader load-path shape, and two real-timer
 * integration legs that pin the acceptance pipeline end to end: a 500 ms
 * synchronous busy-wait must surface as a histogram max spike AND the
 * over-threshold aggregate log line (unattributed → report dump), while a
 * slice recorded in the same window attributes the spike instead.
 *
 * The channel-b alert file is deliberately NOT driven red here: its write
 * path would stamp the real `<dsh-home>` fact file from a test run. Red
 * logic is covered by the `foldWindow` table cases; the file writer is a
 * fail-soft `writeFileSync` beside them.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as eventLoopMonitor from '@deepseek-ai/dsh-event-loop-monitor'
import { recordOvershoot, resetOvershoots, snapshotOvershoots } from '@deepseek-ai/dsh-event-loop-monitor'
import { overshootDelta } from '../src/overshoot.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** A synchronous main-thread stall — the design §三 acceptance experiment's 500 ms busy-wait. */
function busy(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) { /* spin */ }
}

const fibers: { dispose(): Promise<unknown> }[] = []

beforeEach(() => { resetOvershoots() })
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fibers.splice(0).map(fiber => fiber.dispose()))
})

/** Fields a test may override when forging the probe request. */
interface ProbeOptions {
  host?: string
  remote?: string
  method?: string
}

/** IncomingMessage stand-in carrying only what the probe handler and its fence read. */
function probeRequest(options: ProbeOptions): IncomingMessage {
  const headers: Record<string, string> = { host: options.host ?? '127.0.0.1:3080' }
  return {
    method: options.method ?? 'GET',
    headers,
    socket: { remoteAddress: options.remote ?? '127.0.0.1' },
  } as unknown as IncomingMessage
}

/**
 * Mount the watch over a stand-in `webServer` that captures the probe route,
 * and hand back callers that invoke it once and read the answer — the
 * endpoint is asserted through its handler, exactly as the fence and schema
 * are served, without binding a real listener.
 */
async function setupProbe(config: eventLoopMonitor.Config) {
  const ctx = new Context()
  const routes = new Map<string, WebRoute['handler']>()
  ctx.provide('webServer', {
    register(route: WebRoute): () => void {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  } as never)
  const fiber = await ctx.plugin(eventLoopMonitor, config)
  fibers.push(fiber)
  // The route registers from a child fiber waiting on `webServer`.
  await vi.waitFor(() => { expect(routes.size).toBe(1) }, { timeout: 2000 })
  const handler = routes.get(eventLoopMonitor.STATE_PATH)
  if (handler === undefined) throw new Error(`probe route ${eventLoopMonitor.STATE_PATH} did not register`)
  const probe = async (options: ProbeOptions = {}): Promise<{ status: number; body: string }> => {
    const captured = { status: 0, body: '' }
    const res = {
      writeHead(status: number): void { captured.status = status },
      end(body?: string): void { captured.body = body ?? '' },
    } as unknown as ServerResponse
    await handler(probeRequest(options), res)
    return captured
  }
  const readState = async (): Promise<eventLoopMonitor.EventLoopState> => {
    const { status, body } = await probe()
    expect(status).toBe(200)
    return JSON.parse(body) as eventLoopMonitor.EventLoopState
  }
  return { ctx, probe, readState }
}

/** Poll the probe until `count` windows have completed (real 1 s windows). */
async function waitForWindows(
  readState: () => Promise<eventLoopMonitor.EventLoopState>,
  count: number,
): Promise<eventLoopMonitor.EventLoopState> {
  const deadline = Date.now() + 8000
  for (;;) {
    const state = await readState()
    if (state.history.length >= count) return state
    if (Date.now() > deadline) throw new Error(`only ${state.history.length} of ${count} windows after 8s`)
    await sleep(100)
  }
}

describe('event-loop-monitor design §二 light fold', () => {
  const thresholds = { p99WarnMs: 250, maxBadMs: 2000 }
  const quiet = { p99: 40, max: 120, elu: 0.3 }

  it('keeps a normal window green and counts the normal streak', () => {
    const next = eventLoopMonitor.foldWindow(eventLoopMonitor.INITIAL_LIGHT_STATE, quiet, thresholds)
    expect(next.light).toBe('green')
    expect(next.consecutiveNormal).toBe(1)
    expect(next.consecutiveOver).toBe(0)
  })

  it('turns the first and second over-window yellow, never green meanwhile', () => {
    const over = { p99: 412, max: 900, elu: 0.4 }
    const first = eventLoopMonitor.foldWindow(eventLoopMonitor.INITIAL_LIGHT_STATE, over, thresholds)
    expect(first.light).toBe('yellow')
    expect(first.consecutiveOver).toBe(1)
    const second = eventLoopMonitor.foldWindow(first, over, thresholds)
    expect(second.light).toBe('yellow')
    expect(second.consecutiveOver).toBe(2)
    expect(second.consecutiveNormal).toBe(0)
  })

  it('reddens on the third consecutive over-window and recovers when a window clears', () => {
    const over = { p99: 412, max: 900, elu: 0.4 }
    let state = eventLoopMonitor.INITIAL_LIGHT_STATE
    for (let i = 0; i < 3; i += 1) state = eventLoopMonitor.foldWindow(state, over, thresholds)
    expect(state.light).toBe('red')
    const recovered = eventLoopMonitor.foldWindow(state, quiet, thresholds)
    expect(recovered.light).toBe('green')
    expect(recovered.consecutiveOver).toBe(0)
    expect(recovered.consecutiveNormal).toBe(1)
  })

  it('yellows on a single max breach alone (design: 单次 max > 2s)', () => {
    const spike = { p99: 40, max: 2100, elu: 0.3 }
    const next = eventLoopMonitor.foldWindow(eventLoopMonitor.INITIAL_LIGHT_STATE, spike, thresholds)
    expect(next.light).toBe('yellow')
    expect(next.consecutiveOver).toBe(0)
  })

  it('reddens after three consecutive ELU-hot windows (design gap-fill: 持续 = ≥3 窗)', () => {
    const hot = { p99: 40, max: 120, elu: 0.95 }
    let state = eventLoopMonitor.INITIAL_LIGHT_STATE
    state = eventLoopMonitor.foldWindow(state, hot, thresholds)
    state = eventLoopMonitor.foldWindow(state, hot, thresholds)
    expect(state.light).toBe('green')
    expect(state.consecutiveEluHot).toBe(2)
    state = eventLoopMonitor.foldWindow(state, hot, thresholds)
    expect(state.light).toBe('red')
    expect(state.consecutiveOver).toBe(0)
  })
})

describe('event-loop-monitor design §三.2 aggregate line', () => {
  it('stays silent while green', () => {
    expect(eventLoopMonitor.formatAggregateLine({ p99: 40, max: 120, elu: 0.3 }, 'green', 60)).toBeUndefined()
  })

  it('prints the design example shape for an over-threshold window', () => {
    const line = eventLoopMonitor.formatAggregateLine({ p99: 412, max: 2100, elu: 0.63 }, 'yellow', 60)
    expect(line).toBe('event-loop: p99 412ms max 2.1s elu 63% over 60s window')
  })

  it('formats sub-second max in ms and carries the red light too', () => {
    const line = eventLoopMonitor.formatAggregateLine({ p99: 260, max: 515, elu: 0.5 }, 'red', 1)
    expect(line).toBe('event-loop: p99 260ms max 515ms elu 50% over 1s window')
  })
})

describe('slice overshoot registry', () => {
  it('accumulates count/worst/last per slice and diffs windows', () => {
    recordOvershoot('list', 12)
    recordOvershoot('list', 40)
    recordOvershoot('zstd', 5)
    const snapshot = snapshotOvershoots()
    expect(snapshot.list).toMatchObject({ count: 2, worstMs: 40 })
    expect(snapshot.list?.lastAt).toBeGreaterThan(0)
    expect(snapshot.zstd?.count).toBe(1)
    expect(overshootDelta({}, snapshot)).toBe(3)
    expect(overshootDelta(snapshot, snapshot)).toBe(0)
    const later = { ...snapshot, list: { ...snapshot.list!, count: 5, worstMs: 40, lastAt: 1 } }
    expect(overshootDelta(snapshot, later)).toBe(3)
    resetOvershoots()
    expect(snapshotOvershoots()).toEqual({})
  })

  it('lives on globalThis so every importer shares one accumulator', () => {
    recordOvershoot('migration', 7)
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for('dsh.event-loop-monitor.overshoot')]
    expect(registry).toBeDefined()
    expect(snapshotOvershoots().migration?.count).toBe(1)
  })
})

describe('event-loop-monitor probe (channel c)', () => {
  it('serves the state schema with p99/max/elu and the design defaults', async () => {
    const { readState } = await setupProbe({})
    const state = await readState()
    expect(Object.keys(state).sort()).toEqual([
      'at', 'attribution', 'consecutiveNormal', 'consecutiveOver', 'elu', 'events',
      'history', 'light', 'max', 'mean', 'overWindows', 'p50', 'p99', 'unattributed', 'windowSec',
    ])
    expect(state.windowSec).toBe(60)
    expect(state.light).toBe('green')
    for (const field of ['p50', 'p99', 'max', 'mean', 'elu'] as const) {
      expect(typeof state[field]).toBe('number')
    }
    expect(state.attribution.map(entry => entry.slice)).toEqual(['list', 'migration', 'zstd'])
    expect(state.history).toEqual([])
    expect(state.events).toEqual([])
  })

  it('refuses a non-loopback caller before answering anything', async () => {
    const { probe } = await setupProbe({})
    const { status, body } = await probe({ remote: '10.1.2.3' })
    expect(status).toBe(403)
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'forbidden: loopback-only' })
  })

  it('answers 405 to a non-GET from loopback', async () => {
    const { probe } = await setupProbe({})
    const { status } = await probe({ method: 'POST' })
    expect(status).toBe(405)
  })
})

describe('event-loop-monitor config and load path', () => {
  it('stays a quiet absence when disable is set (no route ever registers)', async () => {
    const ctx = new Context()
    const routes = new Map<string, WebRoute['handler']>()
    ctx.provide('webServer', {
      register(route: WebRoute): () => void {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    } as never)
    const fiber = await ctx.plugin(eventLoopMonitor, { disable: true })
    fibers.push(fiber)
    await sleep(100)
    expect(routes.size).toBe(0)
  })

  it('fails loud on out-of-range thresholds', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(eventLoopMonitor, { windowSec: 0 })).rejects.toThrow(/windowSec/)
    await expect(ctx.plugin(eventLoopMonitor, { p99WarnMs: -1 })).rejects.toThrow(/p99WarnMs/)
    await expect(ctx.plugin(eventLoopMonitor, { maxBadMs: 0 })).rejects.toThrow(/maxBadMs/)
  })

  it('has no default export and keeps name/inject through unwrapExports', () => {
    expect('default' in eventLoopMonitor).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(eventLoopMonitor) as Record<string, unknown>
    expect(unwrapped).toBe(eventLoopMonitor)
    expect(unwrapped.name).toBe('event-loop-monitor')
    expect(unwrapped.inject).toEqual([])
    expect(typeof unwrapped.apply).toBe('function')
  })
})

describe('event-loop-monitor real-timer windows', () => {
  it('turns a 500ms busy-wait into a histogram spike and the over-threshold line', async () => {
    const { ctx, readState } = await setupProbe({ windowSec: 1, maxBadMs: 300 })
    const info = vi.spyOn(ctx.logger, 'info')
    // Baseline window: quiet machine → green → no line (design: 异常才出声).
    const baseline = await waitForWindows(readState, 1)
    expect(baseline.light).toBe('green')
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('event-loop: p99'))
    // Let one histogram timer fire after the window reset, then stall the
    // main thread for 500 ms — the acceptance experiment.
    await sleep(50)
    busy(500)
    const spiked = await waitForWindows(readState, 2)
    // 直方图尖峰可见: the stall landed in the window max over the bad threshold.
    expect(spiked.max).toBeGreaterThan(300)
    expect(spiked.p99).toBeGreaterThan(0)
    expect(spiked.light).toBe('yellow')
    // 超阈聚合日志行出现: design §三.2 shape, one line for the window.
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/^event-loop: p99 \d+ms max [\d.]+(?:ms|s) elu \d+% over 1s window$/),
    )
    // Unattributed (no slice overshot) → the report dump fired once.
    expect(spiked.unattributed.count).toBe(1)
    expect(spiked.unattributed.dumps).toBe(1)
    expect(spiked.events.some(event => event.kind === 'spike' && (event.slices ?? []).length === 0)).toBe(true)
  }, 15_000)

  it('attributes a spike to the slice point that overshot in the same window', async () => {
    const { readState } = await setupProbe({ windowSec: 1, maxBadMs: 300 })
    await waitForWindows(readState, 1)
    await sleep(50)
    recordOvershoot('migration', 120)
    busy(500)
    const spiked = await waitForWindows(readState, 2)
    expect(spiked.max).toBeGreaterThan(300)
    // Attributed: the migration slice recorded inside the same window, so no
    // unattributed tally and no dump.
    expect(spiked.unattributed.count).toBe(0)
    expect(spiked.unattributed.dumps).toBe(0)
    const spike = spiked.events.find(event => event.kind === 'spike')
    expect(spike?.slices).toEqual(['migration'])
    const migration = spiked.attribution.find(entry => entry.slice === 'migration')
    expect(migration?.count).toBeGreaterThanOrEqual(1)
    expect(migration?.worstMs).toBeGreaterThanOrEqual(120)
    expect(migration?.lastAt).toBeGreaterThan(0)
  }, 15_000)
})
