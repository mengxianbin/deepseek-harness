/**
 * Auto-build executor — THE single build executor of the machine
 * (build-dispatch-single-source ①⑤, 2026-11-13; design:
 * m-note `content/tech/ai/dsh/build-dispatch-exec-1113.md`).
 *
 * Usage (tsx entry, cwd = the tree it builds):
 *
 *     node <harness>/node_modules/tsx/dist/cli.mjs <harness>/scripts/auto-build-exec.ts
 *
 * Everything that used to make the HOST one of two dispatchers now lives
 * here, in exactly one process at a time:
 *
 * 1. **Single instance = kernel handle for the whole execution period.** A
 *    Windows named pipe (`\\.\pipe\dsh-auto-build-exec-<rootHash>`) is held
 *    from before the re-judgment until after the build and journal flush; a
 *    second instance's `listen` fails `EADDRINUSE` and it journals
 *    `single-instance busy` and exits directly (0 — benign: someone is already
 *    doing the work). A dead holder's pipe is released by the kernel, so there
 *    is no stale heuristic to race (and no cold-start double-spawn window:
 *    2026-11-09 storm 洞① by construction). Per-tree name: parallel trees
 *    never contend with each other. This is NOT the heavy-io gate's business —
 *    the gate queues many initiators (纯排队串行, 2026-11-13), this handle
 *    enforces executor uniqueness; the two layers do not duplicate each other.
 * 2. **Re-judge, payload-free.** The kick (host token / watchdog tick /
 *    human run) carries nothing; this process re-reads the state machine's own
 *    collected judgment (`collectRestartSignal`, the offhost collector's single
 *    source) — N kicks = N re-reads of the same latest judgment. Stale or
 *    missing state → `judge-unavailable` LOUD, exit 2, the next watchdog tick
 *    retries; never a guess.
 * 3. **Stability window then ONE gated build.** `stableMs` (default 15s) of
 *    unchanged judgment facts before dispatch — a source still being edited
 *    defers (`defer unstable`) instead of building a half-edited tree. The
 *    build is the package script `pnpm run build`, which the 30-key gate
 *    wrapping already serializes machine-wide; no lock pre-probe here — the
 *    gate's queue is the coordination (协调不重复造).
 * 4. **Linked leg account follows execution authority** (裁决档 件①): the
 *    pre-claim (`outcome=failed` BEFORE the run — a killed build still lands
 *    in cooldown), the success/failure/stall updates and the four journal
 *    texts (`linked-build repo=` / `-failed` / `-done` / `-stall`, verbatim
 *    from the watchdog — the linked lamp's regex reads them, plus
 *    `linkedBuild` seat compatibility) all moved here from m-note's
 *    `build-watchdog.py`, which now judges and kicks only. The account file is
 *    read-modify-written under its own short mkdir lock (the watchdog still
 *    writes `driftLogged`, its episode dedup — field-partitioned, see design
 *    §七 偏差 5).
 * 5. **Failout + heartbeat + seq journal.** Stdio is captured to files (fd
 *    redirection, not pipes — a pipe dying with us must not fail a live
 *    build), a non-zero exit folds both tails into ONE `build-failed` line,
 *    exit 0 stays silent; for the WHOLE execution period a `heartbeat` line
 *    lands every `heartbeatMs` (⑤③ — the kernel handle defines the period);
 *    every line rides the shared seq protocol (⑤) as `[exec]`.
 *
 * Exit codes: `0` ran / deferred / another instance owns it · `1` a build
 * failed (own or linked) · `2` judgment (or cohort) unavailable — loud.
 *
 * Seams (tests substitute all of it): `collect`, `launch`, `runCaptured`,
 * `listCohort`, `acquireInstance`, marker probes, `journal`, `warn`, clock.
 * Environment: `DSH_AUTO_BUILD_STABLE_MS`, `DSH_AUTO_BUILD_HEARTBEAT_MS`, and
 * `DSH_RESTART_SIGNAL_STATE` — an isolation seam that points the re-judgment at
 * an alternate collector state file (spec/E2E only; production never sets it,
 * so `~/.dsh` stays the single state face).
 * @module auto-build-exec
 */
import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { withDirLock } from '../packages/client/ui-settings-general/src/dir-lock.ts'
import { defaultAutoBuildJournalLine } from '../packages/client/ui-settings-general/src/auto-build-journal.ts'
import { readBuildingCapture } from '../packages/client/ui-settings-general/src/build-start-liveness.ts'
import { collectRestartSignal, type RestartSignalJudgment } from '../packages/client/ui-settings-general/src/restart-signal.ts'
import { defaultRepositoryRoot } from '../packages/client/ui-settings-general/src/restart-stamp.ts'

/** Gitignored directory holding the per-tree build markers. */
const STAMP_DIR = '.dsh-build'

/** Build-failure record (the state machine reads it; the executor gates on its age). */
const FAILURE_FILE = 'restart-stamp.failed.json'

/** Own baseline manifest (INIT cause-split defense). */
const MANIFEST_FILE = 'restart-stamp.json'

