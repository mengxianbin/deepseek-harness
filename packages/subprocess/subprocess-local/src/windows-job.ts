/** Windows parent-side launch and ownership for the private Job runner. */

import { controlPipe } from './control-spawn.ts'
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { devNull } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  loadWin32ProcessBindings,
  probeCurrentTokenJobSupport,
} from '@deepseek-ai/dsh-win32-process'
import type { BoundProcessOwner, ManagedProcessLaunch } from './managed-owner.ts'
import { appendSubprocessLedger } from './ledger.ts'
import type { LedgerEvent } from './ledger.ts'
import {
  captureDescendantProcesses,
  sweepHeldProcesses,
} from './windows-inspector.ts'
import type { HeldWindowsProcess, SweptWindowsProcess } from './windows-inspector.ts'
import {
  type SerializedRunnerError,
  type WindowsRunnerResult,
  deserializeRunnerError,
  parseWindowsRunnerResult,
} from './runner-protocol.ts'
import {
  runnerEnvironment,
  runnerInvocationAvailable,
  runnerStdio,
  spawnRunnerInvocation,
  WINDOWS_RUNNER_SELECTION,
} from './runner-launch.ts'
import type { RunnerInvocation } from './runner-launch.ts'

/** Test seams for runner launch and dynamic capability checks. */
export interface WindowsJobInternals {
  spawn?: typeof spawn
  runnerInvocation?: RunnerInvocation
  resolveRunnerInvocation?: () => RunnerInvocation
  runnerAvailable?: (invocation: RunnerInvocation) => boolean
  loadWin32ProcessBindings?: typeof loadWin32ProcessBindings
  probeCurrentTokenJobSupport?: typeof probeCurrentTokenJobSupport
  /** Pin the runner's live descendants before termination; defaults to the Toolhelp32 walk. */
  captureDescendants?: (rootPid: number) => HeldWindowsProcess[]
  /** Terminate pinned survivors once the range settles; defaults to handle-based kill. */
  sweepHeld?: (held: HeldWindowsProcess[]) => SweptWindowsProcess[]
  /** Journal one spawn/settle line; defaults to the DSH-home JSONL ledger. */
  recordLedger?: (event: LedgerEvent) => void
}

type RunnerProcess = Omit<ReturnType<typeof spawn>, 'send' | 'stdio'> & {
  send?: ReturnType<typeof spawn>['send']
  stdio: Array<Readable | Writable | null>
}

function isWindowsStartCancellationError(error: SerializedRunnerError): boolean {
  return error.name === 'Error'
    && error.message === 'subprocess target start was cancelled'
    && error.code === undefined
    && error.syscall === undefined
    && error.path === undefined
}

/**
 * Re-check the runner entry, bindings, and current Job capability for every spawn.
 * @param internals - optional runner and Win32 capability seams used by tests.
 * @returns whether the Windows native containment path is currently available.
 */
export function probeWindowsJob(internals: WindowsJobInternals = {}): boolean {
  try {
    const invocation = internals.runnerInvocation
      ?? (internals.resolveRunnerInvocation ?? spawnRunnerInvocation)()
    if (!(internals.runnerAvailable ?? runnerInvocationAvailable)(invocation)) return false
    const api = (internals.loadWin32ProcessBindings ?? loadWin32ProcessBindings)()
    ;(internals.probeCurrentTokenJobSupport ?? probeCurrentTokenJobSupport)(api)
    return true
  } catch {
    return false
  }
}

/**
 * The three containment effects a range owner composes from the launch seams:
 * pin descendants before the Job dies, sweep them when the range settles, and
 * journal both moments. Injected wholesale in tests so no unit run touches the
 * process table or the ledger file.
 */
interface WindowsJobEffects {
  capture: (rootPid: number) => HeldWindowsProcess[]
  sweep: (held: HeldWindowsProcess[]) => SweptWindowsProcess[]
  record: (event: LedgerEvent) => void
}

class WindowsJobOwner implements BoundProcessOwner {
  private cancellationReason: unknown
  private cancellationReasonSet = false
  private terminationSent = false
  private captureRan = false
  private settleRecorded = false
  private held: HeldWindowsProcess[] = []

