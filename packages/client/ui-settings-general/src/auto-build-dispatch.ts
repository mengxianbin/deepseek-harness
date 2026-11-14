/**
 * Auto-build host notifier — the HOST half of the build-dispatch
 * single-source architecture (build-dispatch ④ "kick 无载荷", 2026-11-13).
 *
 * This module used to BE the dispatcher: it rode the judgment stream, ran the
 * stability window / interval / exponential backoff timers, probed the
 * machine heavy-io lock, and ran `pnpm run build` itself. That made the
 * host one of two build executors — the 2026-11-09 four-dispatch storm
 * (build-storm-1109.md) fired exactly here, through `fire()` clearing
 * `ownBuildPending` before every NEED_BUILD dispatch (`:621` of the old file).
 *
 * Execution moved out of the host (build-dispatch ①): the ONE executor is now
 * `harness scripts/auto-build-exec.ts` — single-instance by kernel handle,
 * re-judges the state machine's own collected judgment, runs the gated build,
 * owns the linked-build account, and writes the seq journal. The host is
 * stateless by construction:
 *
 * - **It never starts a subprocess.** No child-process call, no launcher seam, no pending
 *   flag, no timers at all — the machine check for this file greps for
 *   child-process start calls and must find nothing (acceptance ③ of the task book).
 * - **It only shouts.** On a judgment that owes a build (`INIT`, or
 *   `NEED_BUILD` whose own face moved — linked-only drift belongs to the
 *   watchdog's per-tree leg, not this file) it OVERWRITES one payload-free
 *   token `.dsh-build/auto-build.kick` (`{at, from, state}` — no command, no
 *   target tree, no shared queue) and journals one `[host] kick` line.
 *   N kicks = one token (只保留最后一个) = one fresh re-judgment at the next
 *   watchdog tick; a lost or duplicated kick is harmless because the kick
 *   carries no truth (裁决档 §三 件④).
 * - **The subscription stays** — the judgment observer roster keeps feeding
 *   the UI lamp chain unchanged; this listener only adds the shout.
 *
 * Consumption and the honest latency bound: m-note's `build-watchdog.py`
 * reads+deletes the token on its next dispatch tick (≤10 min), then judges as
 * it always did and kicks the executor when a build is owed. Prompt delivery
 * beyond the tick would need a host-side child process or `schtasks /run` — both
 * explicitly excluded by the task's machine checks (宿主 dispatcher 零子进程调用
 * grep = 0) and availability gate ① (不新增宿主周期起动面); the periodic
 * tick backstop is the design's own words (裁决档 件④「kick 丢了有定时 tick
 * 兜底」). Design: m-note `content/tech/ai/dsh/build-dispatch-exec-1113.md`.
 *
 * Failure semantics: writing the token or its journal line never throws into
 * the judgment stream — both faces degrade LOUD (stderr + the journal's own
 * fallback protocol), never silently: a lost shout must be visible, because
 * the next tick re-judges anyway but an invisible loss cannot be audited.
 * @module @deepseek-ai/dsh-client-ui-settings-general/auto-build-dispatch
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defaultAutoBuildJournalLine } from './auto-build-journal.ts'
import { defaultRepositoryRoot } from './restart-stamp.ts'
import { onRestartSignalJudgment, type RestartSignalJudgment } from './restart-signal.ts'

/** Payload-free kick token inside the stamp directory (overwritten in place). */
export const AUTO_BUILD_KICK_FILE = 'auto-build.kick'

/** Gitignored directory holding the per-tree build markers. */
const STAMP_DIR = '.dsh-build'

/** One shout: metadata only — by design it carries NO command, NO target
 * tree, NO queue entry. `from` distinguishes the host's automatic shout from
 * a human's manual token write. */
export interface AutoBuildKick {
  /** When the shout happened (ISO 8601). */
  readonly at: string
  /** Who shouted; production writes `'host'`. */
  readonly from: string
  /** The judgment state that owed a build. */
  readonly state: string
}

