/**
 * Auto-build dispatcher (P3, design §四 build 节流): rides the state machine's
 * judgment stream and turns a persistent `NEED_BUILD` — or a missing build
 * baseline (`INIT`) — into one gated build dispatch, never a storm.
 *
 * Throttle, in order: a stability window (the source stamps must have been
 * quiet for `stableMs`, default 15s), a minimum interval between dispatches
 * (default 60s), exponential failure backoff (default 5min, doubling, capped
 * at 1h) driven by the BUILD_FAILED marker, and single-dispatcher mutual
 * exclusion with the save chain: the machine-level heavy-io lock
 * (`owner.json` under the user cache dir — the same reader
 * `scripts/heavy-io-gate.ts` takes) is probed before dispatch, and the build
 * command itself is the gate-wrapped `pnpm run build`, so a save-chain build
 * in flight defers this one and vice versa. `DSH_HEAVY_IO_HELD=1` in this
 * process (we are inside someone else's gated run) also defers.
 *
 * INIT bootstrap (2026-11-01, closes the chicken-and-egg deadlock): the
 * judgment masks BUILDING/BUILD_FAILED behind INIT, so a missing baseline
 * used to abort forever — "waiting for a fresh signal" that INIT can never
 * produce. The dispatcher now bootstraps: INIT with a quiet source and no
 * build markers dispatches the same gated build, which writes the baseline
 * on success; a failed bootstrap is read from the machine's own failure
 * record and arms the same exponential backoff (INIT outranks the failure
 * marker in the judgment, so this module reads the marker directly).
 *
 * INIT cause split (2026-11-01 storm fix): INIT says "some in-scope baseline
 * is missing", and the scan also covers linked plugin repositories
 * (`restart-stamp.ts` `readRestartStamp`). This tree's build can only ever
 * write THIS tree's manifest, so an INIT whose own manifest is present can
 * only name a linked tree's missing manifest — dispatching would rebuild
 * forever without ever clearing the condition (the observed init-bootstrap
 * storm: one dispatched `pnpm run build` per throttle cycle, each a visible
 * console window). With the own manifest present the dispatcher reports the
 * linked condition once per episode in the journal and dispatches nothing;
 * a missing own manifest keeps the bootstrap path above.
 * (linked-split 2026-11-01: `readRestartStamp` no longer INITs on linked
 * absence at all, so that defer branch is defense-in-depth — kept, not
 * removed, as the second guard in front of this dispatch path.)
 *
 * NEED_BUILD trigger scope (linked-split 2026-11-01, the second loop): the
 * combined host-face comparison behind NEED_BUILD covers linked trees too, so
 * a linked repository's moved source judges NEED_BUILD — and no build of THIS
 * tree ever moves that half (the observed need-build loop: one dispatch per
 * throttle cycle, forever, against an actively edited linked worktree). The
 * judgment carries `facts.ownFaceMoved`; NEED_BUILD with `ownFaceMoved ===
 * false` (this tree agrees with its own baseline) journals the condition once
 * per episode and dispatches nothing, while an own-face move — or an unknown
 * scope, stamps unavailable — keeps the normal dispatch. The lamp itself
 * stays NEED_BUILD: linked source really is unbuilt source.
 *
 * Dispatch spawns: `windowsHide` + non-detached on Windows so the gated
 * build inherits this process's hidden console — a detached console-less
 * child instead lets its console grandchild allocate a NEW console, which
 * the default terminal (Windows Terminal) renders as a visible,
 * focus-stealing window (2026-11-01 popup finding). Elsewhere the spawn
 * stays detached so the build outlives this process's session; either way
 * the build writes its own start/failure markers (P0 build-stamp hooks), so
 * the state machine — not this dispatcher — remains the single truth for
 * BUILDING/BUILD_FAILED.
 * A post-dispatch outcome check re-collects after the minimum interval to
 * observe success (state moves on; backoff resets) or failure (backoff arms).
 *
 * Every dispatch decision (dispatch / defer / backoff / error / episode
 * reset) is journalled to `.dsh-build/auto-build.log` beside the manifest —
 * the journal is the durable "did the machine even try?" record (build-trigger
 * hardening 2026-11-01, 洞③).
 *
 * Failure output capture (auto-build failout 2026-11-03, 洞⑦): the spawn no
 * longer discards stdio — stdout/stderr are redirected to
 * `.dsh-build/auto-build.{stdout,stderr}.tmp` (file descriptors, NOT pipes:
 * a pipe's read end dies with this host on restart and the still-running
 * build would crash writing into it, mis-reporting BUILD_FAILED), and the
 * child's `close` event folds a non-zero exit into one journalled line
 * `build-failed exit=<code> cmd=<command> stdout-tail=… stderr-tail=…`
 * (each tail capped at 4KB, whitespace folded — same family as the
 * watchdog's line). A zero exit removes the capture files and writes
 * nothing: successful builds add no journal noise. BUILD_FAILED judgment
 * itself still comes only from the P0 failure marker — this line is
 * observability, never a state-machine input.
 */
