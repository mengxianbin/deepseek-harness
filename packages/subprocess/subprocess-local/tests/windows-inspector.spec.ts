import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  captureDescendantProcesses,
  createWindowsProcessInspector,
  isInvalidHandle,
  sweepHeldProcesses,
  windowsProcessTree,
  WindowsProcessInspector,
} from '@deepseek-ai/dsh-subprocess-local/src/windows-inspector.ts'
import type {
  NativePtr,
  ProcessEntry,
  WindowsProcessInspectorInternals,
  WindowsProcessState,
  WindowsSweepInternals,
} from '@deepseek-ai/dsh-subprocess-local/src/windows-inspector.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})

function fakeInternals() {
  const entries: ProcessEntry[] = []
  const states = new Map<number, WindowsProcessState>()
  const kills: Array<[number, boolean]> = []
  const counts = { enumerations: 0, stateReads: 0 }
  return {
    counts,
    internals: {
      snapshot: () => { counts.enumerations += 1; return [...entries] },
      processState: (pid) => { counts.stateReads += 1; return states.get(pid) },
      taskkill: (pid: number, force: boolean) => { kills.push([pid, force]) },
    } satisfies WindowsProcessInspectorInternals,
    add(entry: ProcessEntry, started?: string, active = true): void {
      entries.push(entry)
      if (started !== undefined) states.set(entry.pid, { started, active })
    },
    kills,
  }
}

describe('WindowsProcessInspector table enumeration', () => {
  it('enumerates the process table only for questions that need it', () => {
    const fake = fakeInternals()
    fake.add({ pid: 10, parentPid: 0 }, 't10')
    fake.add({ pid: 11, parentPid: 10 }, 't11')
    const inspector = new WindowsProcessInspector(fake.internals)

    // Liveness is a per-handle question on Windows, so a snapshot asked only
    // for liveness must not pay a Toolhelp32 walk. The terminal's Windows
    // teardown polls exactly this way, every 25 ms.
    const observed = inspector.snapshot()
    expect(observed.alive({ pid: 11, started: 't11' })).toBe(true)
    expect(fake.counts.enumerations).toBe(0)

    expect(observed.tree(10)).toHaveLength(2)
    expect(fake.counts.enumerations).toBe(1)

    // A second tree question reuses the same observation.
    observed.tree(10)
    expect(fake.counts.enumerations).toBe(1)
  })
})

describe('windowsProcessTree', () => {
  it('walks a table children-first with readable identities only', () => {
    const started = (pid: number): string | undefined => pid === 12 ? undefined : `t${pid}`
    expect(windowsProcessTree([
      { pid: 10, parentPid: 0 },
      { pid: 11, parentPid: 10 },
      { pid: 12, parentPid: 11 },
      { pid: 13, parentPid: 11 },
      { pid: 14, parentPid: 10 },
    ], 10, started)).toEqual([
      { pid: 13, started: 't13' },
      { pid: 11, started: 't11' },
      { pid: 14, started: 't14' },
      { pid: 10, started: 't10' },
    ])
  })

  it('returns an empty walk for an absent root', () => {
    expect(windowsProcessTree([{ pid: 10, parentPid: 0 }], 99, () => 't')).toEqual([])
  })

  it('terminates on a parent cycle instead of recursing forever', () => {
    const entries = [
      { pid: 10, parentPid: 11 },
      { pid: 11, parentPid: 10 },
    ]
    expect(windowsProcessTree(entries, 10, () => 't')).toHaveLength(2)
  })
})

