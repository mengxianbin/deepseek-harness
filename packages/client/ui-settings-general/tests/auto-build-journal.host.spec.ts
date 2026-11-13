/**
 * auto-build journal audit protocol (build-dispatch ⑤, five properties).
 *
 * ① single writer protocol — every line is tagged `[writer]` and passes one
 *   short mkdir lock; a REAL four-process fan-out proves the seq stream stays
 *   gapless and strictly increasing under true concurrency (the Python twin
 *   of the same protocol is proven by m-note's build-watchdog-test.py).
 * ② monotonic seq — contiguous 1..N on a fresh stream, unique under the fan-out,
 *   and CONTINUOUS ACROSS ROTATION (the sidecar keeps counting, so a rotated
 *   window is a visible seq jump, never a silent restart).
 * ③ heartbeat — lives in scripts/auto-build-exec.spec.ts (the executor owns the
 *   execution period; the journal only has to carry whatever line it writes).
 * ④ loud degradation — an unwritable main face shouts through `warn` AND lands
 *   the line on the independent fallback face; it never disappears quietly.
 * ⑤ single-line atomic append — embedded newlines fold; one append = one line.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  AUTO_BUILD_JOURNAL_FALLBACK_FILE,
  AUTO_BUILD_JOURNAL_LOCK_DIR,
  AUTO_BUILD_JOURNAL_SEQ_FILE,
  defaultAutoBuildJournalLine,
} from '../src/auto-build-journal.ts'

const JOURNAL_FILE = 'auto-build.log'
const TSX_CLI = fileURLToPath(new URL('../../../../node_modules/tsx/dist/cli.mjs', import.meta.url))
const WRITER_FIXTURE = fileURLToPath(new URL('./fixtures/journal-writer.host.ts', import.meta.url))

/** A throwaway tree whose `.dsh-build` is the only face we touch. */
function tempTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'auto-build-journal-'))
  onTestFinished(() => {
    // Rotation leftovers (.old) live beside the file, still under root.
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

function journalPath(root: string): string {
  return join(root, '.dsh-build', JOURNAL_FILE)
}

function readLines(root: string): string[] {
  const path = journalPath(root)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '')
}

function seqOf(line: string): number {
  const match = / seq=(\d+)$/.exec(line)
  expect(match, `line lacks a trailing seq: ${line}`).not.toBeNull()
  return Number(match?.[1])
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('auto-build journal seq protocol (⑤ ①②⑤)', () => {
  it('tags every line with its writer and appends a trailing seq (①② format)', () => {
    const root = tempTree()
    const host = defaultAutoBuildJournalLine(root, { writer: 'host' })
    const exec = defaultAutoBuildJournalLine(root, { writer: 'exec' })
    host('kick state=NEED_BUILD')
    exec('dispatch reason=need-build cmd=pnpm run build')
    const lines = readLines(root)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+Z \[host\] kick state=NEED_BUILD seq=1$/)
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+Z \[exec\] dispatch reason=need-build cmd=pnpm run build seq=2$/)
  })

  it('hands out strictly increasing unique seq across two sinks in one stream (②)', () => {
    const root = tempTree()
    const a = defaultAutoBuildJournalLine(root, { writer: 'host' })
    const b = defaultAutoBuildJournalLine(root, { writer: 'watchdog' })
    for (let index = 0; index < 20; index += 1) {
      a(`host-line ${String(index)}`)
      b(`watchdog-line ${String(index)}`)
    }
    const seqs = readLines(root).map(seqOf)
    expect(seqs).toEqual(Array.from({ length: 40 }, (_, index) => index + 1))
  })

  it('keeps seq continuous across rotation — a rotated window is a visible jump, not a reset (②)', () => {
    const root = tempTree()
    const stamp = join(root, '.dsh-build')
    mkdirSync(stamp, { recursive: true })
    // Stream already at 999 + an oversized body owed for rotation.
    writeFileSync(join(stamp, AUTO_BUILD_JOURNAL_SEQ_FILE), '999', 'utf8')
    writeFileSync(join(stamp, JOURNAL_FILE), `${'x'.repeat(512 * 1024 + 64)}\n`, 'utf8')
    const sink = defaultAutoBuildJournalLine(root, { writer: 'exec' })
    sink('post-rotation line')
    expect(existsSync(`${journalPath(root)}.old`)).toBe(true)
    const lines = readLines(root)
    expect(lines).toHaveLength(1)
    expect(seqOf(lines[0] ?? '')).toBe(1000)
    // The rotated-away body still exists on the .old face: no line was silently
    // dressed up as never-happened.
    expect(statSync(`${journalPath(root)}.old`).size).toBeGreaterThan(512 * 1024)
  })

  it('folds embedded newlines so one append is exactly one physical line (⑤)', () => {
    const root = tempTree()
    const sink = defaultAutoBuildJournalLine(root, { writer: 'exec' })
    sink('build-failed exit=7\nmulti\nline\npayload')
    const raw = readFileSync(journalPath(root), 'utf8')
    expect(raw.split('\n').filter(line => line.trim() !== '')).toHaveLength(1)
    expect(raw).toContain('build-failed exit=7 multi line payload')
  })

  it('leaves the lock directory free after every write (① critical section is short)', async () => {
    const root = tempTree()
    const sink = defaultAutoBuildJournalLine(root, { writer: 'host' })
    sink('one')
    await sink.flush()
    expect(existsSync(join(root, '.dsh-build', AUTO_BUILD_JOURNAL_LOCK_DIR))).toBe(false)
  })
})

