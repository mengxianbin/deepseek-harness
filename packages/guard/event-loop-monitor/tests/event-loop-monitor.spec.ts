/**
 * Coverage for @deepseek-ai/dsh-event-loop-monitor (design
 * event-loop-monitor-1108 + output scheme loop-report-sign-1123): the
 * design §二 light table and §三.2 aggregate line as pure-function cases,
 * the slice-overshoot registry (globalThis singleton, window diffing), the
 * channel-c probe through a stand-in webServer (schema, loopback fence,
 * method check), the `disable` quiet absence, fail-loud config, the loader
 * load-path shape, the signature/cold-layer/hot-layer output scheme
 * (bucketing, filename round-trip, caps, rolling JSONL, load sweep), and
 * real-timer integration legs that pin the acceptance pipeline end to end:
 * a 500 ms synchronous busy-wait must surface as a histogram max spike AND
 * the over-threshold aggregate log line (first sighting of a signature →
 * report dump), a repeat sighting must count into the event JSONL instead
 * of dumping again, a full cold layer must refuse the dump, and a slice
 * recorded in the same window attributes the spike instead.
 *
 * Every test runs in a throwaway cwd: the watch writes `.tmp/loop-report/`
 * relative to the process cwd, and the load-time cold-layer sweep would
 * otherwise act on the real repository's stock dumps.
 *
 * The channel-b alert file is deliberately NOT driven red here: its write
 * path would stamp the real `<dsh-home>` fact file from a test run. Red
 * logic is covered by the `foldWindow` table cases; the file writer is a
 * fail-soft `writeFileSync` beside them.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as eventLoopMonitor from '@deepseek-ai/dsh-event-loop-monitor'
import {
  appendLoopEvent,
  COLD_GLOBAL_LIMIT,
  COLD_PER_SIGNATURE_LIMIT,
  dumpFileName,
  LEGACY_SIGNATURE,
  parseDumpSignature,
  readColdLayer,
  recordOvershoot,
  resetOvershoots,
  spikeSignature,
  snapshotOvershoots,
  sweepColdLayer,
  WORST_BUCKETS,
  worstBucket,
} from '@deepseek-ai/dsh-event-loop-monitor'
import { overshootDelta } from '../src/overshoot.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** A synchronous main-thread stall — the design §三 acceptance experiment's 500 ms busy-wait. */
function busy(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) { /* spin */ }
}

/** The dump directory the watch uses, relative to (the test's throwaway) cwd. */
const DUMP_DIR = join('.tmp', 'loop-report')

/** Cold-layer dump files currently on disk (the event JSONL never matches). */
function dumpFiles(): string[] {
  try {
    return readdirSync(DUMP_DIR).filter(name => name.startsWith('loop-report-') && name.endsWith('.json')).sort()
  } catch {
    return []
  }
}

