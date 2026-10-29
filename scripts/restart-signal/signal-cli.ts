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
 * @module scripts/restart-signal/signal-cli
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { explainTree, readBaseline } from './explain.ts'
import { resolveFacePathSets } from './face-paths.ts'
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

function main(args: readonly string[]): number {
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
