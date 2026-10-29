/**
 * `--explain`: baseline read (and its failure mode), the two git layers'
 * record parsing, the layer-union rule, face filtering with per-face package
 * grouping — plus a real CLI spawn against a throwaway repository.
 *
 * The fixture pins one deterministic window: baseline-state commits carry a
 * commit date before the baseline instant, change commits one after it, so
 * `git log --since` never depends on the machine's clock.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  committedChanges,
  explainTree,
  readBaseline,
  unionChanges,
  workingChanges,
  type ExplainedChange,
  type TreeExplanation,
} from './explain.ts'
import { resolveFacePathSets } from './face-paths.ts'
import { writeHarnessManifest, type HarnessManifest } from './manifest.ts'

/** Window edge; baseline-state commits land 60s before it, change commits 60s after. */
const BASELINE = '2026-01-01T00:00:00.000Z'
const BEFORE = '2025-12-31T23:59:00Z'
const AFTER = '2026-01-01T00:01:00Z'

const temporary: string[] = []

function git(root: string, args: readonly string[], commitDate?: string): void {
  const env = commitDate === undefined
    ? process.env
    : { ...process.env, GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate }
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore', env })
}

function stage(root: string): void {
  git(root, ['add', '-A'])
}

function commit(root: string, message: string, date: string): void {
  git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-m', message], date)
}

function writeManifest(root: string): void {
  const hashes = { repo: '1'.repeat(64), host: '2'.repeat(64), client: '3'.repeat(64) }
  const manifest: HarnessManifest = {
    version: 1,
    kind: 'harness',
    time: BASELINE,
    sStartTime: '2025-12-31T23:58:00.000Z',
    builtFaces: ['host', 'client'],
    midBuildDirty: false,
    hostFaceHash: '2'.repeat(64),
    clientFaceHash: '3'.repeat(64),
    sStart: hashes,
    sEnd: hashes,
  }
  writeHarnessManifest(root, manifest)
}

/**
 * Fixture repository: `pkg-a` (host+client), `pkg-b` (host only), `root-src`
 * (host only), `docs` (no face). With `withBaseline` the manifest is written
 * between the baseline-state commit and the change commits; the working tree
 * then keeps four uncommitted changes on top.
 */
function fixtureRepository(withBaseline: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-explain-'))
  temporary.push(root)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  writeFileSync(join(root, '.gitignore'), '.dsh-build/\n')
  writeFileSync(join(root, 'tsconfig.host.json'), '{"include":["packages/pkg-a/src/**/*.ts","packages/pkg-b/src/**/*.ts","root-src/**/*.ts"]}\n')
  writeFileSync(join(root, 'tsconfig.client.json'), '{"include":["packages/pkg-a/src/**/*.ts"]}\n')
  mkdirSync(join(root, 'packages', 'pkg-a', 'src'), { recursive: true })
  mkdirSync(join(root, 'packages', 'pkg-b', 'src'), { recursive: true })
  mkdirSync(join(root, 'root-src'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'packages', 'pkg-a', 'package.json'), '{"name":"pkg-a"}\n')
  writeFileSync(join(root, 'packages', 'pkg-b', 'package.json'), '{"name":"pkg-b"}\n')
  writeFileSync(join(root, 'packages', 'pkg-a', 'src', 'keep.ts'), 'export const keep = 1\n')
  writeFileSync(join(root, 'packages', 'pkg-a', 'src', 'touched.ts'), 'export const touched = 1\n')
  writeFileSync(join(root, 'packages', 'pkg-b', 'src', 'host-only.ts'), 'export const host = 1\n')
  writeFileSync(join(root, 'root-src', 'root.ts'), 'export const rootFile = 1\n')
  writeFileSync(join(root, 'docs', 'readme.md'), '# docs\n')
  git(root, ['init'])
  stage(root)
  commit(root, 'fixture baseline state', BEFORE)
  if (withBaseline) writeManifest(root)

  // Committed after the baseline: modified (both faces), added (both faces),
  // modified (host only), modified (no face), renamed (host only).
  writeFileSync(join(root, 'packages', 'pkg-a', 'src', 'keep.ts'), 'export const keep = 2\n')
  stage(root)
  commit(root, 'modify keep', AFTER)
  writeFileSync(join(root, 'packages', 'pkg-a', 'src', 'new.ts'), 'export const added = 1\n')
  stage(root)
  commit(root, 'add new', AFTER)
  writeFileSync(join(root, 'packages', 'pkg-b', 'src', 'host-only.ts'), 'export const host = 2\n')
  stage(root)
  commit(root, 'modify host-only', AFTER)
  writeFileSync(join(root, 'docs', 'readme.md'), '# docs edited\n')
  stage(root)
  commit(root, 'edit docs', AFTER)
  git(root, ['mv', 'root-src/root.ts', 'root-src/root-renamed.ts'])
  commit(root, 'rename root file', AFTER)

  // Uncommitted: a plain edit, a further edit of the committed add (the
  // structural claim must survive), an untracked file, and a staged rename.
  writeFileSync(join(root, 'packages', 'pkg-a', 'src', 'touched.ts'), 'export const touched = 2\n')
  writeFileSync(join(root, 'packages', 'pkg-a', 'src', 'new.ts'), 'export const added = 2\n')
  writeFileSync(join(root, 'packages', 'pkg-a', 'src', 'untracked.ts'), 'export const fresh = 1\n')
  git(root, ['mv', 'packages/pkg-b/src/host-only.ts', 'packages/pkg-b/src/host-renamed.ts'])
  return root
}

