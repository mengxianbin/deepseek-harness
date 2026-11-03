/**
 * Auto-build throttle (P3, design §四): continuous editing never storms the
 * build — a moved source re-arms the stability window, a persistent NEED_BUILD
 * dispatches one gated build per minimum interval (hidden console on
 * Windows, since 2026-11-01), BUILD_FAILED backs off
 * exponentially (and retries past the backoff), and the heavy-io lock defers
 * the dispatch so the save chain stays the single build dispatcher.
 *
 * Build-trigger hardening (2026-11-01): INIT no longer aborts into a
 * deadlock — a quiet marker-free INIT dispatches one bootstrap build, an
 * in-flight build marker defers to outcome checks, a failure marker arms the
 * same backoff, and every dispatch decision lands in the journal. The INIT
 * cause split keeps that bootstrap honest: when this tree's own manifest is
 * present, INIT can only name a linked repository's missing manifest, which
 * no build here can fix — the dispatcher journals the condition once and
 * dispatches nothing (the storm fix).
 *
 * Linked-split (2026-11-01, second loop): a NEED_BUILD judgment whose
 * `facts.ownFaceMoved === false` names linked-only drift — the dispatch
 * trigger scope is this tree's face (主仓面), so the dispatcher journals that
 * condition once per episode and dispatches nothing; own moves and unknown
 * scopes keep the normal dispatch, and the lamp itself stays NEED_BUILD.
 *
 * Failout (2026-11-03): the spawn redirects stdout/stderr into stamp-dir
 * capture files, and a non-zero close folds both tails (4KB each,
 * whitespace-collapsed) plus cmd and exit code into ONE `build-failed` journal
 * line; exit 0 just drops the captures — success adds no journal noise. These
 * specs drive REAL failing/succeeding commands end to end (real spawn, real
 * capture files, real journal call), because the whole point is that the
 * output actually survives.
 */
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  AUTO_BUILD_BACKOFF_ENV,
  AUTO_BUILD_INTERVAL_ENV,
  AUTO_BUILD_STABLE_ENV,
  defaultAutoBuildJournalLine,
  defaultHeavyIoLockDirectory,
  heavyIoLockHeld,
  registerAutoBuild,
  resolveAutoBuildTimings,
  STDERR_CAPTURE_FILE,
  STDOUT_CAPTURE_FILE,
  type AutoBuildChild,
} from '../src/auto-build-dispatch.ts'
import type { RestartSignalFacts, RestartSignalJudgment } from '../src/restart-signal.ts'
import type { RestartSignalState } from '../src/restart.ts'

const START = 1_000_000

/** A stub child that can replay the two events the dispatcher subscribes to. */
function stubChild(): AutoBuildChild & { emitError(error: Error): void; emitClose(code: number | null): void } {
  const errorListeners: Array<(error: Error) => void> = []
  const closeListeners: Array<(code: number | null) => void> = []
  return {
    unref: vi.fn(),
    on: (event: 'error' | 'close', listener: (...args: never[]) => void): void => {
      if (event === 'error') errorListeners.push(listener as unknown as (error: Error) => void)
      else closeListeners.push(listener as unknown as (code: number | null) => void)
    },
    emitError: (error: Error): void => { for (const listener of errorListeners) listener(error) },
    emitClose: (code: number | null): void => { for (const listener of closeListeners) listener(code) },
  }
}

function facts(host: string, config = 'cfg', ownFaceMoved?: boolean): RestartSignalFacts {
  return { currentHostFace: host, configStamp: config, ...(ownFaceMoved === undefined ? {} : { ownFaceMoved }) }
}

function judgment(state: RestartSignalState, face?: string): RestartSignalJudgment {
  return { state, detail: 'fixture', ...(face === undefined ? {} : { facts: facts(face) }) }
}

/** A NEED_BUILD shaped like production's linked-only drift: own face in sync. */
function linkedDriftJudgment(face: string, config = 'cfg'): RestartSignalJudgment {
  return { state: 'NEED_BUILD', detail: 'fixture', facts: facts(face, config, false) }
}

/** An INIT judgment shaped like production's: facts attached, no host face yet. */
function initJudgment(config = 'cfg'): RestartSignalJudgment {
  return { state: 'INIT', detail: 'fixture', facts: { currentHostFace: undefined, configStamp: config } }
}

