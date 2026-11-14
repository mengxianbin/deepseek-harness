/**
 * The auto-build decision journal — the audited single append stream of the
 * build-dispatch single-source architecture (build-dispatch ⑤, 2026-11-13).
 *
 * One rotating file beside the manifest (`.dsh-build/auto-build.log`) carries
 * every build-relevant decision on the machine: host kicks, watchdog judgment
 * and kick lines, executor dispatch/terminal lines, and the state machine's
 * orphan start-marker recovery line (O-1103). It lives in its own module so
 * every writer — host, collector, executor — composes the SAME sink, and the
 * Python twin of this exact protocol lives in m-note's
 * `scripts/dsh/build-watchdog.py` `write_journal` (same lock directory, same
 * seq sidecar, same line shape), so a python watchdog and this module cannot
 * interleave or hand out duplicate sequence numbers.
 *
 * The five audit properties (裁决档 build-dispatch-single-source-1109 件⑤):
 *
 * 1. **Single writer protocol** — one append path, one short `mkdir` lock
 *    (`.dsh-build/auto-build.log.lock`, stale sweep + loud break), every line
 *    tagged `[writer]`. Four production writers seat here: `[host]` kicks,
 *    `[watchdog]` judgments (Python twin), `[exec]` the executor, `[collect]`
 *    the offhost collector's orphan clear — the second-writer tension recorded
 *    in `#stamp-recheck-offhost-1110` is seated INTO this seq stream, not
 *    worked around.
 * 2. **Monotonic `seq` per line** — `.dsh-build/auto-build.seq` increments
 *    under the lock; rotation does NOT reset it, so a rotated-away window shows
 *    as a visible seq jump: readers get "trustworthy before N, known-untrusted
 *    after" instead of "probably fine".
 * 3. **Heartbeat lines** — the executor emits `heartbeat …` every 60s while it
 *    holds the execution period; a silent window is then an *observed* silence.
 * 4. **Loud degradation, never silent** — a main-face write failure shouts one
 *    stderr line and lands the message on the independent fallback face
 *    `~/.dsh/auto-build-fallback.log` (data home, outside the repository). The
 *    old `catch {}` swallow is gone: swallowing a journal line dresses a write
 *    failure up as "no event happened".
 * 5. **Single-line atomic append** — embedded newlines fold to spaces before a
 *    single append call, so a torn write can only ever cost a tail (seq gap),
 *    never split one record across lines.
 *
 * Delivery: an uncontended write is synchronous (the common case keeps the
 * old observable semantics); contention queues onto an async chain whose waits
 * are timers, never busy-loops — the host event loop only ever spins through
 * the sub-millisecond critical section (availability gate ①).
 * @module @deepseek-ai/dsh-client-ui-settings-general/auto-build-journal
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  isDirLockBusy,
  releaseDirLockSync,
  tryAcquireDirLockSync,
  withDirLock,
} from './dir-lock.ts'
import { defaultRepositoryRoot } from './restart-stamp.ts'

/** Gitignored directory holding the per-tree build markers (mirrors the
 * state-machine-side constants). */
const STAMP_DIR = '.dsh-build'

/** Journal file beside the manifest; rotated past {@link JOURNAL_CAP_BYTES}. */
const JOURNAL_FILE = 'auto-build.log'

/** Journal rotation threshold: keep the last ~512KB of decisions. */
const JOURNAL_CAP_BYTES = 512 * 1024

/** Monotonic sequence sidecar inside the stamp directory (protocol ②). */
export const AUTO_BUILD_JOURNAL_SEQ_FILE = 'auto-build.seq'

/** Append lock directory inside the stamp directory (protocol ①). */
export const AUTO_BUILD_JOURNAL_LOCK_DIR = 'auto-build.log.lock'

/** Independent fallback face in the DSH data home (protocol ④). */
export const AUTO_BUILD_JOURNAL_FALLBACK_FILE = 'auto-build-fallback.log'

/** Which production writer emitted a line; rendered as `[writer]`. */
export type AutoBuildJournalWriter = 'host' | 'watchdog' | 'exec' | 'collect' | (string & {})

/** Injection seams for one journal sink. */
export interface AutoBuildJournalOptions {
  /** Writer tag; defaults to `'host'` (the package's original owner). */
  readonly writer?: AutoBuildJournalWriter
  /** Loud-degradation sink; defaults to one stderr line. */
  readonly warn?: (message: string) => void
  /** Fallback face; defaults to `<DSH data home>/auto-build-fallback.log`.
   * Test seam — production must stay on the data home so a broken stamp
   * directory can never take the escape face down with it. */
  readonly fallbackPath?: string
}

/** Line sink safe from any judgment/dispatch path, plus an explicit flush for
 * short-lived processes that must prove their lines landed before exit. */
export interface AutoBuildJournalSink {
  /** Queue one decision line (fire-and-forget; never throws). */
  (line: string): void
  /** Resolve once every queued line has settled (main face or fallback). */
  flush: () => Promise<void>
}

