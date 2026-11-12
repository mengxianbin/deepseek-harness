/**
 * Restart-signal state machine: the design's seven-state judgment over the
 * S/B/R stamp comparison, plus the off-host gather that feeds it
 * (offhost-1110).
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
 * **Gathering runs outside the host** (负载外移, offhost-1110):
 * the external collector (`scripts/restart-signal/signal-collect.ts`,
 * scheduled as the schtasks task `DSH-Restart-Signal-Collect` on the 60s
 * edge of the design's 30–60s band) is the only process that spawns
 * `scripts/restart-signal/signal-cli.ts`; it re-reads the stamp CLI single
 * source together with this host's persisted runtime capture
 * (`restart-signal-runtime.json`, written once at route registration),
 * judges, and atomically writes `~/.dsh/restart-signal-state.json` carrying
 * its collection instant. This module — and every host request path — only
 * reads that one small file:
 *
 * - stat by `mtime+size`; a changed key is a new collection → parse, publish
 *   the refreshed judgment to the observer roster, and notify the refresh
 *   listeners (which is what makes the host emit `restart-signal/changed`);
 * - a file younger than {@link STATE_FRESH_MS} answers directly (新鲜即读);
 * - a file older than the freshness bound never answers for itself — the
 *   last fresh judgment serves instead (过期回上次值), and with none yet the
 *   collect rejects with {@link RestartSignalStateUnavailableError} so the
 *   route answers its unavailable 504 (响亮，不静默);
 * - `invalidateRestartSignalCache` (the push sensor's move signal) drops the
 *   mtime key, so the next collect re-reads the file instead of answering
 *   from the pre-move read.
 *
 * The host never spawns the stamp CLI: this package's `src` contains no
 * spawn call and no stamp-CLI invocation of any kind — the stamp CLI belongs
 * to the external collector alone (the machine check greps the src tree for
 * the old spawn chain and must find nothing).
 * @module @deepseek-ai/dsh-client-ui-settings-general/restart-signal
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { restartStamp, type RestartStamp } from './restart-stamp.ts'
import { RESTART_SIGNAL_STATES, resolveLinkedBuildSeat, type LinkedBuildState, type RestartSignalReason, type RestartSignalState } from './restart.ts'

/** Gitignored directory holding the per-tree build markers (mirrors the scripts-side constant). */
const STAMP_DIR = '.dsh-build'

/** Build-start capture file name inside the stamp directory (mirrors the scripts-side constant). */
const START_CAPTURE_FILE = 'restart-stamp.start.json'

/** Build-failure record file name inside the stamp directory (mirrors the scripts-side constant). */
const FAILURE_FILE = 'restart-stamp.failed.json'

/** State file the external collector writes into the DSH home (仓外运行态). */
export const RESTART_SIGNAL_STATE_FILE = 'restart-signal-state.json'

/** Runtime-capture file this host writes into the DSH home at registration; the
 * collector reads it to compare "what this process loaded" (R) against a fresh
 * baseline — R lives in this process's memory and exists nowhere else, so this
 * file is how the off-host judgment keeps its NEED_RESTART branch honest. */
export const RESTART_SIGNAL_RUNTIME_FILE = 'restart-signal-runtime.json'

/** Schema id pinning the collector-written file's shape; a mismatch reads as a
 * hard failure (loud) instead of a silently wrong judgment. */
export const RESTART_SIGNAL_STATE_SCHEMA = 'restart-signal-state/1'

/** Schema id of the host runtime capture (mirrors the collector-side constant). */
export const RESTART_SIGNAL_RUNTIME_SCHEMA = 'restart-signal-runtime/1'

/** Freshness bound for one collected state file: the collector's 30–60s
 * cadence plus one late tick. A younger file is served directly; an older one
 * never answers for itself. This bound replaces the 15s result-cache TTL the
 * 1107 cache/timeout fix introduced — that fix's semantics (timeout fallback,
 * 504 with none) stay untouched in the route. */
export const STATE_FRESH_MS = 90_000

