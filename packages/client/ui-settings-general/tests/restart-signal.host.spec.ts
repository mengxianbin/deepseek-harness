/**
 * Restart-signal state machine: the pure seven-state judgment (precedence,
 * restart branches, the client-only informational state, and the
 * conservative degradation when stamps are unavailable) plus the off-host
 * state-file read that feeds the host (offhost-1110): fresh file served
 * directly, mtime change re-reads and publishes, stale file falls back to the
 * last fresh judgment, absent/stale-with-none rejects unavailable — the host
 * never spawns anything.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RESTART_SIGNAL_STATE_FILE,
  RESTART_SIGNAL_STATE_SCHEMA,
  RestartSignalStateUnavailableError,
  STATE_FRESH_MS,
  collectRestartSignal,
  combineHostFace,
  invalidateRestartSignalCache,
  judgeRestartSignal,
  lastRestartSignalJudgment,
  onRestartSignalJudgment,
  onRestartSignalStateRefresh,
  readBuildStartCaptureTime,
  resetRestartSignalForTest,
  type RestartSignalInputs,
  type RestartSignalJudgment,
} from '../src/restart-signal.ts'
import { resetRestartStampForTest } from '../src/restart-stamp.ts'

const HOST_HASH = 'a'.repeat(64)
const CLIENT_HASH = 'b'.repeat(64)

/** One judgment's full input with sane baseline defaults; overrides name the case. */
function inputs(overrides: Partial<RestartSignalInputs> = {}): RestartSignalInputs {
  const runtimeStamp = {
    state: 'BASELINE' as const, reasons: [], notices: [], hostFaceHash: HOST_HASH, sCfg: 'cfg-1',
    capturedAt: '2026-10-25T00:00:00.000Z',
    components: [{
      repository: 'C:\\repo', kind: 'harness' as const, time: 't', builtFaces: ['host', 'client'],
      midBuildDirty: false, hostFaceHash: HOST_HASH, clientFaceHash: CLIENT_HASH,
    }],
  }
  return {
    runtime: runtimeStamp,
    fresh: runtimeStamp,
    configStamp: 'cfg-1',
    building: false,
    failed: false,
    currentHostFace: HOST_HASH,
    currentClientFace: CLIENT_HASH,
    ...overrides,
  }
}

