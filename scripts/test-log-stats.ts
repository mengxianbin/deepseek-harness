/**
 * Vitest console-log statistics: per-file durations, totals, and top offenders.
 *
 * Full runs print one summary line per test file (`<status> <path> (<n> tests[ |
 * <n> failed]) <n>ms`). Summing those durations gives the aggregate test-second
 * budget (the "全量测试秒" metric), while per-file values locate the slow files.
 * Individual test lines never match because they carry no `(<n> tests)` group.
 *
 * Usage: `pnpm exec tsx scripts/test-log-stats.ts <log> [--top N] [--path <substring>]...`
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One test file's summary line as printed by the Vitest default reporter. */
export interface TestFileStat {
  readonly file: string
  readonly tests: number
  readonly failed: number
  readonly durationMs: number
}

/** Whole-log aggregate produced by {@link parseTestLogStats}. */
export interface TestLogStats {
  readonly files: number
  readonly totalMs: number
  readonly entries: readonly TestFileStat[]
}

const ANSI_PATTERN = /\u001B\[[0-9;]*m/gu
const FILE_LINE_PATTERN =
  /(\S+\.(?:spec|test)\.[cm]?[jt]sx?) \((\d+) tests?([^)]*)\)\s+(\d+)ms$/u
const FAILED_PATTERN = /(\d+) failed/u

/**
 * Strip ANSI color codes so duration matching sees plain text.
 * @param text - Raw log text.
 * @returns the same text without escape sequences.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/**
 * Parse per-file durations out of a Vitest console log.
 * @param text - Raw (possibly colorized) log text.
 * @returns every matching file summary in file order, plus totals.
 */
export function parseTestLogStats(text: string): TestLogStats {
  const entries: TestFileStat[] = []
  for (const line of stripAnsi(text).split(/\r?\n/u)) {
    const match = FILE_LINE_PATTERN.exec(line.trimEnd())
    if (match === null) continue
    const file = match[1]
    const testsRaw = match[2]
    const parenthetical = match[3]
    const durationRaw = match[4]
    if (file === undefined || testsRaw === undefined || parenthetical === undefined || durationRaw === undefined) continue
    const failed = FAILED_PATTERN.exec(parenthetical)
    entries.push({
      file,
      tests: Number(testsRaw),
      failed: failed === null || failed[1] === undefined ? 0 : Number(failed[1]),
      durationMs: Number(durationRaw),
    })
  }
  return {
    files: entries.length,
    totalMs: entries.reduce((sum, entry) => sum + entry.durationMs, 0),
    entries,
  }
}

/**
 * Select the longest-running files from parsed statistics.
 * @param stats - Parsed log statistics.
 * @param count - How many entries to return (defaults to all).
 * @returns entries sorted by duration, longest first.
 */
export function topFiles(stats: TestLogStats, count = stats.files): TestFileStat[] {
  return [...stats.entries].sort((left, right) => right.durationMs - left.durationMs).slice(0, count)
}

/**
 * Format a duration in milliseconds as a compact `ms (min)` pair.
 * @param durationMs - Duration in milliseconds.
 * @returns the human-readable rendering used by the CLI output.
 */
export function formatDuration(durationMs: number): string {
  return `${String(durationMs)} ms (${(durationMs / 60_000).toFixed(1)} min)`
}

function parseCliArgs(argv: readonly string[]): { path: string; top: number; filters: string[] } {
  const filters: string[] = []
  let path = ''
  let top = 20
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (argument === '--top') {
      const value = Number(argv[++index])
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('--top expects a positive integer')
      top = value
    } else if (argument === '--path') {
      const value = argv[++index]
      if (value === undefined || value === '') throw new Error('--path expects a substring')
      filters.push(value)
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown option ${argument}`)
    } else if (path === '') {
      path = argument
    } else {
      throw new Error('only one log path is accepted')
    }
  }
  if (path === '') throw new Error('usage: test-log-stats <log> [--top N] [--path <substring>]...')
  return { path, top, filters }
}

function main(argv: readonly string[]): number {
  const { path, top, filters } = parseCliArgs(argv)
  const stats = parseTestLogStats(readFileSync(path, 'utf8'))
  console.log(`files: ${String(stats.files)}`)
  console.log(`total: ${formatDuration(stats.totalMs)}`)
  for (const filter of filters) {
    const matches = stats.entries.filter(entry => entry.file.includes(filter))
    const sum = matches.reduce((total, entry) => total + entry.durationMs, 0)
    const share = stats.totalMs === 0 ? 0 : (sum / stats.totalMs) * 100
    console.log(`--path ${filter}: ${String(matches.length)} file(s), ${formatDuration(sum)} (${share.toFixed(1)}%)`)
    for (const entry of matches) console.log(`    ${formatDuration(entry.durationMs)}  ${entry.file}`)
  }
  console.log(`top ${String(top)}:`)
  for (const [index, entry] of topFiles(stats, top).entries()) {
    const failed = entry.failed > 0 ? `, ${String(entry.failed)} failed` : ''
    console.log(`  ${String(index + 1).padStart(3)}. ${formatDuration(entry.durationMs).padEnd(24)} ${entry.file} (${String(entry.tests)} tests${failed})`)
  }
  return 0
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
