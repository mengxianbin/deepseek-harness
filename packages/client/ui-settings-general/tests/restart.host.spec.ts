/** Restart dispatch: the exact route, the capability global, and the detached spawn. */
import type { SpawnOptions } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { RESTART_COMMAND_ENV, registerRestart, type RestartChild } from '../src/restart-host.ts'
import { RESTART_GLOBAL, RESTART_PATH } from '../src/restart.ts'
import * as HostPlugin from '../src/index.ts'

const spawnMock = vi.hoisted(() => vi.fn<(commandLine: string, options: SpawnOptions) => RestartChild>())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnMock }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  spawnMock.mockReset()
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
  const post = () => handler.fetch(new Request(`http://localhost${RESTART_PATH}`, { method: 'POST' }),
    connection.browserPeer)
  const get = () => handler.fetch(new Request(`http://localhost${RESTART_PATH}`, { method: 'GET' }),
    connection.browserPeer)
  const emitIndex = (): IndexInjection[] => {
    const table: IndexInjection[] = []
    ctx.emit('webserver/index-inject', table)
    return table
  }
  return { ctx, post, get, emitIndex }
}

describe('restart dispatch', () => {
  it('answers 202, runs the whole command line detached with the inherited environment, and announces the capability', async () => {
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
    expect(options).toMatchObject({ shell: true, detached: true, stdio: 'ignore', windowsHide: true })
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

  it('spawns through the hidden detached shell launcher when no seam is injected', async () => {
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
      shell: true, detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    })
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
})
