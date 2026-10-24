/**
 * Restart-signal runtime stamp (R): the read-only baseline the host process
 * captures once at plugin startup.
 *
 * The capture reads this tree's build manifest plus every linked plugin
 * repository's manifest (capability-gated: a linked repository participates
 * only when it ships the matching stamp script), combines their host-face
 * components into the host face hash this process loaded, and snapshots the
 * configured-source fingerprint (S_cfg) of the same moment. A missing manifest
 * — first start, cleaned tree, never built — reads as state `INIT`
 * ("未建基线"), which the state machine reports without acting; this module
 * defines and reads only, it renders no UI and triggers no rebuild or
 * restart.
 *
 * S_cfg enumeration (design §二): the fixed set of setx environment variables
 * under `HKCU\Environment`, plus each profile's `cordis.yml`,
 * `cordis.patch.yml`, and `settings.yaml` (the profile-home settings file the
 * settings package loads). The key list is explicit: a newly setx'd variable
 * must be added here.
 * @module @deepseek-ai/dsh-client-ui-settings-general/restart-stamp
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Directory holding the per-tree build stamp, in both repositories. */
const STAMP_DIR = '.dsh-build'

/** Manifest file name inside the stamp directory. */
const MANIFEST_FILE = 'restart-stamp.json'

/** Stamp script whose presence marks a linked repository as stamp-capable. */
const CAPABILITY_MARKERS: readonly string[] = ['scripts/restart-signal/build-stamp.ts', 'scripts/restart-stamp.mjs']

/** Explicit setx inventory whose persisted values enter the S_cfg snapshot. */
const CONFIG_ENV_KEYS: readonly string[] = [
  'DSH_DIR',
  'DSH_NODE_MODULES',
  'DSH_REMOTE_PUBLIC_BASE_URL',
  'DSH_HOME',
  'DSH_OXLINT_THREADS',
  'DSH_WEB_RESTART_COMMAND',
  'DSH_COVERAGE_MAX_WORKERS',
]

/** Per-profile files whose content enters the S_cfg snapshot. */
const PROFILE_CONFIG_FILES: readonly string[] = ['cordis.yml', 'cordis.patch.yml', 'settings.yaml']

/** One repository's build manifest, as the host reads it. */
export interface RestartManifestComponent {
  /** Absolute path of the repository tree the manifest belongs to. */
  readonly repository: string
  /** Which stamp machinery wrote the manifest. */
  readonly kind: 'harness' | 'dsh-web'
  /** Manifest write time (ISO 8601); display only. */
  readonly time: string
  /** Faces the last build of that tree rebuilt. */
  readonly builtFaces: readonly string[]
  /** Whether a built face's stamp moved during that build. */
  readonly midBuildDirty: boolean
  /** Host-face baseline component; `null` until a host build ran there. */
  readonly hostFaceHash: string | null
  /** Client-face baseline component; `null` until a client build ran there. */
  readonly clientFaceHash: string | null
}

/**
 * The R stamp read at process start: the combined host face hash this process
 * loaded and the configured-source snapshot of the capture moment.
 */
export interface RestartStamp {
  /** `BASELINE` when every in-scope manifest exists; `INIT` (未建基线) otherwise. */
  readonly state: 'INIT' | 'BASELINE'
  /** Missing-manifest reasons; empty at `BASELINE`. */
  readonly reasons: readonly string[]
  /** Combined host face hash of all in-scope components; absent at `INIT`. */
  readonly hostFaceHash: string | undefined
  /** S_cfg snapshot taken with this read. */
  readonly sCfg: string
  /** Capture time (ISO 8601). */
  readonly capturedAt: string
  /** Raw per-repository manifest reads behind the combined hash. */
  readonly components: readonly RestartManifestComponent[]
}

/** Injection seam for one capture; production defaults come from this process. */
export interface RestartStampOptions {
  /** Repository tree this host process runs from; defaults to the tree owning this module. */
  readonly repositoryRoot?: string
  /** DSH home holding the profiles; defaults to `resolveDshHome()`. */
  readonly dshHome?: string
  /** HKCU\\Environment query; defaults to `reg query`. */
  readonly registryQuery?: () => string
}

let cached: RestartStamp | undefined

/**
 * Walk up from `startDir` to the directory holding `pnpm-workspace.yaml`.
 * @param startDir - Absolute directory to start from.
 * @returns The repository root, or `undefined` when none exists above.
 */
function findRepositoryRoot(startDir: string): string | undefined {
  let current = resolve(startDir)
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function defaultRepositoryRoot(): string {
  // import.meta.url points at this module's file: source under src/, built under lib/.
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const root = findRepositoryRoot(moduleDir)
  if (root === undefined) throw new Error(`restart-stamp: no repository root above ${moduleDir}`)
  return root
}

function defaultRegistryQuery(): string {
  try {
    return execFileSync('reg', ['query', 'HKCU\\Environment'], { encoding: 'utf8', windowsHide: true })
  } catch {
    // No readable HKCU\Environment: the snapshot simply omits the variables.
    return ''
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function readManifest(repository: string): RestartManifestComponent | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(repository, STAMP_DIR, MANIFEST_FILE), 'utf8')) as {
      version?: unknown
      kind?: unknown
      time?: unknown
      builtFaces?: unknown
      midBuildDirty?: unknown
      hostFaceHash?: unknown
      clientFaceHash?: unknown
    }
    if (parsed.version !== 1) return undefined
    if (parsed.kind !== 'harness' && parsed.kind !== 'dsh-web') return undefined
    if (typeof parsed.time !== 'string' || !Array.isArray(parsed.builtFaces) || typeof parsed.midBuildDirty !== 'boolean') return undefined
    if (typeof parsed.hostFaceHash !== 'string' && parsed.hostFaceHash !== null) return undefined
    if (typeof parsed.clientFaceHash !== 'string' && parsed.clientFaceHash !== null) return undefined
    return {
      repository,
      kind: parsed.kind,
      time: parsed.time,
      builtFaces: parsed.builtFaces.map(String),
      midBuildDirty: parsed.midBuildDirty,
      hostFaceHash: parsed.hostFaceHash,
      clientFaceHash: parsed.clientFaceHash,
    }
  } catch {
    return undefined
  }
}

