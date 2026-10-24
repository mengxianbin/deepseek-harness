/**
 * Restart-signal face resolution: the source-path set each build face owns.
 *
 * The host face is every source the Host compiler aggregate reaches plus the
 * repository build inputs that shape Host artifacts (compiler and bundler
 * configurations, package manifests, lockfile, native sources). The client
 * face is the Client compiler aggregate plus browser-only inputs Vite compiles
 * (entry HTML, client stylesheets, locale catalogs, the Vite configuration).
 * A path may belong to both faces; a path in neither face cannot move a build
 * baseline. Generated and dependency trees (node_modules, lib, dist, coverage,
 * worktrees, .dsh-build) are filtered out of every set so a build never
 * dirties its own baseline through its outputs.
 *
 * Face membership backs two consumers: the build stamp (S per face at build
 * start/end) and the single-package bundle wrapper (which faces one package's
 * direct tsdown run rebuilt).
 * @module scripts/restart-signal/face-paths
 */

import { existsSync, globSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import ts from 'typescript'

/** Repository-relative path sets of one tree, slash-separated. */
export interface FacePathSets {
  /** Sources and build inputs whose change rebuilds the host face. */
  readonly host: ReadonlySet<string>
  /** Sources and build inputs whose change rebuilds the client face. */
  readonly client: ReadonlySet<string>
}

/** Path segments that never belong to a face: outputs, dependencies, worktrees. */
const EXCLUDED_SEGMENTS: readonly string[] = ['node_modules', 'lib', 'dist', 'coverage', '.wt', '.dsh-build', 'sessions', 'storages', 'profiles']

/**
 * Repository build inputs shaping host artifacts but absent from every
 * compiler program: root configurations, package manifests and compiler
 * configs, and the native source tree.
 */
const HOST_EXTRA_PATTERNS: readonly string[] = [
  'tsdown.config.ts',
  'tsconfig.json',
  'tsconfig.host.json',
  'tsconfig.client.json',
  'tsconfig.base.json',
  'tsconfig.base.client.json',
  'tsconfig.node.base.json',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'packages/*/*/package.json',
  'packages/*/*/tsconfig*.json',
  'packages/*/*/tsdown.config.ts',
  'packages/*/tsdown.client.ts',
  'apps/*/package.json',
  'apps/*/tsconfig*.json',
  'apps/*/tsdown.config.ts',
  'vendor/*/package.json',
  'vendor/*/tsdown.config.ts',
  'native/**',
]

/**
 * Repository build inputs shaping client artifacts but absent from the Client
 * compiler program: the root configurations shared with the host face, the
 * Vite entry tree, and non-TypeScript inputs inside client packages.
 */
const CLIENT_EXTRA_PATTERNS: readonly string[] = [
  'tsdown.config.ts',
  'tsconfig.json',
  'tsconfig.host.json',
  'tsconfig.client.json',
  'tsconfig.base.json',
  'tsconfig.base.client.json',
  'tsconfig.node.base.json',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'packages/*/*/package.json',
  'packages/*/*/tsconfig*.json',
  'packages/*/*/tsdown.config.ts',
  'packages/*/tsdown.client.ts',
  'apps/*/package.json',
  'apps/*/tsconfig*.json',
  'apps/*/tsdown.config.ts',
  'apps/web/index.html',
  'apps/web/vite.config.ts',
  'apps/web/*.ts',
  'apps/web/src/**',
  'apps/web/public/**',
  'packages/client/**/*.css',
  'packages/client/**/locale/*.json',
]

/** Path separator as git reports paths. */
const GIT_SEP = '/'

function toRepoRelative(root: string, path: string): string | undefined {
  const rel = relative(root, path)
  if (rel === '' || rel.startsWith('..') || rel.startsWith(sep)) return undefined
  return rel.split(sep).join(GIT_SEP)
}

function isSourcePath(rel: string): boolean {
  const segments = rel.split('/')
  return !EXCLUDED_SEGMENTS.some(segment => segments.includes(segment))
}

function resolveConfigFile(path: string): string | undefined {
  if (path.endsWith('.json')) return existsSync(path) ? path : undefined
  const inDirectory = join(path, 'tsconfig.json')
  return existsSync(inDirectory) ? inDirectory : undefined
}

function collectProject(
  root: string,
  reference: string,
  files: Set<string>,
  visited: Set<string>,
): void {
  const configFile = resolveConfigFile(reference)
  if (configFile === undefined || visited.has(configFile)) return
  visited.add(configFile)
  const read = ts.readConfigFile(configFile, path => ts.sys.readFile(path))
  if (read.error !== undefined) {
    throw new Error(`restart-signal: cannot read ${configFile}: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`)
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      readFile: path => ts.sys.readFile(path),
      readDirectory: (path, extensions, exclude, include, depth) => ts.sys.readDirectory(path, extensions, exclude, include, depth),
      fileExists: path => ts.sys.fileExists(path),
      getCurrentDirectory: () => dirname(configFile),
      getDirectories: path => ts.sys.getDirectories(path),
    },
    dirname(configFile),
    undefined,
    configFile,
  )
  for (const name of parsed.fileNames) {
    const rel = toRepoRelative(root, name)
    if (rel !== undefined && isSourcePath(rel)) files.add(rel)
  }
  for (const projectReference of parsed.projectReferences ?? []) {
    collectProject(root, projectReference.path, files, visited)
  }
}

