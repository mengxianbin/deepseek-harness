/** Restart dispatch: the exact route, the capability global, and the background spawn. */
import type { SpawnOptions } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { RESTART_COMMAND_ENV, readRestartReason, registerRestart, type RestartChild } from '../src/restart-host.ts'
import { DISPATCH_CLAIM_TTL_MS, resetDispositionStateForTest } from '../src/restart-disposition.ts'
import { RESTART_GLOBAL, RESTART_PATH } from '../src/restart.ts'
import * as HostPlugin from '../src/index.ts'

const spawnMock = vi.hoisted(() => vi.fn<(commandLine: string, options: SpawnOptions) => RestartChild>())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnMock }
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  spawnMock.mockReset()
  // The in-flight dispatch claim is per-process state (P3): each example owns
  // a fresh claim, exactly like a fresh host process would.
  resetDispositionStateForTest()
})

/** A child stand-in whose error listener the test fires directly. */
function stubChild(): { child: RestartChild; fail: (error: Error) => void } {
  const listeners: Array<(error: Error) => void> = []
  const child: RestartChild = {
    unref: vi.fn(),
    on: vi.fn((_event: 'error', listener: (error: Error) => void) => { listeners.push(listener) }),
  }
  return { child, fail: (error) => { for (const listener of listeners) listener(error) } }
}

const capabilityRow = [{ kind: 'global', name: RESTART_GLOBAL, value: { configured: true } }] as const

/** Fresh context, real Connection fetch registry, and request helpers over `/api/restart`. */
function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const handler = connection.createSharedFetchHandler('/api')
  // `target` accepts a query string; `init` carries body/headers for reason rides.
  const post = (target: string = RESTART_PATH, init: RequestInit = {}) =>
    handler.fetch(new Request(`http://localhost${target}`, { method: 'POST', ...init }),
      connection.browserPeer)
  const send = (request: Request) => handler.fetch(request, connection.browserPeer)
  const get = () => handler.fetch(new Request(`http://localhost${RESTART_PATH}`, { method: 'GET' }),
    connection.browserPeer)
  const emitIndex = (): IndexInjection[] => {
    const table: IndexInjection[] = []
    // `webserver/index-inject` now carries the rendering Peer beside the table.
    ctx.emit('webserver/index-inject', table, connection.browserPeer)
    return table
  }
  return { ctx, post, send, get, emitIndex }
}