  constructor(
    private readonly runner: RunnerProcess,
    private readonly exited: Promise<void>,
    private readonly directResultType: () => WindowsRunnerResult['type'] | undefined,
    private readonly failInfrastructure: (error: unknown) => void,
    private readonly runnerPid: number | null,
    private readonly effects: WindowsJobEffects,
  ) {
    void this.exited.catch(() => {})
    // Attached at construction, before any waitForExit() awaiter exists: on a
    // shared promise the earlier handler runs first, so the sweep and its
    // ledger line are complete before teardown callers resume.
    void this.exited.then(
      () => { this.settle('exit') },
      () => { this.settle('error') },
    )
  }

  signal(_signal: 'SIGTERM' | 'SIGKILL', cancellationReason?: unknown): void {
    if (!this.cancellationReasonSet) {
      this.cancellationReason = cancellationReason
      this.cancellationReasonSet = true
    }
    // Pin descendants BEFORE the terminate request reaches the runner: the
    // Job kill is asynchronous on the other side of IPC, and this is the last
    // moment the parent chain is guaranteed intact. Capture runs even when
    // the IPC channel is already dead, because the survivors are then the
    // only thing left this call can still reach.
    this.captureOnce()
    if (this.terminationSent || !this.runner.connected) return
    this.terminationSent = true
    try {
      this.runner.send?.({ type: 'terminate' }, (error) => {
        if (error === null || this.directResultType() !== undefined) return
        this.failInfrastructure(error)
        this.terminateForHostExit()
      })
    } catch (error) {
      this.failInfrastructure(error)
      this.terminateForHostExit()
    }
  }

  mapStartFailure(failure: unknown, serialized: SerializedRunnerError): unknown {
    return this.cancellationReasonSet && isWindowsStartCancellationError(serialized)
      ? this.cancellationReason
      : failure
  }

  async waitForExit(): Promise<void> {
    await this.exited
  }

  terminateForHostExit(): void {
    // The host is losing control right now: pin, then sweep synchronously —
    // promise callbacks may never get a turn once process exit begins. Held
    // members die here directly, held non-members (the foreign-Job class the
    // Job close can never reach) die here for the same reason, and the
    // runner SIGKILL below still closes the Job for anything unpinned.
    this.captureOnce()
    this.settle('host-exit')
    try { this.runner.kill('SIGKILL') } catch { /* Host exit continues with other live runners. */ }
  }

  /** Pin the runner's descendants exactly once; the real capture never throws. */
  private captureOnce(): void {
    if (this.captureRan) return
    this.captureRan = true
    if (this.runnerPid === null) return
    try {
      this.held = this.effects.capture(this.runnerPid)
    } catch {
      // Degraded to Job-only containment; the settle line records captured: 0.
      this.held = []
    }
  }

  /** Sweep held survivors and journal the settlement exactly once. */
  private settle(via: 'exit' | 'error' | 'host-exit'): void {
    if (this.settleRecorded) return
    this.settleRecorded = true
    let swept: SweptWindowsProcess[] = []
    if (this.captureRan && this.held.length > 0) {
      try {
        swept = this.effects.sweep(this.held)
      } catch {
        swept = []
      }
    }
    try {
      this.effects.record({
        event: 'settle',
        runner: this.runnerPid,
        signalled: this.captureRan,
        via,
        captured: this.held.length,
        swept,
      })
    } catch {
      // Ledger is observational by contract; the range settles regardless.
    }
  }
}

/**
 * Launch one target through a runner that uniquely owns its Job handle.
 * @param spec - ordinary target request.
 * @param targetEnv - validated complete target environment.
 * @param internals - optional runner launch seams used by tests.
 * @returns direct streams, result, and runner-owned managed range.
 */
