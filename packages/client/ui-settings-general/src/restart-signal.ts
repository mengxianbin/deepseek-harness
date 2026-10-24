/**
 * Restart-signal state machine: the design's seven-state judgment over the
 * S/B/R stamp comparison, plus the async gathering that feeds it.
 *
 * The judgment is a pure function of machine facts — the process-start
 * runtime stamp (R), a fresh manifest read (B), the current configured-source
 * stamp, build-in-flight/failure markers, and the current source face stamps
 * (S) — and carries no wall-clock input: timestamps inside the manifests are
 * display data, never judgment inputs (design §二).
 *
 * Precedence (implementation choice over the design's condition table, so a
 * transient build state cannot emit a noisy source judgment, and a
 * half-built tree never sends the user to a white restart — R4):
 * `INIT` → `BUILDING` → `BUILD_FAILED` → `NEED_BUILD` → `NEED_RESTART` →
 * `CLIENT_UPDATED` → `OK`. When the current source stamps are unavailable
 * (git or the stamp CLI failed), the source comparison degrades
 * conservatively to `NEED_BUILD` with the failure surfaced in `detail` and
 * one stderr line — never a silent `OK`.
 *
 * Gathering runs the stamp CLI (`scripts/restart-signal/signal-cli.ts`) in a
 * short-lived child process so a recompute never blocks the host event loop;
 * concurrent rechecks coalesce into one in-flight computation.
 * @module @deepseek-ai/dsh-client-ui-settings-general/restart-signal
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  defaultRepositoryRoot,
  readRestartStamp,
  restartStamp,
  type RestartManifestComponent,
  type RestartStamp,
  type RestartStampOptions,
} from './restart-stamp.ts'
import type { RestartSignalReason, RestartSignalState } from './restart.ts'

const execFileAsync = promisify(execFile)

/** Gitignored directory holding the per-tree build markers (mirrors the scripts-side constant). */
const STAMP_DIR = '.dsh-build'

/** Build-start capture file name inside the stamp directory (mirrors the scripts-side constant). */
const START_CAPTURE_FILE = 'restart-stamp.start.json'

/** Build-failure record file name inside the stamp directory (mirrors the scripts-side constant). */
const FAILURE_FILE = 'restart-stamp.failed.json'

/** One repository tree's current source face stamps, as the stamp CLI reports them. */
export interface CurrentStamp {
  readonly repository: string
  readonly kind: 'harness' | 'dsh-web'
  readonly host: string
  readonly client: string
}

/** Everything the judgment consumes; every field is a machine fact. */
export interface RestartSignalInputs {
  /** The process-start runtime stamp (R). */
  readonly runtime: RestartStamp
  /** A fresh manifest read (B): combined baselines, per-repo components, INIT reasons. */
  readonly fresh: RestartStamp
  /** Current configured-source stamp (S_cfg), enumerated like the runtime snapshot was. */
  readonly configStamp: string
  /** True while a build-start capture sits in the harness tree: a build is running. */
  readonly building: boolean
  /** True while a build-failure record sits in the harness tree: the last build failed. */
  readonly failed: boolean
  /** Combined current host-face source stamp (S.host); `undefined` when stamps were unavailable. */
  readonly currentHostFace: string | undefined
  /** Current client-face source stamp of the harness tree; `undefined` when stamps were unavailable. */
  readonly currentClientFace: string | undefined
}

/** One judgment: the state machine's full output. */
export interface RestartSignalJudgment {
  readonly state: RestartSignalState
  /** Present only on `NEED_RESTART`: which restart branch fired. */
  readonly reason?: RestartSignalReason
  /** Human-readable facts behind the judgment; log and test surface, never copy text. */
  readonly detail: string
}

/**
 * Combine per-repository host-face stamps into one hash, mirroring the
 * runtime stamp's own combination (restart-stamp.ts) so a current-stamp
 * combination is directly comparable to the cached R and the fresh B.
 * @param rows - Per-repository `(normalized repository path, host face stamp)` pairs, in component order.
 * @returns sha256 hex over the same line format the runtime stamp hashes.
 */
