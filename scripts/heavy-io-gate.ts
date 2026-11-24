/**
 * Machine-wide advisory gate for heavy repository jobs.
 *
 * Workstation runs share one disk and one memory pool, so concurrent heavy jobs
 * (lint, typecheck, …) from separate sessions pile up and starve interactive work.
 * This gate serializes them through one advisory lock directory. Serialization is
 * strict: waiters queue without a bound and never proceed alongside a live holder
 * (2026-11-12 定稿 · 纯排队——内存余量永远优先留给活会话周转，不给 build 让路).
 * The only automatic breaks are a dead owner (crash recovery) and a directory
 * that stays ownerless past a short read backoff (acquirer crashed between
 * mkdir and owner.json — never a live claimant mid-write, 2026-11-13 竞态修复);
 * a live holder is trusted indefinitely, so a wedged-but-alive holder blocks
 * the queue until a human kills it (watchdog alarms at 45 min of hold time).
 *
 * Usage: `tsx scripts/heavy-io-gate.ts "<shell command>"`.
 * CI (`CI=true`) passes straight through. Full-cold commands (full-repo lint /
 * test matrices, 三级准入) require the `DSH_FULLCHECK_OK=1` token and are
 * refused *before* queueing without it (default-deny, 2026-11-14
 * fullcheck-token — design: m-note content/tech/ai/dsh/fullcheck-token-1114.md);
 * that check runs BEFORE the `DSH_HEAVY_IO=0` / `DSH_HEAVY_IO_HELD=1`
 * passthroughs, because a leaked held-env in a persistent shell once ran two
 * full lints unserialized for 2 h (2026-11-14 17:12/17:18). Hot commands keep
 * the off/held passthrough semantics unchanged.
 *
 * Queue release additionally requires a green memory floor
 * (heavy-admit-floor-1124 · 口子②): a waiter polls `os.freemem()` against the
 * floor — 10% of physical total, the same line as the dispatch pre-read
 * (16108MB → 1611MB here; `DSH_HEAVY_IO_FLOOR_MB` overrides it in MB so
 * fixtures can pin red/green) — and while the floor is red it stays queued
 * (`floor-red` history lines, own 60s rate limit): 处置 A = 留队等待至绿, never a
 * mid-queue refusal, so a floor-red wait can never pollute a caller's failure
 * accounting. Cheap in-process read only — ⛔ never a spawned subprocess.
 * The check sits inside the queue path only: CI/off/held passthroughs (the
 * audited 抢修口, pagein-storm-rootcause-1124 ruling ④) and the full-cold
 * refusal order are untouched, and a live holder still keeps the queue waiting
 * exactly as before (地板红管「不起新活」，不管已在跑的).
 *
 * Every transition also appends one observation line to a history.log kept
 * outside the lock directory (acquire / waiting / floor-red / stale-break /
 * release / passthrough / refused, each with ISO time, pid and command). Pure observation:
 * no gate decision reads it and every write failure is swallowed, so a full disk
 * costs at most the log line, never the gate.
 *
 * Passthrough lines carry the full five-field audit row — `pid` / `reason` /
 * `holderCmd` / `cmd` / ISO time (passthrough-audit-1124): who jumped the
 * queue, which bypass path the gate let it through on, whose live lock it
 * jumped past, and what ran. The `holderCmd` read is observation only and never
 * feeds a release decision.
 */
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { freemem, homedir, totalmem, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_POLL_INTERVAL_MS = 2_000
// 纯排队（2026-11-12 定稿）：waiters queue without a bound. The former 45 min
// wait bound + fail-open let a waiter race a live holder (observed 2026-11-12
// 09:57Z); memory headroom belongs to interactive sessions, never to a build
// that lost the queue. A dead owner still breaks immediately (crash recovery);
// a live owner is trusted indefinitely — the 45 min watchdog alarm, not the
// gate, decides when a wedged holder needs a human.

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
 * Backoff for an ownerless lock directory. `mkdir` is the claim primitive but
 * the winner writes owner.json only afterwards, so between the two there is a
 * window where the directory exists with no (or a half-written) owner record.
 * A reader that treated "owner unreadable" as stale would break a live holder
 * mid-acquire (observed 2026-11-13 12:39:55Z: stale-break on a 2.5 s-old live
 * holder, three trees inside the gate concurrently). Re-reading across this
 * backoff lets the winner finish its write; only a directory still ownerless
 * after all retries is an orphan (winner crashed inside the window).
 */
const OWNERLESS_READ_RETRIES = 3
const OWNERLESS_READ_BACKOFF_MS = 100

/**
 * Append one observation line to the history log (fail-soft).
 * Format: `<ISO time> <event> pid=<n> [fields…] cmd=<command>`; `cmd` is always
 * the last field so it may contain spaces and quotes.
 * Every failure path (full disk, missing permission, bad override path) is
 * swallowed here: history is pure observation and must never affect the gate.
 * @param file - History file path.
 * @param event - Event name (acquire / waiting / floor-red / stale-break / release / passthrough / refused).
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
  } catch (error) {
    // Observation only: a history write failure must never fail the gate. It
    // must not be silent either — a lost audit line is the exact defect this
    // log exists to close (passthrough-audit-1124), so report it on stderr and
    // still never throw (fail-open: 抢修优先, the command keeps running).
    try {
      process.stderr.write(`heavy-io-gate: history write failed (${event}): ${(error as Error).message}\n`)
    } catch {
      // stderr itself unavailable: even that must not take the gate down.
    }
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
 * The owner record is written immediately after the claim to keep the ownerless
 * window between the two calls as small as possible (readers back off across
 * it, see OWNERLESS_READ_RETRIES). If even that write fails (the claim was
 * broken underneath us during a stall, or the disk refused it), the claim is
 * not usable: drop it and report contention so the caller requeues instead of
 * running without an owner record.
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
  try {
    await writeFile(join(directory, 'owner.json'), JSON.stringify(owner))
  } catch {
    return undefined
  }
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
 * Remove the lock directory when its owner is dead, or when an ownerless
 * directory stays ownerless across the backoff (acquirer crashed inside the
 * mkdir → owner.json window). A live owner is never broken, no matter how long
 * it has held the lock — the queue waits (纯排队); the 45 min watchdog alarm
 * escalates a wedged holder to a human instead of racing it. A directory that
 * vanishes while we inspect it (a holder released, or a rival broke it) is not
 * ours to remove: report "nothing broken" and let the caller retry the acquire.
 * @param directory - Lock directory path.
 * @returns true when a stale lock was removed and the caller may retry the acquire.
 */
export async function breakStaleHeavyIoLock(directory: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    const owner = await readHeavyIoLock(directory)
    if (owner !== undefined) {
      if (isProcessAlive(owner.pid)) return false
      await rm(directory, { recursive: true, force: true })
      return true
    }
    // Owner unreadable: either the directory is gone (nothing to break) or a
    // winner is still inside the mkdir → writeFile window (do not break it).
    if (!(await directoryExists(directory))) return false
    if (attempt >= OWNERLESS_READ_RETRIES) {
      await rm(directory, { recursive: true, force: true })
      return true
    }
    await new Promise(done => setTimeout(done, OWNERLESS_READ_BACKOFF_MS))
  }
}

