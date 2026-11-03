/**
 * Build-start marker liveness (O-1103, orphan start-marker recovery).
 *
 * The BUILDING lamp's physical carrier (`.dsh-build/restart-stamp.start.json`)
 * used to be judged by file existence alone: when the build process is killed
 * (observed 2026-11-01 — a foreground `pnpm run build` hit win_bash's 300s
 * tool timeout and died) the marker stayed behind forever, and the state
 * machine, the auto-build dispatcher and the watchdog all believed a build was
 * in flight — permanently BUILDING, never triggering again until a rerun's
 * `beginBuild` overwrote it (m-note `content/tech/ai/dsh/build-trigger-hardening-1101.md`
 * §七, board `#orphan-start-marker-1101`).
 *
 * The opening step now records the build process `pid` alongside the start
 * `time`, and readers probe the way the heavy-io lock does
 * (`scripts/heavy-io-gate.ts` `isProcessAlive` + `startedAt` age bound):
 *
 * | marker state | verdict |
 * |---|---|
 * | absent | not building |
 * | unreadable / no usable `time` | building (fail-soft to the old existence semantics) |
 * | age ≥ {@link BUILD_START_TRUST_BOUND_MS} | orphan `trust-bound-exceeded` (pid-reuse / hung-build bound) |
 * | pid present and dead | orphan `process-dead` |
 * | otherwise (pid alive, or a legacy pid-less marker inside the bound) | building |
 *
 * An orphan is cleared here — marker removed plus one
 * `orphan-start-marker-cleared` line in the tree's auto-build journal — so the
 * very judgment that would have reported BUILDING recovers in one pass, with
 * the recovery greppable in the journal. Design = m-note
 * `content/tech/ai/dsh/dsh-restart-signal-design.md` revision O-1103.
 * @module @deepseek-ai/dsh-client-ui-settings-general/build-start-liveness
 */
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { defaultAutoBuildJournalLine } from './auto-build-journal.ts'

/** Gitignored directory holding the per-tree build markers (mirrors the state-machine-side constant). */
const STAMP_DIR = '.dsh-build'

/** Build-start capture file name inside the stamp directory (mirrors the scripts-side constant). */
const START_CAPTURE_FILE = 'restart-stamp.start.json'

/**
 * Age past which a start marker counts as an orphan even when its pid is
 * alive — the Windows pid-reuse / hung-build bound, mirroring the heavy-io
 * lock's `DEFAULT_STALE_AFTER_MS` (same 90min value: it must outlive the
 * longest build the gate ever holds, while still bounding how long a reused
 * pid can hold the lamp hostage).
 */
export const BUILD_START_TRUST_BOUND_MS = 90 * 60 * 1000

/** Why a start marker was judged orphaned. */
export type OrphanReason = 'process-dead' | 'trust-bound-exceeded'

/** One liveness verdict over a tree's build-start capture. */
export type BuildStartProbe =
  /** No marker on disk (or unreadable as a file). */
  | { readonly state: 'absent' }
  /** A build counts as in flight; `startedAt` is the capture time when readable. */
  | { readonly state: 'building'; readonly startedAt?: string }
  /** The marker outlived its build: clear it and journal the recovery. */
  | { readonly state: 'orphan'; readonly pid: number | undefined; readonly ageMs: number; readonly reason: OrphanReason }

/**
 * Check whether a process id is alive (mirror of `scripts/heavy-io-gate.ts`
 * `isProcessAlive`: a signal-0 probe where a permission error still counts as
 * alive, because an unqueryable process is not proven dead).
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
 * Probe one tree's build-start capture for liveness. Pure read: never
 * deletes, never journals — clearing is {@link readBuildingCapture}'s job.
 * @param repositoryRoot - Harness tree whose `.dsh-build` holds the capture.
 * @param now - Clock in milliseconds; injectable for the age-bound tests.
 * @returns The verdict over the marker currently on disk.
 */
export function probeBuildStartCapture(repositoryRoot: string, now: number = Date.now()): BuildStartProbe {
  let text: string
  try {
    text = readFileSync(join(repositoryRoot, STAMP_DIR, START_CAPTURE_FILE), 'utf8')
  } catch {
    return { state: 'absent' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Unreadable body: keep the old existence semantics (a marker we cannot
    // judge must not be cleared — clearing blind could kill a live build).
    return { state: 'building' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { state: 'building' }
  const record = parsed as Record<string, unknown>
  const time = record.time
  if (typeof time !== 'string') return { state: 'building' }
  const startedAtMs = Date.parse(time)
  if (!Number.isFinite(startedAtMs)) return { state: 'building' }
  const pid = typeof record.pid === 'number' ? record.pid : undefined
  const ageMs = now - startedAtMs
  if (ageMs >= BUILD_START_TRUST_BOUND_MS) return { state: 'orphan', pid, ageMs, reason: 'trust-bound-exceeded' }
  if (pid !== undefined && !isProcessAlive(pid)) return { state: 'orphan', pid, ageMs, reason: 'process-dead' }
  return { state: 'building', startedAt: time }
}

/**
 * Read a tree's build-start capture as the BUILDING lamp's input, clearing an
 * orphaned marker on the way: a dead build's marker is removed and one
 * `orphan-start-marker-cleared` line lands in `.dsh-build/auto-build.log`, so
 * the same pass judges BUILDING false instead of staying stuck forever
 * (one poll, no rerun needed — acceptance ① of `#orphan-start-marker-1101`).
 * @param repositoryRoot - Harness tree whose `.dsh-build` holds the capture.
 * @param journal - Line sink; defaults to this tree's auto-build journal.
 * @returns Whether a live build is in flight after any orphan recovery.
 */
export function readBuildingCapture(
  repositoryRoot: string,
  journal: (line: string) => void = defaultAutoBuildJournalLine(repositoryRoot),
): boolean {
  const probe = probeBuildStartCapture(repositoryRoot)
  if (probe.state === 'absent') return false
  if (probe.state === 'building') return true
  try {
    rmSync(join(repositoryRoot, STAMP_DIR, START_CAPTURE_FILE), { force: true })
  } catch {
    // Fail-soft: an undeletable marker keeps its old semantics on the next
    // read; the journal line below still records the verdict.
  }
  journal(`orphan-start-marker-cleared pid=${probe.pid ?? 'unknown'} ageSec=${Math.round(probe.ageMs / 1000)} reason=${probe.reason}`)
  return false
}