describe('WindowsProcessInspector (injected internals)', () => {
  it('hides the default taskkill helper window for both termination tiers', () => {
    const taskkill = vi.mocked(nodeSpawnSync)
    taskkill.mockReturnValueOnce({} as never).mockReturnValueOnce({} as never)
    const inspector = createWindowsProcessInspector()
    inspector.signalGroup(77, 'SIGKILL')
    inspector.signalGroup(78, 'SIGTERM')
    expect(taskkill).toHaveBeenNthCalledWith(
      1,
      'taskkill',
      ['/PID', '77', '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    )
    expect(taskkill).toHaveBeenNthCalledWith(
      2,
      'taskkill',
      ['/PID', '78', '/T'],
      { stdio: 'ignore', windowsHide: true },
    )
  })

  it('exposes the shell pid as the pseudo foreground group and never proves stdin waits', () => {
    const fake = fakeInternals()
    const inspector = new WindowsProcessInspector(fake.internals)
    expect(inspector.foregroundPgid(77)).toBe(77)
    expect(inspector.isStdinWaiting(77, 10)).toBe(false)
    expect(inspector.snapshot().session(77)).toEqual([])
  })

  it('delegates tree walks and identity checks to the internals', () => {
    const fake = fakeInternals()
    fake.add({ pid: 10, parentPid: 0 }, 't10')
    fake.add({ pid: 11, parentPid: 10 }, 't11')
    const inspector = new WindowsProcessInspector(fake.internals)
    expect(inspector.snapshot().tree(10)).toEqual([
      { pid: 11, started: 't11' },
      { pid: 10, started: 't10' },
    ])
    expect(inspector.isAlive({ pid: 11, started: 't11' })).toBe(true)
    expect(inspector.isAlive({ pid: 11, started: 'stale' })).toBe(false)
    expect(inspector.isAlive({ pid: 99, started: 't99' })).toBe(false)

    fake.add({ pid: 12, parentPid: 10 }, 't12', false)
    expect(inspector.isAlive({ pid: 12, started: 't12' })).toBe(false)
  })

  it('maps SIGKILL to a forced taskkill and other signals to the grace form', () => {
    const fake = fakeInternals()
    const inspector = new WindowsProcessInspector(fake.internals)
    inspector.signalGroup(77, 'SIGKILL')
    inspector.signalGroup(77, 'SIGTERM')
    inspector.signalGroup(0, 'SIGKILL')
    expect(fake.kills).toEqual([[77, true], [77, false], [0, true]])
  })

  it('signals a process only while its start identity matches', () => {
    const fake = fakeInternals()
    fake.add({ pid: 10, parentPid: 0 }, 't10')
    fake.add({ pid: 11, parentPid: 10 }, 't11', false)
    const inspector = new WindowsProcessInspector(fake.internals)
    inspector.signalProcess({ pid: 10, started: 't10' }, 'SIGKILL')
    inspector.signalProcess({ pid: 11, started: 't11' }, 'SIGKILL')
    inspector.signalProcess({ pid: 10, started: 'stale' }, 'SIGTERM')
    expect(fake.kills).toEqual([[10, true]])
  })

  it('accepts an injected internals factory through the creator', () => {
    const fake = fakeInternals()
    expect(createWindowsProcessInspector(fake.internals)).toBeInstanceOf(WindowsProcessInspector)
    expect(createWindowsProcessInspector()).toBeInstanceOf(WindowsProcessInspector)
  })
})

describe('isInvalidHandle', () => {
  it('rejects null, zero, and the all-ones INVALID_HANDLE_VALUE forms', () => {
    const ptr = (value: bigint): NativePtr => value as NativePtr
    expect(isInvalidHandle(null)).toBe(true)
    expect(isInvalidHandle(undefined)).toBe(true)
    expect(isInvalidHandle(ptr(0n))).toBe(true)
    expect(isInvalidHandle(ptr(0xFFFFFFFFFFFFFFFFn))).toBe(true)
    expect(isInvalidHandle(ptr(-1n))).toBe(true)
    expect(isInvalidHandle(ptr(1234n))).toBe(false)
  })
})

const win32 = process.platform === 'win32' ? describe : describe.skip

win32('WindowsProcessInspector over the real koffi bindings', () => {
  it('walks the live process table from the test runner itself', () => {
    const inspector = createWindowsProcessInspector()
    const tree = inspector.snapshot().tree(process.pid)
    const self = tree.find(member => member.pid === process.pid)
    expect(self).toBeDefined()
    expect(inspector.snapshot().alive(self!)).toBe(true)
    expect(inspector.foregroundPgid(process.pid)).toBe(process.pid)
  })

  it('reports unreadable identities for absent processes and no-ops tree signalling', () => {
    const inspector = createWindowsProcessInspector()
    expect(inspector.isAlive({ pid: 0x7FFFFFFF, started: 'absent' })).toBe(false)
    expect(() => { inspector.signalGroup(0x7FFFFFFF, 'SIGKILL') }).not.toThrow()
    expect(() => { inspector.signalGroup(0x7FFFFFFF, 'SIGTERM') }).not.toThrow()
    expect(() => { inspector.signalGroup(0, 'SIGKILL') }).not.toThrow()
    expect(() => { inspector.signalProcess({ pid: 0x7FFFFFFF, started: 'absent' }, 'SIGKILL') }).not.toThrow()
  })
})

describe('captureDescendantProcesses / sweepHeldProcesses', () => {
  const ptr = (value: bigint): NativePtr => value as NativePtr

  function fakeSweep() {
    const entries: ProcessEntry[] = []
    const states = new Map<number, WindowsProcessState>()
    const vanished = new Set<number>()
    const terminateRefused = new Set<number>()
    const terminateThrew = new Set<number>()
    const terminated: number[] = []
    const released: number[] = []
    let releaseThrew = false
    let snapshotThrew = false
    const internals: WindowsSweepInternals = {
      snapshot: () => {
        if (snapshotThrew) throw new Error('table unreadable')
        return [...entries]
      },
      processState: pid => states.get(pid),
      hold: (pid, started) => {
        if (vanished.has(pid)) return undefined
        const state = states.get(pid)
        if (state === undefined || !state.active || state.started !== started) return undefined
        return { pid, started: state.started, handle: ptr(BigInt(pid)) }
      },
      active: held => states.get(held.pid)?.active === true,
      terminate: (held) => {
        terminated.push(held.pid)
        if (terminateThrew.has(held.pid)) throw new Error('terminate refused hard')
        return !terminateRefused.has(held.pid)
      },
      release: (held) => {
        released.push(held.pid)
        if (releaseThrew) throw new Error('close failed')
      },
    }
    return {
      internals,
      terminated,
      released,
      vanish(pid: number): void { vanished.add(pid) },
      refuse(pid: number): void { terminateRefused.add(pid) },
      throwTerminate(pid: number): void { terminateThrew.add(pid) },
      makeReleaseThrow(): void { releaseThrew = true },
      makeSnapshotThrow(): void { snapshotThrew = true },
      deactivate(pid: number): void {
        const state = states.get(pid)
        if (state !== undefined) states.set(pid, { ...state, active: false })
      },
      add(pid: number, parentPid: number, started: string): void {
        entries.push({ pid, parentPid })
        states.set(pid, { started, active: true })
      },
    }
  }

  it('pins live descendants children-first and never the runner itself or strangers', () => {
    const fake = fakeSweep()
    fake.add(100, 0, 's100')
    fake.add(101, 100, 's101')
    fake.add(102, 101, 's102')
    fake.add(200, 999, 's200')
    const held = captureDescendantProcesses(100, fake.internals)
    expect(held.map(one => one.pid)).toEqual([102, 101])
    expect(held.map(one => one.started)).toEqual(['s102', 's101'])
  })

  it('skips a descendant that vanished or died between the walk and the pin', () => {
    const fake = fakeSweep()
    fake.add(100, 0, 's100')
    fake.add(101, 100, 's101')
    fake.add(102, 100, 's102')
    fake.vanish(101)
    fake.deactivate(102)
    const held = captureDescendantProcesses(100, fake.internals)
    expect(held).toEqual([])
  })

  it('degrades to an empty pin set when the table cannot be read', () => {
    const fake = fakeSweep()
    fake.makeSnapshotThrow()
    expect(captureDescendantProcesses(100, fake.internals)).toEqual([])
  })

  it('reports killed / absent / failed per survivor and releases every handle', () => {
    const fake = fakeSweep()
    fake.add(100, 0, 's100')
    fake.add(101, 100, 's101')
    fake.add(102, 100, 's102')
    fake.add(103, 100, 's103')
    fake.add(104, 100, 's104')
    const held = captureDescendantProcesses(100, fake.internals)
    expect(held.map(one => one.pid).sort()).toEqual([101, 102, 103, 104])
    // The Job kills its members before the sweep runs; only non-members reach here alive.
    fake.deactivate(102)
    fake.refuse(103)
    fake.throwTerminate(104)
    const results = sweepHeldProcesses(held, fake.internals)
    expect(results).toEqual([
      { pid: 101, started: 's101', status: 'killed' },
      { pid: 102, started: 's102', status: 'absent' },
      { pid: 103, started: 's103', status: 'failed' },
      { pid: 104, started: 's104', status: 'failed' },
    ])
    expect(fake.terminated).not.toContain(102)
    expect([...fake.released].sort()).toEqual([101, 102, 103, 104])
  })

  it('still reports every survivor when a handle release itself fails', () => {
    const fake = fakeSweep()
    fake.add(100, 0, 's100')
    fake.add(101, 100, 's101')
    const held = captureDescendantProcesses(100, fake.internals)
    fake.makeReleaseThrow()
    const results = sweepHeldProcesses(held, fake.internals)
    expect(results).toEqual([{ pid: 101, started: 's101', status: 'killed' }])
  })
})
