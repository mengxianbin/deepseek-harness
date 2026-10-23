/**
 * Boot-free entry for `dsh web --print-url`: reprint the running web
 * instance's login URL so an expired cookie can be recovered without digging
 * through terminal history or restarting the service. The launch token lives
 * inside the running process, so this new process never mints one — it reads
 * the startup line `dsh web: <url>?token=…` that the instance printed to its
 * stdout log (the same channel the restart supervisor harvests) and proves the
 * line still works by replaying its own exchange: HTTP 303 means the origin is
 * alive and the token is accepted, 401 means the log predates a restart, and a
 * refused connection means no instance. The URL is echoed on stdout only —
 * nothing here serves, stores, or forwards the credential.
 * @module @deepseek-ai/dsh/print-url
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Bytes read from the end of the log; the startup line is always the newest token line. */
const TAIL_BYTES = 512 * 1024

/** Upper bound on the exchange probe so an absent instance fails fast. */
const PROBE_TIMEOUT_MS = 2000

/** The startup line the web app prints: `dsh web: <root>/?token=<launch token>`. */
const STARTUP_URL_PATTERN = /^dsh web: (\S+\?token=\S+)\s*$/gmu

/** Connection-level failures: the origin is not serving this URL at all. */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EAI_AGAIN',
])

/** IO and environment overrides for tests; production defaults read the live process. */
export interface PrintUrlDeps {
  /** Environment mapping read for `DSH_WEB_LOG`. */
  env?: Record<string, string | undefined>
  /** Resolved Harness home anchoring the default log location. */
  home?: string
  /** Module URL whose package root holds the checkout-side log. */
  logAnchorUrl?: string
  /** Replacement for the global `fetch` used by the exchange probe. */
  fetchImpl?: typeof fetch
  /** Sink for the single stdout line (without a trailing newline). */
  stdout?: (line: string) => void
  /** Sink for the human-readable failure line (without a trailing newline). */
  stderr?: (line: string) => void
}

/** How the logged URL answered its own login exchange. */
type ProbeOutcome =
  /** 3xx: the origin is up and the launch token is still accepted. */
  | { kind: 'exchanged' }
  /** The origin answered, but not with the login exchange (server up, URL stale or broken). */
  | { kind: 'answered'; status: number }
  /** Connection-level failure: nothing is listening for this URL. */
  | { kind: 'unreachable'; detail: string }

/**
 * Read the signal a fetch rejection carries, looking at `cause` first (undici
 * wraps connection failures there) and then the error itself.
 * @param error - the thrown fetch failure.
 * @returns the connection `code` or `name`, absent when the error carries neither.
 */
function failureSignal(error: unknown): { code?: string; name?: string } {
  const signal: { code?: string; name?: string } = {}
  if (typeof error !== 'object' || error === null) return signal
  if ('name' in error && typeof error.name === 'string') signal.name = error.name
  if ('code' in error && typeof error.code === 'string') signal.code = error.code
  if ('cause' in error) {
    const cause: unknown = error.cause
    if (typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string') {
      signal.code = cause.code
    }
  }
  return signal
}

/**
 * Classify a fetch failure: connection-level failures and timeouts mean the
 * origin is unreachable, as does a refusal issued before connecting (a
 * forbidden port, a malformed authority — the WHATWG fetch rules reject these
 * with a message but no code, and no browser would open them either).
 * Anything else that proves something answered on that origin — for example a
 * TLS policy this process cannot satisfy — must not deny a URL the running
 * instance printed: the launch token's validity does not depend on this
 * probe's transport.
 * @param error - the thrown fetch failure.
 * @returns the outcome for a failed probe.
 */
function unreachableOutcome(error: unknown): ProbeOutcome {
  const signal = failureSignal(error)
  if (signal.code !== undefined && UNREACHABLE_CODES.has(signal.code)) {
    return { kind: 'unreachable', detail: signal.code }
  }
  if (signal.name === 'TimeoutError' || signal.name === 'AbortError') {
    return { kind: 'unreachable', detail: `no response within ${String(PROBE_TIMEOUT_MS)}ms` }
  }
  const cause = typeof error === 'object' && error !== null && 'cause' in error ? error.cause : undefined
  if (cause instanceof Error && !('code' in cause)) {
    return { kind: 'unreachable', detail: cause.message }
  }
  return { kind: 'exchanged' }
}

/**
 * Replay the logged URL's login exchange to prove the instance behind it is
 * alive and the launch token is still the current process's.
 * @param url - the full startup URL carrying `?token=`.
 * @param fetchImpl - the fetch implementation to probe with.
 * @returns the probe outcome; never throws.
 */
