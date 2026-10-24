/**
 * Restart-signal polling (design triggers ① and ②): the interval capture over
 * repo-level source states plus S_cfg, the recheck fired only when the
 * fingerprint moves from the last captured baseline, one failure line per
 * failure state, the clamped 30–60s interval band with its `0` off-switch,
 * and the child probe running the tree's real stamp modules against a real
 * repository.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  buildFingerprintProbeCode,
  registerStampPoll,
  resolvePollIntervalMs,
  runFingerprintProbe,
  type FingerprintProbe,
  type FingerprintRunner,
  type StampPollInternals,
} from '../src/stamp-poll-host.ts'

/** A fixed home so production profile discovery never leaks into the seams. */
const TEST_HOME = 'C:\\dsh-home-unused'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function probe(repos: Record<string, string>, sCfg = 'cfg'): FingerprintProbe {
  return { repos, sCfg }
}

function pollFixture(runProbe: FingerprintRunner, extra: Partial<StampPollInternals> = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const recheck = vi.fn(() => Promise.resolve({ state: 'OK' }))
  const warn = vi.fn()
  registerStampPoll(ctx, { intervalMs: 30_000, runProbe, recheck, warn, dshHome: TEST_HOME, ...extra })
  return { recheck, warn }
}

describe('poll interval', () => {
  it('defaults, clamps into the 30–60s band, honors zero as off, and rejects junk', () => {
    expect(resolvePollIntervalMs(undefined)).toBe(30_000)
    expect(resolvePollIntervalMs('')).toBe(30_000)
    expect(resolvePollIntervalMs('   ')).toBe(30_000)
    expect(resolvePollIntervalMs('abc')).toBe(30_000)
    expect(resolvePollIntervalMs('-5')).toBe(30_000)
    expect(resolvePollIntervalMs('45000')).toBe(45_000)
    expect(resolvePollIntervalMs('10000')).toBe(30_000)
    expect(resolvePollIntervalMs('90000')).toBe(60_000)
    expect(resolvePollIntervalMs('0')).toBe(0)
  })
})

describe('stamp poll', () => {
  it('primes the baseline without rechecking, then rechecks once when a repository stamp moves', async () => {
    vi.useFakeTimers()
    const answers = [probe({ '/r': 'a' }), probe({ '/r': 'b' }), probe({ '/r': 'b' })]
    const runProbe = vi.fn(() => Promise.resolve(answers.shift() ?? probe({ '/r': 'b' })))
    const { recheck } = pollFixture(runProbe)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(runProbe).toHaveBeenCalledTimes(1)
    expect(recheck).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(runProbe).toHaveBeenCalledTimes(2)
    expect(recheck).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(runProbe).toHaveBeenCalledTimes(3)
    expect(recheck).toHaveBeenCalledTimes(1)
  })

  it('rechecks when only S_cfg moves', async () => {
    vi.useFakeTimers()
    const answers = [probe({ '/r': 'a' }, 'cfg-1'), probe({ '/r': 'a' }, 'cfg-2')]
    const runProbe = vi.fn(() => Promise.resolve(answers.shift() ?? probe({ '/r': 'a' }, 'cfg-2')))
    const { recheck } = pollFixture(runProbe)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(recheck).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(recheck).toHaveBeenCalledTimes(1)
  })

  it('logs one line per failure state, keeps the last good baseline across the outage, and recovers', async () => {
    vi.useFakeTimers()
    const runProbe = vi.fn<FingerprintRunner>()
      .mockImplementationOnce(() => Promise.resolve(probe({ '/r': 'a' })))
      .mockImplementationOnce(() => Promise.reject(new Error('git exploded')))
      .mockImplementationOnce(() => Promise.reject(new Error('git exploded')))
      .mockImplementationOnce(() => Promise.resolve(probe({ '/r': 'a' })))
      .mockImplementationOnce(() => Promise.resolve(probe({ '/r': 'b' })))
    const { recheck, warn } = pollFixture(runProbe)

    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    // The identical second failure is the same failure state: no second line.
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('git exploded'))
    expect(recheck).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    // Back to the pre-outage baseline: no recheck, failure state cleared.
    expect(recheck).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    // The baseline survived the outage, so a genuine move still triggers.
    expect(recheck).toHaveBeenCalledTimes(1)
  })

  it('never runs a second capture while one is in flight', async () => {
    vi.useFakeTimers()
    let release: ((value: FingerprintProbe) => void) | undefined
    const runProbe = vi.fn(() => new Promise<FingerprintProbe>((resolve) => { release = resolve }))
    pollFixture(runProbe)

    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(runProbe).toHaveBeenCalledTimes(1)

    release?.(probe({ '/r': 'a' }))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(runProbe).toHaveBeenCalledTimes(2)
  })

  it('never captures when the interval is switched off', async () => {
    vi.useFakeTimers()
    const runProbe = vi.fn(() => Promise.resolve(probe({ '/r': 'a' })))
    pollFixture(runProbe, { intervalMs: 0 })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(runProbe).not.toHaveBeenCalled()
  })

  it('reads the interval from the environment when no override is given', async () => {
    vi.useFakeTimers()
    vi.stubEnv('DSH_STAMP_POLL_INTERVAL_MS', '0')
    const runProbe = vi.fn(() => Promise.resolve(probe({ '/r': 'a' })))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    registerStampPoll(ctx, { runProbe, recheck: vi.fn(), warn: vi.fn(), dshHome: TEST_HOME })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(runProbe).not.toHaveBeenCalled()
  })

  it('reports a failing recheck without crashing the poller', async () => {
    vi.useFakeTimers()
    const answers = [probe({ '/r': 'a' }), probe({ '/r': 'b' })]
    const runProbe = vi.fn(() => Promise.resolve(answers.shift() ?? probe({ '/r': 'b' })))
    const recheck = vi.fn(() => Promise.reject(new Error('collect blew up')))
    const warn = vi.fn()
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    registerStampPoll(ctx, { intervalMs: 30_000, runProbe, recheck, warn, dshHome: TEST_HOME })

    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('recheck failed'))
  })

  it('stops capturing after disposal, including a pending priming capture', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const runProbe = vi.fn(() => Promise.resolve(probe({ '/r': 'a' })))
    registerStampPoll(ctx, { intervalMs: 30_000, runProbe, recheck: vi.fn(), warn: vi.fn(), dshHome: TEST_HOME })

    await vi.advanceTimersByTimeAsync(2_000)
    expect(runProbe).toHaveBeenCalledTimes(1)
    void ctx.fiber.dispose()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(runProbe).toHaveBeenCalledTimes(1)
  })
})

