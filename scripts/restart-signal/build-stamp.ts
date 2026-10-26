/**
 * Restart-signal build stamp: the opening/closing step every production build
 * entry runs through.
 *
 * `run --faces <faces> -- <command>` captures S_start, executes the command,
 * and on success writes `.dsh-build/restart-stamp.json` (S_start per design;
 * `midBuildDirty` when a built face moved before the end). A failed command
 * leaves the previous manifest untouched — the baseline only advances for a
 * build that finished. When `DSH_BUILD_STAMP_ACTIVE` is already present the
 * invocation is nested inside an outer stamped chain and becomes a pure
 * passthrough, so exactly one opening/closing pair owns each build.
 *
 * Production build entry inventory (grep of root + workspace package.json
 * `scripts` and build scripts, 2026-10-24; new production entries must mount
 * here too):
 *
 * | entry | mount |
 * |---|---|
 * | `build:lib` (chains the two below) | inherited via `build:lib:host` / `build:lib:client` |
 * | `build:lib:host` / `build:lib:client` | this runner (`--faces host` / `--faces client`) |
 * | `heavy:build:lib*` | wrap the mounted scripts above |
 * | `build` / `build:artifacts` / `build:official` (`scripts/build.ts`) | in-process `beginBuild`/`endBuild` + gate env marker |
 * | `build:web` → `apps/web` `build` (vite) | `apps/web/package.json` runner (`--faces client`) |
 * | `apps/web` `build:preview` (also writes the served dist) | same package runner (`--faces client`) |
 * | single-package tsdown direct (`<pkg>` `bundle`, incl. `apps/desktop`) | each `package.json` runner (`--faces auto`) |
 * | `build:native-system` (host-loaded native addon) | root runner (`--faces host`) |
 * | dsh-web repo `pnpm -r build` | dsh-web `package.json` runner (`node scripts/build-stamp.mjs`) |
 * | `test:web` (runs `build`) | inherited via `build` |
 * | `build:check` / `typecheck` / `gen-*` / `verify-*` / `docs:*` / `website:build` | excluded: no production artifact build |
 * | `build:bench` / `benchmark:*` / `package:desktop*` / `upload:*` | excluded: not a production artifact build |
 * | `watch` / `dev:*` | excluded: HMR/dev never writes the manifest (design §二) |
 *
 * `build:native-system` and `apps/web` `build:preview` extend the design's
 * four-entry list: both produce artifacts the running system loads, which the
 * inventory rule ("all production build entries") requires.
 * @module scripts/restart-signal/build-stamp
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, parse, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  type BuildFace,
  readHarnessManifest,
  readStartStamp,
  writeFailedStamp,
  writeHarnessManifest,
  writeStartStamp,
} from './manifest.ts'
import { detectPackageFaces, resolveFacePathSets } from './face-paths.ts'
import { faceContentStamp, repoStateStamp } from './repo-stamp.ts'

/** Environment marker every child of an owning stamped chain inherits. */
export const STAMP_ACTIVE_ENV = 'DSH_BUILD_STAMP_ACTIVE'

function stampActive(): boolean {
  const value = process.env[STAMP_ACTIVE_ENV]
  return value !== undefined && value !== '' && value !== '0'
}

/** Walk up from `startDir` to the directory holding `pnpm-workspace.yaml`. */
function repositoryRoot(startDir: string): string {
  let current = resolve(startDir)
  for (;;) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current
    const parent = parse(current).root
    if (parent === current) throw new Error(`restart-signal: no repository root above ${startDir}`)
    current = dirname(current)
  }
}

function parseFaces(value: string): BuildFace[] | 'auto' {
  if (value === 'auto') return 'auto'
  const faces = value.split(',').map(part => part.trim())
  for (const face of faces) {
    if (face !== 'host' && face !== 'client') {
      throw new Error(`restart-signal: --faces must be host, client, host,client, or auto, got ${JSON.stringify(value)}`)
    }
  }
  return [...new Set(faces)] as BuildFace[]
}

function capture(root: string): { repo: string; host: string; client: string } {
  const sets = resolveFacePathSets(root)
  return {
    repo: repoStateStamp(root),
    host: faceContentStamp(root, sets.host),
    client: faceContentStamp(root, sets.client),
  }
}

