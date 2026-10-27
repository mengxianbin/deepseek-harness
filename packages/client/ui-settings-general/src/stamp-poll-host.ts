/**
 * Restart-signal polling (design §三 triggers ① and ②): the host's own
 * change sensor over the source trees and the configured-source fingerprint.
 *
 * Every interval the poller captures one fingerprint — the repo-level source
 * state of every in-scope repository (`repoStateStamp`: HEAD plus
 * `git diff HEAD`, the porcelain status, and each untracked file's path with
 * its content hash, runtime data excluded) plus the S_cfg configuration
 * snapshot (`computeConfigStamp`: the fixed HKCU setx inventory and each
 * profile's configuration files) — and fires a state-machine recheck only
 * when the fingerprint moved. The capture runs in a short-lived child
 * process (the same non-blocking pattern the recheck gatherer uses), so the
 * host event loop never waits on git or `reg`; each poll needs zero
 * credentials and installs no hooks (design §三).
 *
 * The repository set is the state machine's own scope: this tree plus every
 * linked, stamp-capable plugin repository (`linkedStampRepositories`), so the
 * sensor and the judgment can never drift apart. Failures degrade loudly —
 * one stderr line per failure state, the last good baseline kept, the host
 * untouched — and the interval env (`DSH_STAMP_POLL_INTERVAL_MS`) accepts
 * `0` as an operational off-switch, clamps everything else into the design's
 * 30–60s band, and defaults to 30s.
 *
 * Push leg (design C.5, closes R3「页面开着不操作角标自现」): after a moved
 * fingerprint's recheck lands, the poll emits the allowlisted
 * `restart-signal/changed` Host event, which the Remote carrier forwards to
 * every connected page; the browser half subscribes and answers with its
 * existing `recheck()` — the judgment itself keeps riding the recheck route,
 * so the push event carries no payload and cannot drift from the state
 * machine. A failed recheck emits nothing (there is no fresh judgment to
 * deliver) and keeps the pre-P2 warn line.
 * @module @deepseek-ai/dsh-client-ui-settings-general/stamp-poll-host
 */

import { execFile } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `restart-signal/changed` Events declaration the push emit names.
import type {} from '@deepseek-ai/dsh-api-remotes/types'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { collectRestartSignal } from './restart-signal.ts'
import { defaultRepositoryRoot, linkedStampRepositories } from './restart-stamp.ts'

const execFileAsync = promisify(execFile)

/** Environment variable tuning the poll interval; `0` disables polling. */
export const STAMP_POLL_INTERVAL_ENV = 'DSH_STAMP_POLL_INTERVAL_MS'

/** Default poll interval: the low end of the design's 30–60s band. */
const DEFAULT_INTERVAL_MS = 30_000

/** Lower clamp bound of the configurable interval (design §三). */
const MIN_INTERVAL_MS = 30_000

/** Upper clamp bound of the configurable interval (design §三). */
const MAX_INTERVAL_MS = 60_000

/** Ceiling for one fingerprint child run; normal captures take ~2s. */
const PROBE_TIMEOUT_MS = 30_000

/** Delay of the priming capture: settles post-boot, never reaches a test that drops the plugin. */
const PRIME_DELAY_MS = 2_000

/** One captured fingerprint: per-repository source states plus S_cfg. */
export interface FingerprintProbe {
  /** Repo-level source state hash per absolute repository path. */
  readonly repos: Readonly<Record<string, string>>
  /** Configured-source stamp, enumerated like the runtime snapshot was. */
  readonly sCfg: string
}

/** Injection seam for the fingerprint capture; production spawns the probe child. */
export type FingerprintRunner = (roots: readonly string[], dshHome: string) => Promise<FingerprintProbe>

/** Injection seams for one poller; production defaults come from this process. */
export interface StampPollInternals {
  /** State-machine recheck to fire on a moved fingerprint; defaults to the production collect. */
  readonly recheck?: () => Promise<unknown>
  /** Fingerprint capture; defaults to the child-process probe. */
  readonly runProbe?: FingerprintRunner
  /** Interval override; defaults to the clamped environment variable. */
  readonly intervalMs?: number
  /** DSH home holding the profiles; defaults to `resolveDshHome()`. */
  readonly dshHome?: string
  /** Failure sink; defaults to one stderr line. */
  readonly warn?: (message: string) => void
}

/** Inputs the generated probe module is parameterized with. */
export interface FingerprintProbeCodeOptions {
  /** file: URL of the `repo-stamp` module in this tree. */
  readonly repoStampUrl: string
  /** file: URL of the `restart-stamp` module in this tree. */
  readonly restartStampModuleUrl: string
  /** Absolute repository paths to stamp. */
  readonly roots: readonly string[]
  /** DSH home whose profile configuration enters S_cfg. */
  readonly dshHome: string
}