describe('probe module', () => {
  it('embeds every input as a JSON string literal', () => {
    const code = buildFingerprintProbeCode({
      repoStampUrl: 'file:///D:/x/repo-stamp.ts',
      restartStampModuleUrl: 'file:///D:/x/restart-stamp.ts',
      roots: ['D:\\a b', 'D:\\c'],
      dshHome: 'C:\\Users\\me\\.dsh',
    })
    expect(code).toContain('import { repoStateStamp } from "file:///D:/x/repo-stamp.ts"')
    expect(code).toContain('import { computeConfigStamp } from "file:///D:/x/restart-stamp.ts"')
    expect(code).toContain('const roots = ["D:\\\\a b","D:\\\\c"]')
    expect(code).toContain('computeConfigStamp("C:\\\\Users\\\\me\\\\.dsh", registry)')
    expect(code).toContain("'reg'")
  })

  it('captures a real repository and tracks content moves, runtime churn immunity included', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'dsh-stamp-poll-repo-'))
    const home = mkdtempSync(join(tmpdir(), 'dsh-stamp-poll-home-'))
    onTestFinished(() => {
      rmSync(repository, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    })
    const git = (...args: string[]): Buffer => execFileSync('git', ['-C', repository, ...args])
    git('init')
    git('config', 'user.email', 'poll@test')
    git('config', 'user.name', 'poll')
    writeFileSync(join(repository, 'tracked.txt'), 'one\n')
    git('add', '.')
    git('commit', '-m', 'base')

    const first = await runFingerprintProbe([repository], home)
    expect(first.repos[repository]).toMatch(/^[0-9a-f]{64}$/)
    expect(first.sCfg).toMatch(/^[0-9a-f]{64}$/)

    appendFileSync(join(repository, 'tracked.txt'), 'two\n')
    const dirty = await runFingerprintProbe([repository], home)
    expect(dirty.repos[repository]).not.toBe(first.repos[repository])

    writeFileSync(join(repository, 'untracked.txt'), 'x')
    const added = await runFingerprintProbe([repository], home)
    expect(added.repos[repository]).not.toBe(dirty.repos[repository])

    // Non-boolean: the same untracked path with new bytes must move again.
    writeFileSync(join(repository, 'untracked.txt'), 'y')
    const edited = await runFingerprintProbe([repository], home)
    expect(edited.repos[repository]).not.toBe(added.repos[repository])

    // Runtime churn (logs, session data) never enters the source stamp.
    writeFileSync(join(repository, 'dsh-restart.log'), 'restart happened\n')
    const runtime = await runFingerprintProbe([repository], home)
    expect(runtime.repos[repository]).toBe(edited.repos[repository])
  }, 120_000)
})
