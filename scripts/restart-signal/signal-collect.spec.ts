/**
 * Off-host collector (`signal-collect`): the gather chain moved out of the
 * host wholesale — runtime-capture read (loud on absent/malformed: the
 * NEED_RESTART branch depends on the HOST's R, never a collector-start
 * capture), fresh manifest read, marker liveness with orphan recovery, the
 * single allowed signal-cli spawn (counting seam + one real end-to-end), the
 * pure judgment with machine facts attached — plus the atomic state write the
 * host consumes (round-tripped through `collectRestartSignal`) and the loud
 * journal/registration faces.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RESTART_SIGNAL_RUNTIME_FILE,
  RESTART_SIGNAL_RUNTIME_SCHEMA,
  RESTART_SIGNAL_STATE_FILE,
  RESTART_SIGNAL_STATE_SCHEMA,
  STATE_FRESH_MS,
  collectRestartSignal,
  combineHostFace,
  resetRestartSignalForTest,
} from '../../packages/client/ui-settings-general/src/restart-signal.ts'
import { computeConfigStamp, resetRestartStampForTest } from '../../packages/client/ui-settings-general/src/restart-stamp.ts'
import { writeHarnessManifest } from './manifest.ts'
import {
  COLLECT_TASK_MINUTES,
  COLLECT_TASK_NAME,
  computeJudgment,
  readRuntimeCapture,
  writeRunJournal,
  writeStateFile,
  type CollectedState,
} from './signal-collect.ts'
import { stampRepository, type CurrentStamp } from './signal-cli.ts'

const HOST_HASH = 'a'.repeat(64)
const CLIENT_HASH = 'b'.repeat(64)

const temporary: string[] = []

/** Throwaway tree pair plus a valid host runtime capture in its DSH home. */
function fixtureTree(runtime: { readonly sCfg?: string; readonly hostFaceHash?: string; readonly state?: 'INIT' | 'BASELINE' } = {}): {
  readonly repositoryRoot: string
  readonly dshHome: string
} {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'signal-collect-repo-'))
  temporary.push(repositoryRoot)
  const dshHome = mkdtempSync(join(tmpdir(), 'signal-collect-home-'))
  temporary.push(dshHome)
  mkdirSync(join(dshHome, 'profiles'), { recursive: true })
  writeRuntimeCapture(dshHome, runtime, repositoryRoot)
  return { repositoryRoot, dshHome }
}

/** Write a host-shaped runtime capture (R) into the fixture home. The default
 * sCfg is the capture the fixture's own `registryQuery: () => ''` fresh read
 * will recompute — the config branch needs an exact match to stay out of the
 * way, exactly as the process-cached restartStamp did pre-move. When a tree is
 * named, hostFaceHash is combined the way `restartStamp()` combines it (the
 * host captures the per-repository combination, never a raw manifest field),
 * with this capture's component set — the linked tree enters fresh later and
 * that difference is precisely what NEED_RESTART `built` keys on. */
function writeRuntimeCapture(
  dshHome: string,
  runtime: { readonly sCfg?: string; readonly hostFaceHash?: string; readonly state?: 'INIT' | 'BASELINE' } = {},
  repositoryRoot?: string,
): void {
  const raw = runtime.hostFaceHash ?? HOST_HASH
  const combined = repositoryRoot === undefined
    ? raw
    : combineHostFace([[repositoryRoot.replace(/\\/g, '/'), raw]])
  writeFileSync(join(dshHome, RESTART_SIGNAL_RUNTIME_FILE), JSON.stringify({
    schema: RESTART_SIGNAL_RUNTIME_SCHEMA,
    state: runtime.state ?? 'BASELINE',
    reasons: [],
    notices: [],
    hostFaceHash: combined,
    sCfg: runtime.sCfg ?? computeConfigStamp(dshHome, ''),
    capturedAt: '2026-11-07T00:00:00.000Z',
    components: [{
      repository: (repositoryRoot ?? dshHome).replace(/\\/g, '/'), kind: 'harness', time: '2026-11-07T00:00:00.000Z',
      builtFaces: ['host', 'client'], midBuildDirty: false, hostFaceHash: null, clientFaceHash: null,
    }],
  }))
}

