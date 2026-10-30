/**
 * Restart-signal `--explain`: the package-level change list behind one tree's
 * build baseline — "what actually moved since the build this lamp reports".
 *
 * Baseline = the tree's own `.dsh-build/restart-stamp.json`: its `time` is the
 * window edge and `builtFaces` names the faces that build rebuilt. Two git
 * reads describe what moved after that instant:
 *
 * - `git log --since=<time> --name-status -z` — committed changes, under
 *   commit-date semantics: a commit older than the baseline never appears, and
 *   a merge commit contributes no entries of its own while each commit it
 *   merged in appears individually;
 * - `git status --porcelain -z` — staged / working-tree / untracked state now.
 *
 * The two layers union per path: a structural claim (added/deleted) from
 * either layer survives a plain modification from the other, and the
 * working-tree layer breaks ties between two structural claims — the list
 * reads as the tree's state now, measured against the baseline.
 *
 * Every path is then filtered through the face sets and reported only under
 * the face(s) whose set contains it, because a path in no face cannot move a
 * build baseline. The filter source is the same resolved sets the stamps use
 * (`cachedFacePathSets`, persisted in `.dsh-build/face-paths.json`), so this
 * output and a manual `git … | face-filter` comparison read identical sets.
 *
 * Cheap tier — an explicit git approximation, NOT a manifest-level per-file
 * exact diff set: the baseline manifest records content hashes, not path
 * lists, so "which files this build actually consumed" accounting belongs to
 * the design spec's manifest `changedPaths` tier (the precise-diff track).
 * Two known approximations follow, and both keep this output comparable with
 * the manual reading because that reading applies the same filter source:
 * a path deleted after the sets resolved falls out of the freshly resolved
 * set and drops from the list, and an untracked directory surfaces collapsed
 * as `dir/` and drops unless that bare directory path itself sits in a face.
 *
 * Paths group by owning package — the nearest ancestor directory holding a
 * `package.json`, repository-root files under `.` — each group sorted by path
 * and the groups sorted by name, so two runs over one state are identical.
 * For a `dsh-web` tree (whole-repository stamp, no faces) every path is
 * reported under `host` with no face filter, mirroring that stamp's scope.
 * @module scripts/restart-signal/explain
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { manifestPath, readHarnessManifest, type BuildFace } from './manifest.ts'

/** How one path changed relative to the baseline. */
export type ChangeKind = 'added' | 'modified' | 'deleted'

/** One changed path with its baseline-relative change kind. */
export interface ExplainedChange {
  /** Repository-relative slash-separated path as git reports it. */
  readonly path: string
  readonly change: ChangeKind
}

/** One owning package's grouped changes. */
export interface ExplainPackage {
  /** Nearest ancestor directory holding a `package.json`; `.` for repository-root files. */
  readonly package: string
  readonly changes: readonly ExplainedChange[]
}

/** The explain window: the manifest write time and the faces the build rebuilt. */
export interface Baseline {
  readonly time: string
  readonly builtFaces: readonly BuildFace[]
}

/** Resolved face sets as the stamp cache persists them; `undefined` = whole-repository (dsh-web) semantics. */
export type FaceSets =
  | { readonly host: ReadonlySet<string>; readonly client: ReadonlySet<string> }
  | undefined

/** One tree's explain output: baseline plus per-face package change lists. */
export interface TreeExplanation {
  readonly repository: string
  readonly kind: 'harness' | 'dsh-web'
  readonly baselineTime: string
  readonly builtFaces: readonly BuildFace[]
  readonly faces: {
    readonly host: readonly ExplainPackage[]
    readonly client: readonly ExplainPackage[]
  }
}

/** Buffer ceiling for git output on a long-running baseline window. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024

const MISSING_MANIFEST = (root: string, kind: string): Error =>
  new Error(`restart-signal: ${root}: no readable ${kind} baseline manifest (.dsh-build/restart-stamp.json)`)

function git(root: string, args: readonly string[]): Buffer {
  return execFileSync('git', ['-C', root, ...args], { maxBuffer: GIT_MAX_BUFFER })
}

function isBuildFace(value: unknown): value is BuildFace {
  return value === 'host' || value === 'client'
}

/**
 * Read one tree's build manifest as the explain baseline.
 * @param root - Repository tree whose `.dsh-build/restart-stamp.json` to read.
 * @param kind - Manifest kind that tree writes.
 * @returns The baseline window edge plus the faces the build rebuilt.
 * @throws If the manifest is absent, unreadable, or malformed — explain
 * without a baseline has no window to explain against.
 */
export function readBaseline(root: string, kind: 'harness' | 'dsh-web'): Baseline {
  if (kind === 'harness') {
    const manifest = readHarnessManifest(root)
    if (manifest === undefined) throw MISSING_MANIFEST(root, kind)
    return { time: manifest.time, builtFaces: manifest.builtFaces }
  }
  // dsh-web manifests share the file name but carry their own kind, so read
  // the two fields explain needs instead of the full harness validation.
  let record: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath(root), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      record = parsed as Record<string, unknown>
    }
  } catch {
    record = undefined
  }
  if (record === undefined || record.kind !== 'dsh-web' || typeof record.time !== 'string') {
    throw MISSING_MANIFEST(root, kind)
  }
  const builtFaces: readonly BuildFace[] =
    Array.isArray(record.builtFaces) && record.builtFaces.length > 0 && record.builtFaces.every(isBuildFace)
      ? record.builtFaces.filter(isBuildFace)
      : ['host']
  return { time: record.time, builtFaces }
}

