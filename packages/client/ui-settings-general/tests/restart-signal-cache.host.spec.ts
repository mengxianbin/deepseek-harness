/**
 * Result cache behind `collectRestartSignal` (stamp-recheck-cache-timeout-1107):
 * a repeat collect inside the 15s TTL answers the stored judgment without
 * spawning the stamp CLI, the TTL expiry and a build-marker transition each
 * recompute, the push sensor's invalidation drops the stored result, a cache
 * hit publishes nothing to the observer roster, and the recheck route answers
 * a second BUILDING pull from the cache in well under 500ms — the unit-level
 * twin of the live `dsh-web.log` retest (which waits on the human restart).
 */
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectRestartSignal,
  invalidateRestartSignalCache,
  lastRestartSignalJudgment,
  onRestartSignalJudgment,
  resetRestartSignalForTest,
  type CurrentStamp,
  type RestartSignalJudgment,
} from '../src/restart-signal.ts'
import { registerRestartSignal } from '../src/restart-signal-host.ts'
import { resetRestartStampForTest } from '../src/restart-stamp.ts'
import { RECHECK_PATH } from '../src/restart.ts'
import { writeHarnessManifest } from '../../../../scripts/restart-signal/manifest.ts'

const HOST_HASH = 'a'.repeat(64)
const CLIENT_HASH = 'b'.repeat(64)

/** Throwaway directories for one cache test: a manifest tree and a DSH home. */
const temporary: string[] = []

function fixtureTree(): { repositoryRoot: string; dshHome: string } {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'restart-cache-repo-'))
  temporary.push(repositoryRoot)
  const dshHome = mkdtempSync(join(tmpdir(), 'restart-cache-home-'))
  temporary.push(dshHome)
  return { repositoryRoot, dshHome }
}

/** Write a clean single-build baseline whose host face is the given hex. */
function writeBaseline(repositoryRoot: string, host: string): void {
  writeHarnessManifest(repositoryRoot, {
    version: 1,
    kind: 'harness',
    time: '2026-11-07T00:00:00.000Z',
    sStartTime: '2026-11-07T00:00:00.000Z',
    builtFaces: ['host', 'client'],
    midBuildDirty: false,
    hostFaceHash: host,
    clientFaceHash: CLIENT_HASH,
    sStart: { repo: 'r', host, client: CLIENT_HASH },
    sEnd: { repo: 'r', host, client: CLIENT_HASH },
  })
}

/** A counting stand-in for the production stamp CLI: one OK stamp per call. */
function countingRunner(repositoryRoot: string) {
  return vi.fn(async (): Promise<readonly CurrentStamp[]> => [
    { repository: repositoryRoot, kind: 'harness', host: HOST_HASH, client: CLIENT_HASH },
  ])
}

/** Collect options over one fixture tree with the counting CLI stand-in. */
function fixtureOptions(repositoryRoot: string, dshHome: string, runStampCli: ReturnType<typeof countingRunner>) {
  return { repositoryRoot, dshHome, registryQuery: () => '', runStampCli }
}