/** Write a clean single-build baseline whose face hashes are the given hexes. */
function writeBaseline(repositoryRoot: string, faces: { host: string; client: string | null }): void {
  const shared = { repo: 'r', host: faces.host, client: faces.client ?? CLIENT_HASH }
  writeHarnessManifest(repositoryRoot, {
    version: 1,
    kind: 'harness',
    time: '2026-11-07T00:00:00.000Z',
    sStartTime: '2026-11-07T00:00:00.000Z',
    builtFaces: faces.client === null ? ['host'] : ['host', 'client'],
    midBuildDirty: false,
    hostFaceHash: faces.host,
    clientFaceHash: faces.client,
    sStart: shared,
    sEnd: shared,
  })
}

/** A stamp-capable linked repository behind the fixture profile's link; no manifest yet. */
function linkStampCapableRepository(dshHome: string, repository: string): void {
  mkdirSync(join(repository, '.git'))
  mkdirSync(join(repository, 'scripts', 'restart-signal'), { recursive: true })
  writeFileSync(join(repository, 'scripts', 'restart-signal', 'build-stamp.ts'), '')
  mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true })
  writeFileSync(
    join(dshHome, 'profiles', 'web', 'package.json'),
    JSON.stringify({ name: 'fixture-profile', dependencies: { 'fixture-plugin': `link:${repository}` } }),
  )
}

/** A throwaway linked repository directory, tracked for cleanup. */
function linkedTree(): string {
  const repository = mkdtempSync(join(tmpdir(), 'signal-collect-linked-'))
  temporary.push(repository)
  return repository
}

afterEach(() => {
  resetRestartSignalForTest()
  resetRestartStampForTest()
  vi.restoreAllMocks()
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('readRuntimeCapture', () => {
  it('reads the host-persisted R: state, face, and configured-source snapshot', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'signal-collect-runtime-'))
    temporary.push(dshHome)
    writeRuntimeCapture(dshHome, { hostFaceHash: 'd'.repeat(64), sCfg: 'cfg-9' })
    const runtime = readRuntimeCapture(join(dshHome, RESTART_SIGNAL_RUNTIME_FILE))
    expect(runtime.state).toBe('BASELINE')
    expect(runtime.hostFaceHash).toBe('d'.repeat(64))
    expect(runtime.sCfg).toBe('cfg-9')
    expect(runtime.capturedAt).toBe('2026-11-07T00:00:00.000Z')
  })

  it('fails loud and names the restart when the host never persisted R', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'signal-collect-runtime-missing-'))
    temporary.push(dshHome)
    expect(() => readRuntimeCapture(join(dshHome, RESTART_SIGNAL_RUNTIME_FILE)))
      .toThrow('runtime capture absent')
    expect(() => readRuntimeCapture(join(dshHome, RESTART_SIGNAL_RUNTIME_FILE)))
      .toThrow('restart dsh web to activate off-host collection')
  })

  it('rejects a schema mismatch loudly instead of judging from a foreign shape', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'signal-collect-runtime-bad-'))
    temporary.push(dshHome)
    writeFileSync(join(dshHome, RESTART_SIGNAL_RUNTIME_FILE), JSON.stringify({ schema: 'something-else' }))
    expect(() => readRuntimeCapture(join(dshHome, RESTART_SIGNAL_RUNTIME_FILE))).toThrow('schema mismatch')
  })
})

