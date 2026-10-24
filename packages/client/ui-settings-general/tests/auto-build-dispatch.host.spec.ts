/**
 * Auto-build throttle (P3, design §四): continuous editing never storms the
 * build — a moved source re-arms the stability window, a persistent NEED_BUILD
 * dispatches one detached build per minimum interval, BUILD_FAILED backs off
 * exponentially (and retries past the backoff), and the heavy-io lock defers
 * the dispatch so the save chain stays the single build dispatcher.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  AUTO_BUILD_BACKOFF_ENV,
  AUTO_BUILD_INTERVAL_ENV,
  AUTO_BUILD_STABLE_ENV,
  defaultHeavyIoLockDirectory,
  heavyIoLockHeld,
  registerAutoBuild,
  resolveAutoBuildTimings,
} from '../src/auto-build-dispatch.ts'
import type { RestartSignalFacts, RestartSignalJudgment } from '../src/restart-signal.ts'
import type { RestartChild } from '../src/restart-host.ts'
import type { RestartSignalState } from '../src/restart.ts'

const START = 1_000_000

function stubChild(): RestartChild {
  return { unref: vi.fn(), on: vi.fn() }
}

function facts(host: string, config = 'cfg'): RestartSignalFacts {
  return { currentHostFace: host, configStamp: config }
}

function judgment(state: RestartSignalState, face?: string): RestartSignalJudgment {
  return { state, detail: 'fixture', ...(face === undefined ? {} : { facts: facts(face) }) }
}

/** One dispatcher over controllable seams and a scriptable collect. */
function harness(env: Record<string, string | undefined> = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  let listener: ((judgment: RestartSignalJudgment) => void) | undefined
  const collect = vi.fn(async (): Promise<RestartSignalJudgment> => {
    throw new Error('collect not scripted by this test')
  })
  const launch = vi.fn((_commandLine: string, _options: unknown) => stubChild())
  const warn = vi.fn<(message: string) => void>()
  const lockHeld = vi.fn(() => false)
  const heldFlag = vi.fn(() => false)
  registerAutoBuild(ctx, {
    subscribe: (l) => { listener = l; return () => { listener = undefined } },
    collect,
    launch,
    warn,
    lockHeld,
    heldFlag,
    command: 'build-cmd',
    env,
  })
  const emit = (judgment: RestartSignalJudgment): void => { listener?.(judgment) }
  const settle = async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms) }
  return { emit, settle, collect, launch, warn, lockHeld, heldFlag }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('auto-build timings', () => {
  it('defaults to the design values and clamps the floors', () => {
    expect(resolveAutoBuildTimings({})).toEqual({ stableMs: 15_000, intervalMs: 60_000, backoffMs: 300_000 })
    expect(resolveAutoBuildTimings({
      [AUTO_BUILD_STABLE_ENV]: '0',
      [AUTO_BUILD_INTERVAL_ENV]: '500',
      [AUTO_BUILD_BACKOFF_ENV]: '1',
    })).toEqual({ stableMs: 0, intervalMs: 1_000, backoffMs: 60_000 })
    expect(resolveAutoBuildTimings({
      [AUTO_BUILD_STABLE_ENV]: 'nonsense',
      [AUTO_BUILD_INTERVAL_ENV]: '90000',
    }).stableMs).toBe(15_000)
  })
})

