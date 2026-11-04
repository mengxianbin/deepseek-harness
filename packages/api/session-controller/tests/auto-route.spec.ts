/**
 * The auto-route poll ledger read (2026-11-04 ruling: sustained meter-poll
 * failure reddens the 安康盾, transient misses never do). The pure fold's
 * threshold math and streak semantics, plus the fail-open file read: a
 * missing / unreadable / stale ledger DETACHES the optional plane (the
 * inverse of duty's fail-closed — see auto-route.ts module doc).
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUTO_ROUTE_POLL_FILE,
  AUTO_ROUTE_SUSTAINED_MS,
  AUTO_ROUTE_STALE_MS,
  foldAutoRoutePoll,
  readAutoRoutePoll,
} from '../src/auto-route.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One temp DSH-home-shaped dir holding a ledger the reader can be pointed at. */
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-route-poll-'))
  tempDirs.push(dir)
  return dir
}

const NOW = 1_700_000_000_000

describe('foldAutoRoutePoll (facts in, alarm verdict out)', () => {
  it('a fresh ok ledger reads ok with no streak fields', () => {
    const report = foldAutoRoutePoll({ at: NOW - 45_000, ok: true }, 40_000, NOW)
    expect(report).toEqual({ ok: true, sustained: false, ageSec: 40 })
  })

  it('a fresh miss inside the threshold reads transient (never sustained)', () => {
    const report = foldAutoRoutePoll(
      { at: NOW - 10_000, ok: false, error: 'fetch failed', failingSince: NOW - 90_000 },
      10_000,
      NOW,
    )
    expect(report).toEqual({
      ok: false,
      failingSince: NOW - 90_000,
      failingForSec: 90,
      sustained: false,
      error: 'fetch failed',
      ageSec: 10,
    })
  })

  it('a streak crossing the threshold reads sustained (the shield\'s only red trigger)', () => {
    const since = NOW - AUTO_ROUTE_SUSTAINED_MS
    const report = foldAutoRoutePoll({ at: NOW - 5_000, ok: false, error: 'ECONNREFUSED', failingSince: since }, 5_000, NOW)
    expect(report?.sustained).toBe(true)
    expect(report?.failingForSec).toBe(300)
    // One millisecond short stays transient — the boundary is exact.
    const short = foldAutoRoutePoll({ at: NOW, ok: false, failingSince: NOW - AUTO_ROUTE_SUSTAINED_MS + 1 }, 0, NOW)
    expect(short?.sustained).toBe(false)
  })

  it('a failing writer without failingSince (version skew) reads transient forever, never false-red', () => {
    const report = foldAutoRoutePoll({ at: NOW, ok: false, error: 'old writer' }, 0, NOW)
    expect(report).toEqual({ ok: false, sustained: false, error: 'old writer', ageSec: 0 })
    expect(report?.failingSince).toBeUndefined()
    expect(report?.sustained).toBe(false)
  })

  it('a streak never computes a negative age from clock skew', () => {
    const report = foldAutoRoutePoll({ at: NOW, ok: false, failingSince: NOW + 60_000 }, 0, NOW)
    expect(report?.failingForSec).toBe(0)
    expect(report?.sustained).toBe(false)
  })

  it('a shape-invalid document detaches (undefined), never guesses a verdict', () => {
    expect(foldAutoRoutePoll({ ok: 'yes' }, 0, NOW)).toBeUndefined()
    expect(foldAutoRoutePoll(null, 0, NOW)).toBeUndefined()
    expect(foldAutoRoutePoll('not a ledger', 0, NOW)).toBeUndefined()
  })

  it('an empty error string is dropped from the wire payload', () => {
    expect(foldAutoRoutePoll({ at: NOW, ok: false, error: '' }, 0, NOW)).toEqual({
      ok: false,
      sustained: false,
      ageSec: 0,
    })
  })
})

describe('readAutoRoutePoll (fail-open file read — optional plane)', () => {
  it('reads a ledger the writer stamped (streak age from the current time)', () => {
    const dir = stateDir()
    const path = join(dir, AUTO_ROUTE_POLL_FILE)
    writeFileSync(path, JSON.stringify({ at: NOW - 5_000, ok: false, error: 'boom', failingSince: NOW - 400_000 }))
    const report = readAutoRoutePoll(NOW, path)
    expect(report).toMatchObject({ ok: false, sustained: true, error: 'boom', ageSec: 0 })
  })

  it('detaches on a missing ledger (plugin not installed / disabled)', () => {
    expect(readAutoRoutePoll(NOW, join(stateDir(), AUTO_ROUTE_POLL_FILE))).toBeUndefined()
  })

  it('detaches on a stale ledger (writer stopped — never grows an eternal streak)', () => {
    const dir = stateDir()
    const path = join(dir, AUTO_ROUTE_POLL_FILE)
    writeFileSync(path, JSON.stringify({ at: 0, ok: false, failingSince: 0 }))
    const stale = new Date(NOW - AUTO_ROUTE_STALE_MS - 1_000)
    utimesSync(path, stale, stale)
    expect(readAutoRoutePoll(NOW, path)).toBeUndefined()
    // Exactly at the bound still speaks (the bound is inclusive).
    const fresh = new Date(NOW - AUTO_ROUTE_STALE_MS)
    utimesSync(path, fresh, fresh)
    expect(readAutoRoutePoll(NOW, path)).toMatchObject({ ok: false })
  })

  it('detaches on an unparseable ledger (a broken writer is a stopped writer)', () => {
    const dir = stateDir()
    const path = join(dir, AUTO_ROUTE_POLL_FILE)
    writeFileSync(path, '{not json')
    expect(readAutoRoutePoll(NOW, path)).toBeUndefined()
  })
})
