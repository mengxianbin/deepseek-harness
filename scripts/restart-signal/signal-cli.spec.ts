/**
 * Stamp CLI: spec parsing, the persisted face-path cache keyed by the
 * source-structural signature, and kind-selected stamps — plus one real
 * end-to-end spawn against a throwaway repository.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cachedFacePathSets, facePathsSignature, parseStampArgs, stampRepository } from './signal-cli.ts'

const temporary: string[] = []

function git(root: string, args: readonly string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
}

function fixtureRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-signal-cli-'))
  temporary.push(root)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(root, '.gitignore'), '.dsh-build/\n')
  writeFileSync(join(root, 'tsconfig.host.json'), '{"include":["src/host/**/*.ts"]}\n')
  writeFileSync(join(root, 'tsconfig.client.json'), '{"include":["src/client/**/*.ts"]}\n')
  writeFileSync(join(root, 'src-host-placeholder.txt'), 'kept for the root\n')
  git(root, ['init'])
  git(root, ['add', '.'])
  git(root, ['-c', 'user.name=stamp-fixture', '-c', 'user.email=stamp@fixture.invalid', 'commit', '-m', 'fixture'])
  return root
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('stamp CLI', () => {
  it('parses repeated --stamp pairs and rejects malformed specs', () => {
    expect(parseStampArgs(['--stamp', 'D:/a:harness', '--stamp', 'D:/b:dsh-web'])).toEqual([
      { repository: 'D:/a', kind: 'harness' },
      { repository: 'D:/b', kind: 'dsh-web' },
    ])
    expect(() => parseStampArgs(['--stamp', 'D:/a:wrong'])).toThrow(/--stamp/)
    expect(() => parseStampArgs([])).toThrow(/at least one/)
  })

  it('persists the face-path cache under the signature and rewrites it after a structural change', () => {
    const root = fixtureRepository()
    const first = cachedFacePathSets(root)
    const cachePath = join(root, '.dsh-build', 'face-paths.json')
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as { version: number; signature: string; host: string[] }
    expect(cache.version).toBe(1)
    expect(cache.signature).toBe(facePathsSignature(root))
    expect([...first.host].sort()).toEqual(cache.host)

    // A structural change (a new source file) flips the signature and refreshes the sets.
    writeFileSync(join(root, 'tsconfig-host-extra.txt'), 'x\n')
    git(root, ['add', '.'])
    git(root, ['-c', 'user.name=stamp-fixture', '-c', 'user.email=stamp@fixture.invalid', 'commit', '-m', 'extra'])
    const signature = facePathsSignature(root)
    const second = cachedFacePathSets(root)
    const rewritten = JSON.parse(readFileSync(cachePath, 'utf8')) as { signature: string }
    expect(rewritten.signature).toBe(signature)
    expect(second.host.size).toBe(first.host.size)
  })

  it('stamps by manifest kind: harness resolves faces, dsh-web stamps the whole tree', () => {
    const root = fixtureRepository()
    const harness = stampRepository({ repository: root, kind: 'harness' })
    expect(harness.host).toMatch(/^[0-9a-f]{64}$/)
    expect(harness.client).toMatch(/^[0-9a-f]{64}$/)
    const whole = stampRepository({ repository: root, kind: 'dsh-web' })
    expect(whole.host).toMatch(/^[0-9a-f]{64}$/)
    expect(whole.client).toBe('n/a')
  })

  it('answers parseable JSON over a real spawn', () => {
    const root = fixtureRepository()
    const cli = resolve(import.meta.dirname, 'signal-cli.ts')
    const result = spawnSync(process.execPath, [cli, '--stamp', `${root}:harness`], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout) as { stamps: { repository: string; kind: string; host: string }[] }
    expect(parsed.stamps).toHaveLength(1)
    expect(parsed.stamps[0]?.repository).toBe(root)
    expect(parsed.stamps[0]?.kind).toBe('harness')
    expect(parsed.stamps[0]?.host).toMatch(/^[0-9a-f]{64}$/)
  })
})