describe('computeJudgment (the gather chain, off the host)', () => {
  it('answers INIT from a missing own manifest, facts attached, without spawning the CLI', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    const runStampCli = vi.fn()
    const state = await computeJudgment({ repositoryRoot, dshHome, registryQuery: () => '', runStampCli })
    expect(state.judgment.state).toBe('INIT')
    expect(state.collectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(state.repositoryRoot).toBe(repositoryRoot)
    expect(typeof state.judgment.facts?.configStamp).toBe('string')
    expect(runStampCli).not.toHaveBeenCalled()
  })

  it('answers OK when current stamps equal the baseline, through the runtime combination mirror', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    writeBaseline(repositoryRoot, { host: HOST_HASH, client: CLIENT_HASH })
    const runStampCli = vi.fn(async (): Promise<readonly CurrentStamp[]> => [
      { repository: repositoryRoot, kind: 'harness', host: HOST_HASH, client: CLIENT_HASH },
    ])
    // The persisted runtime stamp and the fresh read share one capture here;
    // the combination mirror is pinned by the OK outcome: a format drift
    // between combineHostFace and the runtime stamp's own hash would surface
    // as NEED_RESTART instead.
    const state = await computeJudgment({ repositoryRoot, dshHome, registryQuery: () => '', runStampCli })
    expect(state.judgment.state).toBe('OK')
    // facts carry the COMBINED current face (what the R/B comparison consumed).
    expect(state.judgment.facts?.currentHostFace).toBe(combineHostFace([[repositoryRoot.replace(/\\/g, '/'), HOST_HASH]]))
    expect(state.judgment.facts?.ownFaceMoved).toBe(false)
  })

  it('reports NEED_RESTART config when the configuration moved past the captured R', async () => {
    const { repositoryRoot, dshHome } = fixtureTree({ sCfg: 'old-home' })
    writeBaseline(repositoryRoot, { host: HOST_HASH, client: null })
    // R was captured against the old value; the fresh enumeration (this run's
    // only registry read — the collector never calls restartStamp) sees the new one.
    const registryQuery = (): string => '\n    HKEY_CURRENT_USER\\Environment\n        DSH_HOME    REG_SZ    new-home\n'
    const runStampCli = vi.fn(async (): Promise<readonly CurrentStamp[]> => [
      { repository: repositoryRoot, kind: 'harness', host: HOST_HASH, client: CLIENT_HASH },
    ])
    const state = await computeJudgment({ repositoryRoot, dshHome, registryQuery, runStampCli })
    expect(state.judgment.state).toBe('NEED_RESTART')
    expect(state.judgment.reason).toBe('config')
  })

  it('degrades to NEED_BUILD with one stderr line when the stamp CLI fails', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    writeBaseline(repositoryRoot, { host: HOST_HASH, client: null })
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const state = await computeJudgment({
      repositoryRoot,
      dshHome,
      registryQuery: () => '',
      runStampCli: vi.fn(async () => { throw new Error('git exploded') }),
    })
    expect(state.judgment.state).toBe('NEED_BUILD')
    expect(state.judgment.detail).toContain('unavailable')
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('git exploded'))
  })

  it('stamps a real tree through the production CLI and lands OK against a matching baseline', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    // A real git tree whose manifest is written from its own computed stamps:
    // git init + sources + tsconfig graphs, then stamp, then baseline.
    writeFileSync(join(repositoryRoot, 'pnpm-workspace.yaml'), 'packages: []\n')
    writeFileSync(join(repositoryRoot, '.gitignore'), '.dsh-build/\n')
    writeFileSync(join(repositoryRoot, 'tsconfig.host.json'), '{"include":["src/host/**/*.ts"]}\n')
    writeFileSync(join(repositoryRoot, 'tsconfig.client.json'), '{"include":["src/client/**/*.ts"]}\n')
    mkdirSync(join(repositoryRoot, 'src', 'host'), { recursive: true })
    mkdirSync(join(repositoryRoot, 'src', 'client'), { recursive: true })
    writeFileSync(join(repositoryRoot, 'src', 'host', 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(repositoryRoot, 'src', 'client', 'b.ts'), 'export const b = 2\n')
    execFileSync('git', ['-C', repositoryRoot, 'init'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repositoryRoot, 'add', '.'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repositoryRoot, '-c', 'user.name=stamp-fixture', '-c', 'user.email=stamp@fixture.invalid', 'commit', '-m', 'fixture'], { stdio: 'ignore' })
    const stamped = stampRepository({ repository: repositoryRoot, kind: 'harness' })
    expect(stamped.host).toMatch(/^[0-9a-f]{64}$/)
    writeBaseline(repositoryRoot, { host: stamped.host, client: stamped.client })
    // The production gatherer spawns the real signal-cli (the collector's one
    // allowed spawn site) from this module's own harness tree.
    writeRuntimeCapture(dshHome, { hostFaceHash: stamped.host }, repositoryRoot)
    const state = await computeJudgment({ repositoryRoot, dshHome, registryQuery: () => '' })
    expect(state.judgment.state).toBe('OK')
  })

  it('answers with a linked-manifest notice, then NEED_RESTART built once the linked tree stamps (R/B keeps linked)', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    const linked = linkedTree()
    linkStampCapableRepository(dshHome, linked)
    writeBaseline(repositoryRoot, { host: HOST_HASH, client: null })
    writeRuntimeCapture(dshHome, { hostFaceHash: HOST_HASH }, repositoryRoot)
    // R captured with linked absent: the fresh read records the absence as a
    // notice while the lamp stays OK (linked-split: INIT is own-manifest-only).
    const first = await computeJudgment({
      repositoryRoot, dshHome, registryQuery: () => '',
      runStampCli: vi.fn(async (): Promise<readonly CurrentStamp[]> => [
        { repository: repositoryRoot, kind: 'harness', host: HOST_HASH, client: CLIENT_HASH },
      ]),
    })
    expect(first.judgment.state).toBe('OK')
    expect(first.judgment.detail).toContain('linked manifest missing')
    // The linked tree gets stamped: its component enters the fresh
    // combination, the persisted R no longer matches, and the R/B comparison
    // — which keeps linked in full — raises NEED_RESTART built. The collector
    // keeps no cache: the next run simply re-reads.
    writeBaseline(linked, { host: 'b'.repeat(64), client: null })
    const second = await computeJudgment({
      repositoryRoot, dshHome, registryQuery: () => '',
      runStampCli: vi.fn(async (): Promise<readonly CurrentStamp[]> => [
        { repository: repositoryRoot, kind: 'harness', host: HOST_HASH, client: CLIENT_HASH },
        { repository: linked, kind: 'harness', host: 'b'.repeat(64), client: CLIENT_HASH },
      ]),
    })
    expect(second.judgment.state).toBe('NEED_RESTART')
    expect(second.judgment.reason).toBe('built')
  })

  it('pins linked-only source drift on ownFaceMoved=false while the lamp stays NEED_BUILD', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    const linked = linkedTree()
    linkStampCapableRepository(dshHome, linked)
    writeBaseline(repositoryRoot, { host: HOST_HASH, client: null })
    writeBaseline(linked, { host: 'b'.repeat(64), client: null })
    const state = await computeJudgment({
      repositoryRoot, dshHome, registryQuery: () => '',
      runStampCli: vi.fn(async (): Promise<readonly CurrentStamp[]> => [
        // Own face matches its baseline; only the linked face drifted.
        { repository: repositoryRoot, kind: 'harness', host: HOST_HASH, client: CLIENT_HASH },
        { repository: linked, kind: 'harness', host: 'c'.repeat(64), client: CLIENT_HASH },
      ]),
    })
    expect(state.judgment.state).toBe('NEED_BUILD')
    expect(state.judgment.facts?.ownFaceMoved).toBe(false)
    expect(state.judgment.detail).toContain('linked repository source moved')
    expect(state.judgment.linkedRepo).toBe(linked)
    expect(state.judgment.detail).toContain(`drifted: ${linked}`)
  })

  it('recovers from a killed build process in the very next run — no permanent BUILDING (O-1103)', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    writeBaseline(repositoryRoot, { host: HOST_HASH, client: CLIENT_HASH })
    const runStampCli = vi.fn(async (): Promise<readonly CurrentStamp[]> => [
      { repository: repositoryRoot, kind: 'harness', host: HOST_HASH, client: CLIENT_HASH },
    ])
    const options = { repositoryRoot, dshHome, registryQuery: () => '', runStampCli }
    // A stand-in build process under real control: the marker records its pid
    // (what beginBuild writes), then it is really killed — the observed 300s
    // foreground-timeout death, reproduced deterministically.
    const buildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true })
    await new Promise<void>((resolve, reject) => {
      buildProcess.once('spawn', () => { resolve() })
      buildProcess.once('error', reject)
    })
    const pid = buildProcess.pid
    if (pid === undefined) throw new Error('stand-in build process exposed no pid')
    const capturePath = join(repositoryRoot, '.dsh-build', 'restart-stamp.start.json')
    mkdirSync(join(repositoryRoot, '.dsh-build'), { recursive: true })
    writeFileSync(capturePath, JSON.stringify({
      version: 1,
      kind: 'harness-start',
      time: new Date().toISOString(),
      pid,
      faces: ['host', 'client'],
      sStart: { repo: 'r', host: HOST_HASH, client: CLIENT_HASH },
    }))

    // While the named process lives, the judgment is BUILDING: a live build is
    // never misjudged by the probe (the anti-blind-clearing half).
    expect((await computeJudgment(options)).judgment.state).toBe('BUILDING')

    buildProcess.kill('SIGKILL')
    await new Promise<void>((resolve) => { buildProcess.once('exit', () => { resolve() }) })

    // One run after the kill: the orphan marker is gone, its recovery line is
    // in the journal, and the judgment has recovered.
    const after = await computeJudgment(options)
    expect(after.judgment.state).toBe('OK')
    expect(existsSync(capturePath)).toBe(false)
    const journal = readFileSync(join(repositoryRoot, '.dsh-build', 'auto-build.log'), 'utf8')
    expect(journal).toContain('orphan-start-marker-cleared')
    expect(journal).toContain(`pid=${String(pid)}`)
  })
})

