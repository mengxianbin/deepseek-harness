/**
 * Auto-build host notifier (build-dispatch ④ "kick 无载荷", 2026-11-13) —
 * the HOST half is now stateless: it observes judgments and SHOUTS, nothing
 * else. What this spec pins:
 *
 * - a build-owing judgment (`INIT`, or `NEED_BUILD` with the own face moved)
 *   produces exactly one payload-free token overwrite + one `[host] kick`
 *   journal line;
 * - linked-only drift, and every non-owing state, stays silent (the watchdog's
 *   per-tree leg and the executor's re-judgment own those);
 * - the token's on-disk content carries metadata ONLY — no command, no target
 *   tree, no queue entry (机检④: 宿主 kick 路径不写共享队列);
 * - a failing token write degrades LOUD (warn + journal) and never throws
 *   into the judgment stream;
 * - disposal unsubscribes; and the module contains no spawn surface at all —
 *   the task's machine check greps this FILE for spawn/launch and must find
 *   none (机检③: 宿主 dispatcher spawn grep = 0).
 *
 * The old throttle/lock/failout suites moved with the execution authority to
 * `scripts/auto-build-exec.spec.ts`.
 */
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  AUTO_BUILD_KICK_FILE,
  registerAutoBuild,
  writeAutoBuildKick,
  type AutoBuildKick,
} from '../src/auto-build-dispatch.ts'
import type { RestartSignalFacts, RestartSignalJudgment } from '../src/restart-signal.ts'
import type { RestartSignalState } from '../src/restart.ts'

function facts(host: string, config = 'cfg', ownFaceMoved?: boolean): RestartSignalFacts {
  return { currentHostFace: host, configStamp: config, ...(ownFaceMoved === undefined ? {} : { ownFaceMoved }) }
}

function judgment(state: RestartSignalState, face?: string): RestartSignalJudgment {
  return { state, detail: 'fixture', ...(face === undefined ? {} : { facts: facts(face) }) }
}

/** Production-shaped linked-only drift: own face agrees with its baseline. */
function linkedDriftJudgment(face: string): RestartSignalJudgment {
  return { state: 'NEED_BUILD', detail: 'fixture', facts: facts(face, 'cfg', false) }
}

function initJudgment(): RestartSignalJudgment {
  return { state: 'INIT', detail: 'fixture', facts: { currentHostFace: undefined, configStamp: 'cfg' } }
}

/** One notifier over a scriptable subscription and an observable kick sink.
 * `realKick` keeps the production default (the module writes the token file
 * itself) so the on-disk face can be inspected byte for byte. */
