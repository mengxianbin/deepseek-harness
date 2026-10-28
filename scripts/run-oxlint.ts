import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultParallelism } from './parallelism.ts'

const oxlintCli = fileURLToPath(new URL('../node_modules/oxlint/bin/oxlint', import.meta.url))
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024 * 1024
const FIX_FLAGS = new Set(['--fix', '--fix-dangerously', '--fix-suggestions'])

function isFixInvocation(args: readonly string[]): boolean {
  return args.some(arg => FIX_FLAGS.has(arg))
}

function hasOutputFormat(args: readonly string[]): boolean {
  return args.some(arg =>
    arg === '-f'
    || arg.startsWith('-f=')
    || arg === '--format'
    || arg.startsWith('--format='))
}

/** Complete Oxlint child-process arguments and environment. */
export interface OxlintInvocation {
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

/**
 * Apply the repository worker bound to both Oxlint backends.
 * `DSH_OXLINT_THREADS` selects the bound; without it, CI keeps Oxlint's own default and other runs use the
 * [local worker budget](./parallelism.ts). A caller's own `--threads` without `DSH_OXLINT_THREADS` passes through.
 * @param args - Oxlint CLI arguments requested by the caller.
 * @param env - Environment inherited by the Oxlint process.
 * @param cpus - CPU count Node reports for this process.
 * @returns the complete CLI arguments and child environment.
 */
export function resolveOxlintInvocation(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cpus: number = availableParallelism(),
): OxlintInvocation {
  const resolvedArgs = [...args]
  if (env.CI === 'true' && !hasOutputFormat(args)) resolvedArgs.push('--format=default')
  const raw = env.DSH_OXLINT_THREADS
  const explicit = raw !== undefined && raw !== ''
  if (explicit) {
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
      throw new Error(`run-oxlint: DSH_OXLINT_THREADS must be a positive integer, got ${JSON.stringify(raw)}.`)
    }
  }
  if (args.some(arg => arg === '--threads' || arg.startsWith('--threads='))) {
    if (explicit) throw new Error('run-oxlint: use DSH_OXLINT_THREADS instead of passing --threads directly.')
    return { args: resolvedArgs, env: { ...env } }
  }
  if (!explicit && env.CI === 'true') return { args: resolvedArgs, env: { ...env } }
  const threads = explicit ? raw : String(defaultParallelism(env, cpus))
  return {
    args: [...resolvedArgs, `--threads=${threads}`],
    env: { ...env, GOMAXPROCS: threads },
  }
}

/** One completed Oxlint child run: exit coordinates plus captured channels when requested. */
export interface OxlintRunResult {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout?: string
  readonly stderr?: string
}

/**
 * Decide whether the Oxlint child may run below normal priority on Windows.
 * Workstation runs share one disk and one memory pool with interactive sessions, so a
 * full-repository scan yields CPU and I/O instead of starving them. CI keeps normal
 * priority, and `DSH_OXLINT_PRIORITY=0` opts a machine out.
 * @param env - Environment inherited by this process.
 * @returns true when the child may be lowered after spawn.
 */
export function shouldLowerOxlintPriority(env: NodeJS.ProcessEnv): boolean {
  return process.platform === 'win32' && env.CI !== 'true' && env.DSH_OXLINT_PRIORITY !== '0'
}

/**
 * Ask Windows to run a just-spawned Oxlint child at BelowNormal priority, which also
 * lowers its I/O priority hint. Best-effort by design: any failure leaves the child at
 * normal priority and never fails the lint run.
 * @param pid - Process id of the spawned child.
 */
function lowerChildPriority(pid: number): void {
  const setter = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).PriorityClass = 'BelowNormal'`],
    { stdio: 'ignore', windowsHide: true },
  )
  setter.on('error', () => undefined)
}

/**
 * Run one Oxlint child process.
 * @param args - Completed Oxlint CLI arguments.
 * @param env - Environment for the child.
 * @param maxBuffer - When set, capture stdout/stderr and reject past this many bytes.
 * @returns exit status and signal, with captured channels when a bound was requested.
 */
function runOxlint(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  maxBuffer?: number,
): Promise<OxlintRunResult> {
  const captureOutput = maxBuffer !== undefined
  const bound = maxBuffer ?? 0
  const child = spawn(process.execPath, [oxlintCli, ...args], {
    env,
    stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  })
  if (child.pid !== undefined && shouldLowerOxlintPriority(env)) lowerChildPriority(child.pid)
  return new Promise((finish, fail) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let capturedBytes = 0
    if (captureOutput) {
      const collect = (chunks: Buffer[]) => (chunk: Buffer): void => {
        capturedBytes += chunk.length
        if (capturedBytes > bound) {
          child.kill()
          fail(new Error('run-oxlint: captured output exceeded maxBuffer.'))
          return
        }
        chunks.push(chunk)
      }
      child.stdout?.on('data', collect(stdoutChunks))
      child.stderr?.on('data', collect(stderrChunks))
    }
    child.on('error', fail)
    child.on('close', (code, signal) => {
      finish({
        status: code,
        signal,
        ...(captureOutput
          ? { stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8') }
          : {}),
      })
    })
  })
}

function completeFrom(result: { readonly signal: NodeJS.Signals | null; readonly status: number | null }): void {
  if (result.signal !== null) {
    process.kill(process.pid, result.signal)
    return
  }
  process.exitCode = result.status ?? 1
}

async function main(): Promise<void> {
  const invocation = resolveOxlintInvocation(process.argv.slice(2), process.env)
  if (!isFixInvocation(invocation.args)) {
    const result = await runOxlint(invocation.args, invocation.env)
    completeFrom(result)
    return
  }

  const first = await runOxlint(invocation.args, invocation.env, MAX_CAPTURED_OUTPUT_BYTES)
  if (first.signal !== null) {
    completeFrom(first)
    return
  }
  if (first.status === 0) {
    process.stdout.write(first.stdout ?? '')
    process.stderr.write(first.stderr ?? '')
    process.exitCode = 0
    return
  }

  // Overlapping JS-plugin fixes can expose one more fixable diagnostic after the first pass.
  const second = await runOxlint(invocation.args, invocation.env)
  completeFrom(second)
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) await main()