describe('auto-build journal loud degradation (⑤ ④)', () => {
  it('shouts through warn and lands the line on the fallback face when the main face is unwritable', () => {
    // A FILE where the stamp directory must be: mkdir fails ENOTDIR — a real
    // write failure, not contention.
    const root = tempTree()
    const blocker = join(root, 'blocked')
    writeFileSync(blocker, 'not a directory', 'utf8')
    const warn = vi.fn<(message: string) => void>()
    const fallback = join(root, 'fallback.log')
    const sink = defaultAutoBuildJournalLine(join(blocker, 'tree'), { writer: 'exec', warn, fallbackPath: fallback })
    expect(() => { sink('judge-unavailable error=disk gone') }).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('main face write failed')
    expect(warn.mock.calls[0]?.[0]).toContain('judge-unavailable error=disk gone')
    const fallbackLines = readFileSync(fallback, 'utf8').split('\n').filter(line => line.trim() !== '')
    expect(fallbackLines).toHaveLength(1)
    expect(fallbackLines[0]).toContain('[exec] FALLBACK judge-unavailable error=disk gone')
  })

  it('flush still resolves on the degraded path — a loud failure never wedges the caller', async () => {
    const root = tempTree()
    const blocker = join(root, 'blocked')
    writeFileSync(blocker, 'not a directory', 'utf8')
    const sink = defaultAutoBuildJournalLine(join(blocker, 'tree'), {
      writer: 'host',
      warn: vi.fn(),
      fallbackPath: join(root, 'fallback.log'),
    })
    sink('any line')
    await expect(sink.flush()).resolves.toBeUndefined()
  })
})

describe('auto-build journal cross-process fan-out (① real concurrency)', () => {
  it('four real processes × N lines each = one gapless strictly increasing seq stream', async () => {
    const root = tempTree()
    const writers = ['host', 'watchdog', 'exec', 'collect']
    const perWriter = 25
    const runs = writers.map(writer => new Promise<number>((done, fail) => {
      const child = spawn(
        process.execPath,
        [TSX_CLI, WRITER_FIXTURE, root, writer, String(perWriter)],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.on('error', fail)
      child.on('close', (code) => {
        if (code === 0) done(0)
        else fail(new Error(`journal-writer ${writer} exited ${String(code)}: ${stderr}`))
      })
    }))
    await expect(Promise.all(runs)).resolves.toEqual([0, 0, 0, 0])
    const lines = readLines(root)
    expect(lines).toHaveLength(writers.length * perWriter)
    const seqs = lines.map(seqOf)
    // File order == lock order == seq order: strictly increasing, no gaps, no dups.
    expect(seqs).toEqual(Array.from({ length: writers.length * perWriter }, (_, index) => index + 1))
    // Every writer's tag survived the contention (归属明).
    for (const writer of writers) {
      expect(lines.filter(line => line.includes(`[${writer}]`))).toHaveLength(perWriter)
    }
    // The lock is free after the storm.
    expect(existsSync(join(root, '.dsh-build', AUTO_BUILD_JOURNAL_LOCK_DIR))).toBe(false)
    expect(existsSync(join(root, '.dsh-build', AUTO_BUILD_JOURNAL_SEQ_FILE))).toBe(true)
    expect(dirname(journalPath(root))).toBe(join(root, '.dsh-build'))
    expect(AUTO_BUILD_JOURNAL_FALLBACK_FILE).toBe('auto-build-fallback.log')
  }, 60_000)
})