import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultAutoBuildJournalLine } from './auto-build-journal.ts'
import { readBuildingCapture } from './build-start-liveness.ts'
import { defaultRepositoryRoot } from './restart-stamp.ts'
import { collectRestartSignal, onRestartSignalJudgment, type RestartSignalFacts, type RestartSignalJudgment } from './restart-signal.ts'

/** Environment variable tuning the stability window; default 15s (design §四). */
export const AUTO_BUILD_STABLE_ENV = 'DSH_AUTO_BUILD_STABLE_MS'

/** Environment variable tuning the minimum dispatch interval; default 60s. */
export const AUTO_BUILD_INTERVAL_ENV = 'DSH_AUTO_BUILD_INTERVAL_MS'

/** Environment variable tuning the failure backoff base; default 5min. */
export const AUTO_BUILD_BACKOFF_ENV = 'DSH_AUTO_BUILD_BACKOFF_MS'

/** Default stability window: the source must be quiet this long before a dispatch. */
const DEFAULT_STABLE_MS = 15_000

/** Default minimum interval between build dispatches. */
const DEFAULT_INTERVAL_MS = 60_000

/** Default failure backoff base; consecutive failures double it. */
const DEFAULT_BACKOFF_MS = 5 * 60_000

/** Backoff ceiling: one retry per hour at worst. */
const BACKOFF_CAP_MS = 60 * 60_000

/** Gitignored directory holding the per-tree build markers (mirrors the
 * state-machine-side constants: INIT outranks the markers in the judgment,
 * so the bootstrap path reads them directly). */
const STAMP_DIR = '.dsh-build'

/** Build-failure record file name inside the stamp directory. */
const FAILURE_FILE = 'restart-stamp.failed.json'

/** Own baseline manifest file name inside the stamp directory (the INIT cause
 * split reads it directly, mirroring the marker probes below). */
const MANIFEST_FILE = 'restart-stamp.json'

/** Build stdout capture file inside the stamp directory (failout 2026-11-03);
 * truncated on every dispatch, removed once the outcome is journalled. */
export const STDOUT_CAPTURE_FILE = 'auto-build.stdout.tmp'

/** Build stderr capture file inside the stamp directory (failout 2026-11-03). */
export const STDERR_CAPTURE_FILE = 'auto-build.stderr.tmp'

/** Bytes of each captured stream kept in a `build-failed` journal line. */
const FAILURE_TAIL_BYTES = 4 * 1024

/** Delay before re-probing a held heavy-io lock. */
const LOCK_RETRY_MS = 30_000

/** Maximum cumulative lock deferral before this dispatcher stays quiet until the next move. */
const LOCK_DEFER_BOUND_MS = 15 * 60_000

/** The default build command: the gate-wrapped umbrella build (single dispatcher
 * with the save chain's segment 4 — both ride the same machine lock). */
const DEFAULT_BUILD_COMMAND = 'pnpm run build'

/** Resolved throttle timings after environment clamping. */
export interface AutoBuildTimings {
  /** Stability window in milliseconds; `0` dispatches without one (tests). */
  readonly stableMs: number
  /** Minimum interval between dispatches in milliseconds. */
  readonly intervalMs: number
  /** Failure backoff base in milliseconds. */
  readonly backoffMs: number
}

function envMillis(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.max(parsed, min)
}

/**
 * Resolve the throttle timings from the environment; unparsable values fall
 * back to the design defaults, and every value is clamped to a sane floor.
 * @param env - Environment to read (production: `process.env`).
 * @returns The effective timings.
 */