/**
 * Resolve the effective poll interval: absent or unparsable input falls back
 * to the default, `0` is the explicit off-switch, and everything else clamps
 * into the design's 30–60s band.
 * @param raw - Raw environment variable text, if any.
 * @returns The interval in milliseconds; `0` when polling is switched off.
 */
export function resolvePollIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_INTERVAL_MS
  if (parsed === 0) return 0
  return Math.min(Math.max(parsed, MIN_INTERVAL_MS), MAX_INTERVAL_MS)
}

/**
 * Generate the probe module source: a dependency-free ESM one-liner module
 * that imports the tree's own stamp modules by file URL, captures the
 * fingerprint, and prints it as JSON. All embeddings are JSON string
 * literals, so paths with spaces or backslashes need no quoting rules of
 * their own; a thrown stamp error exits the child non-zero, which the parent
 * reports as one failure line.
 * @param options - Module URLs, repository roots, and the DSH home to embed.
 * @returns The module source executed by `node --input-type=module -e`.
 */
export function buildFingerprintProbeCode(options: FingerprintProbeCodeOptions): string {
  const regKey = JSON.stringify('HKCU\\Environment')
  return [
    "import { execFileSync } from 'node:child_process'",
    `import { repoStateStamp } from ${JSON.stringify(options.repoStampUrl)}`,
    `import { computeConfigStamp } from ${JSON.stringify(options.restartStampModuleUrl)}`,
    `const roots = ${JSON.stringify([...options.roots])}`,
    'const repos = {}',
    'for (const root of roots) repos[root] = repoStateStamp(root)',
    "let registry = ''",
    `try { registry = execFileSync('reg', ['query', ${regKey}], { encoding: 'utf8', windowsHide: true }) } catch {}`,
    `const sCfg = computeConfigStamp(${JSON.stringify(options.dshHome)}, registry)`,
    'process.stdout.write(JSON.stringify({ repos, sCfg }))',
  ].join('\n')
}

/**
 * Parse the probe child's stdout into a captured fingerprint.
 * @param text - raw stdout of the probe child.
 * @returns the validated fingerprint.
 * @throws When the body is not JSON (with byte count and a head snippet) or
 *   fails the shape checks — so an unreadable body names itself instead of
 *   surfacing a bare `Unexpected end of JSON input` (③, 2026-10-26).
 */