export function combineHostFace(rows: readonly (readonly [string, string])[]): string {
  const combined = rows.map(([repository, host]) => `${repository.replace(/\\/g, '/')}=${host}`).join('\n')
  return createHash('sha256').update(combined).digest('hex')
}

/**
 * Judge the seven-state restart signal from its machine facts. Pure: no I/O,
 * no clock, deterministic for identical inputs.
 * @param inputs - R, fresh B, S_cfg, build markers, and current source stamps.
 * @returns The state, the restart branch when relevant, and the facts behind it.
 */
export function judgeRestartSignal(inputs: RestartSignalInputs): RestartSignalJudgment {
  if (inputs.fresh.state === 'INIT') {
    return { state: 'INIT', detail: `baseline manifest missing: ${inputs.fresh.reasons.join('; ')}` }
  }
  if (inputs.building) {
    return { state: 'BUILDING', detail: `build-start capture present at ${STAMP_DIR}/${START_CAPTURE_FILE}` }
  }
  if (inputs.failed) {
    return { state: 'BUILD_FAILED', detail: `build-failure record present at ${STAMP_DIR}/${FAILURE_FILE}` }
  }
  if (inputs.currentHostFace === undefined) {
    return {
      state: 'NEED_BUILD',
      detail: 'current source stamps unavailable (git or stamp CLI failed); conservatively reporting the build gap',
    }
  }
  if (inputs.currentHostFace !== inputs.fresh.hostFaceHash) {
    return { state: 'NEED_BUILD', detail: 'host-face source moved past the last build baseline' }
  }
  if (inputs.configStamp !== inputs.runtime.sCfg) {
    return { state: 'NEED_RESTART', reason: 'config', detail: 'configured sources changed since the process captured its runtime stamp' }
  }
  if (inputs.runtime.state === 'INIT' || inputs.runtime.hostFaceHash !== inputs.fresh.hostFaceHash) {
    return {
      state: 'NEED_RESTART',
      reason: 'built',
      detail: inputs.runtime.state === 'INIT'
        ? 'the process started before any baseline existed; a build has since established one'
        : 'the build baseline moved past what this process loaded',
    }
  }
  const harness = inputs.fresh.components.find(component => component.kind === 'harness')
  const clientBaseline = harness?.clientFaceHash ?? null
  if (clientBaseline !== null && inputs.currentClientFace !== undefined && inputs.currentClientFace !== clientBaseline) {
    return { state: 'CLIENT_UPDATED', detail: 'client-face source moved; host face agrees with the baseline (F5/HMR territory)' }
  }
  return { state: 'OK', detail: 'source, build baseline, runtime stamp, and configuration all agree' }
}

/** Injection seam for the current-stamp gatherer; production spawns the stamp CLI. */
export type StampCliRunner = (repositoryRoot: string, components: readonly RestartManifestComponent[]) => Promise<readonly CurrentStamp[]>

/** Injection seams for one collect; production defaults come from this process and the CLI. */
export interface RestartSignalOptions extends RestartStampOptions {
  /** Current-stamp gatherer; defaults to spawning `scripts/restart-signal/signal-cli.ts`. */
  readonly runStampCli?: StampCliRunner
}

function parseCliStamps(text: string): CurrentStamp[] {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('restart-signal: stamp CLI returned a non-object body')
  }
  const stamps: unknown = Reflect.get(parsed, 'stamps')
  if (!Array.isArray(stamps)) throw new Error('restart-signal: stamp CLI response has no stamps array')
  return stamps.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('restart-signal: stamp CLI reported a non-object stamp')
    }
    const kind: unknown = Reflect.get(entry, 'kind')
    if (kind !== 'harness' && kind !== 'dsh-web') throw new Error('restart-signal: stamp CLI reported an unknown kind')
    const host: unknown = Reflect.get(entry, 'host')
    const client: unknown = Reflect.get(entry, 'client')
    if (typeof host !== 'string' || typeof client !== 'string') throw new Error('restart-signal: stamp CLI reported a non-string face stamp')
    return { repository: String(Reflect.get(entry, 'repository')), kind, host, client }
  })
}

