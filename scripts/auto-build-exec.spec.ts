/**
 * Auto-build executor — the single-instance build executor of build-dispatch
 * ①⑤ (design: m-note `content/tech/ai/dsh/build-dispatch-exec-1113.md`).
 *
 * What this suite pins, in the task's own words:
 *
 * - **单实例（①）**: a second acquire on the same tree finds the kernel handle
 *   busy and the run exits directly WITHOUT re-judging (cold-start double-spawn
 *   cannot construct a second build); a KILLED holder releases the handle
 *   because the kernel owns it — no stale heuristic, no grace window.
 * - **重判（②④）**: the kick carries nothing — the executor re-reads the state
 *   machine's own collected judgment; a stale/absent state file is answered
 *   LOUD (`judge-unavailable`, exit 2), never with a guess.
 * - **stability window / INIT defenses / BUILD_FAILED cooldown** moved here
 *   verbatim from the old dispatcher (their old host suite lives on as the
 *   decision cases below).
 * - **failout**: fd capture (files, not pipes), tail folding onto ONE journal
 *   line, success silence for `build-failed` (plus the deliberate `build-done`
 *   audit line), captures removed either way.
 * - **heartbeat (⑤③)**: while the execution period is held, `heartbeat` lines
 *   keep landing — a silent window is then an observed silence.
 * - **linked leg account (① linked 腿随迁)**: pre-claim before the run,
 *   cooldown / stall suppression, the four lamp-readable journal texts
 *   verbatim (`linked-build repo=` / `-failed` / `-done` / `-stall`), and the
 *   cohort-failure loud path.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as realSpawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { defaultAutoBuildJournalLine } from '../packages/client/ui-settings-general/src/auto-build-journal.ts'
import {
  acquireSingleInstance,
  instanceNameFor,
  runAutoBuildExec,
  STDERR_CAPTURE_FILE,
  STDOUT_CAPTURE_FILE,
  type CapturedRun,
  type CohortEntry,
  type ExecChild,
} from './auto-build-exec.ts'
import type { RestartSignalFacts, RestartSignalJudgment } from '../packages/client/ui-settings-general/src/restart-signal.ts'
import type { RestartSignalState } from '../packages/client/ui-settings-general/src/restart.ts'

function facts(host: string, config = 'cfg', ownFaceMoved?: boolean): RestartSignalFacts {
  return { currentHostFace: host, configStamp: config, ...(ownFaceMoved === undefined ? {} : { ownFaceMoved }) }
}

function judgment(state: RestartSignalState, face?: string): RestartSignalJudgment {
  return { state, detail: 'fixture', ...(face === undefined ? {} : { facts: facts(face) }) }
}

/** A stub child that replays the two events the executor awaits. */
function stubChild(): ExecChild & { emitError(error: Error): void; emitClose(code: number | null): void } {
  const errorListeners: Array<(error: Error) => void> = []
  const closeListeners: Array<(code: number | null) => void> = []
  return {
    on: (event: 'error' | 'close', listener: never): void => {
      if (event === 'error') errorListeners.push(listener)
      else closeListeners.push(listener)
    },
    emitError: (error: Error): void => { for (const listener of errorListeners) listener(error) },
    emitClose: (code: number | null): void => { for (const listener of closeListeners) listener(code) },
  }
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}

async function waitFor(probe: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('waitFor: probe never became true')
    await new Promise<void>((done) => { setTimeout(done, 20) })
  }
}

const LINKED_BASE_TIME = '2026-11-01T00:00:00.000Z'
const LINKED_NEXT_TIME = '2026-11-13T00:00:00.000Z'
const OWN_REPO = 'D:/trees/harness'
const DRIFTED_REPO = 'D:/trees/dsh-web'
const BASE = '3'.repeat(64)
const CURR = '4'.repeat(64)