afterEach(() => {
  resetRestartSignalForTest()
  resetRestartStampForTest()
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('collectRestartSignal result cache', () => {
  it('answers a repeat collect inside the TTL without spawning the stamp CLI again', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    writeBaseline(repositoryRoot, HOST_HASH)
    const runStampCli = countingRunner(repositoryRoot)
    const options = fixtureOptions(repositoryRoot, dshHome, runStampCli)
    expect(lastRestartSignalJudgment()).toBeUndefined()
    const first = await collectRestartSignal(options)
    const second = await collectRestartSignal(options)
    expect(first.state).toBe('OK')
    expect(second).toBe(first)
    expect(runStampCli).toHaveBeenCalledTimes(1)
    expect(lastRestartSignalJudgment()).toBe(first)
  })

  it('recomputes once the TTL expires (spawn count 1 → 2)', async () => {
    // The clock alone decides this one: only `Date` is faked, so no timer
    // machinery can mask an expiry mistake.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-07T04:00:00.000Z'))
    const { repositoryRoot, dshHome } = fixtureTree()
    writeBaseline(repositoryRoot, HOST_HASH)
    const runStampCli = countingRunner(repositoryRoot)
    const options = fixtureOptions(repositoryRoot, dshHome, runStampCli)
    const first = await collectRestartSignal(options)
    expect(runStampCli).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-11-07T04:00:15.001Z'))
    const second = await collectRestartSignal(options)
    expect(runStampCli).toHaveBeenCalledTimes(2)
    expect(second.state).toBe('OK')
    expect(second).not.toBe(first)
  })

  it('never serves a judgment keyed to another tree', async () => {
    const first = fixtureTree()
    writeBaseline(first.repositoryRoot, HOST_HASH)
    const second = fixtureTree()
    writeBaseline(second.repositoryRoot, HOST_HASH)
    const runnerA = countingRunner(first.repositoryRoot)
    const runnerB = countingRunner(second.repositoryRoot)
    await collectRestartSignal(fixtureOptions(first.repositoryRoot, first.dshHome, runnerA))
    await collectRestartSignal(fixtureOptions(second.repositoryRoot, second.dshHome, runnerB))
    // The second tree recomputed: the cache key is the repository root, so a
    // foreign tree's stored judgment can never answer for this one.
    expect(runnerA).toHaveBeenCalledTimes(1)
    expect(runnerB).toHaveBeenCalledTimes(1)
  })

  it('recomputes on a build-start marker transition instead of waiting out the TTL', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    writeBaseline(repositoryRoot, HOST_HASH)
    const runStampCli = countingRunner(repositoryRoot)
    const options = fixtureOptions(repositoryRoot, dshHome, runStampCli)
    expect((await collectRestartSignal(options)).state).toBe('OK')
    expect(runStampCli).toHaveBeenCalledTimes(1)
    // The build opens: the start marker lands (the legacy pid-less form reads
    // as in flight), and the next collect must see it without waiting the TTL.
    const startedAt = '2026-11-07T04:00:03.000Z'
    mkdirSync(join(repositoryRoot, '.dsh-build'), { recursive: true })
    writeFileSync(join(repositoryRoot, '.dsh-build', 'restart-stamp.start.json'), JSON.stringify({
      version: 1,
      kind: 'harness-start',
      time: startedAt,
      faces: ['host'],
      sStart: { repo: 'r', host: HOST_HASH, client: CLIENT_HASH },
    }))
    const building = await collectRestartSignal(options)
    expect(building.state).toBe('BUILDING')
    expect(building.startedAt).toBe(startedAt)
    expect(runStampCli).toHaveBeenCalledTimes(2)
    // A repeat inside the TTL serves the stored judgment verbatim: the BUILDING
    // `startedAt` rides along, so the client's own 30s refresh keeps walking the
    // elapsed age off the same absolute instant.
    const repeat = await collectRestartSignal(options)
    expect(repeat).toBe(building)
    expect(repeat.startedAt).toBe(startedAt)
    expect(runStampCli).toHaveBeenCalledTimes(2)
  })

  it('recomputes on a build-failure marker transition', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    writeBaseline(repositoryRoot, HOST_HASH)
    const runStampCli = countingRunner(repositoryRoot)
    const options = fixtureOptions(repositoryRoot, dshHome, runStampCli)
    expect((await collectRestartSignal(options)).state).toBe('OK')
    const failure = join(repositoryRoot, '.dsh-build', 'restart-stamp.failed.json')
    mkdirSync(join(repositoryRoot, '.dsh-build'), { recursive: true })
    writeFileSync(failure, '{"version":1}')
    expect((await collectRestartSignal(options)).state).toBe('BUILD_FAILED')
    expect(runStampCli).toHaveBeenCalledTimes(2)
    rmSync(failure)
    expect((await collectRestartSignal(options)).state).toBe('OK')
    expect(runStampCli).toHaveBeenCalledTimes(3)
  })

  it('drops the stored judgment on invalidation — the push sensor\'s move event', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    writeBaseline(repositoryRoot, HOST_HASH)
    const runStampCli = countingRunner(repositoryRoot)
    const options = fixtureOptions(repositoryRoot, dshHome, runStampCli)
    await collectRestartSignal(options)
    expect(runStampCli).toHaveBeenCalledTimes(1)
    invalidateRestartSignalCache()
    expect(lastRestartSignalJudgment()).toBeUndefined()
    await collectRestartSignal(options)
    expect(runStampCli).toHaveBeenCalledTimes(2)
  })

  it('publishes to observers once per computation — a cache hit fires none', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    writeBaseline(repositoryRoot, HOST_HASH)
    const runStampCli = countingRunner(repositoryRoot)
    const options = fixtureOptions(repositoryRoot, dshHome, runStampCli)
    const seen: RestartSignalJudgment[] = []
    const off = onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    const first = await collectRestartSignal(options)
    const second = await collectRestartSignal(options)
    off()
    expect(second).toBe(first)
    expect(seen).toEqual([first])
    expect(runStampCli).toHaveBeenCalledTimes(1)
  })
})

describe('stamp-recheck route over the result cache', () => {
  /** One route fixture over the real Connection fetch registry. */
  function routeFixture() {
    const ctx = new Context()
    const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
    const handler = connection.createSharedFetchHandler('/api')
    const post = () => handler.fetch(new Request(`http://localhost${RECHECK_PATH}`, { method: 'POST' }), connection.browserPeer)
    return { ctx, post }
  }

  it('answers a second BUILDING recheck from the cache in well under 500ms', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    writeBaseline(repositoryRoot, HOST_HASH)
    const startedAt = '2026-11-07T04:00:03.000Z'
    mkdirSync(join(repositoryRoot, '.dsh-build'), { recursive: true })
    writeFileSync(join(repositoryRoot, '.dsh-build', 'restart-stamp.start.json'), JSON.stringify({
      version: 1,
      kind: 'harness-start',
      time: startedAt,
      faces: ['host'],
      sStart: { repo: 'r', host: HOST_HASH, client: CLIENT_HASH },
    }))
    const runStampCli = countingRunner(repositoryRoot)
    const { ctx, post } = routeFixture()
    registerRestartSignal(ctx, {
      collect: () => collectRestartSignal(fixtureOptions(repositoryRoot, dshHome, runStampCli)),
    })
    const first = await post()
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ state: 'BUILDING', startedAt })
    expect(runStampCli).toHaveBeenCalledTimes(1)
    const started = Date.now()
    const second = await post()
    const elapsed = Date.now() - started
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ state: 'BUILDING', startedAt })
    expect(runStampCli).toHaveBeenCalledTimes(1)
    // The live acceptance twin: second pull ≤500ms (unit form; the dsh-web.log
    // form waits on the human restart of the production host).
    expect(elapsed).toBeLessThan(500)
  })
})