/**
 * No servable judgment exists: the state file is absent, or every read so far
 * was stale and none is fresh yet. The route maps this to its unavailable
 * 504 (the "no previous judgment" branch the 12s deadline already had) —
 * never a hang, never a silently stale answer.
 */
export class RestartSignalStateUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RestartSignalStateUnavailableError'
  }
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
  /** Present only on a linked-only `NEED_BUILD` whose named tree carries a
   * data-confirmed machine build state (linked-lamp-twostate-1111); display
   * data attached by the collector AFTER the pure judgment (the same
   * post-judge spread `facts` rides) — `judgeRestartSignal` never produces
   * it, so the seven-state semantics are untouched. */
  readonly linkedBuild?: LinkedBuildState
  /** Present only beside `linkedBuild: 'failed'`: the per-tree failure count.
   * Pair-sanitized by {@link resolveLinkedBuildSeat} (a `failed` without a
   * readable count rides neither half). */
  readonly linkedBuildFailures?: number
  /** Human-readable facts behind the judgment; log and test surface, never copy text. */
  readonly detail: string
  /** Machine facts this judgment consumed; attached by every production collect. */
  readonly facts?: RestartSignalFacts
}

/** One row of the collector-written state file: the judgment plus its collection instant. */
export interface RestartSignalStateEntry {
  /** Collection instant (ISO 8601) the collector stamped the write with. */
  readonly collectedAt: string
  /** The judgment this collection landed on. */
  readonly judgment: RestartSignalJudgment
  /** Repository tree the collection ran against; display/forensics only. */
  readonly repositoryRoot: string | undefined
}

/**
 * Combine per-repository host-face stamps into one hash, mirroring the
 * runtime stamp's own combination (restart-stamp.ts) so a current-stamp
 * combination is directly comparable to the cached R and the fresh B.
 * Production use moved to the external collector with the rest of the gather;
 * kept here as the same combination the R stamp hashes.
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

/**
 * Read the build-start capture time behind the BUILDING lamp, for the timer
 * tooltip only (build-timer-tooltip-1101); the lamp itself keys on the
 * capture's existence. A malformed or unreadable capture degrades to
 * `undefined` — the plain Building copy — instead of failing the judgment.
 * Production reads it in the external collector while gathering; kept as a
 * pure file read for that consumer and for tests.
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

/** Injection seams for one state read: the DSH home (or a direct path) holding
 * the collector's state file. Production resolves the DSH home. */
export interface RestartSignalOptions {
  /** DSH home whose state file answers; defaults to `resolveDshHome()`. */
  readonly dshHome?: string
  /** Direct state-file path; wins over `dshHome`. Tests substitute a fixture file. */
  readonly statePath?: string
}

/** Resolve the state file one collect reads. */
function statePathOf(options: RestartSignalOptions): string {
  if (options.statePath !== undefined) return options.statePath
  return join(resolveDshHome(options.dshHome), RESTART_SIGNAL_STATE_FILE)
}

/** Validate one parsed state-file body; a malformed file is a hard failure
 * (loud), never a silently wrong answer. */
