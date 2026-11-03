/**
 * The auto-build decision journal: one rotating append sink beside the
 * manifest (`.dsh-build/auto-build.log`) that records every dispatch / defer /
 * backoff / episode-reset decision — and, since O-1103, the state machine's
 * orphan start-marker recovery line.
 *
 * It lives in its own module so the build-start liveness probe can write
 * there without importing the dispatcher: the dispatcher rides the state
 * machine's judgment stream (`auto-build-dispatch` → `restart-signal`), so a
 * liveness module that imported the dispatcher would close an import cycle
 * (`restart-signal` → `build-start-liveness` → `auto-build-dispatch`).
 *
 * Best-effort by design — a journal failure must never take a judgment or a
 * dispatch down, so writes swallow their own errors after the rotation
 * attempt.
 * @module @deepseek-ai/dsh-client-ui-settings-general/auto-build-journal
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { defaultRepositoryRoot } from './restart-stamp.ts'

/** Gitignored directory holding the per-tree build markers (mirrors the
 * state-machine-side constants). */
const STAMP_DIR = '.dsh-build'

/** Journal file beside the manifest; rotated past this size (best-effort observability). */
const JOURNAL_FILE = 'auto-build.log'

/** Journal rotation threshold: keep the last ~512KB of dispatch decisions. */
const JOURNAL_CAP_BYTES = 512 * 1024

/**
 * The durable decision journal: one line per dispatch / defer / backoff /
 * error / episode-reset beside the manifest (`.dsh-build/auto-build.log`),
 * rotated past {@link JOURNAL_CAP_BYTES}. Best-effort by design — a journal
 * failure must never take the caller down, so writes swallow their own
 * errors after the rotation attempt.
 * @param repositoryRoot - Harness tree whose stamp directory holds the journal.
 * @returns A line sink safe to call from any dispatcher or judgment path.
 */
export function defaultAutoBuildJournalLine(repositoryRoot: string = defaultRepositoryRoot()): (line: string) => void {
  const directory = join(repositoryRoot, STAMP_DIR)
  const path = join(directory, JOURNAL_FILE)
  return (line: string): void => {
    try {
      mkdirSync(directory, { recursive: true })
      if (existsSync(path) && statSync(path).size > JOURNAL_CAP_BYTES) {
        renameSync(path, `${path}.old`)
      }
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // Observability only: never propagate into the judgment/dispatch path.
    }
  }
}
