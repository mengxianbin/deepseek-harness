/**
 * Machine-checkable death/exit audit lines for heavy jobs
 * (heavyio-silentdeath-1128 · 判据源 = 用户 2026-11-28「不是重活，是一切活儿
 * 都杜绝静默死，凡是死必有死因留痕」——事后可归因、可定向改进、可准确诊断).
 *
 * Three line events share the history.log grammar
 * (`<ISO> <event> pid=<n> [key=value …] cmd=<command>`, `cmd` always last so it
 * may contain spaces):
 *
 * - `exit` — this process finished a job it ran: `path=normal|killed|timeout|
 *   spawn-error` plus a `freeMb`/`floorMb` memory snapshot taken at exit. Written
 *   in-process; Windows OOM kills are `TerminateProcess` and never reach any
 *   hook — that gap is exactly why the `die` writeback exists.
 * - `release` — the machine lock left, always carrying a non-empty
 *   `reason=正常收口|被杀|超时|stale-break`. Holder-released paths write it from
 *   the lease in `enterHeavyIoGate`; the externally-broken path writes it from
 *   the stale-break writeback below, so every lock removal is answerable.
 * - `die` — a holder found dead with no record of its own: written by the *next*
 *   acquirer that breaks the stale lock, carrying `path=killed`,
 *   `reason=stale-break`, the dead holder's pid/age, and a memory snapshot
 *   labelled `snapshotAt=discovery` (the best available — a dead process cannot
 *   sample its own exit; in-process exits label nothing because they ARE the
 *   exit instant). When the machine kill-audit log (m-note build-watchdog)
 *   has a matching `killed` row inside the holder's lifetime, the line is
 *   cross-referenced with `killedBy`/`killTier`/`killDetail` — the fact
 *   correction of 2026-11-28 (dispatch session-6561bef0) showed the dominant
 *   killer is the watchdog's tiered reaper (`tier-hard … tHard=258s`,
 *   `floor-tier`), so a death line must name *who* killed, not only that it
 *   died.
 *
 * The file sits beside history.log — outside the lock directory, so releasing
 * the lock never evaporates it. `DSH_HEAVY_IO_DIELOG` overrides the path (spec
 * isolation, the same convention as `DSH_HEAVY_IO_HISTORY`). Every write is
 * fail-soft: audit must never take the gate down; a lost line reports on stderr
 * instead of throwing (mirrors `recordHistory` in heavy-io-gate.ts).
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { freemem, homedir, totalmem, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** How the machine lock left — every release line carries one of these, never empty. */
export type LockReleaseReason = '正常收口' | '被杀' | '超时' | 'stale-break'

/** Exit path recorded on `exit`/`die` lines. `spawn-error` = the child never started. */
export type ExitPath = 'normal' | 'killed' | 'timeout' | 'spawn-error'

/** Fields rendered before `cmd` on one audit line. */
export type DieFields = Record<string, string | number | boolean>

/**
 * Resolve the default die-log file.
 * Same directory as history.log on purpose: both live outside the lock
 * directory so no lock removal can evaporate the audit trail.
 * @param env - Environment of this process.
 * @returns the user-level die.log path shared by every run on the machine.
 */
export function defaultDieLogFile(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? tmpdir(), 'dsh-heavy-io-gate', 'die.log')
  return join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dsh-heavy-io-gate', 'die.log')
}

/** Die-log path; `DSH_HEAVY_IO_DIELOG` overrides it (spec isolation). */
function dieLogFile(env: NodeJS.ProcessEnv): string {
  return env.DSH_HEAVY_IO_DIELOG ?? defaultDieLogFile(env)
}

/**
 * Append one audit line to the die-log (fail-soft).
 * Format mirrors history.log: `<ISO> <event> pid=<n> [fields…] cmd=<command>`.
 * @param env - Environment supplying the log path override.
 * @param event - `exit` | `release` | `die`.
 * @param command - The gated command the line answers for.
 * @param fields - Extra key=value fields, rendered before `cmd`.
 */
