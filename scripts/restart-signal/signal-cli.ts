/**
 * Restart-signal current-stamp CLI: the async data gatherer the host state
 * machine spawns on a recheck.
 *
 * The host process cannot import this module directly — package sources may
 * not reach into `scripts/` — and the face-path walk costs ~11s cold, so the
 * gatherer runs as its own short-lived Node process (the host never blocks)
 * and persists the resolved face-path sets beside the manifest
 * (`.dsh-build/face-paths.json`, a disposable cache: delete it and the next
 * run rebuilds it). The cache is keyed by a source-structural signature
 * (HEAD, non-runtime porcelain flags, and the diff of configuration files):
 * content edits keep the signature — face SETS do not move when a file's
 * bytes change — while added/removed/renamed paths and tsconfig edits flip
 * it and force one fresh walk.
 *
 * Usage: `node scripts/restart-signal/signal-cli.ts [--explain] --stamp <repo>:<kind> [--stamp ...]`
 * where `<kind>` is `harness` (face sets from the tsconfig graphs) or
 * `dsh-web` (whole-repository stamp, mirroring that repository's own runner).
 * Output on stdout: one JSON object `{"stamps":[{"repository","kind","host","client"}]}`,
 * or with `--explain` one `{"explanations":[…]}` carrying each tree's baseline
 * time, built faces, and per-face package change lists — method and known
 * approximations documented in ./explain.ts.
 *
 * `--list-cohort` (build-scope-rework-1105 B) answers the other direction —
 * *which* repositories are in the restart-signal cohort at all: the in-cohort
 * repository list straight from `linkedStampRepositories` (the capability-gated
 * profile `link:` scan the host judgment itself uses — same source, so a
 * consumer can never drift from the lamp), each entry carrying that tree's own
 * manifest state and current stamps. Consumers: the m-note per-tree build
 * watchdog, which must not re-implement the profile-link + capability scan.
 * @module scripts/restart-signal/signal-cli
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { linkedStampRepositories } from '../../packages/client/ui-settings-general/src/restart-stamp.ts'
import { resolveDshHome } from '../../packages/util/home-paths/src/index.ts'
import { explainTree, readBaseline } from './explain.ts'
import { resolveFacePathSets } from './face-paths.ts'
import { manifestPath } from './manifest.ts'
import { faceContentStamp, isRuntimeDataPath, wholeRepoContentStamp } from './repo-stamp.ts'

/** One repository tree the CLI stamps, with the manifest kind that selects the stamp semantics. */
export interface StampSpec {
  readonly repository: string
  readonly kind: 'harness' | 'dsh-web'
}

/** One stamped repository's current source state, ready for the host-side combination. */
export interface CurrentStamp {
  readonly repository: string
  readonly kind: 'harness' | 'dsh-web'
  readonly host: string
  readonly client: string
}

/** One cohort tree's own manifest state, read for the per-tree drift judgment. */
export interface CohortManifest {
  readonly kind: 'harness' | 'dsh-web'
  /** Manifest write time (ISO 8601). */
  readonly time: string
  /** Build-end face baselines that tree's own last build wrote. */
  readonly sEnd: { readonly host: string; readonly client: string }
  /** Whether a built face's stamp moved during that build. */
  readonly midBuildDirty: boolean
}

/** One in-cohort repository: list membership (single source) + manifest state + current stamps. */
export interface CohortEntry {
  readonly repository: string
  /** The tree's own manifest; `null` when absent or unreadable — a linked
   * absence never locks the lamp and never triggers a build on its own
   * (linked-split 2026-11-01: only that tree's own bootstrap can write it). */
  readonly manifest: CohortManifest | null
  /** Current stamps under the manifest's kind; `null` when there is no manifest to stamp under. */
  readonly current: { readonly host: string; readonly client: string } | null
}

/** Persisted face-path cache: the resolved sets plus the signature they were resolved under. */
interface FacePathsCache {
  readonly version: 1
  readonly signature: string
  readonly host: readonly string[]
  readonly client: readonly string[]
}

const FACE_PATHS_CACHE_FILE = 'face-paths.json'

