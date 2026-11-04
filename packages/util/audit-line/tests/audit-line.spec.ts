/** Timestamped single-line stdout behavior of the audit journal helper. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { auditLine, auditTimestamp } from '../src/index.ts'

/** Captured `process.stdout.write` calls for one test. */
function captureStdout(): { lines: () => string[]; restore: () => void } {
  const written: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  })
  return {
    lines: () => written,
    restore: () => { spy.mockRestore() },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('auditTimestamp', () => {
  it('renders a zero-padded local yyyy-MM-dd HH:mm:ss prefix', () => {
    expect(auditTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05')
    expect(auditTimestamp(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31 23:59:59')
  })

  it('defaults to the current local time within one second of now', () => {
    const before = auditTimestamp()
    // Parse without a zone suffix: the render is the host's local wall clock.
    const rendered = Date.parse(before.replace(' ', 'T'))
    expect(Number.isNaN(rendered)).toBe(false)
    expect(Math.abs(Date.now() - rendered)).toBeLessThan(2_000)
  })
})

describe('auditLine', () => {
  it('writes one bracketed timestamped line ending in a newline', () => {
    const capture = captureStdout()
    auditLine('access GET /probe 401 127.0.0.1 0')
    capture.restore()
    const lines = capture.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] access GET \/probe 401 127\.0\.0\.1 0\n$/u)
  })

  it('folds embedded line breaks so one call emits exactly one line', () => {
    const capture = captureStdout()
    auditLine('first\r\nsecond\nthird')
    capture.restore()
    expect(capture.lines()).toEqual(['[' + auditTimestamp() + '] first second third\n'])
  })
})