/** Fold a message onto one physical line (protocol ⑤). */
function foldMessage(message: string): string {
  return message.replace(/[\r\n]+/g, ' ')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read the shared sequence counter (absent/invalid sidecar = stream start). */
function readSeq(sidecarPath: string): number {
  try {
    const parsed = Number.parseInt(readFileSync(sidecarPath, 'utf8').trim(), 10)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
  } catch {
    return 0
  }
}

/** One fully locked append: allocate seq → rotate if owed → append the line.
 * All synchronous on purpose: the critical section is sub-millisecond and the
 * caller is either already off the fast path (async waiter) or a short-lived
 * non-host process. */
function appendLocked(path: string, sidecarPath: string, writer: string, body: string): void {
  const seq = readSeq(sidecarPath) + 1
  // Seq lands BEFORE the line: a crash between the two shows up as the next
  // line's seq skipping a number — a detectable break, never a silent loss.
  writeFileSync(sidecarPath, String(seq))
  if (existsSync(path)) {
    try {
      if (statSync(path).size > JOURNAL_CAP_BYTES) renameSync(path, `${path}.old`)
    } catch {
      // Rotation is best-effort observability hygiene (pre-existing semantics).
    }
  }
  appendFileSync(path, `${new Date().toISOString()} [${writer}] ${body} seq=${String(seq)}\n`, 'utf8')
}

/**
 * The durable, audited decision journal: one line per kick / dispatch / defer /
 * failure / heartbeat beside the manifest, protocol ①–⑤ above.
 * @param repositoryRoot - Harness tree whose stamp directory holds the journal.
 * @param options - Writer tag, loud sink, fallback seam.
 * @returns A line sink; writes never throw at their caller.
 */
export function defaultAutoBuildJournalLine(
  repositoryRoot: string = defaultRepositoryRoot(),
  options: AutoBuildJournalOptions = {},
): AutoBuildJournalSink {
  const writer = options.writer ?? 'host'
  const directory = join(repositoryRoot, STAMP_DIR)
  const path = join(directory, JOURNAL_FILE)
  const sidecarPath = join(directory, AUTO_BUILD_JOURNAL_SEQ_FILE)
  const lockPath = join(directory, AUTO_BUILD_JOURNAL_LOCK_DIR)
  const warn = options.warn ?? ((message: string): void => { process.stderr.write(`${message}\n`) })
  const fallbackPath = (): string =>
    options.fallbackPath ?? join(resolveDshHome(), AUTO_BUILD_JOURNAL_FALLBACK_FILE)

  /** Protocol ④: shout first, then land the line on the independent face. */
  const degrade = (body: string, error: unknown): void => {
    warn(`auto-build-journal: main face write failed (${errorText(error)}); landing on the fallback face — [${writer}] ${body}`)
    try {
      const target = fallbackPath()
      mkdirSync(dirname(target), { recursive: true })
      appendFileSync(target, `${new Date().toISOString()} [${writer}] FALLBACK ${body}\n`, 'utf8')
    } catch (fallbackError) {
      warn(`auto-build-journal: fallback face unwritable too (${errorText(fallbackError)}); line LOST after this shout — [${writer}] ${body}`)
    }
  }

  /** Uncontended fast path: whole protocol under one synchronous section. */
  const writeSync = (body: string): void => {
    try {
      // The lock lives inside this directory, so the parent must exist before
      // the first acquire; later calls hit the idempotent fast path.
      mkdirSync(directory, { recursive: true })
      tryAcquireDirLockSync(lockPath)
    } catch (error) {
      if (isDirLockBusy(error)) throw error // Hand the body to the async waiter.
      degrade(body, error)
      return
    }
    try {
      appendLocked(path, sidecarPath, writer, body)
    } catch (error) {
      degrade(body, error)
    } finally {
      releaseDirLockSync(lockPath)
    }
  }

  /** Contended path: wait on timers (never block the caller's loop), then append. */
  const writeContended = (body: string): Promise<void> =>
    withDirLock(
      lockPath,
      () => {
        try {
          appendLocked(path, sidecarPath, writer, body)
        } catch (error) {
          degrade(body, error)
        }
      },
      { warn },
    ).catch((error: unknown) => {
      degrade(body, error)
    })

  /** One FIFO queue per sink: sync fast path when idle, chained when busy. */
  let chain: Promise<void> | undefined
  const enqueue = (body: string): void => {
    const next: Promise<void> = (chain ?? Promise.resolve()).then(() => writeContended(body))
    chain = next
    void next.then(() => {
      if (chain === next) chain = undefined
    })
  }

  const sink = ((line: string): void => {
    const body = foldMessage(line)
    if (chain !== undefined) {
      enqueue(body)
      return
    }
    try {
      writeSync(body)
    } catch (error) {
      if (!isDirLockBusy(error)) return // Already degraded loudly inside writeSync.
      enqueue(body)
    }
  }) as AutoBuildJournalSink

  sink.flush = async (): Promise<void> => {
    for (;;) {
      const pending = chain
      if (pending === undefined) return
      await pending
      if (chain === pending) {
        chain = undefined
        return
      }
    }
  }

  return sink
}
