/**
 * One synchronous line on every web-host exit, written straight to disk
 * (restart-attribution-inbox-1118 批1 L2, 2026-11-19).
 *
 * The pipeline tee (`weblog-timestamp.py`) only learns the upstream closed;
 * it cannot say what the exit code was, and a hard kill (`taskkill /F`,
 * TerminateProcess) runs no in-process hook at all — that half is the parent
 * wait in 批2. What this hook covers is every exit Node itself decides:
 * normal completion, `process.exit()`, and a JS-level fatal error that still
 * reaches the `exit` event.
 *
 * The append is `appendFileSync` — never the stdout pipe, which may already be
 * gone (the 2026-11-18 15:41:49 death left zero bytes: log cut, no fatal, no
 * stack). Failure is fail-open: a journal that cannot be written must never
 * change how the process exits.
 * @module @deepseek-ai/dsh/cli-exit-journal
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Account filename under the DSH home — sibling of the other host ledgers. */
export const EXIT_JOURNAL_FILENAME = 'dsh-web-exit.log'

/** Pad a clock component to two digits for the journal's `HH:mm:ss` stamp. */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * The journal line for one exit: local wall clock (same basis as
 * `dsh-start.log` / `dsh-restart.log`), then the code, profile, and pid.
 * @param code - Exit code the process is leaving with.
 * @param profile - Profile being booted (recorded for grep, not for filtering).
 * @param pid - Process id of the exiting node process.
 * @param now - Exit instant; the default keeps production callers honest while tests pin it.
 * @returns one newline-terminated ASCII line.
 */
export function formatExitLine(code: number, profile: string, pid: number, now: Date = new Date()): string {
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
    + ` ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
  return `[${stamp}] node exit code=${code} profile=${profile} pid=${pid}\n`
}

/**
 * Build the `exit` listener that appends {@link formatExitLine} to `journalPath`.
 * Separated from installation so tests can invoke the listener directly instead
 * of emitting a real `exit` on the test process.
 * @param journalPath - Absolute path of the account file.
 * @param profile - Profile being booted.
 * @param pid - Process id to record; defaults to the live process.
 * @returns the listener to register with `process.on('exit', …)`.
 */
export function createExitHandler(
  journalPath: string,
  profile: string,
  pid: number = process.pid,
): (code: number) => void {
  return (code: number): void => {
    try {
      appendFileSync(journalPath, formatExitLine(code, profile, pid), { encoding: 'utf8', flag: 'a' })
    } catch {
      /* fail-open: a journal write must never alter the exit itself. */
    }
  }
}

/**
 * Register the web-host exit account. Non-web profiles return immediately —
 * the account exists to answer "how did the host die", and a tui session
 * exiting on every user quit would bury that signal in noise.
 * @param profile - Profile named by the invocation (`web`, `tui`, …).
 * @param journalPath - Override for tests; the default resolves at call time.
 */
export function installExitJournal(profile: string, journalPath?: string): void {
  if (profile.toLowerCase() !== 'web') return
  let path: string
  try {
    path = journalPath ?? join(resolveDshHome(), EXIT_JOURNAL_FILENAME)
  } catch {
    return // fail-open: an unresolvable home disables the account, never the boot.
  }
  process.on('exit', createExitHandler(path, profile))
}