describe('state write the host consumes', () => {
  it('writes an atomic file the host reads back verbatim (producer/consumer round trip)', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    writeBaseline(repositoryRoot, { host: HOST_HASH, client: CLIENT_HASH })
    const runStampCli = vi.fn(async (): Promise<readonly CurrentStamp[]> => [
      { repository: repositoryRoot, kind: 'harness', host: HOST_HASH, client: CLIENT_HASH },
    ])
    const collected = await computeJudgment({ repositoryRoot, dshHome, registryQuery: () => '', runStampCli })
    const path = join(dshHome, RESTART_SIGNAL_STATE_FILE)
    writeStateFile(path, collected)
    // No half-written temp file survives the rename.
    expect(existsSync(`${path}.tmp-${String(process.pid)}`)).toBe(false)
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(onDisk.schema).toBe(RESTART_SIGNAL_STATE_SCHEMA)
    expect(onDisk.collectedAt).toBe(collected.collectedAt)
    expect(Number.isFinite(Date.parse(String(onDisk.collectedAt)))).toBe(true)
    // The host's own reader answers the very judgment the collector judged.
    const served = await collectRestartSignal({ dshHome })
    expect(served.state).toBe(collected.judgment.state)
    expect(served.detail).toBe(collected.judgment.detail)
    expect(served.facts?.configStamp).toBe(collected.judgment.facts?.configStamp)
    resetRestartSignalForTest()
  })

  it('keeps a stale collector file from ever being served (the host freshness bound reads this mtime)', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    const collected: CollectedState = {
      collectedAt: new Date(Date.now() - STATE_FRESH_MS - 60_000).toISOString(),
      repositoryRoot,
      judgment: { state: 'OK', detail: 'ancient' },
    }
    const path = join(dshHome, RESTART_SIGNAL_STATE_FILE)
    writeStateFile(path, collected)
    // The freshness bound keys on mtime (the host never trusts wall-clock
    // claims inside the body): backdate it the way an old collection ages.
    const backdated = new Date(Date.now() - STATE_FRESH_MS - 60_000)
    utimesSync(path, backdated, backdated)
    await expect(collectRestartSignal({ dshHome })).rejects.toThrow('state file stale')
    resetRestartSignalForTest()
  })

  it('journals one loud line per run (the failure channel a scheduler console cannot carry)', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'signal-collect-journal-'))
    temporary.push(dshHome)
    writeRunJournal(dshHome, 'FAIL runtime capture absent: test')
    const journal = readFileSync(join(dshHome, 'restart-signal-collect.log'), 'utf8')
    expect(journal).toContain('FAIL runtime capture absent: test')
  })

  it('pins the registration contract the live readout verifies against', () => {
    expect(COLLECT_TASK_NAME).toBe('DSH-Restart-Signal-Collect')
    expect(COLLECT_TASK_MINUTES).toBe(1)
  })
})
