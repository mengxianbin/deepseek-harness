/**
 * Restart-signal state machine: the pure seven-state judgment (precedence,
 * restart branches, the client-only informational state, and the
 * conservative degradation when stamps are unavailable) plus the async
 * collect — manifest/config/marker reads, the coalescing single-flight, the
 * combination mirror that must stay equal to the runtime stamp's own hash,
 * and one real stamp-CLI spawn end to end.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  combineHostFace,
  collectRestartSignal,
  judgeRestartSignal,
  resetRestartSignalForTest,
  type CurrentStamp,
  type RestartSignalInputs,
} from '../src/restart-signal.ts'
import { resetRestartStampForTest } from '../src/restart-stamp.ts'
import { writeHarnessManifest } from '../../../../scripts/restart-signal/manifest.ts'
import { stampRepository } from '../../../../scripts/restart-signal/signal-cli.ts'

const HOST_HASH = 'a'.repeat(64)
const CLIENT_HASH = 'b'.repeat(64)

/** One judgment's full input with sane baseline defaults; overrides name the case. */
function inputs(overrides: Partial<RestartSignalInputs> = {}): RestartSignalInputs {
  const runtimeStamp = {
    state: 'BASELINE' as const, reasons: [], hostFaceHash: HOST_HASH, sCfg: 'cfg-1',
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

/** Throwaway directories for one collect test: a manifest tree and a DSH home. */
const temporary: string[] = []

function fixtureTree(): { repositoryRoot: string; dshHome: string } {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'dsh-restart-signal-repo-'))
  temporary.push(repositoryRoot)
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-restart-signal-home-'))
  temporary.push(dshHome)
  return { repositoryRoot, dshHome }
}

/** Write a clean single-build baseline whose face hashes are the given hexes. */
function writeBaseline(repositoryRoot: string, faces: { host: string; client: string | null }): void {
  const shared = { repo: 'r', host: faces.host, client: faces.client ?? CLIENT_HASH }
  writeHarnessManifest(repositoryRoot, {
    version: 1,
    kind: 'harness',
    time: '2026-10-25T00:00:00.000Z',
    sStartTime: '2026-10-25T00:00:00.000Z',
    builtFaces: faces.client === null ? ['host'] : ['host', 'client'],
    midBuildDirty: false,
    hostFaceHash: faces.host,
    clientFaceHash: faces.client,
    sStart: shared,
    sEnd: shared,
  })
}

afterEach(() => {
  resetRestartSignalForTest()
  resetRestartStampForTest()
  vi.restoreAllMocks()
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('collectRestartSignal', () => {
  it('answers INIT without spawning the stamp CLI', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    const runStampCli = vi.fn()
    const judgment = await collectRestartSignal({ repositoryRoot, dshHome, registryQuery: () => '', runStampCli })
    expect(judgment.state).toBe('INIT')
    expect(runStampCli).not.toHaveBeenCalled()
  })

  it('answers OK when current stamps equal the baseline, through the runtime combination mirror', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    writeBaseline(repositoryRoot, { host: HOST_HASH, client: CLIENT_HASH })
    const runStampCli = vi.fn(async (): Promise<readonly CurrentStamp[]> => [
      { repository: repositoryRoot, kind: 'harness', host: HOST_HASH, client: CLIENT_HASH },
    ])
    // The cached runtime stamp and the fresh read share one capture here; the
    // combination mirror is pinned by the OK outcome: a format drift between
    // combineHostFace and the runtime stamp's own hash would surface as
    // NEED_RESTART instead.
    const judgment = await collectRestartSignal({ repositoryRoot, dshHome, registryQuery: () => '', runStampCli })
    expect(judgment.state).toBe('OK')
  })

  it('reports NEED_RESTART on the config branch when the configuration moved since process start', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    writeBaseline(repositoryRoot, { host: HOST_HASH, client: null })
    // The registry answers differently per read, in real `reg query` line
    // shape: the process-start capture snapshots the old value, the fresh
    // read sees the changed one.
    let reads = 0
    const registryQuery = (): string => {
      reads += 1
      const value = reads === 1 ? 'old-home' : 'new-home'
      return `\n    HKEY_CURRENT_USER\\Environment\n        DSH_HOME    REG_SZ    ${value}\n`
    }
    const runStampCli = vi.fn(async (): Promise<readonly CurrentStamp[]> => [
      { repository: repositoryRoot, kind: 'harness', host: HOST_HASH, client: CLIENT_HASH },
    ])
    const judgment = await collectRestartSignal({ repositoryRoot, dshHome, registryQuery, runStampCli })
    expect(judgment.state).toBe('NEED_RESTART')
    expect(judgment.reason).toBe('config')
  })

  it('coalesces concurrent rechecks into one in-flight computation', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    let resolveCli: ((stamps: readonly CurrentStamp[]) => void) | undefined
    const runStampCli = vi.fn(() => new Promise<readonly CurrentStamp[]>((resolve) => { resolveCli = resolve }))
    writeBaseline(repositoryRoot, { host: HOST_HASH, client: null })
    const options = { repositoryRoot, dshHome, registryQuery: () => '', runStampCli }
    const first = collectRestartSignal(options)
    const second = collectRestartSignal(options)
    resolveCli?.([{ repository: repositoryRoot, kind: 'harness', host: HOST_HASH, client: CLIENT_HASH }])
    const [a, b] = await Promise.all([first, second])
    expect(runStampCli).toHaveBeenCalledTimes(1)
    expect(a.state).toBe('OK')
    expect(b.state).toBe('OK')
  })

  it('degrades to NEED_BUILD with one stderr line when the stamp CLI fails', async () => {
    const { repositoryRoot, dshHome } = fixtureTree()
    writeBaseline(repositoryRoot, { host: HOST_HASH, client: null })
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const judgment = await collectRestartSignal({
      repositoryRoot,
      dshHome,
      registryQuery: () => '',
      runStampCli: vi.fn(async () => { throw new Error('git exploded') }),
    })
    expect(judgment.state).toBe('NEED_BUILD')
    expect(judgment.detail).toContain('unavailable')
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
    // The production gatherer spawns the real CLI from this module's own
    // harness tree against the fixture components: one true end-to-end path.
    const judgment = await collectRestartSignal({ repositoryRoot, dshHome, registryQuery: () => '' })
    expect(judgment.state).toBe('OK')
  })
})
