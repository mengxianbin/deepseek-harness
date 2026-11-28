/**
 * Death/exit audit lines (heavyio-silentdeath-1128 · 腿①死因留痕可审).
 *
 * Two layers: pure unit cases for the line grammar and the kill-audit
 * cross-reference matching, plus gate-integrated cases that prove a real run
 * leaves (a) a normal exit + release reason=正常收口 and (b) a stale-broken
 * holder leaves a `die` line with exit path + memory snapshot + the lock's
 * release reason=stale-break. History.log's own format is asserted in
 * heavy-io-gate.spec.ts and must stay untouched there (three pinned consumers).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { killAuditRef, memorySnapshot, recordDie } from './die-log.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const gateScript = fileURLToPath(new URL('./heavy-io-gate.ts', import.meta.url))
const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))

function scratch(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `die-log-spec-${name}-`)), 'die.log')
}

describe('die-log line grammar', () => {
  it('writes <ISO> <event> pid=<n> fields… cmd=<command> with cmd always last', () => {
    const file = scratch('grammar')
    try {
      recordDie({ DSH_HEAVY_IO_DIELOG: file }, 'exit', 'node -e "sleep 1"', { path: 'normal', exitCode: 0, freeMb: 100, floorMb: 50 })
      const line = readFileSync(file, 'utf8').trimEnd()
      expect(line).toMatch(
        /^\d{4}-\d{2}-\d{2}T[\d:.]+Z exit pid=\d+ path=normal exitCode=0 freeMb=100 floorMb=50 cmd=node -e "sleep 1"$/,
      )
      // cmd carries spaces; it must be the final field so parsers can take the tail.
      expect(line.indexOf('cmd=')).toBeGreaterThan(line.indexOf('freeMb=100'))
    } finally {
      rmSync(join(file, '..'), { recursive: true, force: true })
    }
  })

  it('sanitises newlines out of fields so one event stays one line', () => {
    const file = scratch('newline')
    try {
      recordDie({ DSH_HEAVY_IO_DIELOG: file }, 'die', 'cmd\nwith\nnewlines', { path: 'killed', reason: 'stale-break' })
      const text = readFileSync(file, 'utf8')
      expect(text.trimEnd().split('\n')).toHaveLength(1)
      expect(text).toContain('cmd=cmd with newlines')
    } finally {
      rmSync(join(file, '..'), { recursive: true, force: true })
    }
  })

  it('fails soft on an unwritable path and reports instead of throwing', () => {
    const blocker = join(tmpdir(), `die-log-spec-blocker-${process.pid}`)
    writeFileSync(blocker, 'not a directory')
    const stderrWrites: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    try {
      process.stderr.write = (chunk: string | Uint8Array) => {
        stderrWrites.push(String(chunk))
        return true
      }
      expect(() => {
        recordDie({ DSH_HEAVY_IO_DIELOG: join(blocker, 'die.log') }, 'exit', 'x', {})
      }).not.toThrow()
      expect(stderrWrites.join('')).toContain('die-log: write failed (exit)')
    } finally {
      process.stderr.write = original
      rmSync(blocker, { force: true })
    }
  })

  it('derives the floor line like the gate (10% total, env override wins)', () => {
    expect(memorySnapshot({})).toEqual(memorySnapshot({}))
    const overridden = memorySnapshot({ DSH_HEAVY_IO_FLOOR_MB: '1234' })
    expect(overridden.floorMb).toBe(1234)
    expect(overridden.freeMb).toBeGreaterThan(0)
  })
})

describe('kill-audit cross-reference', () => {
  const windowStart = Date.parse('2026-11-28T02:00:00+08:00')
  const windowEnd = Date.parse('2026-11-28T03:00:00+08:00')

  function auditFile(name: string, rows: unknown[]): string {
    const dir = mkdtempSync(join(tmpdir(), `die-log-spec-audit-${name}-`))
    const file = join(dir, 'kill-audit.log')
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    return file
  }

  it('prefers an exact-pid row over a newer unrelated kill in the same window', () => {
    const file = auditFile('pid-priority', [
      // Newer, but a different target (orphan-reaper noise inside the window).
      { ts: '2026-11-28T02:50:00+08:00', actor: 'orphan-reaper', pid: 111, outcome: 'killed', detail: 'embedding-oc' },
      // Older, but THE holder kill.
      { ts: '2026-11-28T02:10:00+08:00', actor: 'build-watchdog', pid: 4242, outcome: 'killed', detail: 'tier-hard family=typecheck tOp=129s tHard=258s' },
    ])
    try {
      const ref = killAuditRef({ DSH_KILL_AUDIT_LOG: file }, windowStart, windowEnd, [4242])
      expect(ref.killedBy).toBe('build-watchdog')
      expect(ref.killPid).toBe(4242)
      expect(ref.killMatch).toBe('pid')
      expect(ref.killTier).toBe('tier-hard')
      expect(ref.killDetail).toContain('tHard=258s')
    } finally {
      rmSync(join(file, '..'), { recursive: true, force: true })
    }
  })

  it('falls back to the newest window row when no pid matches, marked killMatch=window', () => {
    const file = auditFile('window-fallback', [
      { ts: '2026-11-28T02:10:00+08:00', actor: 'build-watchdog', pid: 7, outcome: 'killed', detail: 'floor-tier' },
      { ts: '2026-11-28T02:40:00+08:00', actor: 'build-watchdog', pid: 9, outcome: 'killed', detail: 'floor-tier' },
    ])
    try {
      const ref = killAuditRef({ DSH_KILL_AUDIT_LOG: file }, windowStart, windowEnd, [4242])
      expect(ref.killPid).toBe(9)
      expect(ref.killMatch).toBe('window')
      expect(ref.killTier).toBe('floor-tier')
    } finally {
      rmSync(join(file, '..'), { recursive: true, force: true })
    }
  })

  it('ignores rows outside the holder lifetime window and non-killed outcomes', () => {
    const file = auditFile('bounds', [
      { ts: '2026-11-28T01:00:00+08:00', actor: 'build-watchdog', pid: 4242, outcome: 'killed', detail: 'tier-hard' },
      { ts: '2026-11-28T04:00:00+08:00', actor: 'build-watchdog', pid: 4242, outcome: 'killed', detail: 'tier-hard' },
      { ts: '2026-11-28T02:30:00+08:00', actor: 'build-watchdog', pid: 4242, outcome: 'kill-failed', detail: 'tier-hard' },
    ])
    try {
      expect(killAuditRef({ DSH_KILL_AUDIT_LOG: file }, windowStart, windowEnd, [4242])).toEqual({})
    } finally {
      rmSync(join(file, '..'), { recursive: true, force: true })
    }
  })

  it('returns {} for a missing audit file (fail-soft: never suppress the death)', () => {
    expect(killAuditRef({ DSH_KILL_AUDIT_LOG: join(tmpdir(), 'die-log-spec-no-such-audit.log') }, windowStart, windowEnd)).toEqual({})
  })
})

describe('gate-integrated death lines', () => {
  function runGate(args: readonly string[], env: Record<string, string>) {
    return spawnSync(process.execPath, [tsxCli, gateScript, ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NO_COLOR: '1',
        CI: 'false',
        DSH_HEAVY_IO_HELD: '',
        DSH_HEAVY_IO_FLOOR_MB: '0',
        DSH_FULLCHECK_TICKET: join(tmpdir(), 'die-log-spec-no-ticket.json'),
        ...env,
      },
    })
  }

  it('a normal run leaves exit path=normal and release reason=正常收口', () => {
    const dir = mkdtempSync(join(tmpdir(), 'die-log-spec-normal-'))
    const lock = join(dir, 'lock')
    const history = join(dir, 'history.log')
    const die = join(dir, 'die.log')
    try {
      const result = runGate(['node -e "process.stdout.write(\'ok\')"'], {
        DSH_HEAVY_IO_LOCK_DIR: lock,
        DSH_HEAVY_IO_HISTORY: history,
        DSH_HEAVY_IO_DIELOG: die,
        DSH_KILL_AUDIT_LOG: join(dir, 'no-audit.log'),
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      const lines = readFileSync(die, 'utf8').trimEnd().split('\n')
      const exitLine = lines.find(line => line.includes(' exit pid='))
      expect(exitLine).toMatch(/ exit pid=\d+ path=normal exitCode=0 freeMb=\d+ floorMb=0 cmd=node -e /)
      const releaseLine = lines.find(line => line.includes(' release pid='))
      expect(releaseLine).toMatch(/ release pid=\d+ heldMs=\d+ reason=正常收口 freeMb=\d+ floorMb=0 cmd=node -e /)
      // The frozen history grammar must be byte-identical in shape: no reason leaked in.
      expect(readFileSync(history, 'utf8')).toMatch(/ release pid=\d+ heldMs=\d+ cmd=node -e /)
      expect(readFileSync(history, 'utf8')).not.toContain('reason=')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)

  it('a dead holder is answered with a die line (path + snapshot + kill-audit ref) and release reason=stale-break', () => {
    const dir = mkdtempSync(join(tmpdir(), 'die-log-spec-stale-'))
    const lock = join(dir, 'lock')
    const history = join(dir, 'history.log')
    const die = join(dir, 'die.log')
    const audit = join(dir, 'kill-audit.log')
    const deadPid = 2_147_480_001
    try {
      // Dead holder + a kill-audit row that names its killer inside its lifetime.
      mkdirSync(lock)
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({
        pid: deadPid,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        command: 'pnpm run typecheck',
      }))
      writeFileSync(audit, JSON.stringify({
        ts: new Date().toISOString(),
        actor: 'build-watchdog',
        pid: deadPid,
        outcome: 'killed',
        detail: 'tier-hard family=typecheck tOp=129s tHard=258s',
      }) + '\n')
      const result = runGate(['node -e "process.stdout.write(\'recovered\')"'], {
        DSH_HEAVY_IO_LOCK_DIR: lock,
        DSH_HEAVY_IO_HISTORY: history,
        DSH_HEAVY_IO_DIELOG: die,
        DSH_KILL_AUDIT_LOG: audit,
        DSH_HEAVY_IO_POLL_MS: '100',
        DSH_HEAVY_IO_WAIT_MS: '2000',
        DSH_HEAVY_IO_STALE_MS: '60000',
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)

      const lines = readFileSync(die, 'utf8').trimEnd().split('\n')
      const dieLine = lines.find(line => line.includes(' die pid='))
      expect(dieLine).toBeDefined()
      expect(dieLine).toContain('path=killed')
      expect(dieLine).toContain('reason=stale-break')
      expect(dieLine).toContain(`holderPid=${deadPid}`)
      expect(dieLine).toMatch(/ freeMb=\d+ floorMb=0 /)
      expect(dieLine).toContain('snapshotAt=discovery')
      expect(dieLine).toContain('killedBy=build-watchdog')
      expect(dieLine).toContain('killTier=tier-hard')
      expect(dieLine).toContain('killMatch=pid')
      expect(dieLine).toContain('cmd=pnpm run typecheck')

      // The broken lock is also answered with a release line carrying the reason.
      const releaseLine = lines.find(line => line.includes(' release pid=') && line.includes('reason=stale-break'))
      expect(releaseLine).toBeDefined()
      expect(releaseLine).toContain(`holderPid=${deadPid}`)
      expect(releaseLine).toContain('cmd=pnpm run typecheck')

      // history.log keeps its frozen three-consumer grammar (stale-break shape
      // asserted in heavy-io-gate.spec.ts too) and gains no reason field.
      const historyText = readFileSync(history, 'utf8')
      expect(historyText).toMatch(new RegExp(` stale-break pid=\\d+ holderPid=${deadPid} holderAgeMs=\\d+ holderAlive=false cmd=`))
      expect(historyText).not.toContain('reason=')

      // And the recovered run itself still lands the normal closeout.
      expect(lines.some(line => line.includes(' release pid=') && line.includes('reason=正常收口'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)
})