describe('judgeRestartSignal', () => {
  it('reports INIT while any in-scope manifest is missing', () => {
    const judgment = judgeRestartSignal(inputs({
      fresh: { ...inputs().fresh, state: 'INIT', reasons: ['harness manifest missing: x'], hostFaceHash: undefined },
      currentHostFace: undefined,
    }))
    expect(judgment.state).toBe('INIT')
    expect(judgment.detail).toContain('harness manifest missing')
  })

  it('reports BUILDING while the build-start capture exists, before any source judgment', () => {
    const judgment = judgeRestartSignal(inputs({ building: true, currentHostFace: 'other' }))
    expect(judgment.state).toBe('BUILDING')
  })

  it('carries the build-start time on a BUILDING judgment, and none without one (build-timer-tooltip-1101)', () => {
    const startedAt = '2026-11-01T13:36:21.476Z'
    expect(judgeRestartSignal(inputs({ building: true, buildingStartedAt: startedAt })).startedAt).toBe(startedAt)
    expect(judgeRestartSignal(inputs({ building: true })).startedAt).toBeUndefined()
  })

  it('reports BUILD_FAILED while the failure record exists', () => {
    const judgment = judgeRestartSignal(inputs({ failed: true }))
    expect(judgment.state).toBe('BUILD_FAILED')
  })

  it('prefers BUILDING over BUILD_FAILED while both markers linger', () => {
    const judgment = judgeRestartSignal(inputs({ building: true, failed: true }))
    expect(judgment.state).toBe('BUILDING')
  })

  it('reports NEED_BUILD when host-face source moved past the baseline', () => {
    const judgment = judgeRestartSignal(inputs({ currentHostFace: 'c'.repeat(64) }))
    expect(judgment.state).toBe('NEED_BUILD')
    expect(judgment.reason).toBeUndefined()
  })

  it('keeps the NEED_BUILD lamp for linked-only drift but names the linked cause (build trigger scope: own face)', () => {
    // The lamp stays NEED_BUILD — linked source really is unbuilt — while
    // ownFaceMoved=false tells the dispatcher no build of this tree can clear it.
    const judgment = judgeRestartSignal(inputs({ currentHostFace: 'c'.repeat(64), ownFaceMoved: false }))
    expect(judgment.state).toBe('NEED_BUILD')
    expect(judgment.detail).toContain('linked repository source moved')
    expect(judgment.detail).toContain('build trigger scope: this tree only')
  })

  it('lets linked-manifest notices ride the judgment detail without changing the state', () => {
    const judgment = judgeRestartSignal(inputs({
      fresh: { ...inputs().fresh, notices: ['linked manifest missing: D:/linked-repo'] },
    }))
    expect(judgment.state).toBe('OK')
    expect(judgment.detail).toContain('linked manifest missing: D:/linked-repo')
  })

  it('degrades conservatively to NEED_BUILD when current stamps are unavailable', () => {
    const judgment = judgeRestartSignal(inputs({ currentHostFace: undefined }))
    expect(judgment.state).toBe('NEED_BUILD')
    expect(judgment.detail).toContain('unavailable')
  })

  it('puts NEED_BUILD before every restart branch so a dirty tree never guides a white restart', () => {
    const judgment = judgeRestartSignal(inputs({
      currentHostFace: 'c'.repeat(64),
      configStamp: 'cfg-2',
      runtime: { ...inputs().runtime, hostFaceHash: 'd'.repeat(64) },
    }))
    expect(judgment.state).toBe('NEED_BUILD')
  })

  it('reports NEED_RESTART on the config branch when S_cfg moved since process start', () => {
    const judgment = judgeRestartSignal(inputs({ configStamp: 'cfg-2' }))
    expect(judgment.state).toBe('NEED_RESTART')
    expect(judgment.reason).toBe('config')
  })

  it('reports NEED_RESTART on the built branch when the baseline moved past the runtime stamp', () => {
    const judgment = judgeRestartSignal(inputs({ runtime: { ...inputs().runtime, hostFaceHash: 'd'.repeat(64) } }))
    expect(judgment.state).toBe('NEED_RESTART')
    expect(judgment.reason).toBe('built')
  })

  it('reports NEED_RESTART on the built branch when the process started before any baseline', () => {
    const judgment = judgeRestartSignal(inputs({
      runtime: { ...inputs().runtime, state: 'INIT', hostFaceHash: undefined },
    }))
    expect(judgment.state).toBe('NEED_RESTART')
    expect(judgment.reason).toBe('built')
    expect(judgment.detail).toContain('before any baseline')
  })

  it('reports CLIENT_UPDATED when only the client face moved', () => {
    const judgment = judgeRestartSignal(inputs({ currentClientFace: 'e'.repeat(64) }))
    expect(judgment.state).toBe('CLIENT_UPDATED')
  })

  it('stays OK when the client baseline never existed', () => {
    const components = [{ repository: 'C:\\repo', kind: 'harness' as const, time: 't', builtFaces: ['client'], midBuildDirty: false, hostFaceHash: HOST_HASH, clientFaceHash: null }]
    const judgment = judgeRestartSignal(inputs({
      runtime: { ...inputs().runtime, components },
      fresh: { ...inputs().fresh, components },
    }))
    expect(judgment.state).toBe('OK')
  })

  it('reports OK when every fact agrees', () => {
    const judgment = judgeRestartSignal(inputs())
    expect(judgment.state).toBe('OK')
    expect(judgment.detail).toContain('agree')
  })
})

describe('combineHostFace', () => {
  it('normalizes separators before hashing', () => {
    expect(combineHostFace([['C:\\repo', 'x']])).toBe(combineHostFace([['C:/repo', 'x']]))
  })
})

/** Throwaway DSH home for one state-read test. */
const temporary: string[] = []

function fixtureHome(): string {
  const dshHome = mkdtempSync(join(tmpdir(), 'restart-state-home-'))
  temporary.push(dshHome)
  return dshHome
}

/** One collector-shaped state body; `ageMs` backdates the mtime to make it
 * stale, `mtime` pins it (same-key tricks), `totalSize` space-pads the JSON to
 * an exact byte count (trailing whitespace is valid JSON). */