export function recordDie(
  env: NodeJS.ProcessEnv,
  event: 'exit' | 'release' | 'die',
  command: string,
  fields: DieFields = {},
): void {
  try {
    const clean = (value: string): string => value.replace(/[\r\n]+/g, ' ')
    const parts = [new Date().toISOString(), event, `pid=${String(process.pid)}`]
    for (const [key, value] of Object.entries(fields)) parts.push(`${key}=${clean(String(value))}`)
    parts.push(`cmd=${clean(command)}`)
    const file = dieLogFile(env)
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${parts.join(' ')}\n`, 'utf8')
  } catch (error) {
    // Audit is observation only: a die-log write failure must never fail the
    // job, and must not be silent either — a lost death record is the exact
    // defect this log exists to close, so report on stderr and still never throw.
    try {
      process.stderr.write(`die-log: write failed (${event}): ${(error as Error).message}\n`)
    } catch {
      // stderr itself unavailable: even that must not take the job down.
    }
  }
}

/**
 * Cheap in-process memory snapshot for one audit line.
 * Same floor line as `memoryFloorState` in heavy-io-gate.ts (10% of physical
 * total, `DSH_HEAVY_IO_FLOOR_MB` overrides in MB) — duplicated here rather than
 * imported to keep this module a leaf (heavy-io-gate.ts imports IT; an import
 * back would cycle). ⛔ never a spawned subprocess (availability-gate rule).
 * @param env - Environment supplying the floor override.
 * @returns free/available MB and the floor line the reading is judged against.
 */
export function memorySnapshot(env: NodeJS.ProcessEnv): { freeMb: number; floorMb: number } {
  const totalMb = Math.round(totalmem() / (1024 * 1024))
  const raw = env.DSH_HEAVY_IO_FLOOR_MB
  const override = raw !== undefined && raw.trim() !== '' ? Number(raw) : Number.NaN
  const floorMb = Number.isFinite(override) && override >= 0
    ? Math.round(override)
    : Math.round(totalMb * 0.10)
  const freeMb = Math.round(freemem() / (1024 * 1024))
  return { freeMb, floorMb }
}

/**
 * Kill-audit log path (m-note `scripts/dsh/build-watchdog.py` writer;
 * `DSH_KILL_AUDIT_LOG` overrides it — spec isolation seam, same convention as
 * `DSH_HEAVY_IO_DIELOG`).
 * @param env - Environment of this process.
 * @returns the machine-wide JSON-lines kill-audit path.
 */
export function killAuditFile(env: NodeJS.ProcessEnv): string {
  return env.DSH_KILL_AUDIT_LOG ?? join(homedir(), '.dsh', 'kill-audit.log')
}

/** Extra fields a kill-audit cross-reference contributes to a die line. */
export type KillAuditRef = Record<string, string | number>

/**
 * Cross-reference the external kill-audit log for who killed a dead holder
 * (fact-correction 2026-11-28, dispatch session-6561bef0: the dominant death
 * cause is the build-watchdog's tiered reaper — `tier-hard family=typecheck
 * tOp=129s tHard=258s` / `floor-tier` — not plain OOM; a die line must name
 * the killer, not just the death).
 *
 * The audit pid is the *reaped target*: for tier/floor kills the watchdog
 * taskkills `owner.json`'s pid and audits that same pid (build-watchdog
 * `_tier_kill_verified`), so an exact pid match inside the holder's lifetime
 * window is authoritative. Unrelated reaps (orphan-reaper) land in the same
 * window, so pid match outranks recency; window-newest is only the fallback
 * when no pid row exists, and it is marked `killMatch=window` so a machine
 * check can tell strong from weak attribution. Returns `{}` when the file is
 * absent/unreadable/no row matches: the die line still lands (fail-soft — a
 * missing cross-reference must never suppress the death).
 * @param env - Environment supplying the audit path override.
 * @param windowStartMs - Earliest kill timestamp accepted (holder start).
 * @param windowEndMs - Latest kill timestamp accepted (now / discovery).
 * @param pids - Candidate pids that break ties inside the window.
 * @returns mergeable `killedBy`/`killTier`/`killDetail` fields, or `{}`.
 */
export function killAuditRef(
  env: NodeJS.ProcessEnv,
  windowStartMs: number,
  windowEndMs: number,
  pids: readonly number[] = [],
): KillAuditRef {
  try {
    const raw = readFileSync(killAuditFile(env), 'utf8')
    let best: { fields: KillAuditRef; ts: number; exactPid: boolean } | undefined
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || !trimmed.startsWith('{')) continue
      let row: Record<string, unknown>
      try {
        row = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        continue
      }
      if (row.outcome !== 'killed' || typeof row.ts !== 'string') continue
      const ts = Date.parse(row.ts)
      if (!Number.isFinite(ts) || ts < windowStartMs || ts > windowEndMs) continue
      const exactPid = typeof row.pid === 'number' && pids.includes(row.pid)
      // Priority: any exact-pid row > newer window row (pid is authoritative —
      // the watchdog audits owner.json's own pid); among equals, newest wins.
      const better = best === undefined
        || (exactPid && !best.exactPid)
        || (exactPid === best.exactPid && ts > best.ts)
      if (better) {
        const detail = typeof row.detail === 'string'
          ? row.detail
          : row.detail === undefined ? '' : JSON.stringify(row.detail)
        best = {
          ts,
          exactPid,
          fields: {
            killedBy: typeof row.actor === 'string' ? row.actor : 'unknown',
            ...(detail !== '' ? { killDetail: detail.slice(0, 200) } : {}),
            ...(typeof row.pid === 'number' ? { killPid: row.pid } : {}),
            killMatch: exactPid ? 'pid' : 'window',
          },
        }
      }
    }
    if (best === undefined) return {}
    // Tier token rides in killDetail (`tier-hard family=…` / `floor-tier`);
    // surface it as its own field for machine checks (腿①判据 greps it).
    const detail = best.fields.killDetail
    const tier = typeof detail === 'string'
      ? detail.match(/\b(tier-[a-z]+|floor-tier)\b/)?.[1]
      : undefined
    return tier === undefined ? best.fields : { ...best.fields, killTier: tier }
  } catch {
    // Audit file absent/unreadable: no cross-reference, death line unaffected.
    return {}
  }
}