function isStampCapable(repository: string): boolean {
  return CAPABILITY_MARKERS.some(marker => existsSync(join(repository, marker)))
}

function walkToGitRoot(packageDir: string): string | undefined {
  let current = resolve(packageDir)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Linked plugin repositories declared as `link:` dependencies of any profile;
 * each qualifies only when its tree ships a stamp script (capability gate),
 * so repositories without the machinery never force `INIT`.
 * @param dshHome - DSH home whose `profiles/*` to scan.
 * @returns Absolute repository roots, deduplicated, excluding this tree.
 */
export function linkedStampRepositories(dshHome: string): string[] {
  const roots = new Set<string>()
  let profileDirs: string[]
  try {
    const entries = readdirSyncProfiles(dshHome)
    profileDirs = entries
  } catch {
    profileDirs = []
  }
  for (const profileDir of profileDirs) {
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as Record<string, unknown>
    } catch {
      continue
    }
    for (const section of ['dependencies', 'devDependencies'] as const) {
      const dependencies = manifest[section]
      if (typeof dependencies !== 'object' || dependencies === null) continue
      for (const value of Object.values(dependencies as Record<string, string>)) {
        if (typeof value !== 'string' || !value.startsWith('link:')) continue
        const packageDir = resolve(profileDir, value.slice('link:'.length))
        const repository = walkToGitRoot(packageDir)
        if (repository === undefined || !isStampCapable(repository)) continue
        roots.add(repository)
      }
    }
  }
  return [...roots].sort()
}

function readdirSyncProfiles(dshHome: string): string[] {
  return readdirSync(join(dshHome, 'profiles'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(dshHome, 'profiles', entry.name))
}

function registryValues(query: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of query.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2])
  }
  return values
}

/**
 * The S_cfg snapshot: fixed HKCU environment keys plus every profile's
 * `cordis.yml`, `cordis.patch.yml`, and `settings.yaml` contents.
 * @param dshHome - DSH home holding the profiles.
 * @param registryQuery - HKCU\\Environment query result.
 * @returns sha256 hex over the sorted enumeration lines.
 */
export function computeConfigStamp(dshHome: string, registryQuery: string): string {
  const lines: string[] = []
  const env = registryValues(registryQuery)
  for (const key of CONFIG_ENV_KEYS) {
    const value = env.get(key)
    if (value !== undefined) lines.push(`env:${key}=${value}`)
  }
  for (const profileDir of profileDirectories(dshHome)) {
    for (const file of PROFILE_CONFIG_FILES) {
      const path = join(profileDir, file)
      try {
        const content = readFileSync(path)
        lines.push(`file:${path.replace(/\\/g, '/')}=${createHash('sha256').update(content).digest('hex')}`)
      } catch {
        // Absent profile files simply do not contribute a line.
      }
    }
  }
  lines.sort()
  return sha256(lines.join('\n'))
}

function profileDirectories(dshHome: string): string[] {
  try {
    return readdirSyncProfiles(dshHome).sort()
  } catch {
    return []
  }
}

/**
 * Read the runtime stamp (R) for this process: combine every in-scope
 * manifest's host-face component and snapshot S_cfg at the same moment.
 * @param options - Injection seams; production uses this tree and the resolved DSH home.
 * @returns The R stamp; `state: 'INIT'` when any in-scope manifest is missing.
 */
export function readRestartStamp(options: RestartStampOptions = {}): RestartStamp {
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot()
  const dshHome = options.dshHome ?? resolveDshHome()
  const query = (options.registryQuery ?? defaultRegistryQuery)()
  const reasons: string[] = []
  const components: RestartManifestComponent[] = []

  const own = readManifest(repositoryRoot)
  if (own === undefined) reasons.push(`harness manifest missing: ${join(repositoryRoot, STAMP_DIR, MANIFEST_FILE)}`)
  else components.push(own)

  for (const repository of linkedStampRepositories(dshHome)) {
    if (repository === repositoryRoot) continue
    const component = readManifest(repository)
    if (component === undefined) reasons.push(`linked manifest missing: ${repository}`)
    else components.push(component)
  }

  const sCfg = computeConfigStamp(dshHome, query)
  const capturedAt = new Date().toISOString()
  if (reasons.length > 0) {
    return { state: 'INIT', reasons, hostFaceHash: undefined, sCfg, capturedAt, components }
  }
  const combined = components
    .map(component => `${component.repository.replace(/\\/g, '/')}=${component.hostFaceHash ?? 'ABSENT'}`)
    .join('\n')
  return { state: 'BASELINE', reasons: [], hostFaceHash: sha256(combined), sCfg, capturedAt, components }
}

/**
 * The process-start capture: the first call performs the read, later calls
 * return the same snapshot, so every consumer sees one R for one process.
 * @param options - Injection seams forwarded to the first call.
 * @returns The cached R stamp.
 */
export function restartStamp(options: RestartStampOptions = {}): RestartStamp {
  cached ??= readRestartStamp(options)
  return cached
}

/** Drop the cached R; tests only. */
export function resetRestartStampForTest(): void {
  cached = undefined
}