function harness(root?: string, options: { readonly realKick?: boolean } = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  let listener: ((judgment: RestartSignalJudgment) => void) | undefined
  const kick = vi.fn<(k: AutoBuildKick) => void>()
  const warn = vi.fn<(message: string) => void>()
  const journal = vi.fn<(line: string) => void>()
  const repositoryRoot = root ?? mkdtempSync(join(tmpdir(), 'auto-build-kick-'))
  if (root === undefined) {
    onTestFinished(() => { rmSync(repositoryRoot, { recursive: true, force: true }) })
  }
  registerAutoBuild(ctx, {
    subscribe: (l) => { listener = l; return () => { listener = undefined } },
    ...(options.realKick === true ? {} : { kick }),
    warn,
    journal,
    repositoryRoot,
    now: () => 1_700_000_000_000,
  })
  return {
    emit: (j: RestartSignalJudgment): void => { listener?.(j) },
    kick,
    warn,
    journal,
    repositoryRoot,
    kickPath: join(repositoryRoot, '.dsh-build', AUTO_BUILD_KICK_FILE),
    isSubscribed: (): boolean => listener !== undefined,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('auto-build host notifier: kick semantics (④)', () => {
  it('shouts once on NEED_BUILD with the own face moved — token + one journal line', () => {
    const h = harness()
    h.emit(judgment('NEED_BUILD', 'h1'))
    expect(h.kick).toHaveBeenCalledTimes(1)
    expect(h.kick.mock.calls[0]?.[0]).toEqual({
      at: '2023-11-14T22:13:20.000Z',
      from: 'host',
      state: 'NEED_BUILD',
    })
    expect(h.journal).toHaveBeenCalledTimes(1)
    expect(h.journal.mock.calls[0]?.[0]).toBe('kick state=NEED_BUILD')
    expect(h.warn).not.toHaveBeenCalled()
  })

  it('shouts on INIT (bootstrap owed)', () => {
    const h = harness()
    h.emit(initJudgment())
    expect(h.kick).toHaveBeenCalledTimes(1)
    expect(h.journal.mock.calls[0]?.[0]).toBe('kick state=INIT')
  })

  it('stays silent on linked-only NEED_BUILD — the watchdog per-tree leg owns that', () => {
    const h = harness()
    h.emit(linkedDriftJudgment('h1'))
    expect(h.kick).not.toHaveBeenCalled()
    expect(h.journal).not.toHaveBeenCalled()
  })

  it.each(['BUILDING', 'BUILD_FAILED', 'NEED_RESTART', 'CLIENT_UPDATED', 'OK'] as const)(
    'stays silent on %s — no second opinion on outcomes the watchdog tick re-judges',
    (state) => {
      const h = harness()
      h.emit(judgment(state, 'h1'))
      expect(h.kick).not.toHaveBeenCalled()
      expect(h.journal).not.toHaveBeenCalled()
    },
  )

  it('disposes by unsubscribing: post-dispose emissions shout nothing', async () => {
    const ctx = new Context()
    let listener: ((judgment: RestartSignalJudgment) => void) | undefined
    const kick = vi.fn()
    const root = mkdtempSync(join(tmpdir(), 'auto-build-kick-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    registerAutoBuild(ctx, {
      subscribe: (l) => { listener = l; return () => { listener = undefined } },
      kick,
      warn: vi.fn(),
      journal: vi.fn(),
      repositoryRoot: root,
    })
    listener?.(judgment('NEED_BUILD', 'h1'))
    expect(kick).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose() // disposers drain through the fiber's async disposal
    expect(listener).toBeUndefined()
    listener?.(judgment('NEED_BUILD', 'h2'))
    expect(kick).toHaveBeenCalledTimes(1)
  })
})

describe('auto-build host notifier: the token face (④ 机检: no shared queue)', () => {
  it('overwrites ONE payload-free token file — metadata only, never a queue', () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-build-token-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const h = harness(root, { realKick: true })
    h.emit(judgment('NEED_BUILD', 'h1'))
    h.emit(initJudgment()) // N kicks = same file, last shout wins (只保留最后一个)
    expect(existsSync(h.kickPath)).toBe(true)
    const token: unknown = JSON.parse(readFileSync(h.kickPath, 'utf8'))
    expect(token).toEqual({ at: '2023-11-14T22:13:20.000Z', from: 'host', state: 'INIT' })
    // Exactly these three keys: no command, no target tree, no payload slot.
    expect(Object.keys(token as Record<string, unknown>).sort()).toEqual(['at', 'from', 'state'])
    // One file, overwritten in place — there is no queue to accumulate in.
    expect(readdirSync(join(root, '.dsh-build'))).toEqual([AUTO_BUILD_KICK_FILE])
  })

  it('the direct write seam works for a human/manual shout too', () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-build-token-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    writeAutoBuildKick(root, { at: '2026-11-13T00:00:00.000Z', from: 'human', state: 'NEED_BUILD' })
    const token: unknown = JSON.parse(readFileSync(join(root, '.dsh-build', AUTO_BUILD_KICK_FILE), 'utf8'))
    expect(token).toEqual({ at: '2026-11-13T00:00:00.000Z', from: 'human', state: 'NEED_BUILD' })
  })

  it('a failing token write is LOUD and never thrown into the judgment stream', () => {
    const h = harness()
    const failure = new Error('disk full')
    h.kick.mockImplementation(() => { throw failure })
    expect(() => { h.emit(judgment('NEED_BUILD', 'h1')) }).not.toThrow()
    expect(h.warn).toHaveBeenCalledTimes(1)
    expect(h.warn.mock.calls[0]?.[0]).toContain('auto-build kick token write failed: disk full')
    expect(h.journal).toHaveBeenCalledTimes(1)
    expect(h.journal.mock.calls[0]?.[0]).toBe('kick-write-failed state=NEED_BUILD error=disk full')
  })
})
