/**
 * Automatic-restart fork driver (P3): the entry into NEED_RESTART is the one
 * judgment tick, the shipped flag-off default is completely silent, holds
 * surface one line each while the flag is on, and the in-flight claim makes
 * the fork and the manual route single-dispatch.
 */
import type { SpawnOptions } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { registerRestartDisposition, type DispositionJudgment } from '../src/restart-disposition-host.ts'
import {
  ATTESTATION_MAX_AGE_MS,
  AUTO_RESTART_ENV,
  recordClientRunningCount,
  resetDispositionStateForTest,
  claimRestartDispatch,
} from '../src/restart-disposition.ts'
import { RESTART_COMMAND_ENV } from '../src/restart-host.ts'
import type { RestartChild } from '../src/restart-host.ts'
import type { RestartSignalState } from '../src/restart.ts'

const COMMAND = 'pwsh -NoProfile -File D:\\dsh\\restart.ps1 -NoBrowser'

/** A child stand-in with the detached-dispatch surface. */
function stubChild(): RestartChild {
  return { unref: vi.fn(), on: vi.fn() }
}

/** One driver over controllable seams; `emit` plays the judgment stream. */
function driver(options: { running?: () => number | undefined; env?: Record<string, string | undefined> } = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  let listener: ((judgment: DispositionJudgment) => void) | undefined
  const launch = vi.fn((_commandLine: string, _options: SpawnOptions) => stubChild())
  const warn = vi.fn<(message: string) => void>()
  let now = 100_000
  registerRestartDisposition(ctx, {
    subscribe: (l) => { listener = l; return () => { listener = undefined } },
    ...(options.running === undefined ? {} : { countRunning: options.running }),
    launch,
    warn,
    now: () => now,
    env: options.env ?? { [AUTO_RESTART_ENV]: '1', [RESTART_COMMAND_ENV]: COMMAND },
  })
  const emit = (state: RestartSignalState): void => { listener?.({ state }) }
  const advance = (ms: number): void => { now += ms }
  return { emit, advance, launch, warn }
}

afterEach(() => {
  resetDispositionStateForTest()
  vi.restoreAllMocks()
})

describe('restart disposition driver', () => {
  it('does nothing at all with the flag off — the shipped default stays dark', () => {
    const { emit, launch, warn } = driver({ env: { [RESTART_COMMAND_ENV]: COMMAND } })
    recordClientRunningCount(0)
    emit('NEED_RESTART')
    expect(launch).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('dispatches once on entering NEED_RESTART when the flag is on and every fact agrees at zero', () => {
    const { emit, launch, warn } = driver({ running: () => 0 })
    recordClientRunningCount(0)
    emit('NEED_RESTART')
    expect(launch).toHaveBeenCalledOnce()
    const [commandLine, spawnOptions] = launch.mock.calls[0]!
    expect(commandLine).toBe(COMMAND)
    expect(spawnOptions).toMatchObject({ shell: true, detached: true, stdio: 'ignore', windowsHide: true })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('auto-restart dispatched'))
  })

  it('judges only the entry tick — a repeated NEED_RESTART does not re-dispatch', () => {
    const { emit, launch, warn } = driver({ running: () => 0 })
    recordClientRunningCount(0)
    emit('NEED_RESTART')
    emit('NEED_RESTART')
    emit('NEED_RESTART')
    expect(launch).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('auto-restart dispatched'))
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('latches the in-flight claim: a second entry holds instead of double-dispatching', () => {
    const { emit, launch, warn } = driver({ running: () => 0 })
    recordClientRunningCount(0)
    emit('NEED_RESTART')
    emit('OK')
    emit('NEED_RESTART')
    expect(launch).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('held (in-flight)'))
  })

  it('holds while sessions are running and says so once', () => {
    const { emit, launch, warn } = driver({ running: () => 2 })
    recordClientRunningCount(2)
    emit('NEED_RESTART')
    expect(launch).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('held (running)'))
  })

  it('holds when the host count is unavailable', () => {
    const { emit, launch, warn } = driver({ running: () => undefined })
    emit('NEED_RESTART')
    expect(launch).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('held (count-unavailable)'))
  })

  it('holds without a client attestation', () => {
    const { emit, launch, warn } = driver({ running: () => 0 })
    emit('NEED_RESTART')
    expect(launch).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('held (no-attestation)'))
  })

  it('holds on a stale attestation', () => {
    const { emit, advance, launch, warn } = driver({ running: () => 0 })
    // Record against the driver's own clock (its epoch is the fake 100_000).
    recordClientRunningCount(0, 100_000)
    advance(ATTESTATION_MAX_AGE_MS + 1_000)
    emit('NEED_RESTART')
    expect(launch).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('held (stale-attestation)'))
  })

  it('holds when the client and host counts disagree (不一致即阻断)', () => {
    const { emit, launch, warn } = driver({ running: () => 0 })
    recordClientRunningCount(1)
    emit('NEED_RESTART')
    expect(launch).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('held (mismatch)'))
  })

  it('holds with the flag on but no configured restart command', () => {
    const { emit, launch, warn } = driver({ running: () => 0, env: { [AUTO_RESTART_ENV]: '1' } })
    recordClientRunningCount(0)
    emit('NEED_RESTART')
    expect(launch).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('held (no-command)'))
  })

  it('respects a claim someone else already owns (manual route first)', () => {
    expect(claimRestartDispatch()).toBe(true)
    const { emit, launch, warn } = driver({ running: () => 0 })
    recordClientRunningCount(0)
    emit('NEED_RESTART')
    expect(launch).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('held (in-flight)'))
  })

  it('uses the duck-faced agents registry when no count seam is injected', () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    ctx.provide('agents', { list: () => [{ status: 'running' }, { status: 'idle' }] } as never)
    let listener: ((judgment: DispositionJudgment) => void) | undefined
    const launch = vi.fn((_commandLine: string, _options: SpawnOptions) => stubChild())
    registerRestartDisposition(ctx, {
      subscribe: (l) => { listener = l; return () => { listener = undefined } },
      launch,
      warn: vi.fn(),
      env: { [AUTO_RESTART_ENV]: '1', [RESTART_COMMAND_ENV]: COMMAND },
    })
    recordClientRunningCount(1)
    listener?.({ state: 'NEED_RESTART' })
    // One running agent counts exactly like the client's running===true tally.
    expect(launch).not.toHaveBeenCalled()
  })
})