function git(root: string, args: readonly string[]): Buffer {
  return execFileSync('git', ['-C', root, ...args], { maxBuffer: 256 * 1024 * 1024 })
}

/**
 * The source-structural signature a face-path cache is valid under: HEAD,
 * the non-runtime porcelain flags, and the diff of configuration files whose
 * edits can move face membership without adding or removing a path.
 * @param root - Repository tree to sign.
 * @returns sha256 hex over the three layers.
 */
export function facePathsSignature(root: string): string {
  const hash = createHash('sha256')
  hash.update('HEAD ')
  hash.update(git(root, ['rev-parse', 'HEAD']))
  hash.update('\nPORCELAIN\n')
  for (const token of git(root, ['status', '--porcelain']).toString('utf8').split('\n')) {
    const path = token.slice(3)
    if (path === '' || isRuntimeDataPath(path)) continue
    hash.update(token)
    hash.update('\n')
  }
  hash.update('\nCONFIG-DIFF\n')
  hash.update(git(root, ['diff', 'HEAD', '--', '*.json', '*.yaml', '*.yml']))
  return hash.digest('hex')
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function cachePath(root: string): string {
  return join(root, '.dsh-build', FACE_PATHS_CACHE_FILE)
}

function readFacePathsCache(root: string, signature: string): { host: Set<string>; client: Set<string> } | undefined {
  const parsed = readJsonRecord(cachePath(root))
  if (parsed === undefined || parsed.version !== 1 || parsed.signature !== signature) return undefined
  if (!isStringArray(parsed.host) || !isStringArray(parsed.client)) return undefined
  return { host: new Set(parsed.host), client: new Set(parsed.client) }
}

function writeFacePathsCache(root: string, signature: string, sets: { host: ReadonlySet<string>; client: ReadonlySet<string> }): void {
  const path = cachePath(root)
  mkdirSync(dirname(path), { recursive: true })
  const body: FacePathsCache = {
    version: 1,
    signature,
    host: [...sets.host].sort(),
    client: [...sets.client].sort(),
  }
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(body, undefined, 2)}\n`)
  renameSync(temporary, path)
}

/**
 * Resolve the face-path sets of one harness-kind tree from the persisted
 * cache when its signature still holds, walking the tsconfig graphs otherwise
 * and refreshing the cache.
 * @param root - Repository tree whose sets to resolve.
 * @returns The host and client face sets.
 */
export function cachedFacePathSets(root: string): { host: Set<string>; client: Set<string> } {
  const signature = facePathsSignature(root)
  const cached = readFacePathsCache(root, signature)
  if (cached !== undefined) return cached
  const sets = resolveFacePathSets(root)
  writeFacePathsCache(root, signature, sets)
  return { host: new Set(sets.host), client: new Set(sets.client) }
}

/**
 * Stamp one repository tree's current source state under its manifest kind.
 * @param spec - Repository tree and the stamp semantics its manifest declares.
 * @returns The current host/client face stamps of that tree.
 * @throws If git cannot read the tree.
 */
export function stampRepository(spec: StampSpec): CurrentStamp {
  if (spec.kind === 'dsh-web') {
    return { repository: spec.repository, kind: spec.kind, host: wholeRepoContentStamp(spec.repository), client: 'n/a' }
  }
  const sets = cachedFacePathSets(spec.repository)
  return {
    repository: spec.repository,
    kind: spec.kind,
    host: faceContentStamp(spec.repository, sets.host),
    client: faceContentStamp(spec.repository, sets.client),
  }
}

/**
 * Read one cohort tree's own manifest for the cohort listing (schema mirror of
 * the write side: version 1, kind, time, sEnd, midBuildDirty). A missing or
 * unreadable manifest reads as `null` — same downgrade the host judgment gives
 * a linked absence (`notices`, never a lamp lock).
 * @param repository - Repository tree whose `.dsh-build/restart-stamp.json` to read.
 * @returns The manifest state, or `null` when absent or malformed.
 */
export function readCohortManifest(repository: string): CohortManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath(repository), 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const kind = record.kind
  const time = record.time
  const sEnd = record.sEnd
  const midBuildDirty = record.midBuildDirty
  if (record.version !== 1 || (kind !== 'harness' && kind !== 'dsh-web')) return null
  if (typeof time !== 'string' || typeof midBuildDirty !== 'boolean') return null
  if (typeof sEnd !== 'object' || sEnd === null || Array.isArray(sEnd)) return null
  const host = (sEnd as Record<string, unknown>).host
  const client = (sEnd as Record<string, unknown>).client
  if (typeof host !== 'string' || typeof client !== 'string') return null
  return { kind, time, sEnd: { host, client }, midBuildDirty }
}

/**
 * The restart-signal cohort: every repository `linkedStampRepositories` puts in
 * scope (profile `link:` dependencies that ship a capability marker), each with
 * its own manifest state and current stamps. The list itself is that function's
 * return verbatim — this module re-implements neither the profile scan nor the
 * capability gate, so a watchdog consuming this output sees exactly the set the
 * lamp's combination hash sees.
 * @param dshHome - DSH home whose `profiles/*` to scan; defaults to the resolved home.
 * @returns One entry per in-cohort repository, in `linkedStampRepositories` order.
 */
export function listCohort(dshHome: string = resolveDshHome()): CohortEntry[] {
  return linkedStampRepositories(dshHome).map((repository) => {
    const manifest = readCohortManifest(repository)
    const current = manifest === null ? null : stampRepository({ repository, kind: manifest.kind })
    return {
      repository,
      manifest,
      current: current === null ? null : { host: current.host, client: current.client },
    }
  })
}

/**
 * Parse the command line into stamp specs.
 * @param args - Arguments after the script path.
 * @returns The repository trees to stamp, in argument order.
 * @throws If no `--stamp` pair is given or a kind is unknown.
 */
export function parseStampArgs(args: readonly string[]): StampSpec[] {
  const { values } = parseArgs({ args: [...args], options: { stamp: { type: 'string', multiple: true } }, allowPositionals: false })
  const specs: StampSpec[] = []
  for (const entry of values.stamp ?? []) {
    const separator = entry.lastIndexOf(':')
    const repository = separator < 0 ? undefined : entry.slice(0, separator)
    const kind = separator < 0 ? undefined : entry.slice(separator + 1)
    if (repository === undefined || repository === '' || (kind !== 'harness' && kind !== 'dsh-web')) {
      throw new Error(`restart-signal: --stamp expects <repository>:<harness|dsh-web>, got ${JSON.stringify(entry)}`)
    }
    specs.push({ repository, kind })
  }
  if (specs.length === 0) throw new Error('restart-signal: signal-cli requires at least one --stamp <repository>:<kind>')
  return specs
}

/**
 * The `--explain` flag token; filtered out before stamp parsing so the
 * stamp-only option surface stays unchanged.
 */
const EXPLAIN_FLAG = '--explain'

/**
 * The `--list-cohort` flag token (build-scope-rework-1105 B); it answers
 * alone — no `--stamp` pair is required — and short-circuits the stamp modes.
 */
const COHORT_FLAG = '--list-cohort'

function main(args: readonly string[]): number {
  if (args.includes(COHORT_FLAG)) {
    process.stdout.write(`${JSON.stringify({ cohort: listCohort() })}\n`)
    return 0
  }
  const explain = args.includes(EXPLAIN_FLAG)
  const specs = parseStampArgs(args.filter(argument => argument !== EXPLAIN_FLAG))
  if (explain) {
    const explanations = specs.map((spec) => {
      // Baseline first: a tree without a manifest fails before the face walk.
      const baseline = readBaseline(spec.repository, spec.kind)
      const facePaths = spec.kind === 'harness' ? cachedFacePathSets(spec.repository) : undefined
      return explainTree(spec.repository, spec.kind, baseline, facePaths)
    })
    process.stdout.write(`${JSON.stringify({ explanations }, undefined, 2)}\n`)
    return 0
  }
  const stamps = specs.map(stampRepository)
  process.stdout.write(`${JSON.stringify({ stamps })}\n`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`restart-signal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