describe('restart dispatch', () => {
  it('answers 202, runs the whole command line in the background with the inherited environment, and announces the capability', async () => {
    vi.stubEnv(RESTART_COMMAND_ENV, 'pwsh -NoProfile -File D:\\dsh\\restart.ps1 -NoBrowser')
    const { ctx, post, get, emitIndex } = fixture()
    const { child, fail } = stubChild()
    const launch = vi.fn((_commandLine: string, _options: SpawnOptions) => child)
    registerRestart(ctx, { launch })

    const response = await post()
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ dispatched: true })
    expect(launch).toHaveBeenCalledOnce()
    const [commandLine, options] = launch.mock.calls[0]!
    expect(commandLine).toBe('pwsh -NoProfile -File D:\\dsh\\restart.ps1 -NoBrowser')
    expect(options).toMatchObject({ shell: true, stdio: 'ignore', windowsHide: true })
    // Non-detached since 2026-11-06 popup fix: no console-less detached grandchild,
    // so the default terminal never renders a new focus-stealing window.
    expect(options).not.toHaveProperty('detached')
    // Same trust domain: the child inherits this server's full environment, wiring names included.
    expect(options.env).toBe(process.env)
    expect(child.unref).toHaveBeenCalledOnce()

    // A late spawn failure only reaches stderr; the 202 is already on the wire.
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    fail(new Error('shell is missing'))
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('shell is missing'))
    write.mockRestore()

    expect(emitIndex()).toEqual(capabilityRow)
    expect((await get()).status).toBe(404)
  })

  it('registers no route and no page global without a configured command', async () => {
    vi.stubEnv(RESTART_COMMAND_ENV, undefined)
    const { ctx, post, emitIndex } = fixture()
    registerRestart(ctx, { launch: vi.fn() })
    expect((await post()).status).toBe(404)
    expect(emitIndex()).toEqual([])
  })

  it('treats an empty command line as unconfigured', async () => {
    vi.stubEnv(RESTART_COMMAND_ENV, '')
    const { ctx, post, emitIndex } = fixture()
    registerRestart(ctx, { launch: vi.fn() })
    expect((await post()).status).toBe(404)
    expect(emitIndex()).toEqual([])
  })

  it('spawns through the hidden shell launcher when no seam is injected', async () => {
    vi.stubEnv(RESTART_COMMAND_ENV, 'exit 0')
    const { ctx, post } = fixture()
    const { child } = stubChild()
    spawnMock.mockImplementation(() => child)
    registerRestart(ctx)
    expect((await post()).status).toBe(202)
    expect(spawnMock).toHaveBeenCalledOnce()
    const [commandLine, options] = spawnMock.mock.calls[0]!
    expect(commandLine).toBe('exit 0')
    expect(options).toMatchObject({
      shell: true, stdio: 'ignore', windowsHide: true, env: process.env,
    })
    expect(options).not.toHaveProperty('detached')
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('wires through apply against connection and webserver, and unwires on disposal', async () => {
    vi.stubEnv(RESTART_COMMAND_ENV, 'exit 0')
    const { ctx, post, emitIndex } = fixture()
    ctx.provide('webServer', {} as Context['webServer'])
    spawnMock.mockImplementation(() => stubChild().child)
    const fiber = await ctx.plugin(HostPlugin)
    await vi.waitFor(async () => { expect((await post()).status).toBe(202) })
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(emitIndex()).toEqual(capabilityRow)
    await fiber.dispose()
    expect((await post()).status).toBe(404)
    expect(emitIndex()).toEqual([])
  })

  it('stays entirely absent from apply when no command is configured', async () => {
    vi.stubEnv(RESTART_COMMAND_ENV, undefined)
    const { ctx, post, emitIndex } = fixture()
    ctx.provide('webServer', {} as Context['webServer'])
    await ctx.plugin(HostPlugin)
    expect((await post()).status).toBe(404)
    expect(emitIndex()).toEqual([])
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('answers 409 in-flight for a click inside the claim window but spawns exactly once (D, 如实回报)', async () => {
    vi.stubEnv(RESTART_COMMAND_ENV, 'exit 0')
    const { ctx, post } = fixture()
    const { child } = stubChild()
    spawnMock.mockImplementation(() => child)
    registerRestart(ctx)
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const first = await post()
    const second = await post()
    expect(first.status).toBe(202)
    expect(await first.json()).toEqual({ dispatched: true })
    // The skipped click is told the truth instead of a fake 202 (the 12:57 incident).
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ dispatched: false, reason: 'in-flight' })
    expect(spawnMock).toHaveBeenCalledOnce()
    // One spy, two distinct lines: the manual-route dispatch line (reason audit,
    // `reason=-` — this request carries none) and the skipped line.
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalledWith(expect.stringContaining('already in flight'))
    expect(write).toHaveBeenCalledWith(expect.stringContaining('manual route, reason=-, remote='))
  })

  it('lets a retry dispatch again once the claim TTL expires', async () => {
    vi.useFakeTimers()
    vi.stubEnv(RESTART_COMMAND_ENV, 'exit 0')
    const { ctx, post } = fixture()
    const { child } = stubChild()
    spawnMock.mockImplementation(() => child)
    registerRestart(ctx)
    expect((await post()).status).toBe(202)
    expect((await post()).status).toBe(409)
    vi.advanceTimersByTime(DISPATCH_CLAIM_TTL_MS + 1)
    expect((await post()).status).toBe(202)
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
})

describe('restart reason audit (restart-reason-audit-1111 ①, fail-open)', () => {
  it('answers 202 and logs the caller reason from a JSON body on the dispatch line', async () => {
    vi.stubEnv(RESTART_COMMAND_ENV, 'exit 0')
    const { ctx, post } = fixture()
    spawnMock.mockImplementation(() => stubChild().child)
    registerRestart(ctx)
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const response = await post(RESTART_PATH, { body: JSON.stringify({ reason: 'manual: user pressed the button' }) })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ dispatched: true })
    // 机检锚：行含 `manual route, reason=` 与调用方 reason 本体。
    expect(write).toHaveBeenCalledWith(expect.stringContaining(
      'restart dispatched (manual route, reason=manual: user pressed the button, remote=',
    ))
  })

  it('answers 202 with reason=- when the request carries no reason (缺省回落现状)', async () => {
    vi.stubEnv(RESTART_COMMAND_ENV, 'exit 0')
    const { ctx, post } = fixture()
    spawnMock.mockImplementation(() => stubChild().child)
    registerRestart(ctx)
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const response = await post()
    expect(response.status).toBe(202)
    expect(write).toHaveBeenCalledWith(expect.stringContaining('manual route, reason=-, remote='))
  })

  it('reads query first, then body JSON/plain text, clips to 200, and degrades unreadable bodies to -', async () => {
    const url = `http://localhost${RESTART_PATH}`
    // Query wins over the body.
    expect(await readRestartReason(new Request(`${url}?reason=via-query`))).toBe('via-query')
    expect(await readRestartReason(new Request(url, { method: 'POST', body: JSON.stringify({ reason: 'via-body' }) }))).toBe('via-body')
    // Plain (non-JSON) body rides as the reason itself; empty and field-less bodies degrade.
    expect(await readRestartReason(new Request(url, { method: 'POST', body: 'plain-text' }))).toBe('plain-text')
    expect(await readRestartReason(new Request(url, { method: 'POST' }))).toBe('-')
    expect(await readRestartReason(new Request(url, { method: 'POST', body: JSON.stringify({ other: 1 }) }))).toBe('-')
    // Over-long clips to the 200-char bound — degrade, never reject.
    expect(await readRestartReason(new Request(url, { method: 'POST', body: JSON.stringify({ reason: 'x'.repeat(250) }) }))).toHaveLength(200)
    // An unreadable body degrades to `-` instead of throwing (fail-open).
    const broken = new Request(url, {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('body exploded')) } }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    await expect(readRestartReason(broken)).resolves.toBe('-')
  })

  it('still answers 202 with reason=- when the body cannot be read — the spawn precedes the audit read', async () => {
    vi.stubEnv(RESTART_COMMAND_ENV, 'exit 0')
    const { ctx, send } = fixture()
    spawnMock.mockImplementation(() => stubChild().child)
    registerRestart(ctx)
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const broken = new Request(`http://localhost${RESTART_PATH}`, {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('body exploded')) } }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    const response = await send(broken)
    // Fail-open: the dispatch already happened and the 202 is on the wire.
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ dispatched: true })
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith(expect.stringContaining('manual route, reason=-, remote='))
  })
})
