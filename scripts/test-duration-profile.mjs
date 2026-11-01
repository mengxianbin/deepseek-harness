#!/usr/bin/env node
/**
 * Parse a vitest output log into a per-file duration profile and derive the
 * fast-lane exclusion manifest from it.
 *
 * The fast lane (default `pnpm run test`) skips every spec file whose measured
 * single-file duration exceeded a threshold, so the default suite finishes in
 * about a minute instead of forty. This tool is the single source of that
 * manifest: it reads a full-suite log, reports the distribution, and writes or
 * validates the list — keeping the list auditable instead of hand-maintained.
 *
 * Usage:
 *   node scripts/test-duration-profile.mjs <log> [--threshold <ms>] [--top <n>]
 *       Print the distribution report plus the over-threshold candidates.
 *   node scripts/test-duration-profile.mjs <log> [--threshold <ms>] --write <manifest>
 *       Print the report and write the manifest (one repo-relative path per
 *       line, sorted by path so regeneration diffs clean).
 *   node scripts/test-duration-profile.mjs --check <manifest>
 *       Verify every manifest line is a tracked repo-relative spec path
 *       (anti-dangling: each line must hit `git ls-files`, zero misses).
 *
 * Threshold defaults to 2000 ms (the 2026-11-01 fast-lane ruling: single-file
 * measured duration > 2s goes to the slow list).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** ANSI SGR sequences vitest emits around file result lines. */
