import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveLinkedPath } from '../src/index.ts'

/**
 * `resolveLinkedPath` reads through a symlink or a Windows junction whose
 * target is a file — the shape m-note's `~/.dsh/*.yml → <repo>/.dsh/*.yml`
 * links take, which native `readFileSync` reports as ENOENT.
 *
 * Real links cover the absolute, dangling, and pass-through branches without
 * privilege: `symlink(target, path, 'junction')` needs no admin on Windows,
 * while an ordinary file symlink does (this machine: EPERM). The relative
 * branch cannot be built for real here either — libuv absolutizes a junction's
 * target at creation, so `readlink` never yields a relative path — it is
 * exercised through a scoped `node:fs` mock that delegates every non-virtual
 * path to the real implementation.
 */

/** Virtual stand-in paths for the relative-target branch; no real fs object occupies them. */
const RELATIVE_LINK = 'virtual/relcase/link.txt'
const RELATIVE_PEER = 'peer.txt'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const isVirtualLink = (path: unknown): boolean =>
    String(path).split('\\').join('/').endsWith(RELATIVE_LINK)
  const isVirtualPeer = (path: unknown): boolean =>
    String(path).split('\\').join('/').endsWith(`virtual/relcase/${RELATIVE_PEER}`)
  return {
    ...actual,
    lstatSync: ((path: never, ...rest: never[]) =>
      isVirtualLink(path)
        ? { isSymbolicLink: () => true }
        : (actual.lstatSync as (...args: never[]) => unknown)(path, ...rest)) as typeof actual.lstatSync,
    readlinkSync: ((path: never, ...rest: never[]) =>
      isVirtualLink(path)
        ? RELATIVE_PEER
        : (actual.readlinkSync as (...args: never[]) => unknown)(path, ...rest)) as typeof actual.readlinkSync,
    existsSync: ((path: never) =>
      isVirtualPeer(path) || (actual.existsSync as (p: never) => boolean)(path)) as typeof actual.existsSync,
  }
})

const scratchDirs: string[] = []

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map(dir => rm(dir, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 20,
  })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-resolve-linked-path-'))
  scratchDirs.push(dir)
  return dir
}

describe('resolveLinkedPath', () => {
  it('passes a plain file through unchanged', async () => {
    const dir = await scratch()
    const file = join(dir, 'plain.txt')
    await writeFile(file, 'plain')
    expect(resolveLinkedPath(file)).toBe(file)
  })

  it('passes a missing path through instead of throwing', async () => {
    const dir = await scratch()
    const ghost = join(dir, 'ghost.txt')
    expect(resolveLinkedPath(ghost)).toBe(ghost)
  })

  it('resolves a junction whose target is an existing file', async () => {
    const dir = await scratch()
    const target = join(dir, 'target.txt')
    const link = join(dir, 'link.txt')
    await writeFile(target, 'payload')
    await symlink(target, link, 'junction')
    // The bug: opening the link itself is ENOENT on Windows...
    await expect(readFile(link, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    // ...while the resolved path reads through.
    expect(resolveLinkedPath(link)).toBe(target)
    await expect(readFile(resolveLinkedPath(link), 'utf8')).resolves.toBe('payload')
  })

  it('resolves a junction created from a relative target input (libuv absolutizes it)', async () => {
    const dir = await scratch()
    const target = join(dir, 'target.txt')
    const link = join(dir, 'link.txt')
    await writeFile(target, 'payload')
    await symlink('target.txt', link, 'junction')
    expect(resolveLinkedPath(link)).toBe(target)
  })

  it('keeps a dangling link on its own path so callers keep their ENOENT semantics', async () => {
    const dir = await scratch()
    const link = join(dir, 'dangling.txt')
    await symlink(join(dir, 'nope.txt'), link, 'junction')
    expect(resolveLinkedPath(link)).toBe(link)
  })

  it('resolves a relative readlink against the link directory', () => {
    // Virtual only: real junctions never store a relative target (asserted by
    // the relative-input test above), so the branch needs the scoped mock.
    expect(resolveLinkedPath(RELATIVE_LINK)).toBe(resolve(dirname(RELATIVE_LINK), RELATIVE_PEER))
  })
})
