/**
 * Cross-process short critical section over one directory (build-dispatch
 * single-source ⑤): `mkdir` is atomic on every supported platform, so exactly
 * one caller wins; the winner holds the directory only while it performs a
 * read-modify-write, and a holder that dies mid-section is swept by the stale
 * bound instead of wedging every later writer.
 *
 * Consumers: the auto-build journal's seq allocation (`auto-build-journal.ts`
 * also has an uncontended synchronous fast path and reuses these primitives)
 * and the linked-build account read-modify-write in `scripts/auto-build-exec.ts`
 * — the Python twin of the same protocol lives in m-note's
 * `scripts/dsh/build-watchdog.py` (`_journal_lock` / `_state_lock`), so both
 * languages serialize on the SAME lock directory.
 *
 * The wait is asynchronous on purpose: a contended writer must never block the
 * dsh host event loop (availability gate ① — the host only ever touches the
 * journal through this path).
 * @module @deepseek-ai/dsh-client-ui-settings-general/dir-lock
 */
import { mkdirSync, rmSync, statSync } from 'node:fs'

/** Default stale bound: a live holder keeps its section under a few ms, so a
 * directory older than this belongs to a dead process and is swept. */
export const DIR_LOCK_STALE_MS = 5_000

/** Default wait bound: after this long the lock is broken loudly (one force
 * attempt) instead of waiting forever — liveness beats sequence purity, and
 * the forced break is warned, never silent. */
export const DIR_LOCK_WAIT_MS = 15_000

/** Error subclass marking "another writer holds the lock right now". */
export class DirLockBusyError extends Error {
  public constructor(public readonly directory: string) {
    super(`dir-lock: busy: ${directory}`)
    this.name = 'DirLockBusyError'
  }
}

/** Error subclass marking "the lock stayed busy past the wait bound". */
export class DirLockTimeoutError extends Error {
  public constructor(public readonly directory: string, public readonly waitedMs: number) {
    super(`dir-lock: wait bound exceeded after ${String(waitedMs)}ms: ${directory}`)
    this.name = 'DirLockTimeoutError'
  }
}

/** True for the busy signal (a foreign holder), false for real I/O failures. */
export function isDirLockBusy(error: unknown): error is DirLockBusyError {
  return error instanceof DirLockBusyError
}

/**
 * Take the lock directory synchronously.
 * @param directory - Lock directory path (created atomically).
 * @throws {DirLockBusyError} when another writer holds it right now.
 * @throws Any other I/O error verbatim (an unwritable parent is a write failure,
 *   not contention — callers degrade loudly).
 */
export function tryAcquireDirLockSync(directory: string): void {
  try {
    mkdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DirLockBusyError(directory)
    throw error
  }
}

/**
 * Release the lock directory; only the holder calls this (best effort — a
 * vanished directory already satisfies the goal).
 * @param directory - Lock directory path.
 */
export function releaseDirLockSync(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true })
  } catch {
    // Best effort: the stale sweep owns whatever this leaves behind.
  }
}

/** Remove the lock directory when its holder clearly died (age past stale). */
function sweepStale(directory: string, staleMs: number): boolean {
  try {
    if (Date.now() - statSync(directory).mtimeMs <= staleMs) return false
  } catch {
    return false // Vanished between checks: the next acquire decides.
  }
  releaseDirLockSync(directory)
  return true
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => { setTimeout(done, ms) })
}

/**
 * Run `fn` while holding the lock directory, waiting for a live holder instead
 * of stepping on it, and sweeping a dead holder's lock after {@link DIR_LOCK_STALE_MS}.
 * @param directory - Lock directory path.
 * @param fn - Critical section; runs exactly once if the lock was ever taken.
 * @param options - `staleMs` / `waitMs` bounds and a `warn` sink for the loud break.
 * @returns Whatever `fn` returns.
 * @throws {DirLockTimeoutError} when the wait bound passes; the lock is broken
 *   loudly first (one force attempt) so a wedged holder cannot mute the journal
 *   forever.
 */
export async function withDirLock<T>(
  directory: string,
  fn: () => T | Promise<T>,
  options: { readonly staleMs?: number; readonly waitMs?: number; readonly warn?: (message: string) => void } = {},
): Promise<T> {
  const staleMs = options.staleMs ?? DIR_LOCK_STALE_MS
  const waitMs = options.waitMs ?? DIR_LOCK_WAIT_MS
  const warn = options.warn ?? ((message: string): void => { process.stderr.write(`${message}\n`) })
  const startedAt = Date.now()
  let brokeOnce = false
  for (;;) {
    try {
      tryAcquireDirLockSync(directory)
      break
    } catch (error) {
      if (!isDirLockBusy(error)) throw error
      if (sweepStale(directory, staleMs)) continue
      if (Date.now() - startedAt >= waitMs) {
        if (brokeOnce) throw new DirLockTimeoutError(directory, Date.now() - startedAt)
        brokeOnce = true
        warn(`dir-lock: breaking a lock held past the wait bound (loud): ${directory}`)
        releaseDirLockSync(directory)
        continue
      }
      await sleep(3 + Math.floor(Math.random() * 7))
    }
  }
  try {
    return await fn()
  } finally {
    releaseDirLockSync(directory)
  }
}