async function probeStartupUrl(url: string, fetchImpl: typeof fetch): Promise<ProbeOutcome> {
  try {
    // Redirects are the exchange itself: manual mode surfaces the 303 instead
    // of following it into the authenticated page.
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (response.status >= 300 && response.status < 400) return { kind: 'exchanged' }
    return { kind: 'answered', status: response.status }
  } catch (error) {
    return unreachableOutcome(error)
  }
}

/**
 * Read the tail of a log file; an absent or unreadable file is `undefined`.
 * @param path - absolute log path.
 * @returns at most {@link TAIL_BYTES} trailing bytes as text, absent on failure.
 */
function readLogTail(path: string): string | undefined {
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - TAIL_BYTES)
      const buffer = Buffer.allocUnsafe(size - start)
      readSync(fd, buffer, 0, buffer.length, start)
      return buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

/**
 * Extract the newest startup URL from a log tail.
 * @param tail - text read from the end of the log.
 * @returns the last `dsh web: …?token=…` URL, absent when the log holds none.
 */
export function extractStartupUrl(tail: string): string | undefined {
  let latest: string | undefined
  for (const match of tail.matchAll(STARTUP_URL_PATTERN)) latest = match[1]
  return latest
}

/**
 * Resolve the log files this invocation may read, in order. An explicit
 * `DSH_WEB_LOG` (the stdout redirect the start script owns) is authoritative;
 * otherwise the URL is looked up beside the checkout that runs this launcher,
 * then under the single Harness home, mirroring where `dsh web` startups
 * redirect their stdout.
 * @param env - environment mapping read for `DSH_WEB_LOG`.
 * @param logAnchorUrl - this module's URL, anchoring the checkout-side log.
 * @param home - resolved Harness home.
 * @returns absolute candidate paths, deduplicated, in preference order.
 */
export function logCandidates(
  env: Record<string, string | undefined>,
  logAnchorUrl: string,
  home: string,
): string[] {
  const override = env.DSH_WEB_LOG?.trim()
  const candidates = override !== undefined && override !== ''
    ? [resolve(override)]
    : [fileURLToPath(new URL('../../../dsh-web.log', logAnchorUrl)), join(home, 'dsh-web.log')]
  return [...new Set(candidates.map(candidate => resolve(candidate)))]
}

/**
 * Print the running web instance's login URL, or a one-line human-readable
 * reason it cannot be reprinted. The URL goes to stdout complete — the full
 * 43-character launch token, never truncated — and only after the exchange
 * probe proved it opens; every failure writes one stderr line and exits 1
 * without a stack trace.
 * @param deps - test-injected environment, IO, and probe overrides.
 * @returns the process exit code: 0 with a printed URL, 1 otherwise.
 */
export async function runPrintUrl(deps: PrintUrlDeps = {}): Promise<number> {
  const env = deps.env ?? process.env
  const home = deps.home ?? resolveDshHome()
  const logAnchorUrl = deps.logAnchorUrl ?? import.meta.url
  const fetchImpl = deps.fetchImpl ?? fetch
  const stdout = deps.stdout ?? ((line: string) => { process.stdout.write(`${line}\n`) })
  const stderr = deps.stderr ?? ((line: string) => { process.stderr.write(`${line}\n`) })

  const candidates = logCandidates(env, logAnchorUrl, home)
  const reasons: string[] = []
  let stale: { path: string; origin: string } | undefined
  let answered: { path: string; origin: string; status: number } | undefined
  for (const path of candidates) {
    const tail = readLogTail(path)
    if (tail === undefined) {
      reasons.push(`no log file at ${path}`)
      continue
    }
    const url = extractStartupUrl(tail)
    if (url === undefined) {
      reasons.push(`${path} has no startup URL line`)
      continue
    }
    let origin: string
    try {
      origin = new URL(url).origin
    } catch {
      reasons.push(`${path} holds a malformed startup URL`)
      continue
    }
    const probe = await probeStartupUrl(url, fetchImpl)
    if (probe.kind === 'exchanged') {
      stdout(url)
      return 0
    }
    if (probe.kind === 'answered') {
      if (probe.status === 401 || probe.status === 403) stale ??= { path, origin }
      else answered ??= { path, origin, status: probe.status }
      continue
    }
    reasons.push(`cannot open ${origin} (${probe.detail}) — ${path}`)
  }
  if (answered !== undefined) {
    stderr(`dsh web --print-url: ${answered.origin} answered HTTP ${String(answered.status)} instead of the login exchange — ${answered.path}`)
    return 1
  }
  if (stale !== undefined) {
    stderr(`dsh web --print-url: ${stale.origin} rejected the startup URL in ${stale.path} (HTTP 401): the log predates the running instance's boot`)
    return 1
  }
  stderr(`dsh web is not running: ${reasons.join('; ')}`)
  return 1
}
