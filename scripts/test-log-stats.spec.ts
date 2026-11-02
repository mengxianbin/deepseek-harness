import { describe, expect, it } from 'vitest'
import { formatDuration, parseTestLogStats, stripAnsi, topFiles } from './test-log-stats.ts'

const SAMPLE = [
  '\u001b[32m \u2713\u001b[39m \u001b[30m\u001b[45m thread-safe \u001b[49m\u001b[39m scripts/oxlint-contract.spec.ts \u001b[2m(\u001b[22m\u001b[2m14 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 300000\u001b[2mms\u001b[22m',
  ' \u276f  thread-safe  packages/boot/app-boot/tests/profile-resolution.spec.ts (233 tests | 5 failed) 619784ms',
  ' \u2713  thread-safe  scripts/persistence-schema-snapshot.spec.ts (7 tests) 49ms',
  ' \u2713  some other file without the summary shape 946ms',
  '     \u2713 shows the localized document status 946ms',
  ' \u2193  thread-safe  packages/typert/generator/tests/cordis-catalog-contract.spec.ts (28 tests | 28 skipped)',
  'Test Files  2 failed | 2058 passed (2060)',
].join('\n')

describe('test-log-stats', () => {
  it('strips ANSI color codes before matching', () => {
    expect(stripAnsi('\u001b[32mok\u001b[39m')).toBe('ok')
  })

  it('parses file summary lines and totals while ignoring test-level lines', () => {
    const stats = parseTestLogStats(SAMPLE)
    expect(stats.files).toBe(3)
    expect(stats.totalMs).toBe(300_000 + 619_784 + 49)
    expect(stats.entries[0]).toEqual({
      file: 'scripts/oxlint-contract.spec.ts', tests: 14, failed: 0, durationMs: 300_000,
    })
    expect(stats.entries[1]).toEqual({
      file: 'packages/boot/app-boot/tests/profile-resolution.spec.ts', tests: 233, failed: 5, durationMs: 619_784,
    })
    expect(stats.entries[2]).toEqual({
      file: 'scripts/persistence-schema-snapshot.spec.ts', tests: 7, failed: 0, durationMs: 49,
    })
    // A skipped file prints no duration and must not count toward the budget.
    expect(stats.entries.some(entry => entry.file.includes('cordis-catalog-contract'))).toBe(false)
  })

  it('ranks files longest first and caps the list', () => {
    const stats = parseTestLogStats(SAMPLE)
    const ranked = topFiles(stats, 1)
    expect(ranked).toHaveLength(1)
    expect(ranked[0]?.file).toContain('profile-resolution.spec.ts')
  })

  it('formats durations as milliseconds and minutes', () => {
    expect(formatDuration(1_151_917)).toBe('1151917 ms (19.2 min)')
  })
})
