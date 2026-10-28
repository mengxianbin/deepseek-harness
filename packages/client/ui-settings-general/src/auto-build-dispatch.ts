/**
 * Auto-build dispatcher (P3, design §四 build 节流): rides the state machine's
 * judgment stream and turns a persistent `NEED_BUILD` into one gated build
 * dispatch — never a storm.
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
 * Dispatches are detached spawns: the build outlives this process and writes
 * its own start/failure markers (P0 build-stamp hooks), so the state machine
 * — not this dispatcher — remains the single truth for BUILDING/BUILD_FAILED.
 * A post-dispatch outcome check re-collects after the minimum interval to
 * observe success (state moves on; backoff resets) or failure (backoff arms).
 */
import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** Detached launcher seam typed like the restart dispatch's launcher. */
export type BuildLauncher = (commandLine: string, options: SpawnOptions) => {
  readonly unref: () => void
  readonly on: (event: 'error', listener: (error: Error) => void) => void
}

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
}

function sameFacts(left: RestartSignalFacts | undefined, right: RestartSignalFacts | undefined): boolean {
  if (left === undefined || right === undefined) return false
  return left.currentHostFace === right.currentHostFace && left.configStamp === right.configStamp
}

/**
 * Register the throttled auto-build dispatcher on the host context. It
 * observes fresh judgments; a moved source arms the stability window, a
 * persistent NEED_BUILD dispatches one detached build when every gate is
 * clear, BUILD_FAILED arms the exponential backoff (and a retry past the
 * backoff re-dispatches — the new build's opening clears the failure
 * marker), and any success-shaped judgment resets the backoff. Disposal
 * cancels timers and unsubscribes.
 * @param ctx - Host context carrying the effect lifetime.
 * @param internals - Injectable seams for tests.
 */
export function registerAutoBuild(ctx: Context, internals: AutoBuildInternals = {}): void {
  const now = internals.now ?? Date.now
  const env = internals.env ?? process.env
  const timings = resolveAutoBuildTimings(env)
  const warn = internals.warn ?? ((message: string): void => { process.stderr.write(`${message}\n`) })
  const launch = internals.launch ?? ((commandLine: string, options: SpawnOptions) => spawn(commandLine, options))
  const collect = internals.collect ?? ((): Promise<RestartSignalJudgment> => collectRestartSignal())
  const lockHeld = internals.lockHeld ?? ((): boolean => heavyIoLockHeld(defaultHeavyIoLockDirectory(env)))
  const heldFlag = internals.heldFlag ?? ((): boolean => env.DSH_HEAVY_IO_HELD === '1')
  const command = internals.command ?? DEFAULT_BUILD_COMMAND
  const cwd = internals.cwd
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
  }

  const resetFailure = (): void => {
    failures = 0
    failureRecorded = false
    backoffUntil = 0
  }

  const dispatchBuild = (): void => {
    lastDispatchAt = now()
    // The next failure observed belongs to the next episode: it must grow
    // the backoff instead of reusing this dispatch's count.
    failureRecorded = false
    ownBuildPending = true
    lockDeferralStartedAt = undefined
    const options: SpawnOptions = {
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
      ...(cwd === undefined ? {} : { cwd }),
    }
    const child = launch(command, options)
    child.on('error', (error: Error) => {
      if (isDisposed()) return
      warn(`ui-settings-general: auto-build dispatch failed: ${error.message}`)
      recordFailure()
      scheduleAt(backoffUntil)
    })
    child.unref()
    warn(`ui-settings-general: auto-build dispatched (${command})`)
    // Outcome check: the state machine — via its markers — reports success
    // (the signal moves on) or failure (BUILD_FAILED arms the backoff).
    scheduleAt(now() + timings.intervalMs)
  }

  const fire = async (): Promise<void> => {
    if (isDisposed()) return
    fireTimer = undefined
    if (heldFlag() || lockHeld()) {
      const startedAt = lockDeferralStartedAt ?? now()
      lockDeferralStartedAt = startedAt
      if (now() - startedAt >= LOCK_DEFER_BOUND_MS) {
        warn('ui-settings-general: auto-build deferred: heavy-io lock held past the deferral bound; waiting for the next source move')
        lockDeferralStartedAt = undefined
        return
      }
      scheduleAt(now() + LOCK_RETRY_MS)
      return
    }
    const fresh = await collect()
    if (isDisposed()) return
    switch (fresh.state) {
      case 'INIT':
        warn('ui-settings-general: auto-build aborted: no build baseline (INIT); waiting for a fresh signal')
        return
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
        break
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
        break
      }
      default:
        // NEED_RESTART / OK / CLIENT_UPDATED: nothing to build; a success-
        // shaped outcome clears the failure backoff.
        ownBuildPending = false
        resetFailure()
        return
    }
    dispatchBuild()
  }

  const unsubscribe = subscribe((judgment) => {
    if (disposed) return
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
      case 'NEED_BUILD': {
        const moved = !sameFacts(judgment.facts, lastSeenFacts)
        lastSeenFacts = judgment.facts
        if (moved) lastMoveAt = now()
        arm()
        return
      }
      default:
        // INIT: nothing to throttle until a baseline exists.
        return
    }
  })

  ctx.effect(() => () => {
    disposed = true
    cancelTimer()
    unsubscribe()
  }, 'ui-settings-general: auto-build dispatch')
}