function parseStateEntry(text: string, path: string): RestartSignalStateEntry {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(`restart-signal state file is not JSON (${path}): ${cause}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`restart-signal state file has a non-object body (${path})`)
  }
  const schema: unknown = Reflect.get(parsed, 'schema')
  if (schema !== RESTART_SIGNAL_STATE_SCHEMA) {
    throw new Error(`restart-signal state file schema mismatch (${path}): ${String(schema)}`)
  }
  const collectedAt: unknown = Reflect.get(parsed, 'collectedAt')
  if (typeof collectedAt !== 'string' || !Number.isFinite(Date.parse(collectedAt))) {
    throw new Error(`restart-signal state file has no readable collectedAt (${path})`)
  }
  const judgment = parseStateJudgment(Reflect.get(parsed, 'judgment'))
  if (judgment === undefined) {
    throw new Error(`restart-signal state file has a malformed judgment (${path})`)
  }
  const repositoryRoot: unknown = Reflect.get(parsed, 'repositoryRoot')
  return { collectedAt, judgment, repositoryRoot: typeof repositoryRoot === 'string' ? repositoryRoot : undefined }
}

/** Shape-check the collector's judgment against the same vocabulary the wire
 * validator uses, plus the judgment-only `detail`/`facts` seats. */
function parseStateJudgment(value: unknown): RestartSignalJudgment | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const state: unknown = Reflect.get(value, 'state')
  if (typeof state !== 'string' || !RESTART_SIGNAL_STATES.includes(state as RestartSignalState)) return undefined
  const detail: unknown = Reflect.get(value, 'detail')
  if (typeof detail !== 'string') return undefined
  const reason: unknown = Reflect.get(value, 'reason')
  if (reason !== undefined && reason !== 'config' && reason !== 'built') return undefined
  const startedAt: unknown = Reflect.get(value, 'startedAt')
  if (startedAt !== undefined && (typeof startedAt !== 'string' || !Number.isFinite(Date.parse(startedAt)))) return undefined
  const linkedRepo: unknown = Reflect.get(value, 'linkedRepo')
  if (linkedRepo !== undefined && (typeof linkedRepo !== 'string' || linkedRepo === '')) return undefined
  // The linked-build pair is display-only: a malformed half fails OPEN to an
  // absent seat (the plain linked copy keeps the lamp honest) instead of
  // failing the whole judgment — one bad copy seat must never 500 the route.
  const linkedBuild = resolveLinkedBuildSeat(Reflect.get(value, 'linkedBuild'), Reflect.get(value, 'linkedBuildFailures'))
  const facts = parseStateFacts(Reflect.get(value, 'facts'))
  if (facts === 'invalid') return undefined
  return {
    state: state as RestartSignalState,
    detail,
    ...(reason === undefined ? {} : { reason }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(linkedRepo === undefined ? {} : { linkedRepo }),
    ...(linkedBuild === undefined ? {} : linkedBuild),
    ...(facts === undefined ? {} : { facts }),
  }
}

/** Shape-check the optional facts seat; `undefined` = absent, `'invalid'` = malformed. */
function parseStateFacts(value: unknown): RestartSignalFacts | undefined | 'invalid' {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalid'
  const configStamp: unknown = Reflect.get(value, 'configStamp')
  if (typeof configStamp !== 'string') return 'invalid'
  const rawHost: unknown = Reflect.get(value, 'currentHostFace')
  if (rawHost !== undefined && typeof rawHost !== 'string') return 'invalid'
  const ownFaceMoved: unknown = Reflect.get(value, 'ownFaceMoved')
  if (ownFaceMoved !== undefined && typeof ownFaceMoved !== 'boolean') return 'invalid'
  return {
    currentHostFace: rawHost === undefined ? undefined : rawHost,
    configStamp,
    ...(ownFaceMoved === undefined ? {} : { ownFaceMoved }),
  }
}

/** Identity of one judgment for change detection: only the seats that can move
 * a listener's mind, in a fixed order, so a rewritten-but-identical file never
 * re-fires the roster or the push leg. */
function judgmentKey(judgment: RestartSignalJudgment): string {
  return JSON.stringify([
    judgment.state,
    judgment.reason ?? null,
    judgment.startedAt ?? null,
    judgment.linkedRepo ?? null,
    // linked-lamp-twostate-1111: the pair moves a listener's mind (plain
    // linked line → building/failed), so it keys the change detection and the
    // push bell rings on the transition.
    judgment.linkedBuild ?? null,
    judgment.linkedBuildFailures ?? null,
    judgment.detail,
    judgment.facts === undefined
      ? null
      : [judgment.facts.currentHostFace ?? null, judgment.facts.configStamp, judgment.facts.ownFaceMoved ?? null],
  ])
}

/** Path of the file the current reader is keyed on; a path switch (fixture
 * swap) resets the whole read state so one store never answers for another. */
let readPath: string | undefined

/** `mtimeMs|size` of the last parsed file; a change is a new collection. */
let readKey: string | undefined

/** The most recent FRESH judgment this process served — the stale-file
 * fallback (过期回上次值) and the route's timeout fallback alike. */
let lastJudgment: RestartSignalJudgment | undefined

/** Key of the judgment last published, so identical rewrites stay quiet. */
let publishedKey: string | undefined

let inFlight: Promise<RestartSignalJudgment> | undefined

/** Host-side observers of every fresh judgment (P3: the auto-build throttle and the
 * restart disposition both ride the route/polling stream instead of running
 * a second collector). Listener failures are isolated to one stderr line. */
const judgmentListeners = new Set<(judgment: RestartSignalJudgment) => void>()

/** Host-side observers of a refreshed state read — the route registration maps
 * this onto the allowlisted `restart-signal/changed` push (语义随迁 ②: the
 * host still rings the bell when, and only when, the judgment moved). */
const refreshListeners = new Set<(judgment: RestartSignalJudgment) => void>()

/**
 * Observe every fresh judgment the state machine delivers (once per new state
 * file read whose judgment moved, on every collect path: recheck route,
 * polling, client calls).
 * @param listener - Called with the judgment carrying its machine facts.
 * @returns Unsubscribe handle.
 */
export function onRestartSignalJudgment(listener: (judgment: RestartSignalJudgment) => void): () => void {
  judgmentListeners.add(listener)
  return () => { judgmentListeners.delete(listener) }
}

/**
 * Observe refreshed state reads (a new collection whose judgment moved): the
 * push leg's source. Fires at most once per collector write, never on a
 * repeated identical judgment.
 * @param listener - Called with the refreshed judgment.
 * @returns Unsubscribe handle.
 */
export function onRestartSignalStateRefresh(listener: (judgment: RestartSignalJudgment) => void): () => void {
  refreshListeners.add(listener)
  return () => { refreshListeners.delete(listener) }
}

function publishJudgment(judgment: RestartSignalJudgment): void {
  for (const listener of judgmentListeners) {
    try {
      listener(judgment)
    } catch (error) {
      process.stderr.write(`ui-settings-general: restart-signal judgment listener failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  for (const listener of refreshListeners) {
    try {
      listener(judgment)
    } catch (error) {
      process.stderr.write(`ui-settings-general: restart-signal refresh listener failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}

/**
 * Read the collector's state file and answer the freshest servable judgment.
 * Concurrent callers coalesce into one read (the 单飞合并 contract survives
 * the move: repeated call paths stay idempotent per design 设计 §三).
 *
 * A changed `mtime+size` is a new collection: it is parsed, published to the
 * observer roster (and the refresh listeners — the push bell), and, while
 * fresh, becomes the served judgment. An unchanged key answers the stored
 * judgment verbatim without touching the file again. A stale file never
 * adopts: the last fresh judgment serves, and without one the read rejects
 * with {@link RestartSignalStateUnavailableError} — never a hang, never a
 * silently stale answer.
 * @param options - State-file seams; production resolves the DSH home.
 * @returns The fresh (or stale-fallback) judgment.
 * @throws {@link RestartSignalStateUnavailableError} when nothing servable exists;
 *   a malformed or unreadable file rejects with a plain error (route → 500).
 */
export function collectRestartSignal(options: RestartSignalOptions = {}): Promise<RestartSignalJudgment> {
  inFlight ??= readState(options).finally(() => { inFlight = undefined })
  return inFlight
}

async function readState(options: RestartSignalOptions): Promise<RestartSignalJudgment> {
  const path = statePathOf(options)
  if (readPath !== path) {
    readPath = path
    readKey = undefined
    lastJudgment = undefined
    publishedKey = undefined
  }
  let mtimeMs: number
  let size: number
  try {
    const info = await stat(path)
    mtimeMs = info.mtimeMs
    size = info.size
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new RestartSignalStateUnavailableError(`restart-signal state file absent: ${path} (collector not written yet?)`)
    }
    throw error
  }
  const key = `${String(mtimeMs)}|${String(size)}`
  if (key === readKey) {
    if (lastJudgment !== undefined) return lastJudgment
    throw new RestartSignalStateUnavailableError(`restart-signal state file still stale: ${path}`)
  }
  const entry = parseStateEntry(await readFile(path, 'utf8'), path)
  readKey = key
  const fresh = Date.now() - mtimeMs <= STATE_FRESH_MS
  if (!fresh) {
    // 过期回上次值: a stale collection never publishes and never adopts.
    if (lastJudgment !== undefined) return lastJudgment
    throw new RestartSignalStateUnavailableError(
      `restart-signal state file stale (age ${String(Math.round((Date.now() - mtimeMs) / 1000))}s > ${String(STATE_FRESH_MS)}ms) and no previous judgment: ${path}`,
    )
  }
  const identity = judgmentKey(entry.judgment)
  if (publishedKey !== identity) {
    publishedKey = identity
    publishJudgment(entry.judgment)
  }
  lastJudgment = entry.judgment
  return entry.judgment
}

/**
 * Drop the state-file mtime key so the next collect re-reads the file
 * instead of answering from the pre-move read. The push sensor calls this
 * when its fingerprint or build-marker delta proved a move
 * (restart-signal-poll-host): the file the collector writes after that move
 * — and every page pull `restart-signal/changed` pokes — must be read anew.
 * The last fresh judgment stays (it is the stale-file fallback, not an answer
 * the move discredited: the move is about freshness, which the mtime key
 * now carries).
 */
export function invalidateRestartSignalCache(): void {
  readKey = undefined
}

/**
 * The most recent FRESH judgment this process served, however old — the
 * recheck route's timeout answers from it so a hung read can never hang the
 * request (an old truth beats a hang, never a fresher-than-truth guess).
 * @returns The stored judgment; `undefined` before the first fresh read.
 */
export function lastRestartSignalJudgment(): RestartSignalJudgment | undefined {
  return lastJudgment
}

/**
 * Persist this process's runtime capture (R) where the external collector can
 * read it: one atomic write at route registration, never per request. R is a
 * process-start fact — the host face this process loaded plus the S_cfg of its
 * capture moment — and without this file the collector could only ever compare
 * a fresh baseline against itself, erasing the NEED_RESTART branch entirely.
 *
 * Failures are loud on stderr and never take the registration down (the route
 * serves whatever the collector manages to write; a collector that finds no
 * runtime capture fails loudly on its own side).
 * @param dshHome - DSH home to write into; defaults to `resolveDshHome()`.
 */
export function persistRestartSignalRuntime(dshHome?: string): void {
  // Test workers inherit the real home unless a spec sandboxes it (the
  // DSH_HOME override pattern restart-stamp specs use): never let a suite
  // clobber the production capture — a sandboxed run opts back in. Same
  // guard as session-controller's fork-ledger write (commands.ts).
  if (process.env.VITEST !== undefined && process.env.DSH_HOME === undefined) return
  try {
    const stamp = restartStamp(dshHome === undefined ? {} : { dshHome })
    const target = join(dshHome ?? resolveDshHome(), RESTART_SIGNAL_RUNTIME_FILE)
    mkdirSync(dirname(target), { recursive: true })
    const tempPath = `${target}.tmp-${String(process.pid)}`
    writeFileSync(tempPath, JSON.stringify({ schema: RESTART_SIGNAL_RUNTIME_SCHEMA, ...stamp }))
    renameSync(tempPath, target)
  } catch (error) {
    process.stderr.write(`ui-settings-general: restart-signal runtime capture persist failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/** Drop the read state, both rosters, and the coalescing slot; tests only. */
export function resetRestartSignalForTest(): void {
  inFlight = undefined
  readPath = undefined
  readKey = undefined
  lastJudgment = undefined
  publishedKey = undefined
  judgmentListeners.clear()
  refreshListeners.clear()
}
