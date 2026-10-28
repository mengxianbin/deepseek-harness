/**
 * Restart-signal build manifest: the on-disk baseline a build writes and the
 * host process reads.
 *
 * One manifest per repository tree, under the tree's own gitignored
 * `.dsh-build/` directory — a build stamps the tree it built, and a failed
 * build leaves the previous manifest untouched because the closing step never
 * runs. The harness manifest carries both faces of its own tree; the dsh-web
 * repository writes its own `kind: 'dsh-web'` manifest holding its host-face
 * component (same directory, same file name, different `kind`), which the
 * host read combines with the harness component. `hostFaceHash` and
 * `clientFaceHash` are the face stamps captured at build start (`sStart`):
 * the source state the artifacts this build produced came from.
 * @module scripts/restart-signal/manifest
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Gitignored directory holding the per-tree build stamp. */
export const STAMP_DIR = '.dsh-build'

/** Manifest file name inside `.dsh-build/`, shared by both repositories. */
export const MANIFEST_FILE = 'restart-stamp.json'

/** Build-start capture file; the closing step consumes and removes it. */
export const START_FILE = 'restart-stamp.start.json'

/** Failure record file; the runner writes it on a non-zero build exit and the next opening step clears it. */
export const FAILED_FILE = 'restart-stamp.failed.json'

/** Build faces a manifest entry records. */
export type BuildFace = 'host' | 'client'

/** The three source stamps one build captures. */
export interface FaceHashes {
  /** Repo-level source stamp (design S_src material) at capture time. */
  readonly repo: string
  /** Host-face content stamp at capture time. */
  readonly host: string
  /** Client-face content stamp at capture time. */
  readonly client: string
}

/** Manifest written by a harness-tree build. */
export interface HarnessManifest {
  readonly version: 1
  readonly kind: 'harness'
  /** Manifest write time (ISO 8601); display only, never a judgment input. */
  readonly time: string
  /** Build-start capture time (ISO 8601). */
  readonly sStartTime: string
  /** Faces this build invocation rebuilt. */
  readonly builtFaces: readonly BuildFace[]
  /** True when a built face's stamp moved between build start and end. */
  readonly midBuildDirty: boolean
  /** Host-face baseline; `null` until a host build has run in this tree. */
  readonly hostFaceHash: string | null
  /** Client-face baseline; `null` until a client build has run in this tree. */
  readonly clientFaceHash: string | null
  /** Source stamps captured when the build started. */
  readonly sStart: FaceHashes
  /** Source stamps captured when the build ended. */
  readonly sEnd: FaceHashes
}

/** Build-start capture left by the opening step. */
export interface StartStamp {
  readonly version: 1
  readonly kind: 'harness-start'
  /** Capture time (ISO 8601). */
  readonly time: string
  /** Faces this invocation is rebuilding. */
  readonly faces: readonly BuildFace[]
  /** Source stamps captured at build start. */
  readonly sStart: FaceHashes
}

/** Failure record the runner leaves when the build command exits non-zero. */
export interface FailedStamp {
  readonly version: 1
  readonly kind: 'harness-failed'
  /** Failure write time (ISO 8601). */
  readonly time: string
  /** Faces the failed invocation was rebuilding. */
  readonly faces: readonly BuildFace[]
  /** Source stamps the failed invocation captured at build start. */
  readonly sStart: FaceHashes
  /** Exit code the build command returned. */
  readonly exitCode: number
}

/** Absolute path of a tree's manifest. */
export function manifestPath(root: string): string {
  return join(root, STAMP_DIR, MANIFEST_FILE)
}

/** Absolute path of a tree's build-start capture. */
export function startPath(root: string): string {
  return join(root, STAMP_DIR, START_FILE)
}

/** Absolute path of a tree's build-failure record. */
export function failedPath(root: string): string {
  return join(root, STAMP_DIR, FAILED_FILE)
}

/** Read and parse a JSON file as an untrusted record; `undefined` when absent or unreadable. */
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