describe('heavy-io lock reader (mirrors scripts/heavy-io-gate.ts)', () => {
  it('resolves the user-level directory, never the sandboxed tmpdir default', () => {
    expect(defaultHeavyIoLockDirectory({ LOCALAPPDATA: 'X:\\AppData\\Local' })).toContain('dsh-heavy-io-gate.lock')
    expect(defaultHeavyIoLockDirectory({ LOCALAPPDATA: 'X:\\AppData\\Local' })).toContain('X:')
  })

  it('reads a live owner as held and a dead or absent owner as free', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-build-lock-'))
    try {
      expect(heavyIoLockHeld(dir)).toBe(false)
      writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), command: 'x' }))
      expect(heavyIoLockHeld(dir)).toBe(true)
      writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 999_999_998, startedAt: new Date().toISOString(), command: 'x' }))
      expect(heavyIoLockHeld(dir)).toBe(false)
      writeFileSync(join(dir, 'owner.json'), '{broken')
      expect(heavyIoLockHeld(dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('auto-build dispatch throttle', () => {
  it('R7: continuous editing never storms the build; a quiet source dispatches once, bounded after', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h-final'))
    // Five minutes of continuous edits: the window keeps re-arming.
    for (let i = 0; i < 60; i += 1) {
      h.emit(judgment('NEED_BUILD', `h-${String(i)}`))
      await h.settle(5_000)
    }
    expect(h.launch).not.toHaveBeenCalled()
    // The source goes quiet; one dispatch lands after the stability window.
    h.emit(judgment('NEED_BUILD', 'h-final'))
    await h.settle(16_000)
    expect(h.launch).toHaveBeenCalledOnce()
    // Identical rechecks keep arriving (route/focus): dispatches stay bounded
    // by the minimum interval — one per minute at most, three in the whole
    // run against 84 edit observations. No storm.
    for (let i = 0; i < 24; i += 1) {
      h.emit(judgment('NEED_BUILD', 'h-final'))
      await h.settle(5_000)
    }
    expect(h.launch).toHaveBeenCalledTimes(3)
  })

  it('waits out the stability window before dispatching', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h1'))
    h.emit(judgment('NEED_BUILD', 'h1'))
    await h.settle(14_000)
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.collect).not.toHaveBeenCalled()
    await h.settle(2_000)
    expect(h.launch).toHaveBeenCalledOnce()
  })

  it('honours the minimum interval between dispatches', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h2'))
    h.emit(judgment('NEED_BUILD', 'h2'))
    await h.settle(16_000)
    expect(h.launch).toHaveBeenCalledOnce()
    // A new move five seconds later passes the stability window long before
    // the minimum interval — the dispatch waits for the interval.
    h.emit(judgment('NEED_BUILD', 'h3'))
    await h.settle(20_000)
    expect(h.launch).toHaveBeenCalledOnce()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h3'))
    await h.settle(45_000)
    expect(h.launch).toHaveBeenCalledTimes(2)
  })

  it('does not reset the stability window on identical rechecks (no starvation)', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h1'))
    h.emit(judgment('NEED_BUILD', 'h1'))
    // Route-driven rechecks with unchanged stamps every second: they must not
    // postpone the window that started at the move.
    for (let i = 0; i < 14; i += 1) {
      h.emit(judgment('NEED_BUILD', 'h1'))
      await h.settle(1_000)
    }
    expect(h.launch).not.toHaveBeenCalled()
    await h.settle(2_000)
    expect(h.launch).toHaveBeenCalledOnce()
  })

  it('restarts the stability window when the collect-time stamps moved', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h2'))
    h.emit(judgment('NEED_BUILD', 'h1'))
    await h.settle(15_000)
    // The fire-time collect sees a newer source: the window restarts instead
    // of building a half-edited tree.
    expect(h.launch).not.toHaveBeenCalled()
    await h.settle(14_000)
    expect(h.launch).not.toHaveBeenCalled()
    await h.settle(2_000)
    expect(h.launch).toHaveBeenCalledOnce()
  })

  it('arms an exponential backoff on BUILD_FAILED and retries past it', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h1'))
    h.emit(judgment('NEED_BUILD', 'h1'))
    await h.settle(16_000)
    expect(h.launch).toHaveBeenCalledOnce()
    // The outcome check sees the failure marker: backoff 5min.
    h.collect.mockImplementation(async () => judgment('BUILD_FAILED'))
    await h.settle(60_000)
    expect(h.launch).toHaveBeenCalledOnce()
    await h.settle(298_000)
    expect(h.launch).toHaveBeenCalledOnce()
    // Past the backoff the retry re-dispatches (the new build's opening
    // clears the failure marker).
    await h.settle(3_000)
    expect(h.launch).toHaveBeenCalledTimes(2)
    // A second failure doubles the backoff to 10min.
    await h.settle(60_000)
    expect(h.launch).toHaveBeenCalledTimes(2)
    await h.settle(596_000)
    expect(h.launch).toHaveBeenCalledTimes(2)
    await h.settle(3_000)
    expect(h.launch).toHaveBeenCalledTimes(3)
  })

  it('resets the failure backoff when the signal reports success', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h1'))
    h.emit(judgment('NEED_BUILD', 'h1'))
    await h.settle(16_000)
    h.collect.mockImplementation(async () => judgment('BUILD_FAILED'))
    await h.settle(60_000)
    // Success-shaped judgment clears the episode.
    h.emit(judgment('NEED_RESTART', 'h1'))
    h.emit(judgment('NEED_BUILD', 'h2'))
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h2'))
    await h.settle(60_000)
    expect(h.launch).toHaveBeenCalledTimes(2)
    // The next failure starts a fresh 5min backoff, not a doubled one.
    h.collect.mockImplementation(async () => judgment('BUILD_FAILED'))
    await h.settle(60_000)
    await h.settle(254_000)
    expect(h.launch).toHaveBeenCalledTimes(2)
    await h.settle(3_000)
    expect(h.launch).toHaveBeenCalledTimes(3)
  })

  it('defers to a live heavy-io lock holder and dispatches once it frees', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h1'))
    h.emit(judgment('NEED_BUILD', 'h1'))
    h.lockHeld.mockReturnValue(true)
    await h.settle(15_000)
    // Deferred: no collect, no dispatch.
    expect(h.collect).not.toHaveBeenCalled()
    h.lockHeld.mockReturnValue(false)
    await h.settle(30_000)
    expect(h.launch).toHaveBeenCalledOnce()
  })

  it('stays quiet past the deferral bound while the lock never frees', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h1'))
    h.emit(judgment('NEED_BUILD', 'h1'))
    h.lockHeld.mockReturnValue(true)
    await h.settle(15 * 60_000 + 40_000)
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('held past the deferral bound'))
  })

  it('treats DSH_HEAVY_IO_HELD=1 (we are inside another gated run) as deferral', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h1'))
    h.emit(judgment('NEED_BUILD', 'h1'))
    h.heldFlag.mockReturnValue(true)
    await h.settle(15_000)
    expect(h.collect).not.toHaveBeenCalled()
    h.heldFlag.mockReturnValue(false)
    await h.settle(30_000)
    expect(h.launch).toHaveBeenCalledOnce()
  })

  it('skips a foreign build in flight and dispatches after it clears', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('BUILDING'))
    h.emit(judgment('NEED_BUILD', 'h1'))
    await h.settle(15_000)
    expect(h.launch).not.toHaveBeenCalled()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h1'))
    await h.settle(60_000)
    expect(h.launch).toHaveBeenCalledOnce()
  })

  it('aborts on INIT without a baseline and stays quiet', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('INIT'))
    h.emit(judgment('NEED_BUILD', 'h1'))
    await h.settle(10 * 60_000)
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('INIT'))
  })

  it('reports a spawn failure through the backoff instead of a hot retry loop', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h1'))
    const errorListeners: Array<(error: Error) => void> = []
    h.launch.mockImplementation(() => ({
      unref: vi.fn(),
      on: vi.fn((_event: 'error', listener: (error: Error) => void) => { errorListeners.push(listener) }),
    }))
    h.emit(judgment('NEED_BUILD', 'h1'))
    await h.settle(15_000)
    expect(h.launch).toHaveBeenCalledOnce()
    for (const listener of errorListeners) listener(new Error('pnpm missing'))
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('pnpm missing'))
    await h.settle(60_000)
    // The spawn-failure backoff (5min from the error) blocks the hot window.
    expect(h.launch).toHaveBeenCalledOnce()
  })

  it('cancels the schedule and unsubscribes on disposal', async () => {
    const ctx = new Context()
    let listener: ((judgment: RestartSignalJudgment) => void) | undefined
    const collect = vi.fn(async (): Promise<RestartSignalJudgment> => judgment('NEED_BUILD', 'h1'))
    const launch = vi.fn((_commandLine: string, _options: unknown) => stubChild())
    registerAutoBuild(ctx, {
      subscribe: (l) => { listener = l; return () => { listener = undefined } },
      collect,
      launch,
      warn: vi.fn(),
      lockHeld: () => false,
      heldFlag: () => false,
      command: 'build-cmd',
      env: {},
    })
    listener?.(judgment('NEED_BUILD', 'h1'))
    await ctx.fiber.dispose()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(launch).not.toHaveBeenCalled()
    expect(listener).toBeUndefined()
  })
})