/**
 * Committed changes whose commit date is after the baseline: parsed
 * `git log --since=<time> --name-status -z` records — `A`/`M`/`D` (and any
 * other status letter, read as modified) per path; a rename emits its source
 * as deleted and its destination as added; a copy only its destination.
 * @param root - Repository tree to read.
 * @param since - Baseline time, an ISO 8601 instant git accepts.
 * @returns Change records in git's output order.
 */
export function committedChanges(root: string, since: string): ExplainedChange[] {
  const tokens = git(root, ['log', `--since=${since}`, '--name-status', '-z', '--format=']).toString('utf8').split('\0')
  const changes: ExplainedChange[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index]
    if (status === undefined || status === '') continue
    const first = tokens[index + 1]
    if (status.startsWith('R') || status.startsWith('C')) {
      const second = tokens[index + 2]
      index += 2
      if (first === undefined || second === undefined) break
      if (status.startsWith('R')) changes.push({ path: first, change: 'deleted' })
      changes.push({ path: second, change: 'added' })
      continue
    }
    index += 1
    if (first === undefined) break
    changes.push({
      path: first,
      change: status.startsWith('A') ? 'added' : status.startsWith('D') ? 'deleted' : 'modified',
    })
  }
  return changes
}

/**
 * Working-tree changes now: parsed `git status --porcelain -z` records — `??`
 * and index adds read as added, any `D` column as deleted, everything else as
 * modified. A staged rename/copy carries its destination in the status token
 * and its source in the next NUL field (git's `-z` field order differs from
 * the plain `src -> dst` line), so a rename emits the source as deleted and
 * the destination as added.
 * @param root - Repository tree to read.
 * @returns Change records in git's output order.
 */
export function workingChanges(root: string): ExplainedChange[] {
  const tokens = git(root, ['status', '--porcelain', '-z']).toString('utf8').split('\0')
  const changes: ExplainedChange[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined || token === '') continue
    const status = token.slice(0, 2)
    const path = token.slice(3)
    if (status.includes('R') || status.includes('C')) {
      const source = tokens[index + 1]
      index += 1
      if (source === undefined) break
      if (status.includes('R')) changes.push({ path: source, change: 'deleted' })
      changes.push({ path, change: 'added' })
      continue
    }
    if (status === '??') changes.push({ path, change: 'added' })
    else if (status.includes('D')) changes.push({ path, change: 'deleted' })
    else if (status.includes('A')) changes.push({ path, change: 'added' })
    else changes.push({ path, change: 'modified' })
  }
  return changes
}

/**
 * Union the two layers per path: a structural claim (added/deleted) from
 * either layer survives a plain modification from the other, and the
 * working-tree layer wins when both claim structure. Exported for the spec
 * that pins the rule.
 */
export function unionChanges(committed: readonly ExplainedChange[], working: readonly ExplainedChange[]): Map<string, ChangeKind> {
  const merged = new Map<string, ChangeKind>()
  for (const change of committed) merged.set(change.path, change.change)
  for (const change of working) {
    const prior = merged.get(change.path)
    if (prior === undefined || change.change !== 'modified' || prior === 'modified') {
      merged.set(change.path, change.change)
    }
  }
  return merged
}

function byPath(a: ExplainedChange, b: ExplainedChange): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

function byName(a: ExplainPackage, b: ExplainPackage): number {
  return a.package < b.package ? -1 : a.package > b.package ? 1 : 0
}

/**
 * The nearest ancestor directory holding a `package.json`, `.` at the
 * repository root; memoized per directory for one grouping run.
 */
function ownerPackage(root: string, path: string, owners: Map<string, string>): string {
  const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const cached = owners.get(directory)
  if (cached !== undefined) return cached
  let current = directory
  let owner = '.'
  while (current !== '') {
    if (existsSync(join(root, current, 'package.json'))) {
      owner = current
      break
    }
    const separator = current.lastIndexOf('/')
    current = separator < 0 ? '' : current.slice(0, separator)
  }
  owners.set(directory, owner)
  return owner
}

/** Group one face's changes by owning package; groups and paths both sorted. */
function groupByPackage(root: string, changes: readonly ExplainedChange[]): ExplainPackage[] {
  const owners = new Map<string, string>()
  const groups = new Map<string, ExplainedChange[]>()
  for (const change of changes) {
    const owner = ownerPackage(root, change.path, owners)
    const group = groups.get(owner)
    if (group === undefined) groups.set(owner, [change])
    else group.push(change)
  }
  return [...groups]
    .map(([name, entries]) => ({ package: name, changes: entries.sort(byPath) }))
    .sort(byName)
}

/**
 * Explain one tree: the baseline window, the face-filtered union of both git
 * layers, grouped by owning package per face.
 * @param root - Repository tree to explain.
 * @param kind - Manifest kind its baseline was written under.
 * @param baseline - Baseline already read by {@link readBaseline} — callers
 * read it first so a missing manifest fails before any face walk.
 * @param facePaths - Resolved face sets; `undefined` reports every path under
 * `host` (whole-repository dsh-web stamp semantics).
 * @returns The explanation, ready for stdout JSON.
 */
export function explainTree(root: string, kind: 'harness' | 'dsh-web', baseline: Baseline, facePaths: FaceSets): TreeExplanation {
  const changes = unionChanges(committedChanges(root, baseline.time), workingChanges(root))
  const host: ExplainedChange[] = []
  const client: ExplainedChange[] = []
  for (const [path, change] of changes) {
    if (facePaths === undefined) {
      host.push({ path, change })
      continue
    }
    if (facePaths.host.has(path)) host.push({ path, change })
    if (facePaths.client.has(path)) client.push({ path, change })
  }
  return {
    repository: root,
    kind,
    baselineTime: baseline.time,
    builtFaces: baseline.builtFaces,
    faces: { host: groupByPackage(root, host), client: groupByPackage(root, client) },
  }
}
