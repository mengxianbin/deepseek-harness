/**
 * The revive mechanism-health read (拍板⑭⑮, ruled 2026-11-15: the shield
 * reports revive mechanism health ONLY, 正常静默、异常才亮). The pure fold's
 * fact-token derivation plus the presence/parse file read — and the deliberate
 * NO-mtime rule that separates this change-only writer from auto-route's
 * per-tick ledger: an old stamp is still the current truth (see revive-health.ts
 * module doc), while a missing document detaches to 「未接线」, never broken.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REVIVE_HEALTH_FILE, foldReviveHealth, readReviveHealth } from '../src/revive-health.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One temp DSH-home-shaped dir holding a document the reader can be pointed at. */
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revive-health-'))
  tempDirs.push(dir)
  return dir
}

const NOW = 1_700_000_000_000

/** The writer's healthy five-fact bundle (dsh-web health-state.ts shape). */
const HEALTHY = {
  at: NOW - 1_000,
  active: true,
  mode: 'live',
  status: 'ok',
  breakerTrips: 0,
  breakerOk: true,
  halted: false,
  ok: true,
}

describe('foldReviveHealth (facts in, verdict + red tokens out)', () => {
  it('a healthy bundle echoes the facts with zero red tokens (正常静默)', () => {
    expect(foldReviveHealth(HEALTHY)).toEqual({
      ok: true,
      mode: 'live',
      status: 'ok',
      breakerTrips: 0,
      halted: false,
      failed: [],
      at: NOW - 1_000,
    })
  })

  it('each red fact derives its own raw token (拍板⑮ five conditions)', () => {
    expect(foldReviveHealth({ ...HEALTHY, ok: false, mode: 'shadow' })?.failed).toEqual(['mode'])
    expect(foldReviveHealth({ ...HEALTHY, ok: false, status: 'error' })?.failed).toEqual(['status'])
    expect(foldReviveHealth({ ...HEALTHY, ok: false, breakerOk: false, breakerTrips: 3 })?.failed).toEqual(['breaker'])
    expect(foldReviveHealth({ ...HEALTHY, ok: false, halted: true })?.failed).toEqual(['halted'])
    expect(foldReviveHealth({ ...HEALTHY, ok: false, active: false })?.failed).toEqual(['active'])
  })

  it('a trip streak at the limit reddens the breaker token even without breakerOk (version skew)', () => {
    const { breakerOk: _omit, ...skew } = { ...HEALTHY, ok: false, breakerTrips: 3 }
    expect(foldReviveHealth(skew)?.failed).toEqual(['breaker'])
  })

  it('an unhealthy bundle with no red field still names one token (never an empty failure)', () => {
    expect(foldReviveHealth({ at: NOW, ok: false })?.failed).toEqual(['ok'])
  })

  it('a shape-invalid document detaches (undefined), never guesses a verdict', () => {
    expect(foldReviveHealth({ ok: 'yes' })).toBeUndefined()
    expect(foldReviveHealth(null)).toBeUndefined()
    expect(foldReviveHealth('not a document')).toBeUndefined()
    expect(foldReviveHealth({ mode: 'live' })).toBeUndefined()
  })
})

describe('readReviveHealth (presence/parse — change-only writer, no mtime)', () => {
  it('reads a document the plugin stamped', () => {
    const path = join(stateDir(), REVIVE_HEALTH_FILE)
    writeFileSync(path, JSON.stringify(HEALTHY))
    expect(readReviveHealth(path)).toMatchObject({ ok: true, mode: 'live', failed: [] })
  })

  it('never judges freshness: an ancient stamp is still the current truth (反 auto-route mtime)', () => {
    const path = join(stateDir(), REVIVE_HEALTH_FILE)
    writeFileSync(path, JSON.stringify({ ...HEALTHY, at: 0, ok: false, halted: true }))
    const ancient = new Date(NOW - 30 * 24 * 60 * 60 * 1000)
    utimesSync(path, ancient, ancient)
    expect(readReviveHealth(path)).toMatchObject({ ok: false, failed: ['halted'], at: 0 })
  })

  it('detaches on a missing document (plugin disabled / not yet flipped) — 未接线, never broken', () => {
    expect(readReviveHealth(join(stateDir(), REVIVE_HEALTH_FILE))).toBeUndefined()
  })

  it('detaches on an unparseable document (a writer that cannot write a document cannot be audited)', () => {
    const path = join(stateDir(), REVIVE_HEALTH_FILE)
    writeFileSync(path, '{not json')
    expect(readReviveHealth(path)).toBeUndefined()
  })
})