function isBuildFace(value: unknown): value is BuildFace {
  return value === 'host' || value === 'client'
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

function isFaceHashes(value: unknown): value is FaceHashes {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.repo === 'string' && typeof record.host === 'string' && typeof record.client === 'string'
}

/**
 * Read one tree's build manifest.
 * @param root - Repository tree whose `.dsh-build/restart-stamp.json` to read.
 * @returns The validated harness manifest, or `undefined` when absent, unreadable, or malformed.
 */
export function readHarnessManifest(root: string): HarnessManifest | undefined {
  const parsed = readJsonRecord(manifestPath(root))
  if (parsed === undefined || parsed.kind !== 'harness' || parsed.version !== 1) return undefined
  if (typeof parsed.time !== 'string' || typeof parsed.sStartTime !== 'string') return undefined
  if (!Array.isArray(parsed.builtFaces) || !parsed.builtFaces.every(isBuildFace)) return undefined
  if (typeof parsed.midBuildDirty !== 'boolean') return undefined
  if (!isNullableString(parsed.hostFaceHash) || !isNullableString(parsed.clientFaceHash)) return undefined
  if (!isFaceHashes(parsed.sStart) || !isFaceHashes(parsed.sEnd)) return undefined
  return {
    version: 1,
    kind: 'harness',
    time: parsed.time,
    sStartTime: parsed.sStartTime,
    builtFaces: parsed.builtFaces.filter(isBuildFace),
    midBuildDirty: parsed.midBuildDirty,
    hostFaceHash: parsed.hostFaceHash,
    clientFaceHash: parsed.clientFaceHash,
    sStart: parsed.sStart,
    sEnd: parsed.sEnd,
  }
}

/**
 * Read one tree's build-start capture.
 * @param root - Repository tree whose `.dsh-build/restart-stamp.start.json` to read.
 * @returns The validated start stamp, or `undefined` when absent, unreadable, or malformed.
 */
export function readStartStamp(root: string): StartStamp | undefined {
  const parsed = readJsonRecord(startPath(root))
  if (parsed === undefined || parsed.kind !== 'harness-start' || parsed.version !== 1) return undefined
  if (typeof parsed.time !== 'string') return undefined
  if (!Array.isArray(parsed.faces) || !parsed.faces.every(isBuildFace)) return undefined
  if (!isFaceHashes(parsed.sStart)) return undefined
  return {
    version: 1,
    kind: 'harness-start',
    time: parsed.time,
    faces: parsed.faces.filter(isBuildFace),
    sStart: parsed.sStart,
  }
}

/**
 * Read one tree's build-failure record.
 * @param root - Repository tree whose `.dsh-build/restart-stamp.failed.json` to read.
 * @returns The validated failure record, or `undefined` when absent, unreadable, or malformed.
 */
export function readFailedStamp(root: string): FailedStamp | undefined {
  const parsed = readJsonRecord(failedPath(root))
  if (parsed === undefined || parsed.kind !== 'harness-failed' || parsed.version !== 1) return undefined
  if (typeof parsed.time !== 'string' || typeof parsed.exitCode !== 'number') return undefined
  if (!Array.isArray(parsed.faces) || !parsed.faces.every(isBuildFace)) return undefined
  if (!isFaceHashes(parsed.sStart)) return undefined
  return {
    version: 1,
    kind: 'harness-failed',
    time: parsed.time,
    faces: parsed.faces.filter(isBuildFace),
    sStart: parsed.sStart,
    exitCode: parsed.exitCode,
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, undefined, 2)}\n`)
  renameSync(temporary, path)
}

/**
 * Write the build-start capture for an opening build step, clearing any
 * stale failure record from an earlier attempt.
 * @param root - Repository tree being built.
 * @param stamp - Faces and source stamps captured at build start.
 */
export function writeStartStamp(root: string, stamp: StartStamp): void {
  rmSync(failedPath(root), { force: true })
  writeJson(startPath(root), stamp)
}

/**
 * Write the build-failure record a failed invocation leaves behind and
 * remove the build-start capture, so the failure reads as terminal instead
 * of an eternally running build.
 * @param root - Repository tree whose build command failed.
 * @param stamp - Faces and source stamps the failed invocation captured at start, plus its exit code.
 */
export function writeFailedStamp(root: string, stamp: FailedStamp): void {
  writeJson(failedPath(root), stamp)
  rmSync(startPath(root), { force: true })
}

/**
 * Write the build manifest and remove the build-start capture.
 * @param root - Repository tree whose manifest to replace.
 * @param manifest - The completed build's manifest value.
 */
export function writeHarnessManifest(root: string, manifest: HarnessManifest): void {
  writeJson(manifestPath(root), manifest)
  rmSync(startPath(root), { force: true })
}

/** Directory containing a manifest, for error messages. */
export function stampDir(root: string): string {
  return dirname(manifestPath(root))
}
