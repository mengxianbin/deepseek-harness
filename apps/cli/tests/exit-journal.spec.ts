import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExitHandler, EXIT_JOURNAL_FILENAME, formatExitLine, installExitJournal } from '../src/exit-journal.ts'

const dirs: string[] = []
const journalOf = (): string => join(dirs.at(-1) as string, EXIT_JOURNAL_FILENAME)

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'exit-journal-'))
  dirs.push(dir)
  return dir
}

describe('formatExitLine', () => {
  it('stamps local wall clock, code, profile, and pid on one line', () => {
    const line = formatExitLine(7, 'web', 4321, new Date(2026, 10, 19, 15, 41, 49))
    expect(line).toBe('[2026-11-19 15:41:49] node exit code=7 profile=web pid=4321\n')
  })

  it('zero-pads every clock component', () => {
    expect(formatExitLine(0, 'web', 5, new Date(2026, 0, 2, 3, 4, 5))).toContain('[2026-01-02 03:04:05]')
  })
})

describe('createExitHandler', () => {
  it('appends one line per exit, keeping earlier lines', () => {
    tempDir()
    createExitHandler(journalOf(), 'web', 99)(0)
    createExitHandler(journalOf(), 'web', 99)(1)
    const lines = readFileSync(journalOf(), 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('node exit code=0 profile=web pid=99')
    expect(lines[1]).toContain('node exit code=1 profile=web pid=99')
  })

  it('fails open when the account path cannot be written', () => {
    const missing = join(tmpdir(), `exit-journal-absent-${Date.now()}`, 'nope', EXIT_JOURNAL_FILENAME)
    expect(() => {
      createExitHandler(missing, 'web', 1)(0)
    }).not.toThrow()
  })
})

describe('installExitJournal', () => {
  it('registers no listener for non-web profiles', () => {
    const before = process.listenerCount('exit')
    installExitJournal('tui', join(tempDir(), EXIT_JOURNAL_FILENAME))
    expect(process.listenerCount('exit')).toBe(before)
  })

  it('registers one listener for the web profile', () => {
    const before = process.listenerCount('exit')
    installExitJournal('web', join(tempDir(), EXIT_JOURNAL_FILENAME))
    expect(process.listenerCount('exit')).toBe(before + 1)
    // Unwind the real registration so the test process keeps its own exit path.
    const added = process.listeners('exit').slice(before)
    for (const listener of added) process.removeListener('exit', listener)
  })
})