/** The hot-layer event JSONL, parsed; an absent file reads as no events. */
function readEvents(): Record<string, unknown>[] {
  try {
    return readFileSync(join(DUMP_DIR, 'loop-events.jsonl'), 'utf8')
      .split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

const fibers: { dispose(): Promise<unknown> }[] = []
let cwdBackup = ''
let tempCwd = ''

beforeEach(() => {
  resetOvershoots()
  cwdBackup = process.cwd()
  tempCwd = mkdtempSync(join(tmpdir(), 'event-loop-monitor-'))
  process.chdir(tempCwd)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fibers.splice(0).map(fiber => fiber.dispose()))
  process.chdir(cwdBackup)
  rmSync(tempCwd, { recursive: true, force: true })
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

describe('spike signatures (loop-report-sign-1123)', () => {
  it('buckets the worst ms in tiers of the configured maxBadMs', () => {
    expect(worstBucket(2000, 2000)).toBe('sub1x')
    expect(worstBucket(2001, 2000)).toBe('1-3x')
    expect(worstBucket(6000, 2000)).toBe('1-3x')
    expect(worstBucket(6001, 2000)).toBe('3-10x')
    expect(worstBucket(20_000, 2000)).toBe('3-10x')
    expect(worstBucket(20_001, 2000)).toBe('10-30x')
    expect(worstBucket(60_000, 2000)).toBe('10-30x')
    expect(worstBucket(60_001, 2000)).toBe('30x+')
    expect(worstBucket(Number.NaN, 2000)).toBe('sub1x')
    // The tiers follow a retuned threshold instead of fixed milliseconds.
    expect(worstBucket(510, 300)).toBe('1-3x')
  })

  it('combines the bucket with the slice attribution state', () => {
    expect(spikeSignature(3200, [], 2000)).toBe('1-3x_none')
    expect(spikeSignature(7000, [], 2000)).toBe('3-10x_none')
    expect(spikeSignature(1500, [], 2000)).toBe('sub1x_none')
    // Sorted slice names, `.`-joined — attribution state rides in the signature.
    expect(spikeSignature(7000, ['zstd', 'list'], 2000)).toBe('3-10x_list.zstd')
    expect(spikeSignature(70_000, ['migration'], 2000)).toBe('30x+_migration')
  })

  it('round-trips through the dump file name and reads legacy stock as unsigned', () => {
    expect(dumpFileName('2026-11-23T10-00-00-000Z', '1-3x_none'))
      .toBe('loop-report-2026-11-23T10-00-00-000Z-sig-1-3x-none.json')
    expect(parseDumpSignature(dumpFileName('2026-11-23T10-00-00-000Z', '1-3x_none'))).toBe('1-3x_none')
    expect(parseDumpSignature(dumpFileName('2026-11-23T10-00-00-000Z', '3-10x_list.zstd'))).toBe('3-10x_list.zstd')
    expect(parseDumpSignature(dumpFileName('2026-11-23T10-00-00-000Z', '30x+_none'))).toBe('30x+_none')
    // Pre-signature stock and foreign files carry no signature.
    expect(parseDumpSignature('loop-report-2026-11-20T17-06-17-260Z.json')).toBeUndefined()
    expect(parseDumpSignature('loop-events.jsonl')).toBeUndefined()
  })
})

describe('cold-layer census, caps and first scan', () => {
  it('censuses dump files by signature with legacy stock as one class', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elm-cold-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, dumpFileName('2026-11-23T00-00-01-000Z', '1-3x_none')), '{}')
    writeFileSync(join(dir, dumpFileName('2026-11-23T00-00-02-000Z', '1-3x_none')), '{}')
    writeFileSync(join(dir, 'loop-report-2026-11-20T17-06-17-260Z.json'), '{}')
    writeFileSync(join(dir, 'loop-events.jsonl'), '{}\n')
    writeFileSync(join(dir, 'notes.txt'), 'foreign')
    const census = readColdLayer(dir)
    expect(census?.total).toBe(3)
    expect(census?.perSignature.get('1-3x_none')).toBe(2)
    expect(census?.perSignature.get(LEGACY_SIGNATURE)).toBe(1)
    // A missing directory is an empty layer; a path that is not a directory is unreadable.
    expect(readColdLayer(join(dir, 'absent'))).toEqual({ total: 0, perSignature: new Map() })
    expect(readColdLayer(join(dir, 'notes.txt'))).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('sweeps to the per-signature cap, newest kept, foreign files untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elm-sweep-'))
    mkdirSync(dir, { recursive: true })
    // Five dumps of one signature, two of another, one legacy stock file.
    for (let i = 1; i <= 5; i += 1) {
      writeFileSync(join(dir, dumpFileName(`2026-11-23T00-00-0${i}-000Z`, '1-3x_none')), 'x'.repeat(10 + i))
    }
    writeFileSync(join(dir, dumpFileName('2026-11-23T00-00-01-000Z', '3-10x_list')), 'y')
    writeFileSync(join(dir, dumpFileName('2026-11-23T00-00-02-000Z', '3-10x_list')), 'y')
    writeFileSync(join(dir, 'loop-report-2026-11-20T17-06-17-260Z.json'), 'z')
    writeFileSync(join(dir, 'loop-events.jsonl'), '{"at":1}\n')
    writeFileSync(join(dir, 'notes.txt'), 'foreign')

    const result = sweepColdLayer(dir)
    expect(result.before).toEqual({ files: 8, bytes: (11 + 12 + 13 + 14 + 15) + 1 + 1 + 1 })
    expect(result.removed).toBe(2)
    expect(result.after.files).toBe(6)
    expect(result.keptBySignature).toEqual({ '1-3x_none': 3, '3-10x_list': 2, [LEGACY_SIGNATURE]: 1 })
    // Newest three of the capped signature survive (stamps 03/04/05).
    const survivors = readdirSync(dir).filter(name => name.includes('1-3x')).sort()
    expect(survivors).toHaveLength(COLD_PER_SIGNATURE_LIMIT)
    expect(survivors).toEqual([
      'loop-report-2026-11-23T00-00-03-000Z-sig-1-3x-none.json',
      'loop-report-2026-11-23T00-00-04-000Z-sig-1-3x-none.json',
      'loop-report-2026-11-23T00-00-05-000Z-sig-1-3x-none.json',
    ])
    // The event JSONL and any foreign file are out of the sweep's scope.
    expect(readdirSync(dir)).toContain('loop-events.jsonl')
    expect(readdirSync(dir)).toContain('notes.txt')
    rmSync(dir, { recursive: true, force: true })
  })

  it('applies the global cap on top of the per-signature survivors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elm-global-'))
    mkdirSync(dir, { recursive: true })
    // 55 distinct signatures (≤3 each), newest = highest stamp.
    for (let i = 0; i < COLD_GLOBAL_LIMIT + 5; i += 1) {
      const attr = `${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`
      const stamp = `2026-11-23T00-00-${String(i).padStart(2, '0')}-000Z`
      writeFileSync(join(dir, dumpFileName(stamp, `1-3x_${attr}`)), 'x')
    }
    const result = sweepColdLayer(dir)
    expect(result.before.files).toBe(COLD_GLOBAL_LIMIT + 5)
    expect(result.removed).toBe(5)
    expect(result.after.files).toBe(COLD_GLOBAL_LIMIT)
    // The five oldest (stamps 00–04) went; the newest 50 remain.
    const remaining = readdirSync(dir).filter(name => name.startsWith('loop-report-'))
    expect(remaining.some(name => name.includes('T00-00-00-000Z'))).toBe(false)
    expect(remaining.some(name => name.includes('T00-00-04-000Z'))).toBe(false)
    expect(remaining.some(name => name.includes('T00-00-05-000Z'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a missing directory as an empty sweep (fresh install, no-op)', () => {
    const absent = join(tmpdir(), `elm-absent-${Date.now()}`)
    expect(sweepColdLayer(absent)).toEqual({
      before: { files: 0, bytes: 0 },
      after: { files: 0, bytes: 0 },
      removed: 0,
      keptBySignature: {},
    })
  })
})