/** One executor over an observable journal, stub launcher and scriptable seams. */
function harness(overrides: Partial<Parameters<typeof runAutoBuildExec>[0]> = {}) {
  const root = overrides.repositoryRoot ?? tempRoot('auto-build-exec-')
  const lines: string[] = []
  const journal = vi.fn<(line: string) => void>((line) => { lines.push(line) })
  const say = vi.fn<(line: string) => void>()
  const warn = vi.fn<(line: string) => void>()
  const children: ReturnType<typeof stubChild>[] = []
  const launch = vi.fn((_command: string, _options: unknown) => {
    const child = stubChild()
    children.push(child)
    return child
  })
  const collect = vi.fn(async (): Promise<RestartSignalJudgment> => judgment('NEED_BUILD', 'h1'))
  const listCohort = vi.fn(async (): Promise<readonly CohortEntry[]> => [])
  const run = (extra: Partial<Parameters<typeof runAutoBuildExec>[0]> = {}): Promise<number> =>
    runAutoBuildExec({
      repositoryRoot: root,
      stampDirectory: join(root, '.dsh-build'),
      journal,
      say,
      warn,
      launch,
      collect,
      listCohort,
      stableMs: 0,
      heartbeatMs: 60_000,
      buildingMarker: () => false,
      ownBaseline: () => false,
      failedMarkerAgeMs: () => undefined,
      ...overrides,
      ...extra,
    })
  return { root, lines, journal, say, warn, children, launch, collect, listCohort, run }
}

/** The linked cohort fixture: own tree + a manifest-less tree + a matched tree
 * + the drifted one — mirrors `signal-cli --list-cohort` shape. */
function cohortFixture(): readonly CohortEntry[] {
  return [
    { repository: OWN_REPO, manifest: { sEnd: { host: BASE }, time: LINKED_BASE_TIME }, current: { host: BASE } },
    { repository: 'D:/trees/no-manifest', manifest: null, current: null },
    { repository: 'D:/trees/in-sync', manifest: { sEnd: { host: BASE }, time: LINKED_BASE_TIME }, current: { host: BASE } },
    { repository: DRIFTED_REPO, manifest: { sEnd: { host: BASE }, time: LINKED_BASE_TIME }, current: { host: CURR } },
  ]
}

/** Write a linked tree's manifest (the stall readings read the real file). */
function writeLinkedManifest(tree: string, time: string): void {
  mkdirSync(join(tree, '.dsh-build'), { recursive: true })
  writeFileSync(join(tree, '.dsh-build', 'restart-stamp.json'), JSON.stringify({
    version: 1, kind: 'dsh-web', time, midBuildDirty: false,
    sStart: { repo: 'r', host: BASE }, sEnd: { repo: 'r', host: BASE },
  }), 'utf8')
}

/** The linked tree the cohort names (created inside the throwaway root). */
function linkedTree(root: string): string {
  const tree = join(root, 'dsh-web')
  writeLinkedManifest(tree, LINKED_BASE_TIME)
  return tree
}

/** Cohort whose drifted row points at `tree` (the fixture tree under root). */
function cohortFor(root: string): readonly CohortEntry[] {
  const tree = linkedTree(root)
  return [
    { repository: root, manifest: { sEnd: { host: BASE }, time: LINKED_BASE_TIME }, current: { host: BASE } },
    { repository: tree, manifest: { sEnd: { host: BASE }, time: LINKED_BASE_TIME }, current: { host: CURR } },
  ]
}

function accountOf(root: string): Record<string, { outcome?: string; failures?: number; stall?: unknown }> {
  const path = join(root, '.dsh-build', 'linked-build-state.json')
  if (!existsSync(path)) return {}
  return (JSON.parse(readFileSync(path, 'utf8')) as { repos?: Record<string, { outcome?: string; failures?: number; stall?: unknown }> }).repos ?? {}
}

afterEach(() => {
  vi.restoreAllMocks()
})

/* ── ① single instance: the kernel handle ────────────────────────────────── */