/**
 * Check whether the lock directory currently exists.
 * @param directory - Lock directory path.
 * @returns true when the path exists as a directory-like entry.
 */
async function directoryExists(directory: string): Promise<boolean> {
  try {
    await stat(directory)
    return true
  } catch {
    return false
  }
}

/**
 * Release the lock directory. Only the holder may call this.
 * @param directory - Lock directory path.
 */
export async function releaseHeavyIoLock(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true })
}

function runCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  onSpawn?: (child: ChildProcess) => void,
): Promise<number> {
  return new Promise((finish, fail) => {
    const child = spawn(command, { shell: true, stdio: 'inherit', env: { ...env, DSH_HEAVY_IO_HELD: '1' } })
    onSpawn?.(child)
    child.on('error', fail)
    child.on('close', (code) => {
      finish(code ?? 1)
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms))
}

/**
 * Kill a still-running gated command's process tree (best effort).
 * Windows: `taskkill /T` walks the attached descendants of the shell the gate
 * spawned. The pid must belong to a child this gate spawned and still be alive
 * (callers check first) — killing after `close` would risk a recycled pid.
 * Detached grandchildren that already reparented are unreachable here; the
 * machine watchdog owns those stragglers.
 * @param pid - Process id of the spawned shell root.
 */
function killChildTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      // Best effort: a vanished tree already satisfies the goal.
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Best effort: a vanished tree already satisfies the goal.
    }
  }
}