const ANSI = /\u001b\[[0-9;]*m/g

/**
 * A per-file completion line: indented repo path, `(N tests …)`, trailing
 * duration with ms/s unit. Indent <= 4 keeps result rows and drops the
 * deeply-nested per-test rows vitest prints under each file.
 */
const FILE_LINE =
  /((?:packages|apps|native|scripts|tests)\/[^\s(]+\.spec\.tsx?)\s+\((\d+) tests?[^)]*\)\s+(\d+)(ms|s)\s*$/

const DEFAULT_THRESHOLD_MS = 2000
const DEFAULT_TOP = 20

/**
 * Strip ANSI colour codes, then extract one record per completed spec file.
 * A file completed more than once (multi-run logs) keeps its slowest reading:
 * the worst case is what the fast lane must dodge.
 * @param {string} logPath - Path to the vitest output log.
 * @returns {{ path: string, tests: number, ms: number }[]} unique file records.
 */
export function parseLogFile(logPath) {
  const lines = readFileSync(logPath, 'utf8').replace(ANSI, '').split(/\r?\n/)
  const byPath = new Map()
  for (const line of lines) {
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    if (indent > 4) continue
    const match = line.match(FILE_LINE)
    if (match === null) continue
    const record = {
      path: match[1],
      tests: Number(match[2]),
      ms: match[4] === 's' ? Number(match[3]) * 1000 : Number(match[3]),
    }
    const previous = byPath.get(record.path)
    if (previous === undefined || record.ms > previous.ms) byPath.set(record.path, record)
  }
  return [...byPath.values()]
}

/**
 * Nearest-rank percentile over an ascending duration array.
 * @param {number[]} ascending - Sorted durations in ms.
 * @param {number} p - Percentile in [0, 100].
 * @returns {number} duration in ms.
 */
function percentile(ascending, p) {
  if (ascending.length === 0) return 0
  const rank = Math.ceil((p / 100) * ascending.length)
  return ascending[Math.min(rank, ascending.length) - 1]
}

/**
 * Format a millisecond duration with a human unit.
 * @param {number} ms - Duration in milliseconds.
 * @returns {string} e.g. `480ms`, `3.1s`, `19.2min`.
 */
function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}min`
}

/**
 * Print the distribution report and the over-threshold candidate list.
 * @param {{ path: string, tests: number, ms: number }[]} files - Parsed records.
 * @param {number} thresholdMs - Slow-list threshold.
 * @param {number} top - How many heaviest files to list.
 * @returns {{ slow: typeof files, fast: typeof files }} split for the caller.
 */
export function report(files, thresholdMs, top) {
  const durations = files.map(file => file.ms).sort((a, b) => a - b)
  const totalMs = durations.reduce((sum, ms) => sum + ms, 0)
  const slow = files.filter(file => file.ms > thresholdMs).sort((a, b) => b.ms - a.ms)
  const fast = files.filter(file => file.ms <= thresholdMs)
  const fastMs = fast.reduce((sum, file) => sum + file.ms, 0)
  const fastTests = fast.reduce((sum, file) => sum + file.tests, 0)
  const totalTests = files.reduce((sum, file) => sum + file.tests, 0)

  const buckets = [
    { label: '<0.5s', test: ms => ms < 500 },
    { label: '0.5-5s', test: ms => ms >= 500 && ms < 5_000 },
    { label: '5-15s', test: ms => ms >= 5_000 && ms < 15_000 },
    { label: '15-60s', test: ms => ms >= 15_000 && ms < 60_000 },
    { label: '>60s', test: ms => ms >= 60_000 },
  ]

  console.log(`Files: ${files.length}  Tests: ${totalTests}  Test-time: ${formatMs(totalMs)}`)
  console.log('')
  console.log('Percentiles (per file):')
  for (const p of [50, 75, 90, 95, 99]) {
    console.log(`  p${p}: ${formatMs(percentile(durations, p))}`)
  }
  console.log(`  max: ${formatMs(durations.at(-1) ?? 0)}`)
  console.log('')
  console.log('Duration buckets:')
  for (const bucket of buckets) {
    const count = durations.filter(bucket.test).length
    console.log(`  ${bucket.label}: ${count} files (${((count / files.length) * 100).toFixed(1)}%)`)
  }
  console.log('')
  console.log(`Heaviest ${top} files:`)
  for (const file of files.slice().sort((a, b) => b.ms - a.ms).slice(0, top)) {
    console.log(`  ${formatMs(file.ms).padStart(8)}  ${file.tests} tests  ${file.path}`)
  }
  console.log('')
  console.log(
    `Threshold ${thresholdMs}ms: slow=${slow.length} fast=${fast.length} ` +
    `(${((fast.length / files.length) * 100).toFixed(1)}% of files, ` +
    `${fastTests} tests, ${formatMs(fastMs)} of ${formatMs(totalMs)} test-time)`,
  )
  return { slow, fast }
}

/**
 * Write the manifest: one repo-relative path per line, path-sorted so a
 * regeneration against a fresh log only diffs the entries that crossed the
 * threshold. No comments — every line must be a directly checkable path.
 *
 * Entries the log recorded but git no longer tracks are pruned: the log is a
 * snapshot, and master moves on (specs get renamed or deleted). A pruned path
 * just re-enters the fast lane, so pruning errs toward running more tests,
 * never toward silently skipping an untracked path.
 * @param {{ path: string }[]} slow - Over-threshold records.
 * @param {string} manifestPath - Destination file.
 */
export function writeManifest(slow, manifestPath) {
  const tracked = spawnSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (tracked.status !== 0) {
    throw new Error(`write: git ls-files failed (exit ${tracked.status}): ${tracked.stderr}`)
  }
  const trackedSet = new Set(tracked.stdout.split(/\r?\n/).filter(Boolean))
  const kept = slow.filter(file => trackedSet.has(file.path))
  for (const file of slow) {
    if (!trackedSet.has(file.path)) console.warn(`pruned (not tracked by git): ${file.path}`)
  }
  const paths = kept.map(file => file.path).sort()
  writeFileSync(manifestPath, `${paths.join('\n')}\n`, 'utf8')
  console.log(`Wrote ${paths.length} paths to ${manifestPath} (pruned ${slow.length - kept.length} untracked)`)
}

/**
 * Anti-dangling check: every manifest line must be a tracked repo-relative
 * path (`git ls-files` hit), a relative spec path without backslashes, and
 * unique. Exits non-zero listing the offenders so a renamed or deleted spec
 * cannot silently keep its exclusion forever.
 * @param {string} manifestPath - Manifest to validate.
 * @returns {number} process exit code (0 = clean).
 */
export function checkManifest(manifestPath) {
  const raw = readFileSync(manifestPath, 'utf8')
  const lines = raw.split(/\r?\n/)
  const entries = lines.filter(line => line.trim().length > 0)
  const tracked = spawnSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (tracked.status !== 0) {
    console.error(`check: git ls-files failed (exit ${tracked.status}): ${tracked.stderr}`)
    return 1
  }
  const trackedSet = new Set(tracked.stdout.split(/\r?\n/).filter(Boolean))
  const seen = new Set()
  const problems = []
  for (const [index, line] of entries.entries()) {
    const entry = line.trim()
    if (line !== entry) problems.push(`L${index + 1}: leading/trailing whitespace: ${JSON.stringify(line)}`)
    if (entry.startsWith('/') || entry.includes('\\') || entry.split('/').includes('..')) {
      problems.push(`L${index + 1}: not a repo-relative path: ${entry}`)
      continue
    }
    if (seen.has(entry)) problems.push(`L${index + 1}: duplicate: ${entry}`)
    seen.add(entry)
    if (!trackedSet.has(entry)) problems.push(`L${index + 1}: not tracked by git (dangling): ${entry}`)
  }
  if (problems.length > 0) {
    console.error(`check FAILED: ${problems.length} problem(s) in ${manifestPath}`)
    for (const problem of problems) console.error(`  ${problem}`)
    return 1
  }
  console.log(`check OK: ${entries.length} entries, all tracked, no duplicates`)
  return 0
}

/**
 * Parse argv into a mode + options object.
 * @param {string[]} argv - Arguments after the script path.
 * @returns {{ mode: 'check'|'profile', log?: string, manifest?: string,
 *   write?: string, thresholdMs: number, top: number, help: boolean }} parsed args.
 */
function parseArgs(argv) {
  const options = { mode: 'profile', thresholdMs: DEFAULT_THRESHOLD_MS, top: DEFAULT_TOP, help: false }
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--check') {
      options.mode = 'check'
      options.manifest = argv[++i]
    } else if (arg === '--write') options.write = argv[++i]
    else if (arg === '--threshold') options.thresholdMs = Number(argv[++i])
    else if (arg === '--top') options.top = Number(argv[++i])
    else positional.push(arg)
  }
  if (options.mode === 'check') {
    if (options.manifest === undefined) throw new Error('--check requires a manifest path')
  } else if (positional.length !== 1) {
    throw new Error('expected exactly one <log> argument (or --check <manifest>)')
  } else {
    options.log = positional[0]
  }
  if (!Number.isFinite(options.thresholdMs) || options.thresholdMs <= 0) {
    throw new Error('--threshold requires a positive millisecond number')
  }
  if (!Number.isFinite(options.top) || options.top <= 0) throw new Error('--top requires a positive number')
  return options
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`error: ${error.message}`)
    console.error('usage: test-duration-profile <log> [--threshold <ms>] [--top <n>] [--write <manifest>]')
    console.error('       test-duration-profile --check <manifest>')
    process.exit(2)
  }
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
    return
  }
  if (options.mode === 'check') process.exit(checkManifest(options.manifest))
  const files = parseLogFile(options.log)
  if (files.length === 0) {
    console.error(`error: no per-file duration lines found in ${options.log}`)
    process.exit(1)
  }
  const { slow } = report(files, options.thresholdMs, options.top)
  if (options.write !== undefined) writeManifest(slow, options.write)
}

// Only run the CLI when executed directly; imports (parseLogFile, report, …)
// stay side-effect free for reuse and tests.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}
