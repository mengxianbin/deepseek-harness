/**
 * Restart-signal runtime stamp (R): the process-start read over per-tree build
 * manifests — `INIT` while any in-scope manifest is missing, one combined
 * host face hash plus an S_cfg snapshot once every manifest exists, and the
 * capability gate that keeps stamp-less linked repositories out of scope.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeConfigStamp, linkedStampRepositories, readRestartStamp } from '../src/restart-stamp.ts'

const temporary: string[] = []

function fixtureRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporary.push(root)
  return root
}

function makeStampCapableRepository(prefix: string): string {
  const repository = fixtureRoot(prefix)
  mkdirSync(join(repository, '.git'))
  mkdirSync(join(repository, 'scripts', 'restart-signal'), { recursive: true })
  writeFileSync(join(repository, 'scripts', 'restart-signal', 'build-stamp.ts'), '')
  return repository
}

function writeManifest(repository: string, hostFaceHash: string): void {
  mkdirSync(join(repository, '.dsh-build'), { recursive: true })
  const manifest = {
    version: 1,
    kind: 'harness',
    time: '2026-10-24T00:00:00.000Z',
    sStartTime: '2026-10-24T00:00:00.000Z',
    builtFaces: ['host'],
    midBuildDirty: false,
    hostFaceHash,
    clientFaceHash: null,
    sStart: { repo: 'r', host: hostFaceHash, client: 'c' },
    sEnd: { repo: 'r', host: hostFaceHash, client: 'c' },
  }
  writeFileSync(join(repository, '.dsh-build', 'restart-stamp.json'), JSON.stringify(manifest))
}

function writeProfileLink(dshHome: string, profile: string, linkTarget: string): void {
  mkdirSync(join(dshHome, 'profiles', profile), { recursive: true })
  writeFileSync(
    join(dshHome, 'profiles', profile, 'package.json'),
    JSON.stringify({ name: 'fixture-profile', dependencies: { 'fixture-plugin': `link:${linkTarget}` } }),
  )
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('restart stamp read', () => {
  it('reads INIT when the harness manifest is missing', () => {
    const repositoryRoot = fixtureRoot('dsh-restart-stamp-')
    const dshHome = fixtureRoot('dsh-restart-stamp-home-')
    const stamp = readRestartStamp({ repositoryRoot, dshHome, registryQuery: () => '' })
    expect(stamp.state).toBe('INIT')
    expect(stamp.hostFaceHash).toBeUndefined()
    expect(stamp.reasons).toHaveLength(1)
    expect(stamp.reasons[0]).toContain('harness manifest missing')
    expect(stamp.sCfg).toMatch(/^[0-9a-f]{64}$/)
  })

  it('combines every in-scope manifest into one host face hash at BASELINE', () => {
    const repositoryRoot = fixtureRoot('dsh-restart-stamp-')
    const dshHome = fixtureRoot('dsh-restart-stamp-home-')
    const linked = makeStampCapableRepository('dsh-restart-stamp-linked-')
    writeManifest(repositoryRoot, 'a'.repeat(64))
    writeManifest(linked, 'b'.repeat(64))
    writeProfileLink(dshHome, 'web', linked)
    // A linked repository without the stamp machinery stays out of scope.
    const foreign = fixtureRoot('dsh-restart-stamp-foreign-')
    mkdirSync(join(foreign, '.git'))
    writeProfileLink(dshHome, 'headless', foreign)

    const first = readRestartStamp({ repositoryRoot, dshHome, registryQuery: () => '' })
    const second = readRestartStamp({ repositoryRoot, dshHome, registryQuery: () => '' })
    expect(first.state).toBe('BASELINE')
    expect(first.reasons).toEqual([])
    expect(first.components).toHaveLength(2)
    expect(first.hostFaceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(second.hostFaceHash).toBe(first.hostFaceHash)
  })

  it('reports INIT when a stamp-capable linked repository has no manifest yet', () => {
    const repositoryRoot = fixtureRoot('dsh-restart-stamp-')
    const dshHome = fixtureRoot('dsh-restart-stamp-home-')
    const linked = makeStampCapableRepository('dsh-restart-stamp-linked-')
    writeManifest(repositoryRoot, 'a'.repeat(64))
    writeProfileLink(dshHome, 'web', linked)

    expect(linkedStampRepositories(dshHome)).toEqual([linked])
    const stamp = readRestartStamp({ repositoryRoot, dshHome, registryQuery: () => '' })
    expect(stamp.state).toBe('INIT')
    expect(stamp.reasons.some(reason => reason.startsWith('linked manifest missing'))).toBe(true)

    writeManifest(linked, 'b'.repeat(64))
    const built = readRestartStamp({ repositoryRoot, dshHome, registryQuery: () => '' })
    expect(built.state).toBe('BASELINE')
    expect(built.components).toHaveLength(2)
  })
})

describe('config stamp', () => {
  it('changes with profile configuration content and with a fixed environment key', () => {
    const dshHome = fixtureRoot('dsh-restart-stamp-cfg-')
    mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true })
    const profileFile = join(dshHome, 'profiles', 'web', 'cordis.yml')
    writeFileSync(profileFile, '[]\n')
    const base = computeConfigStamp(dshHome, '')
    expect(base).toMatch(/^[0-9a-f]{64}$/)

    writeFileSync(profileFile, '[plugin]\n')
    expect(computeConfigStamp(dshHome, '')).not.toBe(base)
    expect(computeConfigStamp(dshHome, '    DSH_HOME    REG_SZ    D:\\somewhere')).not.toBe(base)
  })
})

describe('component parsing', () => {
  it('ignores unreadable manifests instead of throwing', () => {
    const repositoryRoot = fixtureRoot('dsh-restart-stamp-broken-')
    mkdirSync(join(repositoryRoot, '.dsh-build'), { recursive: true })
    writeFileSync(join(repositoryRoot, '.dsh-build', 'restart-stamp.json'), '{not json')
    const stamp = readRestartStamp({ repositoryRoot, dshHome: fixtureRoot('dsh-restart-stamp-none-'), registryQuery: () => '' })
    expect(stamp.state).toBe('INIT')
    expect(stamp.components).toHaveLength(0)
  })
})
