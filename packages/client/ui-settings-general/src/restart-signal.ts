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
 * Linked-split (口径拆分, 2026-11-01): `INIT` can only come from this tree's
 * own manifest being missing (`readRestartStamp` keeps linked absences in
 * `notices`); a `NEED_BUILD` lamp still fires when ANY in-scope face moved —
 * linked drift really is unbuilt source, so the lamp stays honest — but the
 * judgment carries `ownFaceMoved` so the build dispatcher's trigger scope
 * (构建触发口径) can be this tree's face alone; and the R/B restart comparison
 * keeps every component including linked ones, because the plugin `lib` this
 * process loaded comes from those trees ("linked just rebuilt, process not
 * reloaded" must keep raising NEED_RESTART `built`).
 *
 * Gathering runs the stamp CLI (`scripts/restart-signal/signal-cli.ts`) in a
 * short-lived child process so a recompute never blocks the host event loop;
 * concurrent rechecks coalesce into one in-flight computation, and a repeat
 * collect inside a short result cache answers the stored judgment without
 * spawning the CLI again (stamp-recheck-cache-timeout-1107). The cache is
 * bounded three ways — a 15s TTL, the own-tree build-marker state it was
 * filled under (a BUILDING/failed flip invalidates at once, never waiting out
 * the TTL), and an explicit invalidation the push sensor fires when its
 * fingerprint delta proved a source/config move — so no judgment older than
 * one of those bounds can be served.
 * @module @deepseek-ai/dsh-client-ui-settings-general/restart-signal
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { readBuildingCapture } from './build-start-liveness.ts'
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
  /** Build-start capture time (ISO 8601) while a build is running; display data
   * behind the BUILDING lamp's timer tooltip (build-timer-tooltip-1101), never
   * a judgment input — the lamp itself still keys on the capture's existence. */
  readonly buildingStartedAt?: string | undefined
  /** True while a build-failure record sits in the harness tree: the last build failed. */
  readonly failed: boolean
  /** Combined current host-face source stamp (S.host); `undefined` when stamps were unavailable. */
  readonly currentHostFace: string | undefined
  /** Current client-face source stamp of the harness tree; `undefined` when stamps were unavailable. */
  readonly currentClientFace: string | undefined
  /** Whether THIS tree's own host face moved past its own manifest baseline — the
   * build-trigger scope (构建触发口径 = 主仓面). `undefined` when the own component or
   * its current stamp was unavailable (conservative: the dispatcher keeps its
   * pre-split dispatch behaviour); `false` names linked-only drift, which no
   * build of this tree can clear. */
  readonly ownFaceMoved?: boolean | undefined
  /** Linked repositories whose current host stamp moved past their own manifest
   * baselines (build-scope-rework-1105 A): names the drift in the NEED_BUILD
   * detail and rides the wire as `linkedRepo` so the lamp copy can point at the
   * tree that owes a build. `undefined` on judgment paths that do not collect it
   * (the detail then keeps its pre-A wording). */
  readonly linkedRepos?: readonly string[] | undefined
}

/** The machine facts a judgment was computed from (P3 observation seam: change-sensitive
 * consumers — the auto-build throttle — distinguish a moved source from a repeated
 * identical judgment without a second stamp channel). */
export interface RestartSignalFacts {
  /** Combined current host-face source stamp; `undefined` when stamps were unavailable. */
  readonly currentHostFace: string | undefined
  /** Current configured-source stamp. */
  readonly configStamp: string
  /** Whether this tree's own host face moved past its own baseline — the build
   * dispatcher reads it off the fresh judgment to keep the dispatch trigger on
   * the 主仓面; `undefined` when unavailable (conservative dispatch). */
  readonly ownFaceMoved?: boolean | undefined
}

/** One judgment: the state machine's full output. */
export interface RestartSignalJudgment {
  readonly state: RestartSignalState
  /** Present only on `NEED_RESTART`: which restart branch fired. */
  readonly reason?: RestartSignalReason
  /** Present only on a linked-only `NEED_BUILD` (ownFaceMoved=false): the drifted
   * linked repository path the lamp copy names — first of the drifted set, the
   * full set riding `detail` (build-scope-rework-1105 A). Display data. */
  readonly linkedRepo?: string
  /** Present only on `BUILDING` when the start capture carried a readable
   * time: the build-start instant (ISO 8601) the browser renders as the
   * timer tooltip's start stamp and elapsed age (build-timer-tooltip-1101). */
  readonly startedAt?: string
  /** Human-readable facts behind the judgment; log and test surface, never copy text. */
  readonly detail: string
  /** Machine facts this judgment consumed; attached by every production collect. */
  readonly facts?: RestartSignalFacts
}