describe('hot-layer event JSONL (rolling retention)', () => {
  it('appends one line per event and rolls back to the line cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elm-events-'))
    for (let occurrence = 1; occurrence <= 15; occurrence += 1) {
      appendLoopEvent(dir, { at: occurrence, sig: '1-3x_none', max: 2100, occurrence, action: 'count' }, 10)
    }
    const lines = readFileSync(join(dir, 'loop-events.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(10)
    // Oldest five dropped, newest ten kept in order.
    expect(JSON.parse(lines[0]!)).toMatchObject({ occurrence: 6, action: 'count' })
    expect(JSON.parse(lines[9]!)).toMatchObject({ occurrence: 15 })
    // The file is one rolling JSONL: valid lines only, no partial records.
    expect(() => lines.map(line => JSON.parse(line))).not.toThrow()
    rmSync(dir, { recursive: true, force: true })
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
    expect(state.attribution.map(entry => entry.slice)).toEqual(['list', 'migration', 'zstd', 'sweep'])
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

  it('dumps the first sighting of a signature and counts the repeat into the event stream', async () => {
    const { readState } = await setupProbe({ windowSec: 1, maxBadMs: 300 })
    await sleep(50)
    busy(500)
    const first = await waitForWindows(readState, 1)
    expect(first.max).toBeGreaterThan(300)
    // First sighting: one full report, filed under the spike's signature.
    expect(first.unattributed.count).toBe(1)
    expect(first.unattributed.dumps).toBe(1)
    const sig = spikeSignature(first.max, [], 300)
    const filesAfterFirst = dumpFiles()
    expect(filesAfterFirst).toHaveLength(1)
    expect(parseDumpSignature(filesAfterFirst[0]!)).toBe(sig)

    await sleep(50)
    busy(500)
    const second = await waitForWindows(readState, 2)
    expect(second.max).toBeGreaterThan(300)
    // Repeat sighting of the same signature: counted, never dumped again.
    expect(second.unattributed.count).toBe(2)
    expect(second.unattributed.dumps).toBe(1)
    expect(dumpFiles()).toHaveLength(1)

    const events = readEvents()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ sig, occurrence: 1, action: 'dump', max: first.max })
    expect(events[1]).toMatchObject({ sig, occurrence: 2, action: 'count', max: second.max })
  }, 15_000)

  it('refuses the full report once the cold layer sits at the global cap', async () => {
    // 50 signature-era files across 20 signatures (≤3 each) — within both
    // caps, so the load-time sweep keeps every one of them.
    mkdirSync(DUMP_DIR, { recursive: true })
    for (let i = 0; i < COLD_GLOBAL_LIMIT; i += 1) {
      const bucket = WORST_BUCKETS[i % WORST_BUCKETS.length]!
      const attr = ['none', 'list', 'migration', 'zstd'][Math.floor(i / WORST_BUCKETS.length) % 4]!
      const stamp = `2026-11-23T00-00-${String(i).padStart(2, '0')}-000Z`
      writeFileSync(join(DUMP_DIR, dumpFileName(stamp, `${bucket}_${attr}`)), '{}')
    }
    const { readState } = await setupProbe({ windowSec: 1, maxBadMs: 300 })
    expect(dumpFiles()).toHaveLength(COLD_GLOBAL_LIMIT)

    await sleep(50)
    busy(500)
    const spiked = await waitForWindows(readState, 1)
    expect(spiked.max).toBeGreaterThan(300)
    expect(spiked.unattributed.count).toBe(1)
    // Cap holds: no room for a report, so the occurrence is counted only.
    expect(spiked.unattributed.dumps).toBe(0)
    expect(dumpFiles()).toHaveLength(COLD_GLOBAL_LIMIT)
    expect(readEvents()).toEqual([expect.objectContaining({ action: 'count', occurrence: 1 })])
  }, 15_000)
})
