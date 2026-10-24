/**
 * Restart-signal source stamps: the git-backed state hashes a build baseline
 * records.
 *
 * Two granularities are produced from one tree:
 *
 * - `repoStateStamp` — the design's repo-level S_src material: HEAD plus the
 *   `git diff HEAD` output (one call covering staged and unstaged changes),
 *   the `git status --porcelain` output, and every untracked file's path with
 *   its content hash. It is the cheap change detector.
 * - `faceContentStamp` — the per-face projection of that state: the sorted
 *   content identity of the face's own paths only (index blob for files whose
 *   working tree matches the index, disk hash for modified and untracked
 *   files, a deleted marker for removals). A commit enters the stamp through
 *   file content, so a change confined to one face cannot move the other
 *   face's stamp — the property the client-only restart rule depends on.
 *
 * All git calls are argument-vector spawns: no shell, no quoting surface.
 * @module scripts/restart-signal/repo-stamp
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Buffer ceiling for git output on a full-repository diff. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024

/**
 * Path segments holding runtime state rather than sources: profile
 * configuration is S_cfg's domain and session/storage data is neither stamp's
 * domain, so their churn never enters the source stamp.
 */
const RUNTIME_SEGMENTS: readonly string[] = ['sessions', 'sessions-backup', 'storages', 'profiles', '.tmp', '.tmp-ask', '.dsh-build']

/**
 * Whether a repository-relative path holds runtime state rather than source.
 * @param path - Slash-separated repository-relative path.
 * @returns True for logs and paths under runtime segments.
 */
export function isRuntimeDataPath(path: string): boolean {
  if (path.endsWith('.log')) return true
  return path.split('/').some(segment => RUNTIME_SEGMENTS.includes(segment))
}

function isRuntimeData(path: string): boolean {
  return isRuntimeDataPath(path)
}

function git(root: string, args: readonly string[]): Buffer {
  return execFileSync('git', ['-C', root, ...args], { maxBuffer: GIT_MAX_BUFFER })
}

function hashContent(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

interface PorcelainEntry {
  readonly path: string
  /** Working-tree column of the porcelain status (`?` for untracked). */
  readonly worktree: string
}

/**
 * Parse `git status --porcelain -z` into path/status pairs; a rename's source
 * token is consumed without emitting an entry.
 */
function porcelainEntries(root: string): PorcelainEntry[] {
  const raw = git(root, ['status', '--porcelain', '-z']).toString('utf8')
  const tokens = raw.split('\0')
  const entries: PorcelainEntry[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined || token === '') continue
    const status = token.slice(0, 2)
    const path = token.slice(3)
    entries.push({ path, worktree: status.slice(1) })
    if (status === 'R ' || status === 'R!' || status === 'C ' || status === 'C!') index += 1
  }
  return entries
}

/** Paths `git ls-files` reports with their index blob ids, keyed by repository-relative path. */
function indexBlobs(root: string): Map<string, string> {
  const raw = git(root, ['ls-files', '-s', '-z']).toString('utf8')
  const blobs = new Map<string, string>()
  for (const token of raw.split('\0')) {
    if (token === '') continue
    const tab = token.indexOf('\t')
    if (tab < 0) continue
    const header = token.slice(0, tab).split(' ')
    const path = token.slice(tab + 1)
    if (header[1] === undefined) continue
    if (header[2] === '0' || header.length === 2) blobs.set(path, header[1])
  }
  return blobs
}

/** Untracked file paths that git itself does not ignore. */
function untrackedPaths(root: string): string[] {
  return git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .toString('utf8')
    .split('\0')
    .filter(path => path !== '')
    .sort()
}

function diskIdentity(root: string, path: string): string {
  try {
    return `disk:${hashContent(readFileSync(join(root, path)))}`
  } catch {
    return 'disk:DELETED'
  }
}

/**
 * The repo-level source stamp: HEAD, the whole `git diff HEAD` output, the
 * porcelain status, and every untracked file's path with its content hash.
 * A clean porcelain output short-circuits the diff and untracked layers —
 * both are necessarily empty — which keeps clean-tree captures cheap.
 * @param root - Repository tree to stamp.
 * @returns sha256 hex over the design-defined layers.
 */
export function repoStateStamp(root: string): string {
  const porcelain = git(root, ['status', '--porcelain'])
  const hash = createHash('sha256')
  hash.update('HEAD ')
  hash.update(git(root, ['rev-parse', 'HEAD']))
  hash.update('\nPORCELAIN\n')
  hash.update(porcelain)
  const clean = porcelain.toString('utf8').trim() === ''
  if (!clean) {
    hash.update('\nDIFF\n')
    hash.update(git(root, ['diff', 'HEAD']))
    hash.update('\nUNTRACKED\n')
    for (const path of untrackedPaths(root)) {
      if (isRuntimeData(path)) continue
      hash.update(path)
      hash.update('\0')
      hash.update(diskIdentity(root, path))
      hash.update('\n')
    }
  }
  return hash.digest('hex')
}

/**
 * The content-state stamp over one path filter: index blobs for tracked
 * files, disk hashes for modified and untracked files, deleted markers for
 * removals; every emitted line is `path\tidentity`, sorted.
 */
function contentStamp(root: string, include: (path: string) => boolean): string {
  const blobs = indexBlobs(root)
  const lines: string[] = []
  for (const [path, blob] of blobs) {
    if (include(path)) lines.push(`${path}\t${blob}`)
  }
  const dirty = new Set<string>()
  for (const entry of porcelainEntries(root)) {
    // `?` (untracked), `M`/`D`/`A` in the worktree column: the disk state
    // differs from the index blob above, so it hashes from disk instead.
    if (entry.worktree !== ' ') dirty.add(entry.path)
  }
  for (const path of untrackedPaths(root)) dirty.add(path)
  for (const path of dirty) {
    if (include(path)) lines.push(`${path}\t${diskIdentity(root, path)}`)
  }
  lines.sort()
  const hash = createHash('sha256')
  for (const line of lines) {
    hash.update(line)
    hash.update('\n')
  }
  return hash.digest('hex')
}

/**
 * The content-state stamp of one face's paths: index blobs for files whose
 * working tree matches the index, disk hashes for modified and untracked
 * files, deleted markers for removals.
 * @param root - Repository tree to stamp.
 * @param facePaths - Face path set (repository-relative, slash-separated).
 * @returns sha256 hex over the sorted per-path content identities.
 * @throws If git cannot list the tree's index.
 */
export function faceContentStamp(root: string, facePaths: ReadonlySet<string>): string {
  return contentStamp(root, path => facePaths.has(path))
}

/**
 * The whole-repository content stamp: the same identity scheme over every
 * path git knows, with no face filter and no runtime-path filter. This
 * mirrors the dsh-web repository's `scripts/build-stamp.mjs` whole-repo
 * stamp byte-for-byte (that repository stamps its single host face as the
 * whole tree), so a harness-side recompute of a dsh-web tree's current
 * state compares equal to the baseline its own runner wrote.
 * @param root - Repository tree to stamp.
 * @returns sha256 hex over the sorted per-path content identities of all paths.
 * @throws If git cannot list the tree's index.
 */
export function wholeRepoContentStamp(root: string): string {
  return contentStamp(root, () => true)
}