/** Build stdout capture file inside the stamp directory (failout). */
export const STDOUT_CAPTURE_FILE = 'auto-build.stdout.tmp'

/** Build stderr capture file inside the stamp directory (failout). */
export const STDERR_CAPTURE_FILE = 'auto-build.stderr.tmp'

/** Bytes of each captured stream kept in a `build-failed` journal line. */
const FAILURE_TAIL_BYTES = 4 * 1024

/** Rolling cap per captured stream held in memory for the linked leg. */
const LINKED_CAPTURE_CAP_BYTES = 1024 * 1024

/** Journal tail folded from a failed linked build (watchdog口径 verbatim). */
const LINKED_JOURNAL_TAIL_CHARS = 1500

/** Default build command: the gate-wrapped umbrella build (own tree). */
const DEFAULT_BUILD_COMMAND = 'pnpm run build'

/** Failure cooldown mirrored from the watchdog judgment (10 min after a fail). */
const FAILURE_COOLDOWN_MS = 10 * 60_000

/** Default stability window (design §四, unchanged from the old dispatcher). */
const DEFAULT_STABLE_MS = 15_000

/** Default heartbeat cadence while the execution period is held (⑤③). */
const DEFAULT_HEARTBEAT_MS = 60_000

/** Per-tree linked account file (schema kept; writers = this executor + the
 * watchdog's `driftLogged` dedup field, serialized by {@link LINKED_STATE_LOCK}). */
const LINKED_STATE_FILE = 'linked-build-state.json'

/** mkdir lock serializing every read-modify-write of the linked account. */
const LINKED_STATE_LOCK = 'linked-build-state.lock'

const LINKED_COOLDOWN_BASE_MS = 10 * 60_000
const LINKED_COOLDOWN_MAX_MS = 60 * 60_000