/** One dispatcher over controllable seams and a scriptable collect. */
function harness(env: Record<string, string | undefined> = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  // Failout capture files land in a throwaway stamp dir: the spec must never
  // touch the real tree's `.dsh-build`.
  const stampDirectory = mkdtempSync(join(tmpdir(), 'auto-build-stamp-'))
  onTestFinished(() => {
    rmSync(stampDirectory, { recursive: true, force: true })
  })
  let listener: ((judgment: RestartSignalJudgment) => void) | undefined
  const collect = vi.fn(async (): Promise<RestartSignalJudgment> => {
    throw new Error('collect not scripted by this test')
  })
  const children: ReturnType<typeof stubChild>[] = []
  const launch = vi.fn((_commandLine: string, _options: unknown) => {
    const child = stubChild()
    children.push(child)
    return child
  })
  const warn = vi.fn<(message: string) => void>()
  const journal = vi.fn<(line: string) => void>()
  const lockHeld = vi.fn(() => false)
  const heldFlag = vi.fn(() => false)
  const buildingMarker = vi.fn(() => false)
  const failedMarker = vi.fn(() => false)
  const ownBaseline = vi.fn(() => false)
  registerAutoBuild(ctx, {
    subscribe: (l) => { listener = l; return () => { listener = undefined } },
    collect,
    launch,
    warn,
    journal,
    stampDirectory,
    lockHeld,
    heldFlag,
    buildingMarker,
    failedMarker,
    ownBaseline,
    command: 'build-cmd',
    env,
  })
  const emit = (judgment: RestartSignalJudgment): void => { listener?.(judgment) }
  const settle = async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms) }
  return {
    emit,
    settle,
    collect,
    launch,
    children,
    warn,
    journal,
    stampDirectory,
    lockHeld,
    heldFlag,
    buildingMarker,
    failedMarker,
    ownBaseline,
  }
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

  it('bootstraps a missing baseline: quiet marker-free INIT dispatches one build after the stability window', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => initJudgment())
    h.emit(initJudgment())
    await h.settle(14_000)
    expect(h.launch).not.toHaveBeenCalled()
    await h.settle(2_000)
    expect(h.launch).toHaveBeenCalledOnce()
    expect(h.journal).toHaveBeenCalledWith(expect.stringContaining('dispatch reason=init-bootstrap'))
  })

  it('skips the INIT bootstrap while a build marker sits in the tree (foreign build in flight)', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => initJudgment())
    h.buildingMarker.mockReturnValue(true)
    h.emit(initJudgment())
    await h.settle(5 * 60_000)
    expect(h.launch).not.toHaveBeenCalled()
    // The marker clears: the next armed fire bootstraps.
    h.buildingMarker.mockReturnValue(false)
    await h.settle(60_000)
    expect(h.launch).toHaveBeenCalledOnce()
  })

  it('arms the exponential backoff on a failed INIT bootstrap and retries past it', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => initJudgment())
    h.emit(initJudgment())
    await h.settle(16_000)
    expect(h.launch).toHaveBeenCalledOnce()
    // The bootstrap failed: the failure marker is on disk (INIT outranks
    // BUILD_FAILED in the judgment, so the dispatcher reads the marker).
    h.failedMarker.mockReturnValue(true)
    await h.settle(60_000)
    expect(h.launch).toHaveBeenCalledOnce()
    expect(h.journal).toHaveBeenCalledWith(expect.stringContaining('backoff failures=1'))
    await h.settle(298_000)
    expect(h.launch).toHaveBeenCalledOnce()
    // Past the backoff the retry re-dispatches even though the failure marker
    // is still on disk (the retry's own opening clears it, production shape).
    await h.settle(3_000)
    expect(h.launch).toHaveBeenCalledTimes(2)
    expect(h.journal).toHaveBeenCalledWith(expect.stringContaining('dispatch reason=init-retry'))
  })

  it('never dispatches when INIT comes from a linked repository missing its own baseline (storm fix)', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => initJudgment())
    // This tree's manifest is present, so INIT can only name a linked tree —
    // a build here would rebuild forever without clearing the condition.
    h.ownBaseline.mockReturnValue(true)
    h.emit(initJudgment())
    await h.settle(10 * 60_000)
    expect(h.launch).not.toHaveBeenCalled()
    const defers = h.journal.mock.calls.map(([line]) => line).filter((line): line is string => line === 'defer init-linked-baseline')
    expect(defers).toHaveLength(1)
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('linked repository missing its own build baseline'))
  })

  it('bootstraps again once the own baseline goes missing (a linked defer never blocks a real bootstrap)', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => initJudgment())
    h.ownBaseline.mockReturnValue(true)
    h.emit(initJudgment())
    await h.settle(60_000)
    expect(h.launch).not.toHaveBeenCalled()
    // e.g. `pnpm run clean` wiped this tree's manifest: the bootstrap returns.
    h.ownBaseline.mockReturnValue(false)
    await h.settle(60_000)
    expect(h.launch).toHaveBeenCalledOnce()
    expect(h.journal).toHaveBeenCalledWith(expect.stringContaining('dispatch reason=init-bootstrap'))
  })

  it('never dispatches when NEED_BUILD comes only from a linked repository drift (build trigger = 主仓面, acceptance ②)', async () => {
    const h = harness()
    const drift = linkedDriftJudgment('h1')
    h.collect.mockImplementation(async () => drift)
    h.emit(drift)
    await h.settle(10 * 60_000)
    // No build, one journal line for the whole episode, zero need-build dispatch lines.
    expect(h.launch).not.toHaveBeenCalled()
    const lines = h.journal.mock.calls.map(([line]) => line)
    expect(lines.filter((line): line is string => line === 'defer linked-source-drift')).toHaveLength(1)
    expect(lines.filter(line => line.includes('dispatch reason=need-build'))).toEqual([])
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('linked repository source drift'))
  })

  it('dispatches normally once the own face moves, even inside a linked-drift episode', async () => {
    const h = harness()
    const drift = linkedDriftJudgment('h1')
    h.collect.mockImplementation(async () => drift)
    h.emit(drift)
    await h.settle(16_000)
    expect(h.launch).not.toHaveBeenCalled()
    // The own face moves too: the scope is no longer linked-only → normal dispatch.
    const ownMove = judgment('NEED_BUILD', 'h2')
    h.collect.mockImplementation(async () => ownMove)
    h.emit(ownMove)
    await h.settle(16_000)
    expect(h.launch).toHaveBeenCalledOnce()
    expect(h.journal).toHaveBeenCalledWith(expect.stringContaining('dispatch reason=need-build'))
  })

  it('journals the linked-drift defer once per episode, not once per recheck', async () => {
    const h = harness()
    const drift = linkedDriftJudgment('h1')
    h.collect.mockImplementation(async () => drift)
    h.emit(drift)
    await h.settle(16_000)
    // The judgment leaves the drift state (e.g. linked rebuilt → OK): episode ends.
    h.emit(judgment('OK', 'h1'))
    // Linked drifts again: a fresh episode gets its one line.
    h.emit(drift)
    await h.settle(16_000)
    const defers = h.journal.mock.calls.map(([line]) => line).filter((line): line is string => line === 'defer linked-source-drift')
    expect(defers).toHaveLength(2)
    expect(h.launch).not.toHaveBeenCalled()
  })

  it('journals every dispatch decision (need-build path included)', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h1'))
    h.emit(judgment('NEED_BUILD', 'h1'))
    await h.settle(16_000)
    expect(h.launch).toHaveBeenCalledOnce()
    expect(h.journal).toHaveBeenCalledWith(expect.stringContaining('dispatch reason=need-build'))
  })

  it('journals a heavy-io deferral once per episode and its give-up', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h1'))
    h.emit(judgment('NEED_BUILD', 'h1'))
    h.lockHeld.mockReturnValue(true)
    await h.settle(15 * 60_000 + 40_000)
    const defers = h.journal.mock.calls.map(([line]) => line).filter((line): line is string => line.startsWith('defer'))
    expect(defers).toEqual(['defer heavy-io-lock-held', 'defer-giveup held-past-bound'])
  })

  it('reports a spawn failure through the backoff instead of a hot retry loop (no build-failed double line)', async () => {
    const h = harness()
    h.collect.mockImplementation(async () => judgment('NEED_BUILD', 'h1'))
    h.emit(judgment('NEED_BUILD', 'h1'))
    await h.settle(15_000)
    expect(h.launch).toHaveBeenCalledOnce()
    const child = h.children.at(-1)
    expect(child).toBeDefined()
    child?.emitError(new Error('pnpm missing'))
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('pnpm missing'))
    // The spawn error dropped the captures itself; the `close` that follows a
    // failed spawn must not add a duplicate build-failed line (spawnFailed
    // guard, failout 2026-11-03).
    child?.emitClose(null)
    const lines = h.journal.mock.calls.map(([line]) => line)
    expect(lines.filter(line => line.includes('build-failed'))).toEqual([])
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

/**
 * Failout (2026-11-03, 洞⑦): the spawn redirects stdout/stderr into stamp-dir
 * capture files, and a non-zero close folds both tails (last 4KB each,
 * whitespace-collapsed to ONE line) plus cmd and exit code into the journal —
 * the same `build-failed` family the watchdog writes, so 查红 has one place to
 * look. These tests drive a REAL journal file under a temp `.dsh-build` (the
 * acceptance surface: findable under `.dsh-build/`), injecting the close event
 * and writing the capture content a real build would have produced.
 */
describe('auto-build failout: failure output capture (failout 2026-11-03)', () => {
  /** One dispatcher over a real journal file in a temp tree's `.dsh-build`. */
  function failoutHarness() {
    const root = mkdtempSync(join(tmpdir(), 'auto-build-failout-'))
    onTestFinished(() => {
      rmSync(root, { recursive: true, force: true })
    })
    const stampDirectory = join(root, '.dsh-build')
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    let listener: ((judgment: RestartSignalJudgment) => void) | undefined
    const children: ReturnType<typeof stubChild>[] = []
    const launch = vi.fn((_commandLine: string, _options: unknown) => {
      const child = stubChild()
      children.push(child)
      return child
    })
    registerAutoBuild(ctx, {
      subscribe: (l) => { listener = l; return () => { listener = undefined } },
      collect: async (): Promise<RestartSignalJudgment> => judgment('NEED_BUILD', 'h1'),
      launch,
      warn: vi.fn(),
      journal: defaultAutoBuildJournalLine(root),
      stampDirectory,
      lockHeld: () => false,
      heldFlag: () => false,
      command: 'build-cmd',
      env: {},
    })
    const journalPath = join(stampDirectory, 'auto-build.log')
    const stdoutPath = join(stampDirectory, STDOUT_CAPTURE_FILE)
    const stderrPath = join(stampDirectory, STDERR_CAPTURE_FILE)
    return {
      emit: (j: RestartSignalJudgment): void => { listener?.(j) },
      settle: async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms) },
      launch,
      children,
      journalPath,
      stdoutPath,
      stderrPath,
      journalLines: (): string[] => readFileSync(journalPath, 'utf8').trim().split('\n'),
    }
  }

  it('captures the spawn stdio as fd redirection (files, not pipes)', async () => {
    const h = failoutHarness()
    h.emit(judgment('NEED_BUILD', 'h1'))
    await h.settle(15_000)
    expect(h.launch).toHaveBeenCalledOnce()
    const call = h.launch.mock.calls.at(-1)
    expect(call).toBeDefined()
    const options = call?.[1] as { stdio?: unknown }
    // ['ignore', stdoutFd, stderrFd]: the child's streams land in the capture
    // files — a pipe would die with this host and crash the surviving build.
    expect(options.stdio).toEqual(['ignore', expect.any(Number), expect.any(Number)])
    expect(existsSync(h.stdoutPath)).toBe(true)
    expect(existsSync(h.stderrPath)).toBe(true)
  })

  it('folds a failed build’s stdout/stderr tails + exit code into the journal (one timestamped line)', async () => {
    const h = failoutHarness()
    h.emit(judgment('NEED_BUILD', 'h1'))
    await h.settle(15_000)
    expect(h.launch).toHaveBeenCalledOnce()
    // What the real build would have written through the inherited fds:
    // >4KB so the fold must keep the TAIL and drop the head, with an
    // embedded newline to prove whitespace collapses onto one journal line.
    writeFileSync(h.stdoutPath, 'OUT-HEAD build starting\nOUT-TAIL done\n')
    writeFileSync(
      h.stderrPath,
      `STDERR-HEAD-MARKER ${'x'.repeat(5000)} line1\nline2\nSTDERR-TAIL-MARKER\n`,
    )
    const child = h.children.at(-1)
    expect(child).toBeDefined()
    child?.emitClose(7)
    const lines = h.journalLines()
    expect(lines).toHaveLength(2)
    const failed = lines.find(line => line.includes('build-failed'))
    expect(failed).toBeDefined()
    // Timestamped (journal ISO prefix) + exit code + command, watchdog family.
    expect(failed).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ build-failed exit=7 cmd=build-cmd /)
    // Both tails present, whitespace folded to a single line.
    expect(failed).toContain('stdout-tail=OUT-HEAD build starting OUT-TAIL done')
    expect(failed).toContain('STDERR-TAIL-MARKER')
    expect(failed).toContain('line1 line2')
    // 4KB tail semantics: the head beyond the window is gone.
    expect(failed).not.toContain('STDERR-HEAD-MARKER')
    // Captures cleaned up after folding — no orphan .tmp files.
    expect(existsSync(h.stdoutPath)).toBe(false)
    expect(existsSync(h.stderrPath)).toBe(false)
  })

  it('adds no journal noise for a successful build and still drops the captures (判据 4)', async () => {
    const h = failoutHarness()
    h.emit(judgment('NEED_BUILD', 'h1'))
    await h.settle(15_000)
    expect(h.launch).toHaveBeenCalledOnce()
    writeFileSync(h.stdoutPath, 'OUT-HEAD build starting\nOUT-TAIL done\n')
    writeFileSync(h.stderrPath, 'warning: something chatty\n')
    const child = h.children.at(-1)
    expect(child).toBeDefined()
    child?.emitClose(0)
    const lines = h.journalLines()
    // Exactly the one pre-existing dispatch decision line: exit 0 writes NO
    // build-failed line and the captures are removed either way.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ dispatch reason=need-build cmd=build-cmd$/)
    expect(lines.some(line => line.includes('build-failed'))).toBe(false)
    expect(existsSync(h.stdoutPath)).toBe(false)
    expect(existsSync(h.stderrPath)).toBe(false)
  })
})