/** Injection seams for one registration; production defaults live in this process. */
export interface AutoBuildInternals {
  /** Judgment subscription; defaults to the state machine's observer seam. */
  readonly subscribe?: (listener: (judgment: RestartSignalJudgment) => void) => () => void
  /** The shout itself; defaults to overwriting the payload-free token file. */
  readonly kick?: (kick: AutoBuildKick) => void
  /** Decision journal sink; defaults to the `[host]` seq journal. */
  readonly journal?: (line: string) => void
  /** Failure sink; defaults to one stderr line. */
  readonly warn?: (message: string) => void
  /** Tree whose stamp directory holds the token; defaults to this tree. */
  readonly repositoryRoot?: string
  /** Clock; defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * Overwrite the payload-free kick token for one tree.
 * @param repositoryRoot - Harness tree whose stamp directory holds the token.
 * @param kick - The shout metadata (no payload by contract).
 * @throws Whatever the file system throws — callers degrade loudly.
 */
export function writeAutoBuildKick(repositoryRoot: string, kick: AutoBuildKick): void {
  const directory = join(repositoryRoot, STAMP_DIR)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, AUTO_BUILD_KICK_FILE), `${JSON.stringify(kick)}\n`, 'utf8')
}

/**
 * Register the host's build notifier on the host context. It observes fresh
 * judgments and converts build-owing states into ONE payload-free token
 * overwrite plus one journal line — nothing else. No child process, no timers, no
 * pending state, no lock probing: every decision that used to live here now
 * belongs to the single executor. Disposal unsubscribes.
 * @param ctx - Host context carrying the effect lifetime.
 * @param internals - Injectable seams for tests.
 */
export function registerAutoBuild(ctx: Context, internals: AutoBuildInternals = {}): void {
  const now = internals.now ?? Date.now
  const repositoryRoot = internals.repositoryRoot ?? defaultRepositoryRoot()
  const warn = internals.warn ?? ((message: string): void => { process.stderr.write(`${message}\n`) })
  const journal = internals.journal ?? defaultAutoBuildJournalLine(repositoryRoot, { writer: 'host' })
  const subscribe = internals.subscribe
    ?? ((listener: (judgment: RestartSignalJudgment) => void): (() => void) => onRestartSignalJudgment(listener))

  const defaultKick = (kick: AutoBuildKick): void => {
    writeAutoBuildKick(repositoryRoot, kick)
  }
  const kickOnce = internals.kick ?? defaultKick

  let disposed = false

  /** Shout once: token overwrite first (the machine-facing signal), then the
   * audit line — both failures loud, neither thrown into the judgment stream. */
  const shout = (state: string): void => {
    const kick: AutoBuildKick = { at: new Date(now()).toISOString(), from: 'host', state }
    try {
      kickOnce(kick)
    } catch (error) {
      warn(`ui-settings-general: auto-build kick token write failed: ${error instanceof Error ? error.message : String(error)}`)
      journal(`kick-write-failed state=${state} error=${error instanceof Error ? error.message : String(error)}`)
      return
    }
    journal(`kick state=${state}`)
  }

  const unsubscribe = subscribe((judgment) => {
    if (disposed) return
    switch (judgment.state) {
      case 'INIT':
        // A missing own baseline owes a bootstrap build; the executor
        // re-judges before acting (its cause-split defense is in the executor).
        shout('INIT')
        return
      case 'NEED_BUILD':
        // 构建触发口径 = 主仓面 (linked-split 2026-11-01): linked-only drift is
        // the watchdog per-tree leg's domain — shouting it here would start a
        // pointless executor round trip every tick.
        if (judgment.facts?.ownFaceMoved !== false) shout('NEED_BUILD')
        return
      default:
        // BUILDING / BUILD_FAILED / OK / NEED_RESTART / CLIENT_UPDATED: the
        // watchdog's periodic judgment owns retries and outcomes; the host
        // adds no second opinion (N kicks would only re-read the same one).
        return
    }
  })

  ctx.effect(() => () => {
    disposed = true
    unsubscribe()
  }, 'ui-settings-general: auto-build dispatch')
}