/**
 * The production gatherer: spawn the stamp CLI against every repository whose
 * manifest carries a host-face baseline (a `null` baseline contributes the
 * combination's `ABSENT` token on both sides, so it needs no current stamp).
 * @param repositoryRoot - Harness repository tree holding the CLI.
 * @param components - Fresh manifest components naming the in-scope repositories.
 * @returns Current per-repository stamps.
 * @throws When the CLI exits non-zero or prints an unreadable body.
 */
export async function runStampCli(
  repositoryRoot: string,
  components: readonly RestartManifestComponent[],
): Promise<readonly CurrentStamp[]> {
  const cli = join(repositoryRoot, 'scripts', 'restart-signal', 'signal-cli.ts')
  const args: string[] = [cli]
  for (const component of components) {
    if (component.hostFaceHash === null) continue
    args.push('--stamp', `${component.repository}:${component.kind}`)
  }
  if (args.length === 1) return []
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: repositoryRoot,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  return parseCliStamps(stdout)
}

let inFlight: Promise<RestartSignalJudgment> | undefined

async function computeRestartSignal(options: RestartSignalOptions): Promise<RestartSignalJudgment> {
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot()
  const runtime = restartStamp(options)
  const fresh = readRestartStamp(options)
  const building = existsSync(join(repositoryRoot, STAMP_DIR, START_CAPTURE_FILE))
  const failed = existsSync(join(repositoryRoot, STAMP_DIR, FAILURE_FILE))
  const configStamp = fresh.sCfg
  if (fresh.state === 'INIT') {
    return judgeRestartSignal({ runtime, fresh, configStamp, building, failed, currentHostFace: undefined, currentClientFace: undefined })
  }
  const needsHostStamp = fresh.components.some(component => component.hostFaceHash !== null)
  let currentHostFace: string | undefined
  let currentClientFace: string | undefined
  if (needsHostStamp) {
    try {
      // The CLI always launches from this module's own harness tree (it lives
      // there); the components it stamps may name other repositories.
      const stamps = await (options.runStampCli ?? runStampCli)(defaultRepositoryRoot(), fresh.components)
      const byRepository = new Map(stamps.map(stamp => [stamp.repository.replace(/\\/g, '/'), stamp]))
      currentHostFace = combineHostFace(
        fresh.components.map(component => [component.repository, component.hostFaceHash === null
          ? 'ABSENT'
          : byRepository.get(component.repository.replace(/\\/g, '/'))?.host ?? 'ABSENT'] as const),
      )
      const harness = stamps.find(stamp => stamp.kind === 'harness')
      currentClientFace = harness?.client
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`ui-settings-general: restart-signal stamp gathering failed: ${message}\n`)
      currentHostFace = undefined
      currentClientFace = undefined
    }
  } else {
    currentHostFace = undefined
    currentClientFace = undefined
  }
  return judgeRestartSignal({ runtime, fresh, configStamp, building, failed, currentHostFace, currentClientFace })
}

/**
 * Recompute the restart signal; concurrent callers coalesce into the one
 * in-flight computation, so repeated call paths (visibility, reconnect,
 * polling) stay idempotent per design (设计 §三: 各路只喊重查).
 * @param options - Injection seams; production uses this process's tree and the stamp CLI.
 * @returns The fresh judgment.
 */
export function collectRestartSignal(options: RestartSignalOptions = {}): Promise<RestartSignalJudgment> {
  inFlight ??= computeRestartSignal(options).finally(() => { inFlight = undefined })
  return inFlight
}

/** Drop the coalescing slot; tests only. */
export function resetRestartSignalForTest(): void {
  inFlight = undefined
}