export function resolveAutoBuildTimings(env: { readonly [name: string]: string | undefined }): AutoBuildTimings {
  return {
    stableMs: envMillis(env[AUTO_BUILD_STABLE_ENV], DEFAULT_STABLE_MS, 0),
    intervalMs: envMillis(env[AUTO_BUILD_INTERVAL_ENV], DEFAULT_INTERVAL_MS, 1_000),
    backoffMs: envMillis(env[AUTO_BUILD_BACKOFF_ENV], DEFAULT_BACKOFF_MS, 60_000),
  }
}

/**
 * Resolve the machine heavy-io lock directory (mirrors
 * `scripts/heavy-io-gate.ts` `defaultLockDirectory`: user-level, never
 * `os.tmpdir()`, which is sandboxed per session).
 * @param env - Environment carrying LOCALAPPDATA / XDG_CACHE_HOME.
 * @returns The lock directory path.
 */
export function defaultHeavyIoLockDirectory(env: { readonly [name: string]: string | undefined }): string {
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? tmpdir(), 'dsh-heavy-io-gate.lock')
  return join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dsh-heavy-io-gate.lock')
}

/**
 * Whether another job currently holds the heavy-io lock (owner present and
 * its process alive; a stale lock is the gate's own job to break).
 * @param directory - Lock directory; defaults to the machine lock.
 * @returns True while a live owner holds the lock.
 */
export function heavyIoLockHeld(directory: string): boolean {
  let pid: unknown
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    pid = Reflect.get(parsed, 'pid')
  } catch {
    return false
  }
  if (typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The child-process surface the dispatcher needs from the launcher seam:
 * spawn failure, terminal close (the exit code behind the failout line), and
 * idle-semantic unref. */
export interface AutoBuildChild {
  /** Keep the child out of this process's exit wait (host idle semantics). */
  readonly unref: () => void
  /** Observe an asynchronous spawn failure (the process never started). */
  on(event: 'error', listener: (error: Error) => void): void
  /** Observe the child's terminal close: exit code, or null when killed by signal. */
  on(event: 'close', listener: (code: number | null) => void): void
}

/** Detached launcher seam typed like the restart dispatch's launcher. */
export type BuildLauncher = (commandLine: string, options: SpawnOptions) => AutoBuildChild

/** Injection seams for one registration; production defaults come from this process. */
export interface AutoBuildInternals {
  /** Judgment subscription; defaults to the state machine's observer seam. */
  readonly subscribe?: (listener: (judgment: RestartSignalJudgment) => void) => () => void
  /** Fresh confirm collected right before a dispatch decision. */
  readonly collect?: () => Promise<RestartSignalJudgment>
  /** Detached build launcher; defaults to a hidden shell spawn. */
  readonly launch?: BuildLauncher
  /** Clock; defaults to `Date.now`. */
  readonly now?: () => number
  /** Heavy-io lock probe; defaults to the machine lock reader. */
  readonly lockHeld?: () => boolean
  /** Held-flag probe (we are inside another gated run); defaults to the environment. */
  readonly heldFlag?: () => boolean
  /** Build command; defaults to the gate-wrapped umbrella build. */
  readonly command?: string
  /** Working directory of the build; defaults to this module's harness tree. */
  readonly cwd?: string
  /** Environment for timings and probes; defaults to `process.env`. */
  readonly env?: { readonly [name: string]: string | undefined }
  /** Failure sink; defaults to one stderr line. */
  readonly warn?: (message: string) => void
  /** Decision journal sink; defaults to the rotating file beside the manifest. */
  readonly journal?: (line: string) => void
  /** Stamp directory holding the journal and the failout capture files;
   * defaults to this tree's `.dsh-build` beside the manifest. */
  readonly stampDirectory?: string
  /** Build-start marker probe (INIT bootstrap: the judgment masks BUILDING
   * behind INIT); defaults to the harness tree's start capture file read
   * through the O-1103 liveness probe, so a marker whose build process died
   * clears (plus its journal line) instead of deferring this dispatcher
   * forever. */
  readonly buildingMarker?: () => boolean
  /** Build-failure marker probe (INIT bootstrap: the judgment masks
   * BUILD_FAILED behind INIT); defaults to the harness tree's failure record. */
  readonly failedMarker?: () => boolean
  /** Own-baseline probe (INIT cause split): true when THIS tree's manifest exists
   * and parses, which means a still-INIT judgment names a linked repository's
   * missing manifest — a condition no build of this tree can fix. Defaults to the
   * harness tree's manifest file. */
  readonly ownBaseline?: () => boolean
}

function sameFacts(left: RestartSignalFacts | undefined, right: RestartSignalFacts | undefined): boolean {
  if (left === undefined || right === undefined) return false
  return left.currentHostFace === right.currentHostFace && left.configStamp === right.configStamp
}

/** One dispatch's opened failout capture files (failout 2026-11-03): the
 * parent closes its fd copies right after the spawn — only the child keeps
 * writing through its inherited handles. */
interface CaptureFiles {
  readonly stdoutFd: number
  readonly stderrFd: number
  readonly stdoutPath: string
  readonly stderrPath: string
}

/**
 * Open this dispatch's stdout/stderr capture files under the stamp directory
 * (each `open('w')` truncates any orphan a dead host left behind). Pure
 * observability: an unwritable stamp directory degrades to the legacy
 * `stdio: 'ignore'` spawn instead of ever blocking the build.
 * @param directory - Stamp directory holding the journal.
 * @returns The open fds and paths, or undefined when capture is unavailable.
 */
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

/**
 * Fold a captured stream tail into one journal-safe segment: the last
 * {@link FAILURE_TAIL_BYTES} bytes with whitespace collapsed to single
 * spaces, so a multi-line build log lands on ONE journal line (the
 * watchdog's `output-tail` folding, same口径). A torn multibyte char at the
 * cut decodes to a replacement glyph — truncation is accepted by design.
 * @param path - Capture file written by the dispatched build.
 * @returns The folded tail; an absent or unreadable file yields ''.
 */
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

/**
 * Remove a dispatch's capture files after the outcome is folded into the
 * journal (or dropped on spawn failure); best-effort like every journal
 * write — a stuck file simply gets truncated by the next dispatch.
 * @param paths - Capture file paths to delete.
 */
function removeCapture(...paths: string[]): void {
  for (const path of paths) {
    try {
      rmSync(path, { force: true })
    } catch {
      // Observability only: never propagate into the dispatch path.
    }
  }
}

/**
 * Whether this tree's own baseline manifest exists and parses as version 1.
 * An unreadable or invalid manifest counts as missing so the INIT bootstrap
 * can rewrite it; a valid own manifest under a still-INIT judgment pins the
 * missing baseline on a linked repository instead.
 * @returns true when the own manifest is present and readable.
 */
function ownBaselinePresent(): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(defaultRepositoryRoot(), STAMP_DIR, MANIFEST_FILE), 'utf8'))
    return typeof parsed === 'object' && parsed !== null && Reflect.get(parsed, 'version') === 1
  } catch {
    return false
  }
}