describe('auto-build exec: single instance (① kernel handle)', () => {
  it('a second acquire on the same tree finds it busy; release hands it back', async () => {
    const root = tempRoot('auto-build-instance-')
    const lease = await acquireSingleInstance(root)
    expect(lease).toBeDefined()
    expect(await acquireSingleInstance(root)).toBeUndefined()
    await lease?.release()
    const reacquired = await acquireSingleInstance(root)
    expect(reacquired).toBeDefined()
    await reacquired?.release()
    expect(instanceNameFor(root)).toMatch(/^dsh-auto-build-exec-[0-9a-f]{12}$/)
    // Different trees never contend (per-tree naming).
    const other = tempRoot('auto-build-instance-')
    const otherLease = await acquireSingleInstance(other)
    expect(otherLease).toBeDefined()
    await otherLease?.release()
  })

  it('a KILLED holder releases the handle — the kernel owns it, no stale heuristic', async () => {
    const root = tempRoot('auto-build-instance-')
    const name = instanceNameFor(root)
    const path = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`)
    const holder = realSpawn(process.execPath, [
      '-e',
      'const net = require("node:net");'
      + 'const p = process.argv[1];'
      + 'const s = net.createServer(c => c.end());'
      + 's.on("error", e => { console.error("ERR " + String(e.code)); process.exit(3); });'
      + 's.listen(p, () => console.log("HOLDING"));'
      + 'setTimeout(() => process.exit(0), 60000);',
      path,
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    let held = ''
    holder.stdout?.on('data', (chunk: Buffer) => { held += chunk.toString('utf8') })
    onTestFinished(() => { try { holder.kill() } catch { /* already gone */ } })
    await waitFor(() => held.includes('HOLDING'))
    // While the holder lives, the executor backs off directly.
    expect(await acquireSingleInstance(root)).toBeUndefined()
    holder.kill()
    const deadline = Date.now() + 5_000
    let lease: Awaited<ReturnType<typeof acquireSingleInstance>>
    for (;;) {
      lease = await acquireSingleInstance(root)
      if (lease !== undefined) break
      if (Date.now() > deadline) throw new Error('kernel handle never came back after the holder died')
      await new Promise<void>((done) => { setTimeout(done, 50) })
    }
    expect(lease).toBeDefined()
    await lease.release()
  }, 20_000)

  it('a busy run exits directly: one journal line, ZERO re-judgment (机检③ 读数)', async () => {
    const h = harness({ acquireInstance: async () => undefined })
    await expect(h.run()).resolves.toBe(0)
    expect(h.collect).not.toHaveBeenCalled() // 直接退 — no second instance ever judges or builds.
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.lines.filter(line => line.startsWith('single-instance busy'))).toHaveLength(1)
    expect(h.lines[0]).toContain('another executor holds the execution period')
    expect(h.say.mock.calls[0]?.[0]).toContain('single-instance busy')
  })
})

/* ── ② re-judge: loud instead of guessing ────────────────────────────────── */

describe('auto-build exec: re-judgment (② ④)', () => {
  it('answers a stale/absent state file LOUD: judge-unavailable + exit 2', async () => {
    const h = harness({
      collect: async (): Promise<RestartSignalJudgment> => {
        throw new Error('restart-signal state file stale (age 612s > 90000ms) and no previous judgment')
      },
    })
    await expect(h.run()).resolves.toBe(2)
    expect(h.lines[0]).toContain('judge-unavailable error=')
    expect(h.say.mock.calls.at(-1)?.[0]).toContain('judge unavailable')
    expect(h.launch).not.toHaveBeenCalled()
  })
})

/* ── decisions that moved from the dispatcher (stability / INIT / cooldown) ── */

describe('auto-build exec: dispatch decisions (moved from the dispatcher)', () => {
  it('NEED_BUILD with the own face moved dispatches one gated build', async () => {
    const h = harness({ collect: async () => judgment('NEED_BUILD', 'h1') })
    const run = h.run()
    await waitFor(() => h.launch.mock.calls.length === 1)
    expect(h.launch.mock.calls[0]?.[0]).toBe('pnpm run build')
    h.children[0]?.emitClose(0)
    await expect(run).resolves.toBe(0)
    expect(h.lines).toHaveLength(2)
    expect(h.lines[0]).toBe('dispatch reason=need-build cmd=pnpm run build')
    expect(h.lines[1]).toContain('build-done exit=0 cmd=pnpm run build')
  })

  it('linked-only NEED_BUILD skips the own build and enters the per-tree leg', async () => {
    const h = harness({
      collect: async () => ({ ...judgment('NEED_BUILD', 'h1'), facts: facts('h1', 'cfg', false) }),
    })
    await expect(h.run()).resolves.toBe(0)
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.listCohort).toHaveBeenCalledTimes(1) // the leg ran (and found nothing owed here)
  })

  it('BUILDING defers: build in flight, nothing dispatched', async () => {
    const h = harness({ collect: async () => judgment('BUILDING') })
    await expect(h.run()).resolves.toBe(0)
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.lines[0]).toContain('defer state=BUILDING (build in flight)')
  })

  it.each([
    ['fresh failure marker', 60_000],
    ['failure marker just past cooldown', 600_001],
  ] as const)('BUILD_FAILED %s decides defer-then-retry correctly', async (_label, ageMs) => {
    const h = harness({
      collect: async () => judgment('BUILD_FAILED'),
      failedMarkerAgeMs: () => ageMs,
    })
    const run = h.run()
    if (ageMs < 600_000) {
      await expect(run).resolves.toBe(0)
      expect(h.launch).not.toHaveBeenCalled()
      expect(h.lines[0]).toMatch(/^defer state=BUILD_FAILED \(failure marker age \d+s < cooldown\)/)
      return
    }
    await waitFor(() => h.launch.mock.calls.length === 1)
    expect(h.launch.mock.calls[0]?.[0]).toBe('pnpm run build')
    h.children[0]?.emitClose(1)
    await expect(run).resolves.toBe(1)
    expect(h.lines[0]).toContain('dispatch reason=failed-retry')
  })

  it('INIT bootstraps one build when the tree is quiet and baseline-less', async () => {
    const h = harness({ collect: async () => ({ state: 'INIT', detail: 'fixture' }) })
    const run = h.run()
    await waitFor(() => h.launch.mock.calls.length === 1)
    h.children[0]?.emitClose(0)
    await expect(run).resolves.toBe(0)
    expect(h.lines[0]).toContain('dispatch reason=init-bootstrap')
  })

  it('INIT with a foreign build marker in flight defers (defense moved intact)', async () => {
    const h = harness({ collect: async () => ({ state: 'INIT', detail: 'fixture' }), buildingMarker: () => true })
    await expect(h.run()).resolves.toBe(0)
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.lines[0]).toContain('defer state=INIT (build marker in flight)')
  })

  it('INIT whose own manifest is present defers as linked-only (storm fix defense intact)', async () => {
    const h = harness({ collect: async () => ({ state: 'INIT', detail: 'fixture' }), ownBaseline: () => true })
    await expect(h.run()).resolves.toBe(0)
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.lines[0]).toContain('defer init-linked-baseline')
  })

  it('stability window: a source still moving inside the window defers, never builds a half-edited tree', async () => {
    let reads = 0
    const h = harness({
      stableMs: 60,
      // First read: NEED_BUILD h1; the re-read (60ms later): h2 — still editing.
      collect: async (): Promise<RestartSignalJudgment> => {
        reads += 1
        return reads === 1 ? judgment('NEED_BUILD', 'h1') : judgment('NEED_BUILD', 'h2')
      },
    })
    await expect(h.run()).resolves.toBe(0)
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.lines[0]).toContain('defer unstable from=NEED_BUILD to=NEED_BUILD')
    expect(reads).toBe(2)
  })

  it('stability window: quiet facts across the window dispatches once', async () => {
    let reads = 0
    const h = harness({
      stableMs: 40,
      collect: async (): Promise<RestartSignalJudgment> => { reads += 1; return judgment('NEED_BUILD', 'h1') },
    })
    const run = h.run()
    await waitFor(() => h.launch.mock.calls.length === 1, 4_000)
    h.children[0]?.emitClose(0)
    await expect(run).resolves.toBe(0)
    expect(reads).toBe(2)
    expect(h.lines[0]).toContain('dispatch reason=need-build')
  })
})

/* ── ⑤③ heartbeat + failout (dispatch-era coverage, transplanted) ────────── */

describe('auto-build exec: failout + heartbeat (⑤ ③ failout 2026-11-03)', () => {
  function failoutHarness() {
    const root = tempRoot('auto-build-failout-')
    const stampDirectory = join(root, '.dsh-build')
    const realJournal = defaultAutoBuildJournalLine(root, { writer: 'exec' })
    const lines: string[] = []
    const say = vi.fn<(line: string) => void>()
    const children: ReturnType<typeof stubChild>[] = []
    const launch = vi.fn((_command: string, _options: unknown) => {
      const child = stubChild()
      children.push(child)
      return child
    })
    const run = (heartbeatMs = 60_000): Promise<number> =>
      runAutoBuildExec({
        repositoryRoot: root,
        stampDirectory,
        journal: Object.assign((line: string): void => { lines.push(line); realJournal(line) }, {
          flush: (): Promise<void> => realJournal.flush(),
        }),
        say,
        warn: vi.fn(),
        launch,
        collect: async (): Promise<RestartSignalJudgment> => judgment('NEED_BUILD', 'h1'),
        listCohort: async (): Promise<readonly CohortEntry[]> => [],
        stableMs: 0,
        heartbeatMs,
        buildingMarker: () => false,
        ownBaseline: () => false,
        failedMarkerAgeMs: () => undefined,
      })
    return {
      root,
      stampDirectory,
      run,
      launch,
      say,
      children,
      lines,
      stdoutPath: join(stampDirectory, STDOUT_CAPTURE_FILE),
      stderrPath: join(stampDirectory, STDERR_CAPTURE_FILE),
      journalLines: (): string[] => readFileSync(join(stampDirectory, 'auto-build.log'), 'utf8').trim().split('\n'),
    }
  }

  it('captures the spawn stdio as fd redirection (files, not pipes)', async () => {
    const h = failoutHarness()
    const run = h.run()
    await waitFor(() => h.launch.mock.calls.length === 1)
    const options = h.launch.mock.calls[0]?.[1] as { stdio?: unknown }
    expect(options.stdio).toEqual(['ignore', expect.any(Number), expect.any(Number)])
    expect(existsSync(h.stdoutPath)).toBe(true)
    expect(existsSync(h.stderrPath)).toBe(true)
    h.children[0]?.emitClose(0)
    await expect(run).resolves.toBe(0)
  })

  it('folds a failed build’s stdout/stderr tails + exit code into ONE journal line', async () => {
    const h = failoutHarness()
    const run = h.run()
    await waitFor(() => h.launch.mock.calls.length === 1)
    writeFileSync(h.stdoutPath, 'OUT-HEAD build starting\nOUT-TAIL done\n')
    writeFileSync(h.stderrPath, `STDERR-HEAD-MARKER ${'x'.repeat(5000)} line1\nline2\nSTDERR-TAIL-MARKER\n`)
    h.children[0]?.emitClose(7)
    await expect(run).resolves.toBe(1)
    const failed = h.journalLines().find(line => line.includes('build-failed'))
    expect(failed).toBeDefined()
    expect(failed).toMatch(/^\d{4}-\d{2}-\d{2}T\S+Z \[exec\] build-failed exit=7 cmd=pnpm run build .+ seq=\d+$/)
    expect(failed).toContain('stdout-tail=OUT-HEAD build starting OUT-TAIL done')
    expect(failed).toContain('STDERR-TAIL-MARKER')
    expect(failed).not.toContain('STDERR-HEAD-MARKER')
    expect(existsSync(h.stdoutPath)).toBe(false)
    expect(existsSync(h.stderrPath)).toBe(false)
  })

  it('adds no build-failed noise on success — captures dropped, build-done audit line lands', async () => {
    const h = failoutHarness()
    const run = h.run()
    await waitFor(() => h.launch.mock.calls.length === 1)
    writeFileSync(h.stdoutPath, 'chatty\n')
    h.children[0]?.emitClose(0)
    await expect(run).resolves.toBe(0)
    const lines = h.journalLines()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('dispatch reason=need-build')
    expect(lines[1]).toContain('build-done exit=0')
    expect(lines.some(line => line.includes('build-failed'))).toBe(false)
    expect(existsSync(h.stdoutPath)).toBe(false)
    expect(existsSync(h.stderrPath)).toBe(false)
  })

  it('heartbeats land for the whole execution period, then the terminal line closes the window (⑤③)', async () => {
    const h = failoutHarness()
    const run = h.run(50)
    await waitFor(() => h.launch.mock.calls.length === 1)
    await waitFor(() => h.lines.filter(line => line.includes('heartbeat elapsedSec=')).length >= 2, 4_000)
    h.children[0]?.emitClose(0)
    await expect(run).resolves.toBe(0)
    const heartbeats = h.lines.filter(line => line.includes('heartbeat elapsedSec='))
    expect(heartbeats.length).toBeGreaterThanOrEqual(2)
    // On-disk shape: tagged + seq'd like every other line of the period.
    const fileLine = h.journalLines().find(line => line.includes('heartbeat elapsedSec='))
    expect(fileLine).toMatch(/^\d{4}-\d{2}-\d{2}T\S+Z \[exec\] heartbeat elapsedSec=\d+ execution=period seq=\d+$/)
    expect(h.lines.at(-1)).toContain('build-done exit=0')
  })
})

/* ── ④ linked leg: the per-tree account moved with execution authority ───── */

describe('auto-build exec: linked leg account (① linked 腿随迁)', () => {
  function linkedHarness(root: string, runCode = 0, options: { readonly moveManifest?: boolean } = {}) {
    const moves = { moveManifest: options.moveManifest ?? true }
    const captured: Array<{ command: string; cwd?: string; accountDuringRun?: unknown }> = []
    const runCaptured = vi.fn(async (command: string, runOptions: SpawnOptions): Promise<CapturedRun> => {
      const cwd = runOptions.cwd
      const tree = typeof cwd === 'string' ? cwd : ''
      captured.push({ command, cwd: tree, accountDuringRun: accountOf(root)[tree] })
      if (runCode === 0 && moves.moveManifest) writeLinkedManifest(tree, LINKED_NEXT_TIME)
      return runCode === 0
        ? { code: 0, stdout: 'linked ok\n', stderr: '' }
        : { code: runCode, stdout: '', stderr: 'fake linked build failed on purpose\n' }
    })
    return { captured, runCaptured }
  }

  it('pre-claims the account BEFORE the run, then records done + account ok (lamp texts verbatim)', async () => {
    const root = tempRoot('auto-build-linked-')
    const tree = linkedTree(root)
    const { captured, runCaptured } = linkedHarness(root, 0)
    const h = harness({
      repositoryRoot: root,
      listCohort: async (): Promise<readonly CohortEntry[]> => cohortFor(root),
      runCaptured,
      collect: async () => ({ state: 'NEED_BUILD', detail: 'fixture', facts: facts('x', 'cfg', false) }),
    })
    await expect(h.run()).resolves.toBe(0)
    expect(runCaptured).toHaveBeenCalledTimes(1)
    expect(captured[0]?.command).toContain('heavy-io-gate.ts')
    expect(captured[0]?.command).toContain('"pnpm build"')
    expect(captured[0]?.cwd).toBe(tree)
    // Pre-claim visible DURING the run (killed builds still land in cooldown).
    expect(captured[0]?.accountDuringRun).toMatchObject({ outcome: 'failed', failures: 1 })
    const texts = h.lines.join('\n')
    expect(texts).toContain(`linked-build repo=${tree} reason=linked-drift`)
    expect(texts).toContain(`linked-build-done repo=${tree} manifestTime=${LINKED_NEXT_TIME}`)
    const account = accountOf(root)[tree]
    expect(account).toMatchObject({ outcome: 'ok', failures: 0, stall: null })
  })

  it('run succeeded but manifest time unmoved → stall recorded + alarmed, next run stays quiet (防无限重建)', async () => {
    const root = tempRoot('auto-build-linked-')
    const tree = linkedTree(root)
    const { runCaptured } = linkedHarness(root, 0, { moveManifest: false })
    const h = harness({
      repositoryRoot: root,
      listCohort: async (): Promise<readonly CohortEntry[]> => cohortFor(root),
      runCaptured,
      collect: async () => ({ state: 'NEED_BUILD', detail: 'fixture', facts: facts('x', 'cfg', false) }),
    })
    await expect(h.run()).resolves.toBe(0)
    expect(h.lines.some(line => line.includes(`linked-build-stall repo=${tree} manifestTime=${LINKED_BASE_TIME}`))).toBe(true)
    expect(accountOf(root)[tree]).toMatchObject({ outcome: 'ok', failures: 0, stall: { manifestTime: LINKED_BASE_TIME } })
    // Second run: the stall suppresses dispatch entirely.
    const second = harness({
      repositoryRoot: root,
      listCohort: async (): Promise<readonly CohortEntry[]> => cohortFor(root),
      runCaptured: async () => { throw new Error('stalled tree must not dispatch') },
      collect: async () => ({ state: 'NEED_BUILD', detail: 'fixture', facts: facts('x', 'cfg', false) }),
    })
    await expect(second.run()).resolves.toBe(0)
    expect(second.lines.some(line => line.includes('linked-build repo='))).toBe(false)
  })

  it('a failed linked run journals the lamp failure text + returns 1 (failures pre-claimed)', async () => {
    const root = tempRoot('auto-build-linked-')
    const tree = linkedTree(root)
    const { runCaptured } = linkedHarness(root, 3)
    const h = harness({
      repositoryRoot: root,
      listCohort: async (): Promise<readonly CohortEntry[]> => cohortFor(root),
      runCaptured,
      collect: async () => ({ state: 'NEED_BUILD', detail: 'fixture', facts: facts('x', 'cfg', false) }),
    })
    await expect(h.run()).resolves.toBe(1)
    expect(h.lines.some(line => line.includes(`linked-build-failed repo=${tree} exit=3 output-tail=fake linked build failed on purpose`))).toBe(true)
    expect(accountOf(root)[tree]).toMatchObject({ outcome: 'failed', failures: 1 })
  })

  it('failure cooldown suppresses the next dispatch until it expires (护栏①)', async () => {
    const root = tempRoot('auto-build-linked-')
    const tree = linkedTree(root)
    mkdirSync(join(root, '.dsh-build'), { recursive: true })
    writeFileSync(join(root, '.dsh-build', 'linked-build-state.json'), JSON.stringify({
      version: 1,
      repos: { [tree]: { failures: 1, outcome: 'failed', lastAttemptAt: new Date().toISOString(), stall: null } },
    }), 'utf8')
    const h = harness({
      repositoryRoot: root,
      listCohort: async (): Promise<readonly CohortEntry[]> => cohortFor(root),
      runCaptured: async () => { throw new Error('inside cooldown: no dispatch') },
      collect: async () => ({ state: 'NEED_BUILD', detail: 'fixture', facts: facts('x', 'cfg', false) }),
    })
    await expect(h.run()).resolves.toBe(0)
    expect(h.lines.some(line => line.includes('linked-build repo='))).toBe(false)
  })

  it('own tree / manifest-less rows are skipped — only the drifted linked tree dispatches', async () => {
    const root = tempRoot('auto-build-linked-')
    const tree = linkedTree(root)
    const { captured, runCaptured } = linkedHarness(root, 0)
    const h = harness({
      repositoryRoot: root,
      // The production-shaped fixture names DRIFTED_REPO; point that row at the
      // real throwaway tree so the manifest readings work. The OWN_REPO row is
      // in-sync here — the own-path skip itself is exercised by `cohortFor`.
      listCohort: async (): Promise<readonly CohortEntry[]> => cohortFixture().map(entry =>
        entry.repository === DRIFTED_REPO ? { repository: tree, manifest: entry.manifest, current: entry.current } : entry),
      runCaptured,
      collect: async () => judgment('OK', 'h1'),
    })
    await expect(h.run()).resolves.toBe(0)
    expect(runCaptured).toHaveBeenCalledTimes(1)
    expect(captured[0]?.cwd).toBe(tree)
  })

  it('a cohort failure is loud: linked-cohort-failed + exit 2', async () => {
    const root = tempRoot('auto-build-linked-')
    const h = harness({
      repositoryRoot: root,
      listCohort: async (): Promise<readonly CohortEntry[]> => {
        throw new Error('signal-cli --list-cohort exited with 1 stderr=boom')
      },
      collect: async () => judgment('OK', 'h1'),
    })
    await expect(h.run()).resolves.toBe(2)
    expect(h.lines[0]).toContain('linked-cohort-failed error=signal-cli --list-cohort exited with 1 stderr=boom')
  })

  it('success-shaped judgments route straight to the linked leg (no own dispatch)', async () => {
    const root = tempRoot('auto-build-linked-')
    const listCohort = vi.fn(async (): Promise<readonly CohortEntry[]> => [])
    const h = harness({
      repositoryRoot: root,
      listCohort,
      collect: async () => judgment('OK', 'h1'),
    })
    await expect(h.run()).resolves.toBe(0)
    expect(h.launch).not.toHaveBeenCalled()
    expect(listCohort).toHaveBeenCalledTimes(1)
  })
})