/** Normalize a repository path for combination/lookup comparisons (separator-insensitive). */
function normalizeRepository(repository: string): string {
  return repository.replace(/\\/g, '/')
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
 * no clock, deterministic for identical inputs. Linked-manifest notices from
 * the fresh read ride every judgment's `detail` — recorded, never
 * lamp-locking (linked-split 2026-11-01).
 * @param inputs - R, fresh B, S_cfg, build markers, and current source stamps.
 * @returns The state, the restart branch when relevant, and the facts behind it.
 */
export function judgeRestartSignal(inputs: RestartSignalInputs): RestartSignalJudgment {
  const judgment = judgeCore(inputs)
  const notices = inputs.fresh.notices
  return notices.length === 0 ? judgment : { ...judgment, detail: `${judgment.detail} | ${notices.join('; ')}` }
}

function judgeCore(inputs: RestartSignalInputs): RestartSignalJudgment {
  if (inputs.fresh.state === 'INIT') {
    return { state: 'INIT', detail: `baseline manifest missing: ${inputs.fresh.reasons.join('; ')}` }
  }
  if (inputs.building) {
    const startedAt = inputs.buildingStartedAt
    return {
      state: 'BUILDING',
      ...(startedAt === undefined ? {} : { startedAt }),
      detail: `build-start capture present at ${STAMP_DIR}/${START_CAPTURE_FILE}`,
    }
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
    // The lamp may name linked drift (unbuilt source is unbuilt source — honest),
    // but ownFaceMoved=false pins the gap on a linked tree: the build trigger
    // (构建触发口径) stays on this tree's face, and the dispatcher defers instead
    // of rebuilding this tree forever (linked-split 2026-11-01, second loop).
    if (inputs.ownFaceMoved === false) {
      // A (build-scope-rework-1105): name the drifted trees — the full set in
      // the log-surface detail, the first as `linkedRepo` for the copy seat.
      // Without linkedRepos (judgment paths that do not collect them) the
      // pre-A detail and an absent linkedRepo both stay exactly as before.
      const drifted = inputs.linkedRepos ?? []
      const named = drifted.length === 0 ? '' : `; drifted: ${drifted.join(', ')}`
      return {
        state: 'NEED_BUILD',
        ...(drifted.length === 0 ? {} : { linkedRepo: drifted[0] }),
        detail: 'linked repository source moved past its build baseline while this tree agrees with its own; no build of this tree can clear it (build trigger scope: this tree only)'.concat(named),
      }
    }
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

/**
 * Read the build-start capture time behind the BUILDING lamp, for the timer
 * tooltip only (build-timer-tooltip-1101); the lamp itself keys on the
 * capture's existence. A malformed or unreadable capture degrades to
 * `undefined` — the plain Building copy — instead of failing the judgment.
 * @param repositoryRoot - Harness repository tree holding `.dsh-build`.
 * @returns The capture time (ISO 8601) or `undefined` when unreadable.
 */
export function readBuildStartCaptureTime(repositoryRoot: string): string | undefined {
  let text: string
  try {
    text = readFileSync(join(repositoryRoot, STAMP_DIR, START_CAPTURE_FILE), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (record.kind !== 'harness-start' || record.version !== 1) return undefined
  const time = record.time
  return typeof time === 'string' && Number.isFinite(Date.parse(time)) ? time : undefined
}

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

/** Result-cache TTL: 15s — a sixth of the host's 90s attestation freshness window
 * (`restart-disposition.ts` `ATTESTATION_MAX_AGE_MS`, design = P11 报告 §五) and
 * half the client's 30s refresh cadence (`client/restart-signal-flow.ts`
 * `DEFAULT_REFRESH_MS`), so a cached judgment can never age past one refresh tick
 * (freshness-window check, stamp-recheck-cache-timeout-1107: TTL ≤ 90s 窗的保守份额 → 无语义变更). */
const CACHE_TTL_MS = 15_000

/** One cached judgment plus the inputs it was keyed and probed under. */
interface RestartSignalCacheEntry {
  /** The stored judgment; served verbatim on a hit (`startedAt` and all display fields ride along). */
  readonly judgment: RestartSignalJudgment
  /** Separator-normalized repository root the collect ran against (the cache key). */
  readonly repositoryRoot: string
  /** Epoch ms of the fill; a hit must land within {@link CACHE_TTL_MS}. */
  readonly at: number
  /** Own-tree build-start marker state probed *before* the compute it labels. */
  readonly building: boolean
  /** Own-tree build-failure marker state probed *before* the compute it labels. */
  readonly failed: boolean
}

let cache: RestartSignalCacheEntry | undefined

/** Host-side observers of every fresh judgment (P3: the auto-build throttle and the
 * restart disposition both ride the route/polling recheck stream instead of running
 * a second collector). Listener failures are isolated to one stderr line. */
const judgmentListeners = new Set<(judgment: RestartSignalJudgment) => void>()

/**
 * Observe every fresh judgment the state machine produces (once per coalesced
 * computation, on every collect path: recheck route, polling, client calls).
 * @param listener - Called with the judgment carrying its machine facts.
 * @returns Unsubscribe handle.
 */
export function onRestartSignalJudgment(listener: (judgment: RestartSignalJudgment) => void): () => void {
  judgmentListeners.add(listener)
  return () => { judgmentListeners.delete(listener) }
}

function publishJudgment(judgment: RestartSignalJudgment, facts: RestartSignalFacts): RestartSignalJudgment {
  const enriched: RestartSignalJudgment = judgment.facts === undefined ? { ...judgment, facts } : judgment
  for (const listener of judgmentListeners) {
    try {
      listener(enriched)
    } catch (error) {
      process.stderr.write(`ui-settings-general: restart-signal judgment listener failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  return enriched
}

async function computeRestartSignal(options: RestartSignalOptions): Promise<RestartSignalJudgment> {
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot()
  const runtime = restartStamp(options)
  const fresh = readRestartStamp(options)
  // O-1103: this read doubles as the liveness probe — a marker whose build
  // process died is cleared here (one `orphan-start-marker-cleared` journal
  // line), so the judgment below recovers from a permanent BUILDING in the
  // same pass instead of waiting for a rerun's beginBuild to overwrite it.
  const building = readBuildingCapture(repositoryRoot)
  const buildingStartedAt = building ? readBuildStartCaptureTime(repositoryRoot) : undefined
  const failed = existsSync(join(repositoryRoot, STAMP_DIR, FAILURE_FILE))
  const configStamp = fresh.sCfg
  if (fresh.state === 'INIT') {
    return publishJudgment(
      judgeRestartSignal({
        runtime, fresh, configStamp, building, buildingStartedAt, failed,
        currentHostFace: undefined, currentClientFace: undefined,
      }),
      { currentHostFace: undefined, configStamp },
    )
  }
  const needsHostStamp = fresh.components.some(component => component.hostFaceHash !== null)
  // 构建触发口径 = 主仓面: this tree's own component (always present at BASELINE —
  // INIT owns the missing-own case) and its current stamp decide ownFaceMoved,
  // the fact the dispatcher reads to keep harness builds off linked-only drift.
  const own = fresh.components.find(component => normalizeRepository(component.repository) === normalizeRepository(repositoryRoot))
  let ownFaceMoved: boolean | undefined = own !== undefined && own.hostFaceHash === null ? false : undefined
  let linkedRepos: readonly string[] | undefined
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
      if (own !== undefined && own.hostFaceHash !== null) {
        ownFaceMoved = byRepository.get(normalizeRepository(own.repository))?.host !== own.hostFaceHash
      }
      // A (build-scope-rework-1105): every non-own component whose current stamp
      // exists and moved past its own baseline — the linked trees that owe a
      // build. Only a *present* differing stamp counts: a missing current stamp
      // already reads ABSENT in the combination and names nothing new here.
      linkedRepos = fresh.components
        .filter(component => normalizeRepository(component.repository) !== normalizeRepository(repositoryRoot)
          && component.hostFaceHash !== null)
        .filter((component) => {
          const stamp = byRepository.get(normalizeRepository(component.repository))
          return stamp !== undefined && stamp.host !== component.hostFaceHash
        })
        .map(component => component.repository)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`ui-settings-general: restart-signal stamp gathering failed: ${message}\n`)
      currentHostFace = undefined
      currentClientFace = undefined
      ownFaceMoved = undefined
      linkedRepos = undefined
    }
  } else {
    currentHostFace = undefined
    currentClientFace = undefined
  }
  return publishJudgment(
    judgeRestartSignal({
      runtime, fresh, configStamp, building, buildingStartedAt, failed,
      currentHostFace, currentClientFace, ownFaceMoved, linkedRepos,
    }),
    { currentHostFace, configStamp, ownFaceMoved },
  )
}

/** The cheap own-tree build-marker state both sides of the cache decision probe:
 * the same two reads the compute makes (the liveness probe may journal-and-clear an
 * orphan, which the compute then simply observes as absent). Linked trees are out of
 * scope here — their marker transitions ride the push sensor's in-scope signature
 * (stamp-poll-host, ≤ one 30s tick). */
function ownMarkerState(repositoryRoot: string): { readonly building: boolean; readonly failed: boolean } {
  return {
    building: readBuildingCapture(repositoryRoot),
    failed: existsSync(join(repositoryRoot, STAMP_DIR, FAILURE_FILE)),
  }
}

/**
 * Recompute the restart signal; concurrent callers coalesce into the one
 * in-flight computation, so repeated call paths (visibility, reconnect,
 * polling) stay idempotent per design (设计 §三: 各路只喊重查).
 *
 * A repeat collect inside the result cache answers the stored judgment
 * without spawning the stamp CLI, keyed on the repository root, bounded by
 * the TTL and the own-tree marker state the fill probed (see the module doc).
 * A hit returns the stored object verbatim — display fields such as the
 * BUILDING `startedAt` ride along untouched — and never publishes to the
 * observer roster, because it is not a fresh computation (one publish per
 * compute keeps the "单飞合并" contract exact).
 * @param options - Injection seams; production uses this process's tree and the stamp CLI.
 * @returns The fresh (or, within the TTL, the stored) judgment.
 */
export function collectRestartSignal(options: RestartSignalOptions = {}): Promise<RestartSignalJudgment> {
  // The async wrapper keeps the original failure contract: a degenerate root
  // resolution rejects the returned promise (as the compute always has), never
  // throws synchronously at the caller — while the body still runs its cache
  // check synchronously, so concurrent callers join one promise as before.
  inFlight ??= (async () => {
    const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot()
    const key = normalizeRepository(repositoryRoot)
    // Probed on every collect — once — so the fill labels its judgment with the
    // marker state the compute starts from, and a flip during or after the run
    // surfaces as a hit-path mismatch (a recompute) instead of a stale serve.
    const probed = ownMarkerState(repositoryRoot)
    const entry = cache
    if (entry !== undefined
      && entry.repositoryRoot === key
      && entry.building === probed.building
      && entry.failed === probed.failed
      && Date.now() - entry.at < CACHE_TTL_MS) {
      return entry.judgment
    }
    const judgment = await computeRestartSignal(options)
    cache = { judgment, repositoryRoot: key, at: Date.now(), building: probed.building, failed: probed.failed }
    return judgment
  })().finally(() => { inFlight = undefined })
  return inFlight
}

/**
 * Drop the result cache so the next collect recomputes. The push sensor calls
 * this when its fingerprint or build-marker delta proved a move
 * (stamp-poll-host): that delta already knows the stored judgment is stale, so
 * the recheck it triggers — and every page pull `restart-signal/changed` pokes
 * after it — must recompute rather than answer from the pre-move result.
 */
export function invalidateRestartSignalCache(): void {
  cache = undefined
}

/**
 * The most recent judgment this process computed, however old — the recheck
 * route's timeout answers from it so a hung gather can never hang the request
 * (an old truth beats a hang, never a fresher-than-truth guess).
 * @returns The stored judgment; `undefined` before the first computation.
 */
export function lastRestartSignalJudgment(): RestartSignalJudgment | undefined {
  return cache?.judgment
}

/** Drop the coalescing slot, the result cache, and the observer roster; tests only. */
export function resetRestartSignalForTest(): void {
  inFlight = undefined
  cache = undefined
  judgmentListeners.clear()
}