export function parseProbeOutput(text: string): FingerprintProbe {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const head = text.length > 0 ? JSON.stringify(text.slice(0, 120)) : '(empty)'
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(`stamp-poll: probe body is not JSON (bytes=${text.length}, head=${head}): ${cause}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('stamp-poll: probe returned a non-object body')
  }
  const repos: unknown = Reflect.get(parsed, 'repos')
  if (typeof repos !== 'object' || repos === null || Array.isArray(repos)) {
    throw new Error('stamp-poll: probe response has no repos record')
  }
  const entries = Object.entries(repos as Record<string, unknown>)
  if (!entries.every(([, value]) => typeof value === 'string')) {
    throw new Error('stamp-poll: probe reported a non-string repository stamp')
  }
  const sCfg: unknown = Reflect.get(parsed, 'sCfg')
  if (typeof sCfg !== 'string') throw new Error('stamp-poll: probe response has no sCfg string')
  return { repos: Object.fromEntries(entries) as Record<string, string>, sCfg }
}

/**
 * The production capture: spawn the generated probe against this tree's stamp
 * modules, off the host event loop.
 * @param roots - Absolute repository paths to stamp.
 * @param dshHome - DSH home whose profile configuration enters S_cfg.
 * @returns The captured fingerprint.
 * @throws When the child exits non-zero or prints an unreadable body.
 */
export async function runFingerprintProbe(roots: readonly string[], dshHome: string): Promise<FingerprintProbe> {
  const repositoryRoot = defaultRepositoryRoot()
  const code = buildFingerprintProbeCode({
    repoStampUrl: pathToFileURL(join(repositoryRoot, 'scripts', 'restart-signal', 'repo-stamp.ts')).href,
    restartStampModuleUrl: pathToFileURL(
      join(repositoryRoot, 'packages', 'client', 'ui-settings-general', 'src', 'restart-stamp.ts'),
    ).href,
    roots,
    dshHome,
  })
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: repositoryRoot,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    timeout: PROBE_TIMEOUT_MS,
  })
  return parseProbeOutput(stdout)
}

function fingerprintMoved(baseline: FingerprintProbe, probe: FingerprintProbe): boolean {
  if (baseline.sCfg !== probe.sCfg) return true
  const keys = new Set([...Object.keys(baseline.repos), ...Object.keys(probe.repos)])
  for (const key of keys) {
    if (baseline.repos[key] !== probe.repos[key]) return true
  }
  return false
}

/**
 * Render one failure for the single-line log (③, 2026-10-26: the old form
 * dumped the probe child's full `-e` script — hundreds of lines — and buried
 * the exit code; a JSON body failure surfaced as a bare
 * `Unexpected end of JSON input` with no body context).
 *
 * Child-process failures (code/signal/stderr attached) collapse to a compact
 * `exit=… signal=… stderr:"…"` fact line; everything else keeps its message.
 * The text is deterministic per failure state, so the one-line-per-state
 * dedupe still holds.
 * @param error - any thrown value from a probe or recheck run.
 * @returns a single-line, diagnosis-ready description.
 */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  // Explicit unknown: Reflect.get returns any; annotate to keep the log path lint-clean.
  const code: unknown = Reflect.get(error, 'code')
  const signal: unknown = Reflect.get(error, 'signal')
  const stderr: unknown = Reflect.get(error, 'stderr')
  const isChildFailure = code !== undefined || signal !== undefined || typeof stderr === 'string'
  if (!isChildFailure) return error.message
  const codeText = typeof code === 'string' || typeof code === 'number' ? String(code) : 'unknown'
  const parts: string[] = [`exit=${codeText}`]
  if (typeof signal === 'string' && signal !== '') parts.push(`signal=${signal}`)
  if (typeof stderr === 'string' && stderr.trim() !== '') {
    const flat = stderr.trim().replace(/\s+/g, ' ')
    // Head, not tail: child diagnostics (git warnings, thrown error + top
    // stack frames) lead the stream; the tail is mostly `at …` frames.
    const head = flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
    parts.push(`stderr:"${head}"`)
  }
  return `probe child failed (${parts.join(' ')})`
}

/**
 * Start the design's polling triggers ① and ②: one fingerprint capture per
 * interval, a state-machine recheck whenever the fingerprint moves from the
 * last captured baseline, and one failure line per distinct failure state.
 * Disposal clears the timer; an in-flight capture that lands after disposal
 * is dropped.
 * @param ctx - Host context carrying the effect lifetime.
 * @param internals - Injectable seams; production uses this tree, the resolved DSH home, and the probe child.
 */
export function registerStampPoll(ctx: Context, internals: StampPollInternals = {}): void {
  const intervalMs = internals.intervalMs ?? resolvePollIntervalMs(process.env[STAMP_POLL_INTERVAL_ENV])
  const repositoryRoot = defaultRepositoryRoot()
  const dshHome = internals.dshHome ?? resolveDshHome()
  const recheck = internals.recheck ?? ((): Promise<unknown> => collectRestartSignal())
  const runProbe = internals.runProbe ?? runFingerprintProbe
  const warn = internals.warn ?? ((message: string): void => { process.stderr.write(`${message}\n`) })

  let baseline: FingerprintProbe | undefined
  let probing = false
  let disposed = false
  let lastFailure: string | undefined

  const probeRoots = (): string[] => [
    repositoryRoot,
    ...linkedStampRepositories(dshHome).filter(root => root !== repositoryRoot),
  ]

  const tick = (): void => {
    if (probing || disposed) return
    probing = true
    void runProbe(probeRoots(), dshHome).then((probe) => {
      probing = false
      if (disposed) return
      lastFailure = undefined
      if (baseline === undefined) {
        baseline = probe
        return
      }
      if (!fingerprintMoved(baseline, probe)) return
      baseline = probe
      void recheck().then(() => {
        if (disposed) return
        // Design C.5 push leg: the judgment was just recomputed, so poke
        // every open page to pull it — payload-free by design (see module
        // doc). Emitted only on success: a failed recheck has no fresh
        // judgment to deliver.
        ctx.emit('restart-signal/changed')
      }, (error: unknown) => {
        if (disposed) return
        warn(`ui-settings-general: stamp-poll recheck failed: ${errorText(error)}`)
      })
    }, (error: unknown) => {
      probing = false
      if (disposed) return
      // One line per failure state, not one per tick: a persistent failure
      // (a missing repository, a broken git) logs once and stays visible.
      const message = `ui-settings-general: stamp-poll probe failed: ${errorText(error)}`
      if (message === lastFailure) return
      lastFailure = message
      warn(message)
    })
  }

  ctx.effect(() => {
    if (intervalMs === 0) return () => {}
    // The priming capture lands shortly after start so the first interval
    // window can never absorb a change silently: a change before the first
    // scheduled tick then compares against the boot-time baseline instead of
    // redefining it. A plugin that is applied and dropped before the delay
    // (the route specs) never spawns it.
    const prime = setTimeout(() => { tick() }, Math.min(intervalMs, PRIME_DELAY_MS))
    prime.unref()
    const timer = setInterval(() => { tick() }, intervalMs)
    timer.unref()
    return () => {
      disposed = true
      clearTimeout(prime)
      clearInterval(timer)
    }
  }, 'ui-settings-general: stamp poll')
}
