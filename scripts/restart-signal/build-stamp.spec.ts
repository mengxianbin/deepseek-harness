/**
 * Build-stamp opening/closing steps over a throwaway git repository: the
 * manifest advances only the rebuilt face, `midBuildDirty` fires when a built
 * face's source moves between the two steps, a failed window never reaches
 * the closing step's manifest, the runner records a failure over the start
 * capture, and a face absent from the invocation carries
 * its previous baseline forward.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { beginBuild, endBuild } from './build-stamp.ts'
import { readFailedStamp, readHarnessManifest, readStartStamp, writeFailedStamp } from './manifest.ts'

const temporary: string[] = []

function git(root: string, args: readonly string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
}

function fixtureRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-build-stamp-'))
  temporary.push(root)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(root, '.gitignore'), '.dsh-build/\n')
  mkdirSync(join(root, 'src', 'host'), { recursive: true })
  mkdirSync(join(root, 'src', 'client'), { recursive: true })
  writeFileSync(join(root, 'tsconfig.host.json'), '{"include":["src/host/**/*.ts"]}\n')
  writeFileSync(join(root, 'tsconfig.client.json'), '{"include":["src/client/**/*.ts"]}\n')
  writeFileSync(join(root, 'src', 'host', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'src', 'client', 'b.ts'), 'export const b = 2\n')
  git(root, ['init'])
  git(root, ['add', '.'])
  git(root, ['-c', 'user.name=stamp-fixture', '-c', 'user.email=stamp@fixture.invalid', 'commit', '-m', 'fixture'])
  return root
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('build stamp closing step', () => {
  it('writes the manifest for the rebuilt face and flags a mid-build edit', () => {
    const root = fixtureRepository()
    beginBuild(root, ['host'])
    expect(readStartStamp(root)?.faces).toEqual(['host'])
    appendFileSync(join(root, 'src', 'host', 'a.ts'), '// edited during the build\n')
    endBuild(root)

    const manifest = readHarnessManifest(root)
    expect(manifest).toBeDefined()
    expect(manifest?.builtFaces).toEqual(['host'])
    expect(manifest?.midBuildDirty).toBe(true)
    expect(manifest?.hostFaceHash).toBe(manifest?.sStart.host)
    expect(manifest?.hostFaceHash).not.toBe(manifest?.sEnd.host)
    expect(manifest?.clientFaceHash).toBeNull()
    expect(readStartStamp(root)).toBeUndefined()
  })

  it('keeps the baseline untouched when the closing step never runs', () => {
    const root = fixtureRepository()
    beginBuild(root, ['host'])
    endBuild(root)
    const built = readHarnessManifest(root)

    beginBuild(root, ['host'])
    // A failed build simulates a vanished closing step: no manifest rewrite.
    expect(readStartStamp(root)).toBeDefined()
    expect(readHarnessManifest(root)).toEqual(built)
  })

  it('carries a previously built face forward and refreshes only the rebuilt one', () => {
    const root = fixtureRepository()
    beginBuild(root, ['client'])
    endBuild(root)
    const clientBuilt = readHarnessManifest(root)
    expect(clientBuilt?.clientFaceHash).toBe(clientBuilt?.sStart.client)
    expect(clientBuilt?.hostFaceHash).toBeNull()

    appendFileSync(join(root, 'src', 'host', 'a.ts'), '// host-only change\n')
    beginBuild(root, ['host'])
    endBuild(root)
    const hostBuilt = readHarnessManifest(root)
    expect(hostBuilt).toBeDefined()
    expect(hostBuilt?.hostFaceHash).toBe(hostBuilt?.sStart.host)
    expect(hostBuilt?.clientFaceHash).toBe(clientBuilt?.clientFaceHash)
    expect(hostBuilt?.midBuildDirty).toBe(false)
  })
})

describe('build failure record', () => {
  it('records the failure over the start capture and clears it on the next opening step', () => {
    const root = fixtureRepository()
    beginBuild(root, ['host'])
    const start = readStartStamp(root)
    expect(start).toBeDefined()
    writeFailedStamp(root, {
      version: 1,
      kind: 'harness-failed',
      time: new Date().toISOString(),
      faces: start?.faces ?? [],
      sStart: start?.sStart ?? { repo: 'r', host: 'h', client: 'c' },
      exitCode: 7,
    })
    expect(readStartStamp(root)).toBeUndefined()
    expect(readFailedStamp(root)?.exitCode).toBe(7)
    expect(readHarnessManifest(root)).toBeUndefined()

    beginBuild(root, ['host'])
    expect(readFailedStamp(root)).toBeUndefined()
    expect(readStartStamp(root)).toBeDefined()
  })

  it('leaves a failure record and no manifest when the wrapped command exits non-zero', () => {
    const root = fixtureRepository()
    const runner = resolve(import.meta.dirname, 'build-stamp.ts')
    const result = spawnSync(process.execPath, [runner, 'run', '--faces', 'host', '--root', root, '--', 'exit 3'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(result.status).toBe(3)
    expect(readStartStamp(root)).toBeUndefined()
    expect(readFailedStamp(root)?.exitCode).toBe(3)
    expect(readHarnessManifest(root)).toBeUndefined()
  })
})