export function launchWindowsJob(
  spec: SubprocessSpawnSpec,
  targetEnv: Record<string, string>,
  internals: WindowsJobInternals = {},
): ManagedProcessLaunch {
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const [command, ...prefix] = invocation
  const ignoredStdinFd = spec.stdio.stdin === 'ignore' ? openSync(devNull, 'r') : undefined
  let child: RunnerProcess
  try {
    child = (internals.spawn ?? spawn)(command, [
      ...prefix,
      '--',
      ...spec.argv,
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      env: runnerEnvironment(WINDOWS_RUNNER_SELECTION, invocation),
      stdio: runnerStdio(spec, true, ignoredStdinFd ?? 'pipe'),
    }) as RunnerProcess
  } finally {
    if (ignoredStdinFd !== undefined) closeSync(ignoredStdinFd)
  }
  const targetStdin = child.stdio[4] as Writable | null

  const direct = Promise.withResolvers<SubprocessOutcome>()
  const rangeExit = Promise.withResolvers<void>()
  let directResultType: WindowsRunnerResult['type'] | undefined
  let runnerSpawned = false
  let runnerExit: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined
  let ipcDisconnected = false
  const failInfrastructure = (error: unknown): void => {
    direct.reject(error)
    rangeExit.reject(error)
  }
  const settleRange = (): void => {
    if (!runnerSpawned || runnerExit === undefined) return
    const { exitCode, signal } = runnerExit
    if (exitCode === 0 && signal === null) {
      if (directResultType !== undefined) {
        rangeExit.resolve()
        return
      }
      // The private IPC result may arrive after the process-exit notification.
      if (!ipcDisconnected) return
    }
    const status = signal !== null
      ? `signal ${signal}`
      : exitCode === null ? 'without an exit status' : `exit code ${String(exitCode)}`
    failInfrastructure(new Error(
      `subprocess-local: Windows Job runner exited with ${status} before proving its managed range empty`,
    ))
  }

  const effects: WindowsJobEffects = {
    capture: internals.captureDescendants ?? captureDescendantProcesses,
    sweep: internals.sweepHeld ?? sweepHeldProcesses,
    record: internals.recordLedger ?? appendSubprocessLedger,
  }
  const owner = new WindowsJobOwner(
    child,
    rangeExit.promise,
    () => directResultType,
    failInfrastructure,
    child.pid ?? null,
    effects,
  )
  child.on('message', (value: unknown) => {
    if (directResultType !== undefined) {
      const error = new Error('subprocess-local: Windows runner emitted more than one direct result')
      failInfrastructure(error)
      owner.terminateForHostExit()
      return
    }
    let result: ReturnType<typeof parseWindowsRunnerResult>
    try {
      result = parseWindowsRunnerResult(value)
    } catch (error) {
      failInfrastructure(error)
      owner.terminateForHostExit()
      return
    }
    directResultType = result.type
    if (result.type === 'target-exit') {
      direct.resolve({ exitCode: result.exitCode, signal: null })
    } else {
      direct.reject(owner.mapStartFailure(deserializeRunnerError(result.error), result.error))
    }
    settleRange()
  })
  child.once('spawn', () => {
    runnerSpawned = true
    try {
      effects.record({ event: 'spawn', runner: child.pid ?? null, target: spec.argv[0] ?? '' })
    } catch {
      // Ledger is observational by contract; spawning continues without it.
    }
    try {
      if (child.send === undefined) throw new Error('subprocess-local: Windows runner has no IPC channel')
      child.send({ type: 'start', cwd: spec.cwd, env: targetEnv, ...spec.stdio.control === undefined ? {} : { control: spec.stdio.control } }, (error) => {
        if (error === null) return
        failInfrastructure(error)
        owner.terminateForHostExit()
      })
    } catch (error) {
      failInfrastructure(error)
      owner.terminateForHostExit()
    }
  })
  child.once('error', (error) => {
    if (!runnerSpawned) {
      direct.reject(error)
      rangeExit.resolve()
      return
    }
    failInfrastructure(error)
  })
  child.once('exit', (exitCode, signal) => {
    runnerExit = { exitCode, signal }
    settleRange()
  })
  child.once('disconnect', () => {
    ipcDisconnected = true
    settleRange()
  })

  return {
    stdin: spec.stdio.stdin === 'ignore' ? null : targetStdin,
    stdout: child.stdio[5] as Readable | null,
    stderr: child.stdio[6] as Readable | null,
    control: controlPipe(child, spec.stdio.control),
    direct: direct.promise,
    owner,
  }
}