/** Which bypass path skips the gate; undefined means the command must queue. */
function passthroughReason(env: NodeJS.ProcessEnv): 'ci' | 'off' | 'held' | undefined {
  if (env.CI === 'true') return 'ci'
  if (env.DSH_HEAVY_IO === '0') return 'off'
  if (env.DSH_HEAVY_IO_HELD === '1') return 'held'
  return undefined
}

/**
 * Full-cold command patterns (三级准入 · fullcheck-token, 2026-11-14).
 * 全-冷 = full-repository check matrices that historically flooded the queue
 * (2026-11-13: 27 full-lint acquires ≈ 9 h of hold time in one day). The list
 * mirrors guard-core's `_FULL_COLD_KEYS` (m-note `scripts/guard/guard-core.py`);
 * the two implementations are deliberately independent across repos — the
 * semantic source is `content/tech/ai/dsh/fullcheck-token-1114.md` §二, and a
 * new full-cold entry must land on both sides in the same batch.
 * Patterns match the *gated command string* (inner command of package.json
 * wrappers, lefthook forms, and the run-oxlint sink's argv join), not script
 * keys, so inner keys like `npm run lint:contracts-ready` are covered together
 * with the outer `pnpm run lint` form. Targeted forms (staged lint with a
 * config + file list, `vitest run --config …`, `vitest run <path>`) intentionally
 * do NOT match — they stay hot-path queue citizens.
 */
const FULL_COLD_PATTERNS: readonly RegExp[] = [
  // pnpm|npm|yarn run lint[:…] / pnpm lint — the lint family (outer + inner keys)
  /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?lint(?::|[\s]|$)/i,
  // full-repository oxlint sink: `run-oxlint.ts .` (bare dot = repo root arg)
  /run-oxlint\.ts\s+\./,
  // pnpm run test:all key form; the wrapper's expanded inner form
  // (`… && vitest run`) is caught by the bare-vitest pattern below
  /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?test:all(?::|[\s]|$)/i,
  // bare full suite: `… && vitest run` / `vitest run --coverage` — a following
  // --config flag or path argument means targeted (hot), so the lookahead
  // only accepts end-of-command or a trailing `&&` chain
  /vitest\s+run(?:\s+--coverage)?(?=\s*(?:&&|$))/,
  // check:all key form / run-gates.ts check-all (local full matrix)
  /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?check:all(?::|[\s]|$)/i,
  /run-gates\.ts\s+check-all\b/,
]

/**
 * Classify a gated command as full-cold (requires the fullcheck token).
 * @param command - The command string the gate is about to queue.
 * @returns true when the command belongs to the cold full-repo check tier.
 */
export function isFullColdCommand(command: string): boolean {
  return FULL_COLD_PATTERNS.some(pattern => pattern.test(command))
}

/**
 * Whether the fullcheck token authorizes full-cold execution.
 * Static env by design — no rotation, no state, one string comparison
 * (decision record Q3: m-note content/tech/ai/dsh/fullcheck-token-1114.md).
 * @param env - Environment of this process.
 * @returns true when DSH_FULLCHECK_OK=1 is present.
 */
export function fullcheckAuthorized(env: NodeJS.ProcessEnv): boolean {
  return env.DSH_FULLCHECK_OK === '1'
}

/** Memory floor as a share of physical total — the dispatch pre-read line (FreeMB ≥10%). */
const DEFAULT_FLOOR_RATIO = 0.10

/**
 * Memory floor state at the moment a queued waiter would be released
 * (heavy-admit-floor-1124 · 口子② 放行前内存复核).
 * Floor = 10% of `os.totalmem()` (16108MB → 1611MB on this machine, matching
 * the board reading), overridable in MB via `DSH_HEAVY_IO_FLOOR_MB` so red/green
 * fixtures pin deterministically (huge value = always red, `0` = always green).
 * Cheap in-process reads only (`os.freemem()` / `os.totalmem()`) — ⛔ never a
 * spawned subprocess (spawn-to-read-memory is the availability-gate anti-pattern).
 * @param env - Environment supplying the floor override.
 * @returns whether the floor is green plus the readings behind the verdict.
 */
export function memoryFloorState(env: NodeJS.ProcessEnv): { green: boolean; freeMb: number; floorMb: number } {
  const totalMb = Math.round(totalmem() / (1024 * 1024))
  // Empty string must NOT read as 0 (Number('') === 0 would silently pin green).
  const raw = env.DSH_HEAVY_IO_FLOOR_MB
  const override = raw !== undefined && raw.trim() !== '' ? Number(raw) : Number.NaN
  const floorMb = Number.isFinite(override) && override >= 0
    ? Math.round(override)
    : Math.round(totalMb * DEFAULT_FLOOR_RATIO)
  const freeMb = Math.round(freemem() / (1024 * 1024))
  return { green: freeMb >= floorMb, freeMb, floorMb }
}