/** Order-independent rendering: byte order by path, then by change kind. */
function sorted(changes: readonly ExplainedChange[]): ExplainedChange[] {
  return [...changes].sort((a, b) =>
    a.path === b.path
      ? a.change < b.change
        ? -1
        : a.change > b.change
          ? 1
          : 0
      : a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : 0)
}

const PKG_A_CHANGES = [
  { path: 'packages/pkg-a/src/keep.ts', change: 'modified' },
  { path: 'packages/pkg-a/src/new.ts', change: 'added' },
  { path: 'packages/pkg-a/src/touched.ts', change: 'modified' },
  { path: 'packages/pkg-a/src/untracked.ts', change: 'added' },
]

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('--explain', () => {
  it('reads the baseline window and rejects a tree without a manifest', { timeout: 20_000 }, () => {
    const root = fixtureRepository(true)
    expect(readBaseline(root, 'harness')).toEqual({ time: BASELINE, builtFaces: ['host', 'client'] })
    const bare = mkdtempSync(join(tmpdir(), 'dsh-explain-bare-'))
    temporary.push(bare)
    expect(() => readBaseline(bare, 'harness')).toThrow(/no readable harness baseline manifest/)
  })

  it('parses committed changes since the baseline, splitting a rename into both paths', { timeout: 20_000 }, () => {
    const root = fixtureRepository(true)
    expect(sorted(committedChanges(root, BASELINE))).toEqual([
      { path: 'docs/readme.md', change: 'modified' },
      { path: 'packages/pkg-a/src/keep.ts', change: 'modified' },
      { path: 'packages/pkg-a/src/new.ts', change: 'added' },
      { path: 'packages/pkg-b/src/host-only.ts', change: 'modified' },
      { path: 'root-src/root-renamed.ts', change: 'added' },
      { path: 'root-src/root.ts', change: 'deleted' },
    ])
  })

  it('parses working-tree porcelain records, -z rename field order included', { timeout: 20_000 }, () => {
    const root = fixtureRepository(true)
    expect(sorted(workingChanges(root))).toEqual([
      { path: 'packages/pkg-a/src/new.ts', change: 'modified' },
      { path: 'packages/pkg-a/src/touched.ts', change: 'modified' },
      { path: 'packages/pkg-a/src/untracked.ts', change: 'added' },
      { path: 'packages/pkg-b/src/host-only.ts', change: 'deleted' },
      { path: 'packages/pkg-b/src/host-renamed.ts', change: 'added' },
    ])
  })

  it('unions the layers with structural claims surviving plain modifications', () => {
    expect(unionChanges(
      [{ path: 'kept.ts', change: 'modified' }, { path: 'recreated.ts', change: 'modified' }, { path: 'gone.ts', change: 'added' }],
      [{ path: 'kept.ts', change: 'modified' }, { path: 'recreated.ts', change: 'added' }, { path: 'gone.ts', change: 'deleted' }],
    )).toEqual(new Map([
      ['kept.ts', 'modified'],
      ['recreated.ts', 'added'],
      ['gone.ts', 'deleted'],
    ]))
    // Status says modified where the log already claims structure: the log claim stands.
    expect(unionChanges([{ path: 'added-then-touched.ts', change: 'added' }], [{ path: 'added-then-touched.ts', change: 'modified' }]))
      .toEqual(new Map([['added-then-touched.ts', 'added']]))
  })

  it('groups face-filtered changes by package under the baseline', { timeout: 20_000 }, () => {
    const root = fixtureRepository(true)
    const explanation = explainTree(root, 'harness', readBaseline(root, 'harness'), resolveFacePathSets(root))
    expect(explanation).toMatchObject({
      repository: root,
      kind: 'harness',
      baselineTime: BASELINE,
      builtFaces: ['host', 'client'],
    })
    // `docs/readme.md` has no face and drops; the deleted halves (root.ts,
    // host-only.ts) fall out with the disk-resolved face sets — both exactly
    // as the manual comparison's face filter drops them.
    expect(explanation.faces.host).toEqual([
      { package: '.', changes: [{ path: 'root-src/root-renamed.ts', change: 'added' }] },
      { package: 'packages/pkg-a', changes: PKG_A_CHANGES },
      { package: 'packages/pkg-b', changes: [{ path: 'packages/pkg-b/src/host-renamed.ts', change: 'added' }] },
    ])
    expect(explanation.faces.client).toEqual([
      { package: 'packages/pkg-a', changes: PKG_A_CHANGES },
    ])
  })

  it('answers a real spawn with baseline time and per-face package lists', { timeout: 20_000 }, () => {
    const root = fixtureRepository(true)
    const cli = resolve(import.meta.dirname, 'signal-cli.ts')
    const result = spawnSync(process.execPath, [cli, '--explain', '--stamp', `${root}:harness`], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout) as { explanations: TreeExplanation[] }
    expect(parsed.explanations).toHaveLength(1)
    const explanation = parsed.explanations[0]
    expect(explanation?.baselineTime).toBe(BASELINE)
    expect(explanation?.builtFaces).toEqual(['host', 'client'])
    expect(explanation?.faces.host.map(group => group.package)).toEqual(['.', 'packages/pkg-a', 'packages/pkg-b'])
    expect(explanation?.faces.client.map(group => group.package)).toEqual(['packages/pkg-a'])
  })

  it('fails a spawn against a tree without a baseline manifest', { timeout: 20_000 }, () => {
    const root = fixtureRepository(false)
    const cli = resolve(import.meta.dirname, 'signal-cli.ts')
    const result = spawnSync(process.execPath, [cli, '--explain', '--stamp', `${root}:harness`], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no readable harness baseline manifest')
  })
})
