/**
 * Build-start marker liveness (O-1103, orphan start-marker recovery): the
 * probe's branch table — absent / unreadable / live pid / dead pid /
 * start-time trust bound (the Windows pid-reuse guard) — and the recovery
 * read that clears an orphan with its journal line while leaving a live
 * build's marker untouched (a live build must never be misjudged: clearing
 * blind would let a second build stomp the first).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUILD_START_TRUST_BOUND_MS,
  isProcessAlive,
  probeBuildStartCapture,
  readBuildingCapture,
} from '../src/build-start-liveness.ts'

/** Provably unused pid on Windows, mirroring scripts/heavy-io-gate.spec.ts. */
const DEAD_PID = 2_147_480_000

const temporary: string[] = []

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-build-liveness-'))
  temporary.push(root)
  return root
}

function capturePath(root: string): string {
  return join(root, '.dsh-build', 'restart-stamp.start.json')
}

function journalPath(root: string): string {
  return join(root, '.dsh-build', 'auto-build.log')
}

function writeCapture(root: string, body: unknown): void {
  mkdirSync(join(root, '.dsh-build'), { recursive: true })
  writeFileSync(capturePath(root), typeof body === 'string' ? body : JSON.stringify(body))
}

/** A well-formed start capture with the given time and optional pid. */
function marker(time: string, pid?: number): Record<string, unknown> {
  return {
    version: 1,
    kind: 'harness-start',
    time,
    ...(pid === undefined ? {} : { pid }),
    faces: ['host'],
    sStart: { repo: 'r', host: 'h', client: 'c' },
  }
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('isProcessAlive (mirrors scripts/heavy-io-gate.ts)', () => {
  it('reads this process as alive and a provably absent pid as dead', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(DEAD_PID)).toBe(false)
  })
})

describe('probeBuildStartCapture', () => {
  it('reports absent when no marker exists', () => {
    expect(probeBuildStartCapture(tree())).toEqual({ state: 'absent' })
  })

  it('reads a fresh marker whose pid is alive as building', () => {
    const root = tree()
    const time = new Date().toISOString()
    writeCapture(root, marker(time, process.pid))
    expect(probeBuildStartCapture(root)).toEqual({ state: 'building', startedAt: time })
  })

  it('reads a fresh marker whose pid is dead as an orphan (process-dead)', () => {
    const root = tree()
    const time = new Date().toISOString()
    writeCapture(root, marker(time, DEAD_PID))
    const probe = probeBuildStartCapture(root)
    expect(probe).toMatchObject({ state: 'orphan', pid: DEAD_PID, reason: 'process-dead' })
    if (probe.state === 'orphan') expect(probe.ageMs).toBeGreaterThanOrEqual(0)
  })

  it('reads a pid-less legacy marker inside the bound as building (conservative fallback)', () => {
    const root = tree()
    writeCapture(root, marker(new Date().toISOString()))
    expect(probeBuildStartCapture(root).state).toBe('building')
  })

  it('treats any marker past the start-time trust bound as an orphan even when its pid is alive (pid-reuse guard)', () => {
    const root = tree()
    const time = '2026-11-01T00:00:00.000Z'
    writeCapture(root, marker(time, process.pid))
    const startedAtMs = Date.parse(time)
    // One millisecond inside the bound: still building (the pid is alive).
    expect(probeBuildStartCapture(root, startedAtMs + BUILD_START_TRUST_BOUND_MS - 1).state).toBe('building')
    // Exactly at the bound: orphan, reason = the bound (not the pid), pid still reported.
    const atBound = probeBuildStartCapture(root, startedAtMs + BUILD_START_TRUST_BOUND_MS)
    expect(atBound).toMatchObject({ state: 'orphan', pid: process.pid, reason: 'trust-bound-exceeded' })
    // A pid-less legacy marker past the bound is an orphan too.
    writeCapture(root, marker(time))
    expect(probeBuildStartCapture(root, startedAtMs + BUILD_START_TRUST_BOUND_MS)).toMatchObject({
      state: 'orphan',
      pid: undefined,
      reason: 'trust-bound-exceeded',
    })
  })

  it.each([
    ['malformed JSON', '{'],
    ['a non-object body', '[]'],
    ['a missing time', JSON.stringify({ version: 1, kind: 'harness-start', pid: process.pid })],
    ['an unreadable time', JSON.stringify({ version: 1, kind: 'harness-start', time: 'yesterday', pid: process.pid })],
  ])('keeps the old existence semantics (building) on %s — an unjudgeable marker is never cleared', (_label, body) => {
    const root = tree()
    writeCapture(root, body)
    expect(probeBuildStartCapture(root)).toEqual({ state: 'building' })
    expect(readBuildingCapture(root)).toBe(true)
    expect(existsSync(capturePath(root))).toBe(true)
    expect(existsSync(journalPath(root))).toBe(false)
  })
})

describe('readBuildingCapture', () => {
  it('leaves a live build alone: still building, marker untouched, no journal line', () => {
    const root = tree()
    writeCapture(root, marker(new Date().toISOString(), process.pid))
    expect(readBuildingCapture(root)).toBe(true)
    expect(existsSync(capturePath(root))).toBe(true)
    expect(existsSync(journalPath(root))).toBe(false)
  })

  it('clears an orphan marker whose pid is dead and journals one recovery line (acceptance ④)', () => {
    const root = tree()
    writeCapture(root, marker(new Date().toISOString(), DEAD_PID))
    expect(readBuildingCapture(root)).toBe(false)
    expect(existsSync(capturePath(root))).toBe(false)
    const journal = readFileSync(journalPath(root), 'utf8')
    expect(journal).toContain('orphan-start-marker-cleared')
    expect(journal).toContain(`pid=${String(DEAD_PID)}`)
    expect(journal).toContain('reason=process-dead')
  })

  it('clears a past-bound marker with the bound reason, even with a live pid', () => {
    const root = tree()
    writeCapture(root, marker(new Date(Date.now() - BUILD_START_TRUST_BOUND_MS - 60_000).toISOString(), process.pid))
    expect(readBuildingCapture(root)).toBe(false)
    expect(existsSync(capturePath(root))).toBe(false)
    expect(readFileSync(journalPath(root), 'utf8')).toContain('reason=trust-bound-exceeded')
  })

  it('reports not building without creating a journal when the marker is absent', () => {
    const root = tree()
    expect(readBuildingCapture(root)).toBe(false)
    expect(existsSync(journalPath(root))).toBe(false)
  })
})