/**
 * Observation-only snapshot of the lock holder a passthrough jumps past.
 * This is a logging input, not a gate decision: it never influences whether the
 * command is released, and every failure degrades to `none` instead of throwing
 * (a passthrough must stay fail-open — 抢修优先).
 * @param env - Environment supplying the lock directory override.
 * @returns the live holder's command, or `none` when no owner record is readable.
 */
async function holderCommandForAudit(env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const directory = env.DSH_HEAVY_IO_LOCK_DIR ?? defaultLockDirectory(env)
    return (await readHeavyIoLock(directory))?.command ?? 'none'
  } catch {
    return 'none'
  }
}

/**
 * Queue for the machine-wide heavy lock and hold it until the lease is released.
 * Pure queue (2026-11-12 定稿): no wait bound, no fail-open — a waiter polls
 * until every live holder has released *and* the memory floor reads green
 * (heavy-admit-floor-1124 · 口子②, 处置 A 留队至绿); only a dead owner breaks early.
 * When the lease is taken on `process.env` (the in-process sink default), the
 * holder marks `DSH_HEAVY_IO_HELD=1` so nested gate wrappers pass through.
 * @param command - Description recorded in owner.json and history.log.
 * @param env - Environment to read gate settings from; defaults to this process.
 * @returns an idempotent release handle, or undefined when the call passes through.
 */
export async function enterHeavyIoGate(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ release: () => Promise<void> } | undefined> {
  // CI = 授权环境：全量检查是 CI 本职，一律透传（token 不适用）。
  if (env.CI === 'true') {
    recordHistory(historyFile(env), 'passthrough', command, {
      reason: 'ci',
      holderCmd: await holderCommandForAudit(env),
    })
    return undefined
  }
  // 三级准入（fullcheck-token 2026-11-14）：全-冷命令 default-deny——排队前
  // 拒绝（不是排队），history 留 refused 行供审计。**置于 off/held 透传之前**：
  // 2026-11-14 17:12/17:18 实证，持久壳 DSH_HEAVY_IO_HELD 泄漏曾让两棵全量
  // lint 以 reason=held 绕闸并发跑 2 小时（free 0.2G 打穿）——HELD/OFF 不得绕证；
  // 合法嵌套不受影响（持证父生出的子树继承 DSH_FULLCHECK_OK，决策记录 Q2）。
  if (isFullColdCommand(command) && !fullcheckAuthorized(env)) {
    recordHistory(historyFile(env), 'refused', command, { reason: 'fullcheck-token' })
    throw new Error(
      `heavy-io-gate: full-cold command refused (DSH_FULLCHECK_OK missing): ${command}\n`
      + 'Full-repo checks are cold-path only (design: m-note content/tech/ai/dsh/fullcheck-token-1114.md). '
      + 'Iterate with staged lint / targeted tests; run full checks only via an authorized runner, '
      + 'or after explicit approval prefix DSH_FULLCHECK_OK=1.',
    )
  }
  const reason = passthroughReason(env)
  if (reason !== undefined) {
    recordHistory(historyFile(env), 'passthrough', command, {
      reason,
      holderCmd: await holderCommandForAudit(env),
    })
    return undefined
  }
  const directory = env.DSH_HEAVY_IO_LOCK_DIR ?? defaultLockDirectory(env)
  const history = historyFile(env)
  await waitForHeavyIoLock(directory, command, env)
  if (env === process.env) process.env.DSH_HEAVY_IO_HELD = '1'
  const acquiredAt = Date.now()
  let released = false
  return {
    release: async (): Promise<void> => {
      if (released) return
      released = true
      await releaseHeavyIoLock(directory)
      recordHistory(history, 'release', command, { heldMs: Date.now() - acquiredAt })
    },
  }
}

/**
 * Wait until the lock directory is free (or its owner is dead), the memory
 * floor is green, then take it.
 * Records acquire / waiting / floor-red / stale-break transitions to the history log.
 * @param directory - Lock directory path.
 * @param command - The gated command, reported to waiters and the log.
 * @param env - Environment supplying poll interval, floor and history overrides.
 * @returns the acquire timestamp (ms).
 */
