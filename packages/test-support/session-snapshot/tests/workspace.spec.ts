import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureExpectedWorkspaceSnapshot,
  captureWorkspaceSnapshot,
  EMPTY_WORKSPACE_MARKER,
} from '../src/workspace.ts'

describe('workspace snapshots', () => {
  const roots: string[] = []

  async function root(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), 'dsh-workspace-snapshot-'))
    roots.push(value)
    return value
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('captures readable text, binary bytes, links, and empty directories in path order', async (ctx) => {
    const directory = await root()
    await writeFile(join(directory, 'a.txt'), 'hello\n')
    await writeFile(join(directory, 'b.bin'), Buffer.from([0xff, 0x01]))
    await mkdir(join(directory, 'empty'))
    try {
      await symlink('a.txt', join(directory, 'link'))
    } catch (error) {
      // This case pins symlink DETECTION, so only a real symlink proves it. On a
      // non-elevated Windows session (no SeCreateSymbolicLinkPrivilege, Developer
      // Mode off) the kernel refuses creation with EPERM; skip loudly rather than
      // report a machine-privilege gap as a regression.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      ctx.skip('symlink creation requires elevation or Developer Mode on this session')
      return
    }

    expect(await captureWorkspaceSnapshot(directory)).toEqual([
      { path: 'a.txt', kind: 'text', content: 'hello\n' },
      { path: 'b.bin', kind: 'binary', base64: '/wE=' },
      { path: 'empty', kind: 'empty-directory' },
      { path: 'link', kind: 'symlink', target: 'a.txt' },
    ])
  })

  it('keeps generic marker files but omits declared runtime roots and the expected-empty marker', async () => {
    const directory = await root()
    await mkdir(join(directory, '.dsh'))
    await writeFile(join(directory, '.dsh', 'runtime.json'), '{}')
    await writeFile(join(directory, EMPTY_WORKSPACE_MARKER), '')
    await writeFile(join(directory, 'visible.txt'), 'visible')

    expect(await captureWorkspaceSnapshot(directory, { ignoredRootEntries: ['.dsh'] })).toEqual([
      { path: '.empty', kind: 'text', content: '' },
      { path: 'visible.txt', kind: 'text', content: 'visible' },
    ])
    expect(await captureExpectedWorkspaceSnapshot(directory)).toEqual([
      { path: '.dsh/runtime.json', kind: 'text', content: '{}' },
      { path: 'visible.txt', kind: 'text', content: 'visible' },
    ])
  })

  it('treats NUL-bearing UTF-8 as binary workspace state', async () => {
    const directory = await root()
    await writeFile(join(directory, 'nul.bin'), Buffer.from([0x61, 0x00, 0x62]))
    expect(await captureWorkspaceSnapshot(directory)).toEqual([
      { path: 'nul.bin', kind: 'binary', base64: 'YQBi' },
    ])
  })
})
