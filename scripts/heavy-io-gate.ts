/**
 * Machine-wide advisory gate for heavy repository jobs.
 *
 * Workstation runs share one disk and one memory pool, so concurrent heavy jobs
 * (lint, typecheck, …) from separate sessions pile up and starve interactive work.
 * This gate serializes them through one advisory lock directory. It is fail-open by
 * design: a stale lock (dead owner or past the age bound) is broken, and a waiter
 * past its bound proceeds anyway — the gate trades strict mutual exclusion for never
 * becoming its own outage.
 *
 * Usage: `tsx scripts/heavy-io-gate.ts "<shell command>"`.
 * CI (`CI=true`), `DSH_HEAVY_IO=0`, and nested calls that already hold the gate
 * (`DSH_HEAVY_IO_HELD=1`) pass the command straight through.
 *
 * Every transition also appends one observation line to a history.log kept
 * outside the lock directory (acquire / waiting / fail-open / stale-break /
 * release / passthrough, each with ISO time, pid and command). Pure observation:
 * no gate decision reads it and every write failure is swallowed, so a full disk
 * costs at most the log line, never the gate.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_POLL_INTERVAL_MS = 2_000
// A full-repo `pnpm run test` runs ~38 min on this host (m-note
// worktree-governance §5.7 cost anchor), so a 15 min wait bound let the second
// job fail-open and race it — the gate only ever saw one heavy job at a time by
// luck. 45 min puts a whole full test inside one waiter's bound.
const DEFAULT_WAIT_BOUND_MS = 45 * 60 * 1000
// Stale-after must outlive the longest job the gate ever holds, or a waiter
// breaks a live owner's lock mid-run and the two jobs race anyway. 30 min was
// shorter than a full test; 90 min clears the 45 min wait bound with headroom.
// A dead owner is still broken immediately via `isProcessAlive`, so crash
// recovery is unaffected — this bound only governs how long a live owner is
// trusted.
const DEFAULT_STALE_AFTER_MS = 90 * 60 * 1000

/**
 * Resolve the default lock directory.
 * It must be stable across shells and sessions — `os.tmpdir()` is not: sandboxed
 * shells (for example dsh-win-bash) point TEMP at a per-session directory, which
 * would silently degrade the gate to per-session exclusion.
 * @param env - Environment of this process.
 * @returns the user-level lock directory shared by every session on the machine.
 */
export function defaultLockDirectory(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? tmpdir(), 'dsh-heavy-io-gate.lock')
  return join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dsh-heavy-io-gate.lock')
}

/**
 * Resolve the default observation history file.
 * It sits outside the lock directory on purpose: releasing the lock removes
 * that directory wholesale, so a log inside it would evaporate with every run.
 * @param env - Environment of this process.
 * @returns the user-level history.log path shared by every run on the machine.
 */
export function defaultHistoryFile(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? tmpdir(), 'dsh-heavy-io-gate', 'history.log')
  return join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dsh-heavy-io-gate', 'history.log')
}

/** Observation history path; `DSH_HEAVY_IO_HISTORY` overrides it (spec isolation). */
function historyFile(env: NodeJS.ProcessEnv): string {
  return env.DSH_HEAVY_IO_HISTORY ?? defaultHistoryFile(env)
}

/** Repeat `waiting` lines are rate-limited so a 2s poll cannot flood the log. */
const HISTORY_WAITING_INTERVAL_MS = 60_000

/**
 * Append one observation line to the history log (fail-soft).
 * Format: `<ISO time> <event> pid=<n> [fields…] cmd=<command>`; `cmd` is always
 * the last field so it may contain spaces and quotes.
 * Every failure path (full disk, missing permission, bad override path) is
 * swallowed here: history is pure observation and must never affect the gate.
 * @param file - History file path.
 * @param event - Event name (acquire / waiting / fail-open / stale-break / release / passthrough).
 * @param command - The gated command.
 * @param fields - Extra key=value fields, rendered before `cmd`.
 */