async function waitForHeavyIoLock(directory: string, command: string, env: NodeJS.ProcessEnv): Promise<number> {
  const history = historyFile(env)
  const pollMs = Number(env.DSH_HEAVY_IO_POLL_MS ?? DEFAULT_POLL_INTERVAL_MS)
  const startedAt = Date.now()
  let waitingLoggedAt = 0
  let floorLoggedAt = 0
  for (;;) {
    // 地板红 → 不放行（处置 A 留队至绿，heavy-admit-floor-1124 ②）：复核放在
    // acquire（放行点）之前，红窗内连无争用的首取也拦。独立事件名 + 独立 60s
    // 限流，不与 waiting 行字段序耦合（既有 spec 正则零回归）。读 = os.freemem()
    // 廉价读、零 spawn；读失败（抛不出的系统调用）不进此分支 = 天然 fail-open。
    const floor = memoryFloorState(env)
    if (!floor.green) {
      process.stderr.write(
        `heavy-io-gate: floor red (free ${floor.freeMb}MB < floor ${floor.floorMb}MB) — holding the queue\n`,
      )
      if (Date.now() - floorLoggedAt >= HISTORY_WAITING_INTERVAL_MS) {
        floorLoggedAt = Date.now()
        recordHistory(history, 'floor-red', command, {
          waitedMs: Date.now() - startedAt,
          freeMb: floor.freeMb,
          floorMb: floor.floorMb,
        })
      }
      await sleep(pollMs + Math.floor(Math.random() * 500))
      continue
    }
    if (await acquireHeavyIoLock(directory, command) !== undefined) {
      recordHistory(history, 'acquire', command)
      return startedAt
    }
    // Observation pre-read: breakStaleHeavyIoLock answers only yes/no (its
    // internal reads may already be past this point), so the owner record about
    // to be judged is captured here for the log.
    const heldForLog = await readHeavyIoLock(directory)
    if (await breakStaleHeavyIoLock(directory)) {
      if (heldForLog !== undefined) {
        recordHistory(history, 'stale-break', command, {
          holderPid: heldForLog.pid,
          holderAgeMs: Date.now() - Date.parse(heldForLog.startedAt),
          holderAlive: isProcessAlive(heldForLog.pid),
        })
      } else {
        // An ownerless orphan directory was broken (crash inside the
        // mkdir → owner.json window): record the break anyway, so history can
        // answer for every removal of the lock directory.
        recordHistory(history, 'stale-break', command, {
          holderPid: 'none',
          holderAgeMs: 0,
          holderAlive: 'unknown',
        })
      }
      continue
    }
    const holder = await readHeavyIoLock(directory)
    process.stderr.write(
      `heavy-io-gate: waiting for ${holder?.command ?? 'another heavy job'} (pid ${holder?.pid ?? 'unknown'})\n`,
    )
    if (Date.now() - waitingLoggedAt >= HISTORY_WAITING_INTERVAL_MS) {
      waitingLoggedAt = Date.now()
      recordHistory(history, 'waiting', command, {
        waitedMs: Date.now() - startedAt,
        holderPid: holder?.pid ?? 'none',
        ...(holder !== undefined ? { holderCmd: holder.command } : {}),
      })
    }
    await sleep(pollMs + Math.floor(Math.random() * 500))
  }
}

async function main(): Promise<void> {
  const command = process.argv.slice(2).join(' ')
  if (command === '') throw new Error('heavy-io-gate: expected a shell command argument after --.')
  let lease: { release: () => Promise<void> } | undefined
  try {
    lease = await enterHeavyIoGate(command, process.env)
  } catch (error) {
    // Full-cold refusal (and any enter failure): print the message without a
    // stack dump and exit 2 — the queue was never entered.
    process.stderr.write(`${(error as Error).message}\n`)
    process.exit(2)
  }
  if (lease === undefined) {
    // Passthrough was recorded by enterHeavyIoGate — the "was this gated?"
    // question the history exists to answer.
    process.exitCode = await runCommand(command, process.env)
    return
  }
  let child: ChildProcess | undefined
  // Abnormal exit only: a signal means the gate is going down while the
  // command may still be attached — kill the tree before releasing so the
  // next queued job never overlaps surviving descendants (tsgolint respawn).
  // On normal `close` the tree is done; killing then would risk a recycled pid.
  const onSignal = (signal: NodeJS.Signals): void => {
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      killChildTree(child.pid)
    }
    void lease.release().finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    process.exitCode = await runCommand(command, process.env, (spawned) => { child = spawned })
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await lease.release()
  }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) await main()
