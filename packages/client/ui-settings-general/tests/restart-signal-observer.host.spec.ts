/**
 * Restart-signal observation seam (P3): every production collect carries its
 * machine facts, listeners fire once per coalesced computation, a throwing
 * listener degrades to one stderr line, and the test reset drops the roster.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectRestartSignal,
  onRestartSignalJudgment,
  resetRestartSignalForTest,
  type RestartSignalJudgment,
} from '../src/restart-signal.ts'

const temporary: string[] = []

afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true })
  vi.restoreAllMocks()
  resetRestartSignalForTest()
})

/** A bare tree pair whose manifest read lands in INIT. */
function fixtureTree(): { repositoryRoot: string; dshHome: string } {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'p3-observer-repo-'))
  temporary.push(repositoryRoot)
  const dshHome = mkdtempSync(join(tmpdir(), 'p3-observer-home-'))
  temporary.push(dshHome)
  mkdirSync(join(dshHome, 'profiles'))
  return { repositoryRoot, dshHome }
}

describe('restart-signal judgment observation', () => {
  it('attaches machine facts to every judgment, INIT included', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    const seen: RestartSignalJudgment[] = []
    const off = onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    const judgment = await collectRestartSignal({ repositoryRoot, dshHome, registryQuery: () => '', runStampCli: vi.fn() })
    off()
    expect(judgment.state).toBe('INIT')
    expect(judgment.facts?.currentHostFace).toBeUndefined()
    expect(typeof judgment.facts?.configStamp).toBe('string')
    expect(seen).toEqual([judgment])
  })

  it('fires listeners once per coalesced computation', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    const seen: RestartSignalJudgment[] = []
    const off = onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    const first = collectRestartSignal({ repositoryRoot, dshHome, registryQuery: () => '', runStampCli: vi.fn() })
    const second = collectRestartSignal({ repositoryRoot, dshHome, registryQuery: () => '', runStampCli: vi.fn() })
    expect(second).toBe(first)
    await first
    off()
    expect(seen).toHaveLength(1)
  })

  it('isolates a throwing listener to one stderr line and keeps the others', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const seen: RestartSignalJudgment[] = []
    const offThrowing = onRestartSignalJudgment(() => { throw new Error('boom') })
    const offKeeping = onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    await collectRestartSignal({ repositoryRoot, dshHome, registryQuery: () => '', runStampCli: vi.fn() })
    offThrowing()
    offKeeping()
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('boom'))
    expect(seen).toHaveLength(1)
  })

  it('drops the roster through the test reset', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    const seen: RestartSignalJudgment[] = []
    onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    resetRestartSignalForTest()
    await collectRestartSignal({ repositoryRoot, dshHome, registryQuery: () => '', runStampCli: vi.fn() })
    expect(seen).toEqual([])
  })

  it('stops firing after unsubscribe', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    const seen: RestartSignalJudgment[] = []
    const off = onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    off()
    await collectRestartSignal({ repositoryRoot, dshHome, registryQuery: () => '', runStampCli: vi.fn() })
    expect(seen).toEqual([])
  })
})
