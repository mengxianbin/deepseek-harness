/**
 * The repair-signal ledger read (三态账 + 盾挂, segment 4): the m-note side
 * publishes `<dsh-home>/repair-signal-ledger.json` and this side folds its
 * three signal-repair counters at READ time. The queue-timeout demotion is
 * the point of the suite — a `queued` signal ≥30 min old reads 无人管 without
 * any writer state and without any new timer (the existing 15s sweep tick is
 * the only clock), and a missing / unparseable document detaches to
 * 「未接线」, never broken (optional-plane pattern, like revive-health).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  QUEUE_TIMEOUT_MS,
  REPAIR_SIGNAL_LEDGER_FILE,
  foldRepairSignals,
  readRepairSignals,
} from '../src/repair-signals.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One temp DSH-home-shaped dir holding a ledger the reader can be pointed at. */
function ledgerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repair-signals-'))
  tempDirs.push(dir)
  return dir
}

/** Fixed fold clock (epoch ms); every fixture timestamp derives from it. */
const NOW = Date.parse('2026-11-25T03:00:00+08:00')

/** Minutes before NOW as an ISO-8601 timestamp with offset (writer format). */
function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString()
}

/** The contract's two-signal example plus one fresh repair: 1 repairing, 1 queued, 0 unmanaged. */
const FRESH = {
  version: 1,
  updatedAt: minutesAgo(0),
  signals: [
    {
      id: 'sig-1',
      source: 'watchdog:linked-drift',
      taskRef: 'content/tech/ai/dsh/tasks.md#repair-auto-x',
      state: 'repairing',
      sessionId: 'session-abc',
      progress: '.wt/x/.tmp/progress.md',
      queuePos: null,
      enqueuedAt: null,
      firstSeen: minutesAgo(60),
      lastSeen: minutesAgo(0),
      alarm: 'linked-drift repo=dsh-web',
    },
    {
      id: 'sig-2',
      source: 'watchdog:kick-failed',
      taskRef: null,
      state: 'queued',
      sessionId: null,
      progress: null,
      queuePos: 1,
      enqueuedAt: minutesAgo(5),
      firstSeen: minutesAgo(5),
      lastSeen: minutesAgo(5),
      alarm: 'kick-failed error=...',
    },
  ],
}

describe('foldRepairSignals (facts in, three counters + oldest age out)', () => {
  it('counts the contract example: repairing, fresh queued, oldest firstSeen floored to minutes', () => {
    expect(foldRepairSignals(FRESH, NOW)).toEqual({
      repairing: 1,
      queued: 1,
      unmanaged: 0,
      oldestMin: 60,
    })
  })

  it('a queued signal inside the 30-minute window stays queued', () => {
    expect(QUEUE_TIMEOUT_MS).toBe(30 * 60_000)
    const atBoundary = foldRepairSignals(
      { signals: [{ state: 'queued', enqueuedAt: minutesAgo(29), firstSeen: minutesAgo(29) }] },
      NOW,
    )
    expect(atBoundary).toMatchObject({ queued: 1, unmanaged: 0 })
  })

  it('demotes a queued signal AT/over the timeout to unmanaged at read time (超时无人动, no timer)', () => {
    const justOver = foldRepairSignals(
      { signals: [{ state: 'queued', enqueuedAt: minutesAgo(30), firstSeen: minutesAgo(30) }] },
      NOW,
    )
    expect(justOver).toMatchObject({ queued: 0, unmanaged: 1 })
    const longOver = foldRepairSignals(
      { signals: [{ state: 'queued', enqueuedAt: minutesAgo(120), firstSeen: minutesAgo(120) }] },
      NOW,
    )
    expect(longOver).toMatchObject({ queued: 0, unmanaged: 1 })
  })

  it('counts an explicit unmanaged signal as unmanaged', () => {
    expect(foldRepairSignals({ signals: [{ state: 'unmanaged', firstSeen: minutesAgo(3) }] }, NOW))
      .toMatchObject({ repairing: 0, queued: 0, unmanaged: 1 })
  })

  it('an empty signal list folds to all-zero counters (oldestMin 0 with no signals)', () => {
    expect(foldRepairSignals({ signals: [] }, NOW)).toEqual({
      repairing: 0,
      queued: 0,
      unmanaged: 0,
      oldestMin: 0,
    })
  })

  it('a shape-invalid document detaches (undefined), never guesses a count', () => {
    expect(foldRepairSignals({ version: 1 }, NOW)).toBeUndefined()
    expect(foldRepairSignals({ signals: 'none' }, NOW)).toBeUndefined()
    expect(foldRepairSignals(null, NOW)).toBeUndefined()
    expect(foldRepairSignals('not a document', NOW)).toBeUndefined()
  })
})

describe('readRepairSignals (presence/parse — read-time demotion, no mtime)', () => {
  it('reads a ledger the m-note writer published and folds the four numbers', () => {
    const path = join(ledgerDir(), REPAIR_SIGNAL_LEDGER_FILE)
    writeFileSync(path, JSON.stringify(FRESH))
    expect(readRepairSignals(NOW, path)).toEqual({
      repairing: 1,
      queued: 1,
      unmanaged: 0,
      oldestMin: 60,
    })
  })

  it('folds a timed-out queued signal into unmanaged on the read (the timeout case needs no writer)', () => {
    const path = join(ledgerDir(), REPAIR_SIGNAL_LEDGER_FILE)
    writeFileSync(path, JSON.stringify({
      version: 1,
      signals: [
        { id: 'a', state: 'queued', enqueuedAt: minutesAgo(45), firstSeen: minutesAgo(45) },
        { id: 'b', state: 'unmanaged', firstSeen: minutesAgo(90) },
      ],
    }))
    expect(readRepairSignals(NOW, path)).toEqual({
      repairing: 0,
      queued: 0,
      unmanaged: 2,
      oldestMin: 90,
    })
  })

  it('detaches on a missing ledger (writer not wired) — 未接线, never broken', () => {
    expect(readRepairSignals(NOW, join(ledgerDir(), REPAIR_SIGNAL_LEDGER_FILE))).toBeUndefined()
  })

  it('detaches on an unparseable ledger (a writer that cannot write a document cannot be audited)', () => {
    const path = join(ledgerDir(), REPAIR_SIGNAL_LEDGER_FILE)
    writeFileSync(path, '{not json')
    expect(readRepairSignals(NOW, path)).toBeUndefined()
  })

  it('detaches when `signals` is not an array (shape-invalid, same quiet detach)', () => {
    const path = join(ledgerDir(), REPAIR_SIGNAL_LEDGER_FILE)
    writeFileSync(path, JSON.stringify({ version: 1, signals: { bad: true } }))
    expect(readRepairSignals(NOW, path)).toBeUndefined()
  })
})
