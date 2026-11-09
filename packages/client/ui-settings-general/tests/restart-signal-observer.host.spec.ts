/**
 * Restart-signal observation seam (P3, carried through the off-host move):
 * every refreshed state read publishes to the judgment roster and the push
 * listeners, a throwing listener degrades to one stderr line, and the test
 * reset drops both rosters. (The publish itself — once per moved judgment,
 * never on an identical rewrite — is pinned in restart-signal.host.spec.)
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RESTART_SIGNAL_STATE_FILE,
  RESTART_SIGNAL_STATE_SCHEMA,
  STATE_FRESH_MS,
  collectRestartSignal,
  onRestartSignalJudgment,
  onRestartSignalStateRefresh,
  resetRestartSignalForTest,
  type RestartSignalJudgment,
} from '../src/restart-signal.ts'

const temporary: string[] = []

afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true })
  vi.restoreAllMocks()
  resetRestartSignalForTest()
})

/** A DSH home holding one fresh collector state file. */
function fixtureState(judgment: Partial<RestartSignalJudgment> & Pick<RestartSignalJudgment, 'state'> = { state: 'OK' }, ageMs?: number): string {
  const dshHome = mkdtempSync(join(tmpdir(), 'p3-observer-home-'))
  temporary.push(dshHome)
  writeFileSync(join(dshHome, RESTART_SIGNAL_STATE_FILE), JSON.stringify({
    schema: RESTART_SIGNAL_STATE_SCHEMA,
    collectedAt: new Date().toISOString(),
    repositoryRoot: 'C:\\repo',
    judgment: { detail: 'fixture', ...judgment },
  }))
  if (ageMs !== undefined) {
    const backdated = new Date(Date.now() - ageMs)
    utimesSync(join(dshHome, RESTART_SIGNAL_STATE_FILE), backdated, backdated)
  }
  return dshHome
}

describe('restart-signal judgment observation', () => {
  it('publishes a fresh state read to both the judgment roster and the refresh listeners', async () => {
    const dshHome = fixtureState({ state: 'NEED_BUILD', detail: 'host-face source moved past the last build baseline' })
    const seen: RestartSignalJudgment[] = []
    const refreshes: RestartSignalJudgment[] = []
    const off = onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    const offRefresh = onRestartSignalStateRefresh((judgment) => { refreshes.push(judgment) })
    const judgment = await collectRestartSignal({ dshHome })
    off()
    offRefresh()
    expect(judgment.state).toBe('NEED_BUILD')
    expect(seen).toEqual([judgment])
    expect(refreshes).toEqual([judgment])
  })

  it('never publishes a stale read — no roster, no refresh bell', async () => {
    const dshHome = fixtureState({ state: 'OK' }, STATE_FRESH_MS + 60_000)
    const seen: RestartSignalJudgment[] = []
    const refreshes: RestartSignalJudgment[] = []
    const off = onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    const offRefresh = onRestartSignalStateRefresh((judgment) => { refreshes.push(judgment) })
    await expect(collectRestartSignal({ dshHome })).rejects.toThrow('state file stale')
    off()
    offRefresh()
    expect(seen).toHaveLength(0)
    expect(refreshes).toHaveLength(0)
  })

  it('isolates a throwing listener to one stderr line and keeps the others', async () => {
    const dshHome = fixtureState()
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const seen: RestartSignalJudgment[] = []
    const offThrowing = onRestartSignalJudgment(() => { throw new Error('boom') })
    const offKeeping = onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    await collectRestartSignal({ dshHome })
    offThrowing()
    offKeeping()
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('boom'))
    expect(seen).toHaveLength(1)
  })

  it('drops both rosters through the test reset', async () => {
    const dshHome = fixtureState()
    const seen: RestartSignalJudgment[] = []
    const refreshes: RestartSignalJudgment[] = []
    onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    onRestartSignalStateRefresh((judgment) => { refreshes.push(judgment) })
    resetRestartSignalForTest()
    await collectRestartSignal({ dshHome })
    expect(seen).toEqual([])
    expect(refreshes).toEqual([])
  })

  it('stops firing after unsubscribe', async () => {
    const dshHome = fixtureState()
    const seen: RestartSignalJudgment[] = []
    const off = onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    off()
    await collectRestartSignal({ dshHome })
    expect(seen).toEqual([])
  })
})