function recordHistory(
  file: string,
  event: string,
  command: string,
  fields: Record<string, string | number | boolean> = {},
): void {
  try {
    const clean = (value: string): string => value.replace(/[\r\n]+/g, ' ')
    const parts = [new Date().toISOString(), event, `pid=${process.pid}`]
    for (const [key, value] of Object.entries(fields)) parts.push(`${key}=${clean(String(value))}`)
    parts.push(`cmd=${clean(command)}`)
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${parts.join(' ')}\n`, 'utf8')
  } catch {
    // Observation only: a history write failure must never fail the gate.
  }
}

/** Record written into the lock directory by the current owner. */
export interface HeavyIoLockOwner {
  readonly pid: number
  readonly startedAt: string
  readonly command: string
}

function isOwnerRecord(value: unknown): value is HeavyIoLockOwner {
  return typeof value === 'object'
    && value !== null
    && 'pid' in value
    && typeof value.pid === 'number'
    && 'startedAt' in value
    && typeof value.startedAt === 'string'
    && 'command' in value
    && typeof value.command === 'string'
}

/**
 * Try to take the lock directory; `mkdir` is atomic, so exactly one caller wins.
 * @param directory - Lock directory path.
 * @param command - The gated command, recorded for waiters to report.
 * @returns the owner record on success, or undefined when another job holds the lock.
 */
export async function acquireHeavyIoLock(directory: string, command: string): Promise<HeavyIoLockOwner | undefined> {
  const owner: HeavyIoLockOwner = { pid: process.pid, startedAt: new Date().toISOString(), command }
  try {
    await mkdir(directory)
  } catch {
    return undefined
  }
  await writeFile(join(directory, 'owner.json'), JSON.stringify(owner))
  return owner
}

/**
 * Read the current lock owner.
 * @param directory - Lock directory path.
 * @returns the owner record, or undefined when the lock is absent or unreadable.
 */
export async function readHeavyIoLock(directory: string): Promise<HeavyIoLockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'))
    return isOwnerRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Check whether a process id is alive.
 * @param pid - Process id to probe.
 * @returns true when the process exists; permission errors count as alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Remove the lock directory when its owner is dead or the lock is older than the bound.
 * @param directory - Lock directory path.
 * @param staleAfterMs - Age bound after which any lock counts as stale.
 * @returns true when a stale lock was removed and the caller may retry the acquire.
 */
export async function breakStaleHeavyIoLock(directory: string, staleAfterMs: number): Promise<boolean> {
  const owner = await readHeavyIoLock(directory)
  if (owner !== undefined) {
    const ageMs = Date.now() - Date.parse(owner.startedAt)
    if (isProcessAlive(owner.pid) && ageMs < staleAfterMs) return false
  }
  await rm(directory, { recursive: true, force: true })
  return true
}

/**
 * Release the lock directory. Only the holder may call this.
 * @param directory - Lock directory path.
 */
export async function releaseHeavyIoLock(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true })
}

function runCommand(command: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((finish, fail) => {
    const child = spawn(command, { shell: true, stdio: 'inherit', env: { ...env, DSH_HEAVY_IO_HELD: '1' } })
    child.on('error', fail)
    child.on('close', (code) => {
      finish(code ?? 1)
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms))
}

async function runGated(command: string, env: NodeJS.ProcessEnv): Promise<number> {
  const directory = env.DSH_HEAVY_IO_LOCK_DIR ?? defaultLockDirectory(env)
  const history = historyFile(env)
  const pollMs = Number(env.DSH_HEAVY_IO_POLL_MS ?? DEFAULT_POLL_INTERVAL_MS)
  const waitBoundMs = Number(env.DSH_HEAVY_IO_WAIT_MS ?? DEFAULT_WAIT_BOUND_MS)
  const staleAfterMs = Number(env.DSH_HEAVY_IO_STALE_MS ?? DEFAULT_STALE_AFTER_MS)
  const deadline = Date.now() + waitBoundMs
  const startedAt = Date.now()
  let acquired = false
  let acquiredAt = 0
  let waitingLoggedAt = 0
  for (;;) {
    if (await acquireHeavyIoLock(directory, command) !== undefined) {
      acquired = true
      acquiredAt = Date.now()
      recordHistory(history, 'acquire', command)
      break
    }
    // Observation pre-read: breakStaleHeavyIoLock re-reads internally and only
    // answers yes/no, so the owner record about to be judged is captured here
    // (the helper's exported contract stays byte-identical).
    const heldForLog = await readHeavyIoLock(directory)
    if (await breakStaleHeavyIoLock(directory, staleAfterMs)) {
      if (heldForLog !== undefined) {
        recordHistory(history, 'stale-break', command, {
          holderPid: heldForLog.pid,
          holderAgeMs: Date.now() - Date.parse(heldForLog.startedAt),
          holderAlive: isProcessAlive(heldForLog.pid),
        })
      }
      continue
    }
    const holder = await readHeavyIoLock(directory)
    process.stderr.write(
      `heavy-io-gate: waiting for ${holder?.command ?? 'another heavy job'} (pid ${holder?.pid ?? 'unknown'})\n`,
    )
    // Captured at the original position (right after the waiting line, exactly
    // where the previous code evaluated it) so the history write below cannot
    // nudge the fail-open decision.
    const boundReached = Date.now() + pollMs > deadline
    if (Date.now() - waitingLoggedAt >= HISTORY_WAITING_INTERVAL_MS) {
      waitingLoggedAt = Date.now()
      recordHistory(history, 'waiting', command, {
        waitedMs: Date.now() - startedAt,
        holderPid: holder?.pid ?? 'none',
        ...(holder !== undefined ? { holderCmd: holder.command } : {}),
      })
    }
    if (boundReached) {
      process.stderr.write('heavy-io-gate: wait bound reached, proceeding anyway (fail-open).\n')
      recordHistory(history, 'fail-open', command, { waitedMs: Date.now() - startedAt })
      break
    }
    await sleep(pollMs + Math.floor(Math.random() * 500))
  }
  try {
    return await runCommand(command, env)
  } finally {
    if (acquired) {
      await releaseHeavyIoLock(directory)
      recordHistory(history, 'release', command, { heldMs: Date.now() - acquiredAt })
    }
  }
}

async function main(): Promise<void> {
  const command = process.argv.slice(2).join(' ')
  if (command === '') throw new Error('heavy-io-gate: expected a shell command argument after --.')
  const passthrough = process.env.CI === 'true'
    || process.env.DSH_HEAVY_IO === '0'
    || process.env.DSH_HEAVY_IO_HELD === '1'
  if (passthrough) {
    // Which bypass path fired is exactly the "was this gated?" question the
    // history exists to answer — record it, then proceed unchanged.
    recordHistory(historyFile(process.env), 'passthrough', command, {
      reason: process.env.CI === 'true' ? 'ci' : process.env.DSH_HEAVY_IO === '0' ? 'off' : 'held',
    })
  }
  process.exitCode = passthrough ? await runCommand(command, process.env) : await runGated(command, process.env)
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) await main()