function extraFiles(root: string, patterns: readonly string[], into: Set<string>): void {
  for (const pattern of patterns) {
    for (const match of globSync(pattern, { cwd: root })) {
      const rel = match.split(sep).join(GIT_SEP)
      if (isSourcePath(rel)) into.add(rel)
    }
  }
}

/** Resolved sets per root; one opening/closing pair resolves them twice in one process. */
const resolved = new Map<string, FacePathSets>()

/**
 * Resolve the host and client face path sets of one repository tree.
 * @param root - Repository root holding `tsconfig.host.json` and `tsconfig.client.json`.
 * @returns Both face sets as repository-relative slash-separated paths; cached per root for the process lifetime.
 * @throws If an aggregate compiler configuration cannot be read.
 */
export function resolveFacePathSets(root: string): FacePathSets {
  const cached = resolved.get(root)
  if (cached !== undefined) return cached
  const host = new Set<string>()
  const client = new Set<string>()
  collectProject(root, join(root, 'tsconfig.host.json'), host, new Set())
  collectProject(root, join(root, 'tsconfig.client.json'), client, new Set())
  extraFiles(root, HOST_EXTRA_PATTERNS, host)
  extraFiles(root, CLIENT_EXTRA_PATTERNS, client)
  const sets: FacePathSets = { host, client }
  resolved.set(root, sets)
  return sets
}

/**
 * Detect which faces one package directory belongs to, for a direct single-package build.
 * @param root - Repository root the face sets were resolved against.
 * @param packageDir - Absolute path of the package directory being built.
 * @param sets - Face sets of the same repository tree.
 * @returns The distinct faces whose sources live under the package; empty when the package owns none.
 */
export function detectPackageFaces(root: string, packageDir: string, sets: FacePathSets): ('host' | 'client')[] {
  const prefix = `${toRepoRelative(root, packageDir) ?? ''}/`
  const srcPrefix = `${prefix}src/`
  const faces: ('host' | 'client')[] = []
  for (const [face, paths] of [['host', sets.host], ['client', sets.client]] as const) {
    let owned = false
    for (const path of paths) {
      if (!path.startsWith(prefix)) continue
      // Source-root membership keeps a client-only package's Host test files
      // (the Host aggregate tests every package) from claiming the host face.
      if (path.startsWith(srcPrefix) || !srcPrefixExists(packageDir)) {
        owned = true
        break
      }
    }
    if (owned) faces.push(face)
  }
  return faces
}

function srcPrefixExists(packageDir: string): boolean {
  return existsSync(join(packageDir, 'src'))
}
