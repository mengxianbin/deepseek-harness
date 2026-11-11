/**
 * Automatic-restart fork driver (P3, design §四): observes the state machine's
 * judgment stream and, on entering `NEED_RESTART`, runs the disposition — the
 * host running count (P11 口径: the agents registry that the `session/list`
 * rows and `api-session/status` events are computed from), the client
 * running-count attestation, and the shared in-flight dispatch lock — and
 * dispatches the configured restart command in the background when, and only when,
 * every fact agrees at zero while the `DSH_AUTO_RESTART` flag is on.
 *
 * The default is dark: with the flag absent the entry tick does nothing at
 * all, so shipping this code cannot restart anyone's sessions (开关默认关，
 * 启用 = T2 人工交接点). Every uncertainty holds with one stderr line and the
 * existing badge keeps guiding the human (fail-closed, P11 报告 §五).
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  autoRestartEnabled,
  claimRestartDispatch,
  currentClientAttestation,
  judgeRestartDisposition,
  restartDispatchClaimed,
} from './restart-disposition.ts'
import { dispatchRestart, spawnDetached, RESTART_COMMAND_ENV, type RestartLauncher } from './restart-host.ts'
import { onRestartSignalJudgment } from './restart-signal.ts'
import type { RestartSignalReason, RestartSignalState } from './restart.ts'

/** Minimal host agents face the count reads (mirrors core-agent's
 * `AgentRegistry.list()` and `Agent.status === 'running'` — the exact host
 * source the client's `countRunningSessions` is fed from; P11 report §三). */
export interface RunningAgentsFace {
  list(): ReadonlyArray<{ readonly status: string }>
}

/** Minimal judgment shape the entry detector consumes. */
export interface DispositionJudgment {
  readonly state: RestartSignalState
  /** Present only on `NEED_RESTART`: which restart branch fired (config vs
   * built) — surfaced on the dispatched line so the automatic route's motive
   * is auditable (restart-reason-audit-1111 ②; judgment producer unchanged —
   * `judgeRestartSignal` already carries this field). */
  readonly reason?: RestartSignalReason
}

/** Injection seams for one registration; production defaults come from this process. */
export interface RestartDispositionInternals {
  /** Judgment subscription; defaults to the state machine's observer seam. */
  readonly subscribe?: (listener: (judgment: DispositionJudgment) => void) => () => void
  /** Running-count reader; defaults to the duck-faced `ctx.agents` registry. */
  readonly countRunning?: () => number | undefined
  /** Detached launcher seam; defaults to the restart dispatch's own launcher. */
  readonly launch?: RestartLauncher
  /** Clock; defaults to `Date.now`. */
  readonly now?: () => number
  /** Failure sink; defaults to one stderr line. */
  readonly warn?: (message: string) => void
  /** Environment read at tick time; defaults to `process.env`. */
  readonly env?: { readonly [name: string]: string | undefined }
}

/**
 * Register the automatic fork on the host context: subscribe to fresh
 * judgments, detect the entry into `NEED_RESTART` (the design's single
 * judgment tick), and hold-or-dispatch per the pure disposition. Disposal
 * unsubscribes.
 * @param ctx - Host context; the count resolves `agents` lazily per tick so
 *   registration order against the session controller does not matter.
 * @param internals - Injectable seams for tests.
 */
export function registerRestartDisposition(ctx: Context, internals: RestartDispositionInternals = {}): void {
  const now = internals.now ?? Date.now
  const warn = internals.warn ?? ((message: string): void => { process.stderr.write(`${message}\n`) })
  const countRunning = internals.countRunning ?? ((): number | undefined => {
    const agents = ctx.get('agents', false) as RunningAgentsFace | undefined
    if (agents === undefined || typeof agents.list !== 'function') return undefined
    try {
      return agents.list().filter(agent => agent.status === 'running').length
    } catch {
      return undefined
    }
  })
  const subscribe = internals.subscribe
    ?? ((listener: (judgment: DispositionJudgment) => void): (() => void) => onRestartSignalJudgment(listener))

  let wasNeedRestart = false
  const unsubscribe = subscribe((judgment) => {
    const entry = judgment.state === 'NEED_RESTART' && !wasNeedRestart
    wasNeedRestart = judgment.state === 'NEED_RESTART'
    if (!entry) return
    const env = internals.env ?? process.env
    const at = now()
    const decision = judgeRestartDisposition({
      enabled: autoRestartEnabled(env),
      hostRunningCount: countRunning(),
      attestation: currentClientAttestation(),
      now: at,
    })
    if (decision.action !== 'dispatch') {
      // The flag-off state is the shipped default — quiet by design. Any
      // other hold while the flag is on deserves one visible line.
      if (decision.action !== 'hold:flag-off') {
        warn(`ui-settings-general: auto-restart held (${decision.action.slice('hold:'.length)})`)
      }
      return
    }
    const commandLine = env[RESTART_COMMAND_ENV]
    if (commandLine === undefined || commandLine === '') {
      warn('ui-settings-general: auto-restart held (no-command)')
      return
    }
    if (restartDispatchClaimed() || !claimRestartDispatch()) {
      warn('ui-settings-general: auto-restart held (in-flight)')
      return
    }
    dispatchRestart(commandLine, internals.launch ?? spawnDetached)
    // reason rides the line (`config` | `built` | `-` when the judgment carried
    // none): the motive joins the existing who/when account (restart-reason-audit-1111 ②).
    warn(`ui-settings-general: auto-restart dispatched (0 running sessions, attestation agreed, reason=${judgment.reason ?? '-'})`)
  })

  ctx.effect(() => () => { unsubscribe() }, 'ui-settings-general: restart disposition')
}