/**
 * Register the throttled auto-build dispatcher on the host context. It
 * observes fresh judgments; a moved source arms the stability window, a
 * persistent NEED_BUILD whose scope includes this tree's face — or a missing
 * OWN baseline (INIT, the bootstrap) — dispatches one gated build when every
 * gate is clear, an INIT that only a linked repository's baseline can clear
 * reports and dispatches nothing (cause split, 2026-11-01), a NEED_BUILD that
 * only a linked repository's drift can clear likewise reports and dispatches
 * nothing (build trigger = 主仓面, linked-split 2026-11-01), BUILD_FAILED arms
 * the exponential backoff (and a retry past the backoff re-dispatches — the
 * new build's opening clears the failure marker), and any success-shaped
 * judgment resets the backoff. Disposal cancels timers and unsubscribes.
 * @param ctx - Host context carrying the effect lifetime.
 * @param internals - Injectable seams for tests.
 */
export function registerAutoBuild(ctx: Context, internals: AutoBuildInternals = {}): void {
  const now = internals.now ?? Date.now
  const env = internals.env ?? process.env
  const timings = resolveAutoBuildTimings(env)
  const warn = internals.warn ?? ((message: string): void => { process.stderr.write(`${message}\n`) })
  const launch: BuildLauncher = internals.launch ?? ((commandLine: string, options: SpawnOptions) => spawn(commandLine, options))
  const collect = internals.collect ?? ((): Promise<RestartSignalJudgment> => collectRestartSignal())
  const lockHeld = internals.lockHeld ?? ((): boolean => heavyIoLockHeld(defaultHeavyIoLockDirectory(env)))
  const heldFlag = internals.heldFlag ?? ((): boolean => env.DSH_HEAVY_IO_HELD === '1')
  const command = internals.command ?? DEFAULT_BUILD_COMMAND
  const cwd = internals.cwd
  const journal = internals.journal ?? defaultAutoBuildJournalLine()
  const stampDirectory = internals.stampDirectory ?? join(defaultRepositoryRoot(), STAMP_DIR)
  const buildingMarker = internals.buildingMarker
    ?? ((): boolean => readBuildingCapture(defaultRepositoryRoot()))
  const failedMarker = internals.failedMarker
    ?? ((): boolean => existsSync(join(defaultRepositoryRoot(), STAMP_DIR, FAILURE_FILE)))
  const ownBaseline = internals.ownBaseline ?? ownBaselinePresent
  const subscribe = internals.subscribe
    ?? ((listener: (judgment: RestartSignalJudgment) => void): (() => void) => onRestartSignalJudgment(listener))

  let disposed = false
  let lastSeenFacts: RestartSignalFacts | undefined
  let lastMoveAt: number | undefined
  let lastDispatchAt = Number.NEGATIVE_INFINITY
  let backoffUntil = 0
  let failures = 0
  let failureRecorded = false
  let ownBuildPending = false
  let linkedBaselineWarned = false
  let linkedDriftWarned = false
  let lockDeferralStartedAt: number | undefined
  let fireTimer: ReturnType<typeof setTimeout> | undefined

  // Read through a function so control-flow narrowing never treats the
  // mutable flag as a constant inside spawned callbacks.
  const isDisposed = (): boolean => disposed

  const cancelTimer = (): void => {
    if (fireTimer !== undefined) clearTimeout(fireTimer)
    fireTimer = undefined
  }

  const scheduleAt = (at: number): void => {
    cancelTimer()
    const delay = Math.max(0, at - now())
    fireTimer = setTimeout(() => { void fire() }, delay)
    // Node timer: keep the host's idle exit semantics untouched.
    fireTimer.unref()
  }

  const arm = (): void => {
    const moveAt = lastMoveAt ?? now()
    scheduleAt(Math.max(moveAt + timings.stableMs, lastDispatchAt + timings.intervalMs, backoffUntil))
  }

  const recordFailure = (): void => {
    // One episode, one count: the BUILD_FAILED marker persists, so re-seeing
    // it (polling, route rechecks, the retry's own fire) must not slide the
    // backoff deadline forward — the next dispatch grows it by failing anew.
    if (failureRecorded) return
    failures += 1
    failureRecorded = true
    backoffUntil = now() + Math.min(timings.backoffMs * 2 ** (failures - 1), BACKOFF_CAP_MS)
    journal(`backoff failures=${failures} until=${new Date(backoffUntil).toISOString()}`)
  }

  const resetFailure = (): void => {
    if (failures > 0) journal(`episode-reset after ${String(failures)} failure(s)`)
    failures = 0
    failureRecorded = false
    backoffUntil = 0
  }

  const dispatchBuild = (reason: string): void => {
    lastDispatchAt = now()
    // The next failure observed belongs to the next episode: it must grow
    // the backoff instead of reusing this dispatch's count.
    failureRecorded = false
    ownBuildPending = true
    lockDeferralStartedAt = undefined
    const capture = openCaptureFiles(stampDirectory)
    const options: SpawnOptions = {
      shell: true,
      // Windows: NOT detached — a detached console-less cmd lets its console
      // grandchild allocate a fresh console, which the default terminal
      // (Windows Terminal) renders as a visible, focus-stealing window (the
      // 2026-11-01 run-gates popups); staying attached lets windowsHide's
      // hidden console cover the whole tree. Elsewhere detached keeps the
      // build outliving this process's session.
      detached: process.platform !== 'win32',
      // Failout (2026-11-03): file redirection, NOT pipes — a pipe's read end
      // dies with this host on restart and the still-running build would
      // crash writing into it (false BUILD_FAILED); files are immune. Falls
      // back to 'ignore' when the stamp dir is unwritable (observability
      // never blocks a build).
      stdio: capture === undefined ? 'ignore' : ['ignore', capture.stdoutFd, capture.stderrFd],
      windowsHide: true,
      env: process.env,
      ...(cwd === undefined ? {} : { cwd }),
    }
    const child = launch(command, options)
    // The parent keeps no fd copies: the child inherited its own handles, and
    // holding ours would pin the capture files open on Windows (rmSync would
    // fail and the next dispatch could not truncate).
    if (capture !== undefined) {
      try { closeSync(capture.stdoutFd) } catch { /* already closed */ }
      try { closeSync(capture.stderrFd) } catch { /* already closed */ }
    }
    let spawnFailed = false
    child.on('error', (error: Error) => {
      spawnFailed = true
      if (capture !== undefined) removeCapture(capture.stdoutPath, capture.stderrPath)
      if (isDisposed()) return
      warn(`ui-settings-general: auto-build dispatch failed: ${error.message}`)
      journal(`dispatch-error ${error.message}`)
      recordFailure()
      scheduleAt(backoffUntil)
    })
    // The failout line: non-zero exit folds both stream tails (4KB each,
    // whitespace-collapsed to ONE line) plus cmd and exit code into the
    // journal — the watchdog's build-failed family, same file. Exit 0 just
    // drops the captures: success adds no journal noise (failout 判据 4).
    // `close` after `error` carries no new truth; spawnFailed skips it and
    // the error path already dropped the captures.
    child.on('close', (code: number | null) => {
      if (spawnFailed || code === 0) {
        if (capture !== undefined) removeCapture(capture.stdoutPath, capture.stderrPath)
        return
      }
      const stdoutTail = capture === undefined ? '' : foldTail(capture.stdoutPath)
      const stderrTail = capture === undefined ? '' : foldTail(capture.stderrPath)
      if (capture !== undefined) removeCapture(capture.stdoutPath, capture.stderrPath)
      journal(`build-failed exit=${code ?? 'null'} cmd=${command} stdout-tail=${stdoutTail} stderr-tail=${stderrTail}`)
    })
    child.unref()
    warn(`ui-settings-general: auto-build dispatched (${command})`)
    journal(`dispatch reason=${reason} cmd=${command}`)
    // Outcome check: the state machine — via its markers — reports success
    // (the signal moves on) or failure (BUILD_FAILED arms the backoff).
    scheduleAt(now() + timings.intervalMs)
  }

  const fire = async (): Promise<void> => {
    if (isDisposed()) return
    fireTimer = undefined
    if (heldFlag() || lockHeld()) {
      const startedAt = lockDeferralStartedAt ?? now()
      if (lockDeferralStartedAt === undefined) journal('defer heavy-io-lock-held')
      lockDeferralStartedAt = startedAt
      if (now() - startedAt >= LOCK_DEFER_BOUND_MS) {
        warn('ui-settings-general: auto-build deferred: heavy-io lock held past the deferral bound; waiting for the next source move')
        journal('defer-giveup held-past-bound')
        lockDeferralStartedAt = undefined
        return
      }
      scheduleAt(now() + LOCK_RETRY_MS)
      return
    }
    const fresh = await collect()
    if (isDisposed()) return
    switch (fresh.state) {
      case 'INIT': {
        // The bootstrap (build-trigger hardening 2026-11-01, 洞①): INIT can
        // never produce a "fresh signal" on its own — the judgment outranks
        // BUILDING/BUILD_FAILED — so aborting here was a deadlock that left
        // the tree unbuilt until a human noticed the lamp. Read the machine's
        // markers directly instead: a build in flight dissolves into an
        // outcome check, a recorded failure arms the same exponential
        // backoff, and a quiet marker-free tree gets the one gated build
        // that writes the missing baseline. A bootstrap of a mid-edit tree
        // is self-correcting: the manifest records sStart, so the final
        // state still judges NEED_BUILD and the normal dispatch rebuilds.
        if (buildingMarker()) {
          scheduleAt(now() + timings.intervalMs)
          return
        }
        ownBuildPending = false
        if (ownBaseline()) {
          // INIT cause split (2026-11-01 storm fix): with this tree's manifest
          // present, INIT can only name a linked repository's missing manifest
          // (readRestartStamp scans the profile's link: repos) — no build of
          // this tree ever writes that file, so dispatching here rebuilt the
          // machine forever without clearing the condition (the observed
          // init-bootstrap storm, one visible `pnpm run build` window per
          // throttle cycle). Report once per episode and wait for that tree's
          // own stamped build; a missing own manifest keeps the bootstrap below.
          if (!linkedBaselineWarned) {
            linkedBaselineWarned = true
            warn('ui-settings-general: auto-build deferred: INIT comes from a linked repository missing its own build baseline; this tree cannot fix it')
            journal('defer init-linked-baseline')
          }
          scheduleAt(now() + timings.intervalMs)
          return
        }
        if (failedMarker()) {
          recordFailure()
          if (now() < backoffUntil) {
            scheduleAt(backoffUntil)
            return
          }
          dispatchBuild('init-retry')
          return
        }
        if (!sameFacts(fresh.facts, lastSeenFacts)) {
          lastSeenFacts = fresh.facts
          lastMoveAt = now()
          arm()
          return
        }
        dispatchBuild('init-bootstrap')
        return
      }
      case 'BUILDING':
        // The fire-time collect saw a build in flight — ours or the save
        // chain's — so this attempt dissolves into a later outcome check.
        scheduleAt(now() + timings.intervalMs)
        return
      case 'BUILD_FAILED': {
        ownBuildPending = false
        recordFailure()
        if (now() < backoffUntil) {
          scheduleAt(backoffUntil)
          return
        }
        // Past the backoff the retry itself is the recovery: the new build's
        // opening clears the failure marker (P0 build-stamp semantics).
        dispatchBuild('failed-retry')
        return
      }
      case 'NEED_BUILD': {
        // The stability window is measured against the collect-time truth:
        // a source that moved while we waited restarts the window instead of
        // building a half-edited tree (the manifest would catch it anyway,
        // but a quiet tree builds once, not three times).
        ownBuildPending = false
        if (!sameFacts(fresh.facts, lastSeenFacts)) {
          lastSeenFacts = fresh.facts
          lastMoveAt = now()
          arm()
          return
        }
        if (fresh.facts?.ownFaceMoved === false) {
          // Build trigger = 主仓面 (linked-split 2026-11-01): only a linked
          // tree's source moved; this tree's build writes this tree's manifest
          // and can never clear that gap — dispatching here was the second
          // loop (one need-build dispatch per throttle cycle, forever). Report
          // once per episode and keep observing: an own-face move dispatches
          // normally, and a linked rebuild resolves the lamp on its own.
          if (!linkedDriftWarned) {
            linkedDriftWarned = true
            warn('ui-settings-general: auto-build deferred: NEED_BUILD comes from a linked repository source drift; this tree agrees with its own baseline')
            journal('defer linked-source-drift')
          }
          scheduleAt(now() + timings.intervalMs)
          return
        }
        dispatchBuild('need-build')
        return
      }
      default:
        // NEED_RESTART / OK / CLIENT_UPDATED: nothing to build; a success-
        // shaped outcome clears the failure backoff.
        ownBuildPending = false
        resetFailure()
        return
    }
  }

  const unsubscribe = subscribe((judgment) => {
    if (disposed) return
    // A judgment that left INIT ends the linked-baseline episode: the next
    // INIT (should one arrive) gets its one journal line again.
    if (judgment.state !== 'INIT') linkedBaselineWarned = false
    // Likewise a judgment that is no longer a linked-only drift (or lacks the
    // own-face fact) ends the linked-drift episode for its one journal line.
    if (judgment.state !== 'NEED_BUILD' || judgment.facts?.ownFaceMoved !== false) linkedDriftWarned = false
    switch (judgment.state) {
      case 'BUILDING':
        if (ownBuildPending) scheduleAt(now() + timings.intervalMs)
        else cancelTimer()
        return
      case 'BUILD_FAILED':
        recordFailure()
        arm()
        return
      case 'NEED_RESTART':
      case 'OK':
      case 'CLIENT_UPDATED':
        ownBuildPending = false
        resetFailure()
        cancelTimer()
        return
      case 'INIT':
      case 'NEED_BUILD': {
        // INIT arms the same throttle as NEED_BUILD: the bootstrap dispatch
        // in fire() is the only act that can ever leave the INIT state.
        const moved = !sameFacts(judgment.facts, lastSeenFacts)
        lastSeenFacts = judgment.facts
        if (moved) lastMoveAt = now()
        arm()
        return
      }
    }
  })

  ctx.effect(() => () => {
    disposed = true
    cancelTimer()
    unsubscribe()
  }, 'ui-settings-general: auto-build dispatch')
}