/**
 * Opening build step: capture S_start for the faces this invocation rebuilds
 * and persist it as the build-start temporary record.
 * @param root - Repository tree being built.
 * @param faces - Faces this build invocation will rebuild.
 */
export function beginBuild(root: string, faces: readonly BuildFace[]): void {
  const sStart = capture(root)
  writeStartStamp(root, {
    version: 1,
    kind: 'harness-start',
    time: new Date().toISOString(),
    faces: [...faces],
    sStart,
  })
}

/**
 * Closing build step: capture S_end, advance only the faces this invocation
 * rebuilt (others carry the previous baseline), and replace the manifest.
 * @param root - Repository tree whose build finished.
 * @throws If no build-start capture exists — the mount did not run its opening step.
 */
export function endBuild(root: string): void {
  const start = readStartStamp(root)
  if (start === undefined) {
    throw new Error(`restart-signal: closing step found no build-start record at ${resolve(root, '.dsh-build', 'restart-stamp.start.json')}; the opening mount did not run`)
  }
  const sEnd = capture(root)
  const previous = readHarnessManifest(root)
  const builtFaces = start.faces
  const midBuildDirty = builtFaces.some(face => sEnd[face] !== start.sStart[face])
  const hostFaceHash = builtFaces.includes('host') ? start.sStart.host : previous?.hostFaceHash ?? null
  const clientFaceHash = builtFaces.includes('client') ? start.sStart.client : previous?.clientFaceHash ?? null
  const now = new Date().toISOString()
  writeHarnessManifest(root, {
    version: 1,
    kind: 'harness',
    time: now,
    sStartTime: start.time,
    builtFaces,
    midBuildDirty,
    hostFaceHash,
    clientFaceHash,
    sStart: start.sStart,
    sEnd,
  })
  process.stderr.write(
    `restart-signal: manifest written (${builtFaces.join('+')} face${builtFaces.length === 1 ? '' : 's'}, midBuildDirty=${String(midBuildDirty)}) .dsh-build/restart-stamp.json\n`,
  )
}

interface RunArguments {
  readonly faces: BuildFace[] | 'auto'
  readonly root: string | undefined
  readonly command: string
}

function parseRunArguments(args: readonly string[]): RunArguments {
  const positional = args[0] === 'run' ? args.slice(1) : args
  const separator = positional.indexOf('--')
  if (separator < 0) throw new Error('restart-signal: run requires `-- <command>`')
  const { values } = parseArgs({
    args: positional.slice(0, separator),
    options: { faces: { type: 'string' }, root: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.faces === undefined) throw new Error('restart-signal: run requires --faces')
  const command = positional.slice(separator + 1).join(' ')
  if (command === '') throw new Error('restart-signal: run requires a command after `--`')
  return { faces: parseFaces(values.faces), root: values.root, command: command }
}

function runChild(command: string, environment: NodeJS.ProcessEnv): number {
  const result = spawnSync(command, { shell: true, stdio: 'inherit', env: environment })
  if (result.error !== undefined) throw result.error
  return result.status ?? 1
}

function main(args: readonly string[]): number {
  const parsed = parseRunArguments(args)
  if (stampActive()) return runChild(parsed.command, process.env)
  const root = parsed.root ?? repositoryRoot(process.cwd())
  const faces = parsed.faces === 'auto'
    ? detectPackageFaces(root, process.cwd(), resolveFacePathSets(root))
    : parsed.faces
  if (faces.length === 0) {
    throw new Error(`restart-signal: --faces auto found no owning face for ${process.cwd()}; the package is not in either face set`)
  }
  beginBuild(root, faces)
  const code = runChild(parsed.command, { ...process.env, [STAMP_ACTIVE_ENV]: '1' })
  if (code === 0) {
    endBuild(root)
    return 0
  }
  // A failed command leaves the baseline untouched and records the failure
  // instead of the build-start capture, so the state machine reports
  // BUILD_FAILED rather than an eternally running build.
  const start = readStartStamp(root)
  if (start !== undefined) {
    writeFailedStamp(root, {
      version: 1,
      kind: 'harness-failed',
      time: new Date().toISOString(),
      faces: start.faces,
      sStart: start.sStart,
      exitCode: code,
    })
  }
  return code
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`restart-signal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