function writeState(
  dshHome: string,
  judgment: Partial<RestartSignalJudgment> & Pick<RestartSignalJudgment, 'state'>,
  options: {
    readonly ageMs?: number
    readonly mtime?: Date
    readonly totalSize?: number
    readonly collectedAt?: string
    readonly raw?: string
  } = {},
): string {
  const path = join(dshHome, RESTART_SIGNAL_STATE_FILE)
  let body = options.raw ?? JSON.stringify({
    schema: RESTART_SIGNAL_STATE_SCHEMA,
    collectedAt: options.collectedAt ?? new Date().toISOString(),
    repositoryRoot: 'C:\\repo',
    judgment: { detail: 'fixture', ...judgment },
  })
  if (options.totalSize !== undefined) body = body.padEnd(options.totalSize, ' ')
  writeFileSync(path, body)
  if (options.ageMs !== undefined) {
    const backdated = new Date(Date.now() - options.ageMs)
    utimesSync(path, backdated, backdated)
  } else if (options.mtime !== undefined) {
    utimesSync(path, options.mtime, options.mtime)
  }
  return path
}

afterEach(() => {
  resetRestartSignalForTest()
  resetRestartStampForTest()
  vi.restoreAllMocks()
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('collectRestartSignal over the collector state file', () => {
  it('answers a fresh state file directly, seats included (新鲜即读)', async () => {
    const dshHome = fixtureHome()
    writeState(dshHome, {
      state: 'BUILDING',
      startedAt: '2026-11-01T13:36:21.476Z',
      detail: 'build-start capture present',
      facts: { currentHostFace: HOST_HASH, configStamp: 'cfg-1', ownFaceMoved: false },
    })
    const judgment = await collectRestartSignal({ dshHome })
    expect(judgment.state).toBe('BUILDING')
    expect(judgment.startedAt).toBe('2026-11-01T13:36:21.476Z')
    expect(judgment.facts?.configStamp).toBe('cfg-1')
    expect(lastRestartSignalJudgment()?.state).toBe('BUILDING')
  })

  it('coalesces concurrent collects into one state read', async () => {
    const dshHome = fixtureHome()
    writeState(dshHome, { state: 'OK' })
    const first = collectRestartSignal({ dshHome })
    const second = collectRestartSignal({ dshHome })
    expect(second).toBe(first)
    expect((await first).state).toBe('OK')
  })

  it('re-reads when the collector wrote a new file and serves the new judgment', async () => {
    const dshHome = fixtureHome()
    writeState(dshHome, { state: 'OK' })
    expect((await collectRestartSignal({ dshHome })).state).toBe('OK')
    writeState(dshHome, { state: 'NEED_BUILD', detail: 'host-face source moved past the last build baseline' })
    expect((await collectRestartSignal({ dshHome })).state).toBe('NEED_BUILD')
  })

  it('serves the last fresh judgment once the file goes stale — never the stale body (过期回上次值)', async () => {
    const dshHome = fixtureHome()
    writeState(dshHome, { state: 'NEED_RESTART', reason: 'config', detail: 'configured sources moved' })
    expect((await collectRestartSignal({ dshHome })).state).toBe('NEED_RESTART')
    // A new file lands with a backdated mtime: parsed (the key moved), but
    // stale — so it never adopts and never replaces the served judgment.
    writeState(dshHome, { state: 'OK', detail: 'a stale claim' }, { ageMs: STATE_FRESH_MS + 60_000 })
    expect((await collectRestartSignal({ dshHome })).state).toBe('NEED_RESTART')
    expect(lastRestartSignalJudgment()?.state).toBe('NEED_RESTART')
  })

  it('rejects unavailable when the state file is absent', async () => {
    const dshHome = fixtureHome()
    await expect(collectRestartSignal({ dshHome })).rejects.toBeInstanceOf(RestartSignalStateUnavailableError)
  })

  it('rejects unavailable when the only file was stale (no previous judgment)', async () => {
    const dshHome = fixtureHome()
    writeState(dshHome, { state: 'OK', detail: 'old truth' }, { ageMs: STATE_FRESH_MS + 60_000 })
    await expect(collectRestartSignal({ dshHome })).rejects.toBeInstanceOf(RestartSignalStateUnavailableError)
    expect(lastRestartSignalJudgment()).toBeUndefined()
  })

  it('rejects a malformed body with a plain error — the route maps that to 500, not the unavailable 504', async () => {
    const dshHome = fixtureHome()
    writeState(dshHome, { state: 'OK' }, { raw: '{not json' })
    const attempt = collectRestartSignal({ dshHome })
    await expect(attempt).rejects.toThrow('not JSON')
    await expect(attempt).rejects.not.toBeInstanceOf(RestartSignalStateUnavailableError)
  })

  it('drops the mtime key on invalidate so the next collect re-reads (语义随迁 ①)', async () => {
    const dshHome = fixtureHome()
    // Identical byte count and identical mtime: without invalidation the key
    // matches and the stored read serves; after invalidation the file is read anew.
    const pinned = new Date(Date.now() - 5_000)
    writeState(dshHome, { state: 'OK', detail: 'aaaa'.padEnd(64, 'a') }, { totalSize: 512, mtime: pinned })
    expect((await collectRestartSignal({ dshHome })).state).toBe('OK')
    writeState(dshHome, { state: 'INIT', detail: 'bbbb'.padEnd(64, 'b') }, { totalSize: 512, mtime: pinned })
    expect((await collectRestartSignal({ dshHome })).state).toBe('OK')
    invalidateRestartSignalCache()
    expect((await collectRestartSignal({ dshHome })).state).toBe('INIT')
  })

  it('publishes once per moved judgment and stays quiet on an identical rewrite (语义随迁 ②)', async () => {
    const dshHome = fixtureHome()
    const seen: RestartSignalJudgment[] = []
    const refreshes: RestartSignalJudgment[] = []
    const off = onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    const offRefresh = onRestartSignalStateRefresh((judgment) => { refreshes.push(judgment) })
    writeState(dshHome, { state: 'OK', detail: 'same body' })
    await collectRestartSignal({ dshHome })
    expect(seen).toHaveLength(1)
    expect(refreshes).toHaveLength(1)
    // A rewrite with a new mtime but the identical judgment: re-read, no churn.
    writeState(dshHome, { state: 'OK', detail: 'same body' })
    await collectRestartSignal({ dshHome })
    expect(seen).toHaveLength(1)
    expect(refreshes).toHaveLength(1)
    writeState(dshHome, { state: 'BUILDING', detail: 'build-start capture present' })
    await collectRestartSignal({ dshHome })
    expect(seen).toHaveLength(2)
    expect(refreshes).toHaveLength(2)
    off()
    offRefresh()
  })

  it('never publishes a stale body', async () => {
    const dshHome = fixtureHome()
    writeState(dshHome, { state: 'OK', detail: 'fresh first' })
    await collectRestartSignal({ dshHome })
    const seen: RestartSignalJudgment[] = []
    const off = onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    writeState(dshHome, { state: 'NEED_BUILD', detail: 'stale claim' }, { ageMs: STATE_FRESH_MS + 60_000 })
    await collectRestartSignal({ dshHome })
    expect(seen).toHaveLength(0)
    off()
  })

  it('drops the roster through the test reset', async () => {
    const dshHome = fixtureHome()
    const seen: RestartSignalJudgment[] = []
    onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    resetRestartSignalForTest()
    writeState(dshHome, { state: 'OK' })
    await collectRestartSignal({ dshHome })
    expect(seen).toEqual([])
  })

  it('stops firing after unsubscribe', async () => {
    const dshHome = fixtureHome()
    const seen: RestartSignalJudgment[] = []
    const off = onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    off()
    writeState(dshHome, { state: 'OK' })
    await collectRestartSignal({ dshHome })
    expect(seen).toEqual([])
  })
})

describe('readBuildStartCaptureTime', () => {
  const tree = mkdtempSync(join(tmpdir(), 'dsh-build-start-'))
  const capturePath = join(tree, '.dsh-build', 'restart-stamp.start.json')
  afterEach(() => { rmSync(tree, { recursive: true, force: true }) })
  const writeCapture = (body: string): void => {
    mkdirSync(join(tree, '.dsh-build'), { recursive: true })
    writeFileSync(capturePath, body)
  }

  it('reads the capture time behind the BUILDING lamp', () => {
    writeCapture(JSON.stringify({
      version: 1,
      kind: 'harness-start',
      time: '2026-11-01T13:36:21.476Z',
      faces: ['host'],
      sStart: { repo: 'r', host: 'h', client: 'c' },
    }))
    expect(readBuildStartCaptureTime(tree)).toBe('2026-11-01T13:36:21.476Z')
  })

  it.each([
    ['a missing capture', undefined],
    ['malformed JSON', '{'],
    ['a foreign kind', JSON.stringify({ version: 1, kind: 'other', time: '2026-11-01T00:00:00.000Z' })],
    ['an unreadable time', JSON.stringify({ version: 1, kind: 'harness-start', time: 'yesterday' })],
  ])('degrades to undefined on %s (build-timer-tooltip-1101)', (_label, body) => {
    if (body === undefined) rmSync(capturePath, { force: true })
    else writeCapture(body)
    expect(readBuildStartCaptureTime(tree)).toBeUndefined()
  })
})
