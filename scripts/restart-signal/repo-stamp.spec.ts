/**
 * Source stamps over a throwaway git repository: a face stamp moves only
 * when its own face's content moves (the client-only restart rule's
 * foundation), and the whole-repository stamp — the dsh-web runner's mirror
 * semantics — moves on any tracked or untracked change while ignored files
 * stay out of both.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { faceContentStamp, repoStateStamp, wholeRepoContentStamp } from './repo-stamp.ts'

const temporary: string[] = []

function git(root: string, args: readonly string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
}

function fixtureRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repo-stamp-'))
  temporary.push(root)
  writeFileSync(join(root, '.gitignore'), '.dsh-build/\nignored.txt\n')
  writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'b.ts'), 'export const b = 2\n')
  git(root, ['init'])
  git(root, ['add', '.'])
  git(root, ['-c', 'user.name=stamp-fixture', '-c', 'user.email=stamp@fixture.invalid', 'commit', '-m', 'fixture'])
  return root
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('source stamps', () => {
  it('keeps a face stamp stable when the other face moves', () => {
    const root = fixtureRepository()
    const hostFace = new Set(['a.ts'])
    const before = faceContentStamp(root, hostFace)
    appendFileSync(join(root, 'b.ts'), '// client-face edit\n')
    expect(faceContentStamp(root, hostFace)).toBe(before)
    appendFileSync(join(root, 'a.ts'), '// host-face edit\n')
    expect(faceContentStamp(root, hostFace)).not.toBe(before)
  })

  it('moves the whole-repository stamp on untracked changes but not on ignored files', () => {
    const root = fixtureRepository()
    const before = wholeRepoContentStamp(root)
    writeFileSync(join(root, 'ignored.txt'), 'ignored\n')
    expect(wholeRepoContentStamp(root)).toBe(before)
    writeFileSync(join(root, 'notes.txt'), 'untracked\n')
    expect(wholeRepoContentStamp(root)).not.toBe(before)
  })

  it('agrees with the face stamp when the face covers the whole tree', () => {
    const root = fixtureRepository()
    writeFileSync(join(root, 'c.ts'), 'export const c = 3\n')
    const all = new Set(['.gitignore', 'a.ts', 'b.ts', 'c.ts'])
    // The whole-repo stamp hashes every path git knows; a face set naming
    // exactly those paths must produce the identical digest.
    expect(wholeRepoContentStamp(root)).toBe(faceContentStamp(root, all))
  })

  it('detects a repo-level change through the repo stamp', () => {
    const root = fixtureRepository()
    const before = repoStateStamp(root)
    appendFileSync(join(root, 'a.ts'), '// edit\n')
    expect(repoStateStamp(root)).not.toBe(before)
  })
})