function envMillis(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.max(parsed, min)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Separator-insensitive repository comparison (watchdog口径). */
function normalizeRepository(repository: string): string {
  return repository.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** A child-process seam over one build spawn: terminal close and error. */
export interface ExecChild {
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'close', listener: (code: number | null) => void): void
}

/** Own-build launcher seam (the old dispatcher's seam, moved here). */
export type BuildLauncher = (commandLine: string, options: SpawnOptions) => ExecChild

/** Captured run result for the linked leg (watchdog `subprocess.run` mirror). */
export interface CapturedRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** One cohort row as `signal-cli --list-cohort` answers it. */
export interface CohortEntry {
  readonly repository?: unknown
  readonly manifest?: unknown
  readonly current?: unknown
}

/** One tree's seat of the linked account (schema mirrors the Python writer;
 * fields are mutable because the executor's RMW mutates one seat in place). */
export interface LinkedRepoState {
  failures?: number
  lastAttemptAt?: string | null
  outcome?: string | null
  stall?: { readonly manifestTime: string } | null
  driftLogged?: unknown
}

/** The linked account document. */
export interface LinkedState {
  readonly version?: number
  readonly repos?: Record<string, LinkedRepoState>
}

/** The single-instance lease: holds the kernel handle for the execution period. */
export interface InstanceLease {
  /** Release the handle (kernel object disappears — a dead holder's too). */
  release: () => Promise<void>
}

/** Injection seams for one executor run. */
export interface AutoBuildExecOptions {
  /** Tree to judge and build; defaults to this script's own tree. */
  readonly repositoryRoot?: string
  /** Stamp directory; defaults to `<root>/.dsh-build`. */
  readonly stampDirectory?: string
  /** Fresh judgment source; defaults to the collector state file. */
  readonly collect?: () => Promise<RestartSignalJudgment>
  /** Own-build launcher; defaults to a hidden shell spawn with fd capture. */
  readonly launch?: BuildLauncher
  /** Linked-build runner (captured output); defaults to a piped shell spawn. */
  readonly runCaptured?: (commandLine: string, options: SpawnOptions) => Promise<CapturedRun>
  /** Cohort reader; defaults to `signal-cli --list-cohort` (DSH_HOME pinned). */
  readonly listCohort?: () => Promise<readonly CohortEntry[]>
  /** Single-instance acquire; defaults to the per-tree named pipe. */
  readonly acquireInstance?: () => Promise<InstanceLease | undefined>
  /** INIT in-flight probe; defaults to the O-1103 liveness read. */
  readonly buildingMarker?: () => boolean
  /** INIT cause-split probe: own manifest present? */
  readonly ownBaseline?: () => boolean
  /** Age of the failure marker in ms; `undefined` = marker absent. */
  readonly failedMarkerAgeMs?: () => number | undefined
  /** Own build command; defaults to the gate-wrapped umbrella build. */
  readonly command?: string
  /** Linked build command (run inside the linked tree); defaults to `pnpm build`. */
  readonly linkedCommand?: string
  /** Stability window in ms (0 disables); default 15s. */
  readonly stableMs?: number
  /** Heartbeat cadence in ms; default 60s. */
  readonly heartbeatMs?: number
  /** Journal sink (seq protocol, `[exec]`); must expose `flush` in production. */
  readonly journal?: ((line: string) => void) & { readonly flush?: () => Promise<void> }
  /** Loud sink; defaults to one stderr line. */
  readonly warn?: (message: string) => void
  /** Clock; defaults to `Date.now`. */
  readonly now?: () => number
  /** Line sink for operator-facing stdout (tests capture/quiet it). */
  readonly say?: (line: string) => void
}

/* ── ① single instance: kernel handle (Windows named pipe) ───────────────── */

/** Per-tree instance name: parallel trees never contend with each other. */
export function instanceNameFor(repositoryRoot: string): string {
  const digest = createHash('sha1').update(normalizeRepository(repositoryRoot)).digest('hex').slice(0, 12)
  return `dsh-auto-build-exec-${digest}`
}

function pipePathFor(repositoryRoot: string): string {
  const name = instanceNameFor(repositoryRoot)
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`)
}

/**
 * Take the per-tree single-instance kernel handle (design §三.1).
 * Windows: a named pipe server — the kernel object exists exactly while this
 * process holds it, and a second `listen` answers `EADDRINUSE` immediately
 * (2026-11-13 probe: A-OK / B-ERR EADDRINUSE). POSIX: a unix socket with the
 * standard stale-file sweep (connect-refused → unlink → one retry).
 * @param repositoryRoot - Tree whose executor instance this guards.
 * @returns The lease when acquired, or `undefined` when another instance holds it.
 */
export async function acquireSingleInstance(repositoryRoot: string): Promise<InstanceLease | undefined> {
  const path = pipePathFor(repositoryRoot)
  const server: Server = createServer((socket) => { socket.end() })
  const listen = (target: string): Promise<void> =>
    new Promise<void>((done, fail) => {
      const onError = (error: Error): void => { server.off('listening', onListening); fail(error) }
      const onListening = (): void => { server.off('error', onError); done() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(target)
    })
  try {
    await listen(path)
  } catch (error) {
    if (process.platform !== 'win32' && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // Stale socket from a dead holder: prove it dead (connect refused), then sweep once.
      const { connect } = await import('node:net')
      const swept = await new Promise<boolean>((done) => {
        const probe = connect(path)
        probe.on('error', () => {
          probe.destroy()
          try { rmSync(path, { force: true }) } catch { /* fall through */ }
          done(true)
        })
        probe.on('connect', () => { probe.destroy(); done(false) })
      })
      if (swept) {
        try {
          await listen(path)
        } catch {
          return undefined
        }
      } else {
        return undefined
      }
    } else {
      return undefined
    }
  }
  // A post-listen error must never become an unhandled 'error' mid-build.
  server.on('error', (error: Error) => {
    process.stderr.write(`auto-build-exec: instance pipe error: ${error.message}\n`)
  })
  return {
    release: async (): Promise<void> =>
      new Promise<void>((done) => {
        try {
          server.close(() => { done() })
        } catch {
          done()
        }
      }),
  }
}

/* ── failout capture (moved verbatim from the old dispatcher) ────────────── */

interface CaptureFiles {
  readonly stdoutFd: number
  readonly stderrFd: number
  readonly stdoutPath: string
  readonly stderrPath: string
}

function openCaptureFiles(directory: string): CaptureFiles | undefined {
  const stdoutPath = join(directory, STDOUT_CAPTURE_FILE)
  const stderrPath = join(directory, STDERR_CAPTURE_FILE)
  let stdoutFd: number | undefined
  let stderrFd: number | undefined
  try {
    mkdirSync(directory, { recursive: true })
    stdoutFd = openSync(stdoutPath, 'w')
    stderrFd = openSync(stderrPath, 'w')
    return { stdoutFd, stderrFd, stdoutPath, stderrPath }
  } catch {
    if (stdoutFd !== undefined) {
      try { closeSync(stdoutFd) } catch { /* best-effort cleanup */ }
      removeCapture(stdoutPath)
    }
    return undefined
  }
}

function foldTail(path: string): string {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const { size } = fstatSync(fd)
    const length = Math.min(size, FAILURE_TAIL_BYTES)
    const buffer = Buffer.allocUnsafe(length)
    const read = readSync(fd, buffer, 0, length, size - length)
    return buffer.subarray(0, read).toString('utf8').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* best-effort close */ }
    }
  }
}

function removeCapture(...paths: string[]): void {
  for (const path of paths) {
    try {
      rmSync(path, { force: true })
    } catch {
      // Observability only: never propagate into the dispatch path.
    }
  }
}

/* ── default seams ───────────────────────────────────────────────────────── */

function defaultLaunch(commandLine: string, options: SpawnOptions): ExecChild {
  return spawn(commandLine, options)
}

/** Piped, memory-capped capture run for the linked leg (watchdog mirror). */
async function defaultRunCaptured(commandLine: string, options: SpawnOptions): Promise<CapturedRun> {
  const child = spawn(commandLine, { ...options, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const keep: (chunks: Buffer[], chunk: Buffer) => void = (chunks, chunk) => {
    chunks.push(chunk)
    let total = chunks.reduce((sum, part) => sum + part.length, 0)
    while (total > LINKED_CAPTURE_CAP_BYTES && chunks.length > 1) total -= chunks.shift()?.length ?? 0
  }
  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => { keep(out, chunk) })
  child.stderr.on('data', (chunk: Buffer) => { keep(err, chunk) })
  return new Promise<CapturedRun>((done, fail) => {
    child.on('error', fail)
    child.on('close', (code) => {
      done({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

/** `signal-cli --list-cohort`, DSH_HOME pinned to the data root (schtasks-birth
 * mirror of the watchdog: an install-root DSH_HOME yields an empty cohort). */
async function defaultListCohort(repositoryRoot: string): Promise<readonly CohortEntry[]> {
  const cli = join(repositoryRoot, 'scripts', 'restart-signal', 'signal-cli.ts')
  const env = { ...process.env, DSH_HOME: join(homedir(), '.dsh') }
  const run = await new Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>((done, fail) => {
    const child = spawn('node', [cli, '--list-cohort'], { cwd: repositoryRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => { out.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { err.push(chunk) })
    child.on('error', fail)
    child.on('close', (code) => {
      done({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
  if (run.code !== 0) {
    throw new Error(`signal-cli --list-cohort exited with ${String(run.code)} stderr=${run.stderr.trim().slice(-300)}`)
  }
  const parsed: unknown = JSON.parse(run.stdout)
  const cohort = (parsed as { cohort?: unknown }).cohort
  if (!Array.isArray(cohort)) throw new Error('signal-cli --list-cohort returned a non-list cohort')
  return cohort as CohortEntry[]
}

/* ── linked account (RMW under its own short lock) ──────────────────────── */

function linkedStatePath(stampDirectory: string): string {
  return join(stampDirectory, LINKED_STATE_FILE)
}

function loadLinkedState(stampDirectory: string): LinkedState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(linkedStatePath(stampDirectory), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
  } catch {
    // Missing/corrupt account = empty book (watchdog `linked_state_load` mirror).
  }
  return { version: 1, repos: {} }
}

function saveLinkedState(stampDirectory: string, state: LinkedState): void {
  const path = linkedStatePath(stampDirectory)
  mkdirSync(stampDirectory, { recursive: true })
  const body = `${JSON.stringify(state, undefined, 2)}\n`
  const tempPath = `${path}.tmp-${String(process.pid)}`
  writeFileSync(tempPath, body, 'utf8')
  try {
    renameSync(tempPath, path)
  } catch {
    // Windows sharing violation against a concurrent reader: fall back to a
    // direct write so the account never stays unwritten (loud either way).
    try {
      rmSync(tempPath, { force: true })
      writeFileSync(path, body, 'utf8')
    } catch (error) {
      process.stderr.write(`auto-build-exec: linked account write failed: ${errorText(error)}\n`)
    }
  }
}

function repoKey(repos: Record<string, LinkedRepoState>, repository: string): string {
  return Object.keys(repos).find(candidate => normalizeRepository(candidate) === normalizeRepository(repository)) ?? repository
}

/** Unlocked read of one tree's seat (readers never mutate; writers serialize). */
function readRepoState(stampDirectory: string, repository: string): LinkedRepoState {
  const repos = loadLinkedState(stampDirectory).repos ?? {}
  const seat: unknown = repos[repoKey(repos, repository)]
  return typeof seat === 'object' && seat !== null ? seat : {}
}

/** Read-modify-write one field set of the account under the mkdir lock. */
async function mutateLinkedState(
  stampDirectory: string,
  mutate: (repo: LinkedRepoState) => void,
  repository: string,
): Promise<void> {
  // The lock lives inside the stamp directory — a tree that never journaled
  // (fresh worktree, mock journal in tests) must still be able to book an attempt.
  mkdirSync(stampDirectory, { recursive: true })
  await withDirLock(join(stampDirectory, LINKED_STATE_LOCK), () => {
    const state = loadLinkedState(stampDirectory)
    const repos = { ...(state.repos ?? {}) }
    const key = repoKey(repos, repository)
    const current: unknown = repos[key]
    const seat: LinkedRepoState = typeof current === 'object' && current !== null ? { ...(current as LinkedRepoState) } : {}
    mutate(seat)
    repos[key] = seat
    saveLinkedState(stampDirectory, { ...state, repos })
  })
}

function linkedCooldownMs(failures: number): number {
  if (failures <= 0) return 0
  return Math.min(LINKED_COOLDOWN_BASE_MS * 2 ** (failures - 1), LINKED_COOLDOWN_MAX_MS)
}

function isoAgeMs(stamp: string): number | undefined {
  const at = Date.parse(stamp)
  return Number.isFinite(at) ? Date.now() - at : undefined
}

/** The linked tree's manifest `time` (stall readings); absent = None. */
function linkedManifestTime(repository: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(repository, STAMP_DIR, MANIFEST_FILE), 'utf8'))
    const time: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'time') : undefined
    return typeof time === 'string' ? time : undefined
  } catch {
    return undefined
  }
}

/** Fold a captured tail the watchdog way (whitespace collapsed, last 1500). */
function foldJournalTail(capture: CapturedRun): string {
  return `${capture.stdout}\n${capture.stderr}`.replace(/\s+/g, ' ').trim().slice(-LINKED_JOURNAL_TAIL_CHARS)
}

/* ── 2 re-judge → stability window → one gated build (own leg) ──────────── */

/** Decide from ONE fresh judgment. Build-worthy states must first survive the
 * stability window; linked-only NEED_BUILD and success-shaped states route to
 * the linked leg; everything else defers with its reason line. */
type Decision =
  | { readonly kind: 'build'; readonly reason: string }
  | { readonly kind: 'defer'; readonly line: string }
  | { readonly kind: 'linked' }

function factsEqual(left: RestartSignalJudgment['facts'], right: RestartSignalJudgment['facts']): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.currentHostFace === right.currentHostFace
    && left.configStamp === right.configStamp
    && left.ownFaceMoved === right.ownFaceMoved
}

/** The design's stability window (§四, unchanged parameters): re-read the
 * judgment after `stableMs`; a moved state or moved facts means the source is
 * still being edited — defer to the next tick instead of building a
 * half-edited tree. */
async function stabilityDecision(
  before: RestartSignalJudgment,
  o: NormalizedExec,
): Promise<Decision | 'stable'> {
  if (o.stableMs <= 0) return 'stable'
  await new Promise<void>((done) => { setTimeout(done, o.stableMs).unref() })
  let after: RestartSignalJudgment
  try {
    after = await o.collect()
  } catch (error) {
    return { kind: 'defer', line: `defer unstable (re-judge failed: ${errorText(error)})` }
  }
  if (after.state !== before.state || !factsEqual(after.facts, before.facts)) {
    return { kind: 'defer', line: `defer unstable from=${before.state} to=${after.state}` }
  }
  return 'stable'
}

async function decide(fresh: RestartSignalJudgment, o: NormalizedExec): Promise<Decision> {
  switch (fresh.state) {
    case 'BUILDING':
      return { kind: 'defer', line: 'defer state=BUILDING (build in flight)' }
    case 'BUILD_FAILED': {
      const ageMs = o.failedMarkerAgeMs()
      if (ageMs !== undefined && ageMs < FAILURE_COOLDOWN_MS) {
        return { kind: 'defer', line: `defer state=BUILD_FAILED (failure marker age ${String(Math.round(ageMs / 1000))}s < cooldown)` }
      }
      // Past the cooldown the retry itself is the recovery: the new build's
      // opening clears the failure marker (P0 build-stamp semantics).
      const stable = await stabilityDecision(fresh, o)
      return stable === 'stable' ? { kind: 'build', reason: 'failed-retry' } : stable
    }
    case 'INIT': {
      // Bootstrap defenses moved with the execution authority (old dispatcher
      // INIT branch): a foreign build in flight defers; a present own manifest
      // means INIT can only name a linked tree's baseline — no build here fixes it.
      if (o.buildingMarker()) return { kind: 'defer', line: 'defer state=INIT (build marker in flight)' }
      if (o.ownBaseline()) return { kind: 'defer', line: 'defer init-linked-baseline' }
      const stable = await stabilityDecision(fresh, o)
      return stable === 'stable' ? { kind: 'build', reason: 'init-bootstrap' } : stable
    }
    case 'NEED_BUILD': {
      // 构建触发口径 = 主仓面 (linked-split 2026-11-01): linked-only drift owes
      // no build of THIS tree — straight to the per-tree leg.
      if (fresh.facts?.ownFaceMoved === false) return { kind: 'linked' }
      const stable = await stabilityDecision(fresh, o)
      return stable === 'stable' ? { kind: 'build', reason: 'need-build' } : stable
    }
    default:
      // OK / NEED_RESTART / CLIENT_UPDATED: own face agrees — the linked leg owns the rest.
      return { kind: 'linked' }
  }
}

/** One gated own-tree build: failout capture, terminal journal line
 * (failout判据 4 verbatim). The period heartbeat lives in `runAutoBuildExec`. */
async function runOwnBuild(reason: string, o: NormalizedExec): Promise<number> {
  const command = o.command
  const capture = openCaptureFiles(o.stampDirectory)
  const options: SpawnOptions = {
    shell: true,
    // Windows: NOT detached — a detached console-less cmd lets its console
    // grandchild allocate a fresh, focus-stealing console window (2026-11-01
    // popup finding); staying attached lets windowsHide's hidden console cover
    // the whole tree. Elsewhere detached keeps the build outliving this run.
    detached: process.platform !== 'win32',
    // Failout: file descriptors, NOT pipes — a pipe's read end dies with this
    // process on a hard kill and the surviving build would crash writing into
    // it (false BUILD_FAILED). Unwritable stamp dir degrades to 'ignore'.
    stdio: capture === undefined ? 'ignore' : ['ignore', capture.stdoutFd, capture.stderrFd],
    windowsHide: true,
    env: process.env,
    cwd: o.repositoryRoot,
  }
  o.journal(`dispatch reason=${reason} cmd=${command}`)
  o.say(`auto-build-exec: dispatch reason=${reason} cmd=${command}`)
  const child = o.launch(command, options)
  if (capture !== undefined) {
    // The parent keeps no fd copies: the child inherited its own handles, and
    // holding ours would pin the capture files open on Windows.
    try { closeSync(capture.stdoutFd) } catch { /* already closed */ }
    try { closeSync(capture.stderrFd) } catch { /* already closed */ }
  }
  const exit = await new Promise<number>((done) => {
    let spawnFailed = false
    let settled = false
    child.on('error', (error: Error) => {
      if (settled) return
      settled = true
      spawnFailed = true
      if (capture !== undefined) removeCapture(capture.stdoutPath, capture.stderrPath)
      o.warn(`auto-build-exec: dispatch failed: ${error.message}`)
      o.journal(`dispatch-error ${error.message}`)
      done(1)
    })
    // The failout line: non-zero exit folds both stream tails (4KB each,
    // whitespace-collapsed to ONE line) plus cmd and exit code into the
    // journal; exit 0 adds no noise (成功零噪声) and drops the captures.
    child.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      if (spawnFailed) return
      if (code === 0) {
        if (capture !== undefined) removeCapture(capture.stdoutPath, capture.stderrPath)
        done(0)
        return
      }
      const stdoutTail = capture === undefined ? '' : foldTail(capture.stdoutPath)
      const stderrTail = capture === undefined ? '' : foldTail(capture.stderrPath)
      if (capture !== undefined) removeCapture(capture.stdoutPath, capture.stderrPath)
      o.journal(`build-failed exit=${code ?? 'null'} cmd=${command} stdout-tail=${stdoutTail} stderr-tail=${stderrTail}`)
      o.say(`auto-build-exec: build failed exit=${code ?? 'null'}`)
      done(1)
    })
  })
  if (exit === 0) {
    o.journal(`build-done exit=0 cmd=${command}`)
    o.say('auto-build-exec: build done')
    return 0
  }
  return 1
}

/* ── 4 linked leg: the per-tree dispatch account moved here ──────────────── */

/** Gate-wrapped linked command run inside the patient tree (watchdog
 * `dispatch_linked_build` command line, moved verbatim). */
function linkedCommandLine(o: NormalizedExec): string {
  const tsxCli = join(o.repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const gate = join(o.repositoryRoot, 'scripts', 'heavy-io-gate.ts')
  return `node "${tsxCli}" "${gate}" "${o.linkedCommand}"`
}

async function runLinkedLeg(o: NormalizedExec): Promise<number> {
  let cohort: readonly unknown[]
  try {
    cohort = await o.listCohort()
  } catch (error) {
    o.journal(`linked-cohort-failed error=${errorText(error)}`)
    return 2
  }
  let exitCode = 0
  for (const entry of cohort) {
    if (typeof entry !== 'object' || entry === null) continue
    const repoValue: unknown = Reflect.get(entry, 'repository')
    if (typeof repoValue !== 'string') continue
    const repo = repoValue
    // Own tree is the main judgment leg's business — per-tree leg = linked only.
    if (normalizeRepository(repo) === normalizeRepository(o.repositoryRoot)) continue
    const manifestValue: unknown = Reflect.get(entry, 'manifest')
    const currentValue: unknown = Reflect.get(entry, 'current')
    const manifest = typeof manifestValue === 'object' && manifestValue !== null ? manifestValue : undefined
    const current = typeof currentValue === 'object' && currentValue !== null ? currentValue : undefined
    // No manifest = notices face (L-1101 ①): that tree's own bootstrap owes it.
    if (manifest === undefined || current === undefined) continue
    const sEnd: unknown = Reflect.get(manifest, 'sEnd')
    const baseline: unknown = typeof sEnd === 'object' && sEnd !== null ? Reflect.get(sEnd, 'host') : undefined
    const curr: unknown = Reflect.get(current, 'host')
    if (typeof baseline !== 'string' || typeof curr !== 'string') continue
    const timeValue: unknown = Reflect.get(manifest, 'time')
    const manifestTime = typeof timeValue === 'string' ? timeValue : undefined
    if (baseline === curr) continue

    // 收敛护栏解除: manifest `time` moved since the stall record = a stamping
    // build landed on it — the stall record is void (same value the watchdog
    // writes; both sides RMW under the account lock, design §七 偏差 5).
    let seat = readRepoState(o.stampDirectory, repo)
    if (seat.stall !== undefined && seat.stall !== null && manifestTime !== undefined && seat.stall.manifestTime !== manifestTime) {
      await mutateLinkedState(o.stampDirectory, (target) => { target.stall = null }, repo)
      seat = readRepoState(o.stampDirectory, repo)
    }
    // ② 收敛护栏: still stalled — already alarmed once, stay quiet.
    if (seat.stall !== undefined && seat.stall !== null) continue
    // ③ per-tree failure cooldown: 10min × 2^(failures−1) capped at 60min.
    if (seat.outcome === 'failed' && typeof seat.lastAttemptAt === 'string') {
      const ageMs = isoAgeMs(seat.lastAttemptAt)
      const failures = typeof seat.failures === 'number' && Number.isFinite(seat.failures) ? seat.failures : 0
      if (ageMs !== undefined && ageMs < linkedCooldownMs(failures)) continue
    }

    // ⑤ pre-claim BEFORE the run (build killed mid-flight still lands in cooldown),
    //    then the dispatch line the linked lamp reads (`linkedEventOf`).
    const failuresBefore = typeof seat.failures === 'number' && Number.isFinite(seat.failures) ? seat.failures : 0
    await mutateLinkedState(o.stampDirectory, (target) => {
      // Machine facts keep WALL time (the watchdog's _utc_stamp mirror) —
      // the injected clock only drives windows/heartbeats, never the account.
      target.lastAttemptAt = new Date().toISOString()
      target.outcome = 'failed'
      target.failures = failuresBefore + 1
    }, repo)
    o.journal(`linked-build repo=${repo} reason=linked-drift`)
    o.say(`auto-build-exec: linked-build repo=${repo}`)

    const result = await o.runCaptured(linkedCommandLine(o), { cwd: repo })
    if (result.code !== 0) {
      o.journal(`linked-build-failed repo=${repo} exit=${String(result.code)} output-tail=${foldJournalTail(result)}`)
      exitCode = 1
      continue
    }

    // ⑥ stall reading: run succeeded but the manifest `time` did not move —
    //    the build did not stamp the tree; stop dispatching it (防无限重建).
    const timeAfter = linkedManifestTime(repo)
    if (timeAfter === undefined || manifestTime === undefined || timeAfter === manifestTime) {
      await mutateLinkedState(o.stampDirectory, (target) => {
        target.outcome = 'ok'
        target.failures = 0
        target.stall = { manifestTime: manifestTime ?? 'unknown' }
      }, repo)
      o.journal(`linked-build-stall repo=${repo} manifestTime=${manifestTime ?? 'unknown'} (manifest time did not move; stop dispatching this tree)`)
      continue
    }
    await mutateLinkedState(o.stampDirectory, (target) => {
      target.outcome = 'ok'
      target.failures = 0
      // A stamping success explicitly clears any stall seat: the tree is
      // dispatchable again on the next drift (schema keeps the key present).
      target.stall = null
    }, repo)
    o.journal(`linked-build-done repo=${repo} manifestTime=${timeAfter}`)
  }
  return exitCode
}

/* ── one execution period ───────────────────────────────────────────────── */

interface NormalizedExec extends AutoBuildExecOptions {
  readonly repositoryRoot: string
  readonly stampDirectory: string
  readonly journal: ((line: string) => void) & { readonly flush?: () => Promise<void> }
  readonly warn: (message: string) => void
  readonly say: (line: string) => void
  readonly now: () => number
  readonly collect: () => Promise<RestartSignalJudgment>
  readonly launch: BuildLauncher
  readonly runCaptured: (commandLine: string, options: SpawnOptions) => Promise<CapturedRun>
  readonly listCohort: () => Promise<readonly CohortEntry[]>
  readonly acquireInstance: () => Promise<InstanceLease | undefined>
  readonly buildingMarker: () => boolean
  readonly ownBaseline: () => boolean
  readonly failedMarkerAgeMs: () => number | undefined
  readonly command: string
  readonly linkedCommand: string
  readonly stableMs: number
  readonly heartbeatMs: number
}

/**
 * Run one executor pass to completion: single-instance → re-judgment →
 * stability → own build or linked leg → flush. Never throws for expected
 * degradation paths; returns the process exit code.
 * @param options - Injection seams; production defaults resolve from this tree.
 * @returns 0 ran/deferred/owned elsewhere · 1 a build failed · 2 judgment unavailable.
 */
export async function runAutoBuildExec(options: AutoBuildExecOptions = {}): Promise<number> {
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot()
  const stampDirectory = options.stampDirectory ?? join(repositoryRoot, STAMP_DIR)
  const journal = options.journal ?? defaultAutoBuildJournalLine(repositoryRoot, { writer: 'exec' })
  const warn = options.warn ?? ((message: string): void => { process.stderr.write(`${message}\n`) })
  const say = options.say ?? ((line: string): void => { process.stdout.write(`${line}\n`) })
  const now = options.now ?? Date.now
  const env = process.env
  const o: NormalizedExec = {
    ...options,
    repositoryRoot,
    stampDirectory,
    journal,
    warn,
    say,
    now,
    collect: options.collect ?? ((): Promise<RestartSignalJudgment> => collectRestartSignal(
      env.DSH_RESTART_SIGNAL_STATE === undefined ? {} : { statePath: env.DSH_RESTART_SIGNAL_STATE },
    )),
    launch: options.launch ?? defaultLaunch,
    runCaptured: options.runCaptured ?? defaultRunCaptured,
    listCohort: options.listCohort ?? ((): Promise<readonly CohortEntry[]> => defaultListCohort(repositoryRoot)),
    acquireInstance: options.acquireInstance ?? ((): Promise<InstanceLease | undefined> => acquireSingleInstance(repositoryRoot)),
    buildingMarker: options.buildingMarker ?? ((): boolean => readBuildingCapture(repositoryRoot)),
    ownBaseline: options.ownBaseline ?? ((): boolean => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(stampDirectory, MANIFEST_FILE), 'utf8'))
        return typeof parsed === 'object' && parsed !== null && Reflect.get(parsed, 'version') === 1
      } catch {
        return false
      }
    }),
    failedMarkerAgeMs: options.failedMarkerAgeMs ?? ((): number | undefined => {
      try {
        return now() - statSync(join(stampDirectory, FAILURE_FILE)).mtimeMs
      } catch {
        return undefined
      }
    }),
    command: options.command ?? DEFAULT_BUILD_COMMAND,
    linkedCommand: options.linkedCommand ?? 'pnpm build',
    stableMs: options.stableMs ?? envMillis(env.DSH_AUTO_BUILD_STABLE_MS, DEFAULT_STABLE_MS, 0),
    heartbeatMs: options.heartbeatMs ?? envMillis(env.DSH_AUTO_BUILD_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS, 1_000),
  }

  // ① second instance:抢不到直接退 — one journal line of evidence, exit 0.
  const lease = await o.acquireInstance()
  if (lease === undefined) {
    const name = instanceNameFor(repositoryRoot)
    o.journal(`single-instance busy name=${name} selfPid=${String(process.pid)} (another executor holds the execution period; exit without re-judging)`)
    o.say(`auto-build-exec: single-instance busy (${name}); exiting`)
    await journal.flush?.()
    return 0
  }

  let code = 0
  // ⑤③ heartbeat for the WHOLE execution period (judge wait → stability →
  // build → linked leg): a silent window is then an OBSERVED silence, and the
  // kernel handle above is exactly what defines "the period".
  const periodStartedAt = now()
  let heartbeat: ReturnType<typeof setInterval> | undefined
  if (o.heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      journal(`heartbeat elapsedSec=${String(Math.round((now() - periodStartedAt) / 1000))} execution=period`)
    }, o.heartbeatMs)
    heartbeat.unref()
  }
  try {
    say(`auto-build-exec: instance acquired pid=${String(process.pid)} root=${repositoryRoot}`)
    // ② re-judge from the state machine's single source; stale/absent = LOUD, never a guess.
    let fresh: RestartSignalJudgment
    try {
      fresh = await o.collect()
    } catch (error) {
      journal(`judge-unavailable error=${errorText(error)}`)
      say(`auto-build-exec: judge unavailable: ${errorText(error)}`)
      await journal.flush?.()
      return 2
    }
    say(`auto-build-exec: judge state=${fresh.state}`)
    const decision = await decide(fresh, o)
    switch (decision.kind) {
      case 'defer':
        journal(decision.line)
        say(`auto-build-exec: ${decision.line}`)
        code = 0
        break
      case 'build':
        code = await runOwnBuild(decision.reason, o)
        break
      case 'linked':
        // Own face agrees; the per-tree leg decides (and journals) per repo —
        // a clean cohort legitimately ends with no new line beyond the judge say.
        code = await runLinkedLeg(o)
        break
    }
  } finally {
    // Stop the heartbeat, release the kernel handle first (a queued watchdog
    // kick may now start), then flush every journal line this process owed
    // before it disappears.
    if (heartbeat !== undefined) clearInterval(heartbeat)
    await lease.release()
    await journal.flush?.()
  }
  say(`auto-build-exec: exit=${String(code)}`)
  return code
}

async function main(_args: readonly string[]): Promise<number> {
  // Schtasks/scheduler births carry the install root in DSH_HOME (env-key-catalog
  // 读表须知 3) — pin the data root exactly like the collector and the watchdog,
  // or the re-judgment would look for the state file where no collector writes it.
  // The isolation seam (DSH_RESTART_SIGNAL_STATE) bypasses the state path anyway.
  if (process.env.DSH_RESTART_SIGNAL_STATE === undefined) process.env.DSH_HOME = join(homedir(), '.dsh')
  return runAutoBuildExec()
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (error: unknown) => {
      const message = errorText(error)
      // Fatal = the run died outside every designed degradation path: shout on
      // stderr AND land a journal line if the default face answers at all.
      process.stderr.write(`auto-build-exec: FATAL ${message}\n`)
      try {
        const sink = defaultAutoBuildJournalLine(undefined, { writer: 'exec' })
        sink(`exec-fatal error=${message}`)
        void sink.flush().catch(() => { /* stderr above already shouted */ })
      } catch {
        // stderr above already carried the shout.
      }
      process.exitCode = 1
    },
  )
}
