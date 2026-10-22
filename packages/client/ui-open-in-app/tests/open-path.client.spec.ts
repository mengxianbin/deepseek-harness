/**
 * Path controller behavior: the once-per-page desktop read (failed reads stay unknown and retry)
 * and the open/reveal outcomes over the Session Remote.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionOpenWorkspacePathRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import { DESKTOP_RETRY_LIMIT, OpenInAppPathController, type OpenInAppPathRemote } from '../src/client/open-path.ts'

type SessionRemote = OpenInAppPathRemote['session']

function remoteOf(over: Partial<SessionRemote> = {}): OpenInAppPathRemote {
  return {
    session: {
      workspacePathApplications: async () => ({ ok: true, value: [] }),
      canOpenWorkspacePath: async () => ({ ok: true, value: true }),
      openWorkspacePath: async () => ({ ok: true, value: { opened: true } }),
      ...over,
    },
  }
}

describe('OpenInAppPathController desktop availability', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts unanswered and shares one read across concurrent loads', async () => {
    const canOpenWorkspacePath = vi.fn(async () => ({ ok: true as const, value: true }))
    const controller = new OpenInAppPathController(remoteOf({ canOpenWorkspacePath }))
    expect(controller.desktop.getSnapshot()).toBeNull()
    await Promise.all([controller.load(), controller.load()])
    await controller.load()
    expect(canOpenWorkspacePath).toHaveBeenCalledOnce()
    expect(controller.desktop.getSnapshot()).toBe(true)
  })

  it('publishes no desktop for a Host that definitively refuses', async () => {
    const refusing = new OpenInAppPathController(remoteOf({ canOpenWorkspacePath: async () => ({ ok: true, value: false }) }))
    await refusing.load()
    expect(refusing.desktop.getSnapshot()).toBe(false)
  })

  it('keeps a failed read unknown, warns about it, and recovers it on the next load', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let answered = false
    const canOpenWorkspacePath = vi.fn(async () => {
      if (!answered) return { ok: false as const, error: new RemoteError('gateway/internal', 'boom', {}) }
      return { ok: true as const, value: true }
    })
    const controller = new OpenInAppPathController(remoteOf({ canOpenWorkspacePath }))
    await controller.load()
    expect(controller.desktop.getSnapshot()).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    answered = true
    await controller.load()
    expect(controller.desktop.getSnapshot()).toBe(true)
    expect(canOpenWorkspacePath).toHaveBeenCalledTimes(2)
  })

  it('re-reads a rejecting carrier after the backoff and stops once the answer settles', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const canOpenWorkspacePath = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('down')
      return { ok: true as const, value: true }
    })
    const controller = new OpenInAppPathController(remoteOf({ canOpenWorkspacePath }), 50)
    await controller.load()
    expect(controller.desktop.getSnapshot()).toBeNull()
    await vi.advanceTimersByTimeAsync(50)
    expect(controller.desktop.getSnapshot()).toBe(true)
    expect(canOpenWorkspacePath).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(canOpenWorkspacePath).toHaveBeenCalledTimes(2)
  })

  it(`bounds automatic re-reads to ${DESKTOP_RETRY_LIMIT}, keeping later mounts free to re-query`, async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const canOpenWorkspacePath = vi.fn(async () => { throw new Error('down') })
    const controller = new OpenInAppPathController(remoteOf({ canOpenWorkspacePath }), 50)
    await controller.load()
    for (let attempt = 0; attempt < DESKTOP_RETRY_LIMIT + 2; attempt += 1) await vi.advanceTimersByTimeAsync(50)
    expect(canOpenWorkspacePath).toHaveBeenCalledTimes(DESKTOP_RETRY_LIMIT + 1)
    expect(controller.desktop.getSnapshot()).toBeNull()
    await controller.load()
    expect(canOpenWorkspacePath).toHaveBeenCalledTimes(DESKTOP_RETRY_LIMIT + 2)
  })
})

describe('OpenInAppPathController gestures', () => {
  it('sends the default-application open without an action and the reveal with one', async () => {
    const openWorkspacePath = vi.fn(async (_request: SessionOpenWorkspacePathRequest, _signal?: AbortSignal) =>
      ({ ok: true as const, value: { opened: true as const } }))
    const controller = new OpenInAppPathController(remoteOf({ openWorkspacePath }))
    expect(await controller.openPath('/w/clip.mp4', 'open')).toBeNull()
    expect(await controller.openPath('/w/clip.mp4', 'reveal')).toBeNull()
    expect(openWorkspacePath.mock.calls.map(call => call[0])).toEqual([
      { path: '/w/clip.mp4' },
      { path: '/w/clip.mp4', action: 'reveal' },
    ])
  })

  it('names the failed gesture for a refused answer and for a rejecting carrier', async () => {
    const refused = new OpenInAppPathController(remoteOf({
      openWorkspacePath: async () => ({ ok: false, error: new RemoteError('gateway/internal', 'boom', {}) }),
    }))
    expect(await refused.openPath('/w/clip.mp4', 'open')).toBe('openError')
    expect(await refused.openPath('/w/clip.mp4', 'reveal')).toBe('revealError')

    const rejecting = new OpenInAppPathController(remoteOf({ openWorkspacePath: () => Promise.reject(new Error('down')) }))
    expect(await rejecting.openPath('/w/clip.mp4', 'open')).toBe('openError')
  })
})


it('queries current handlers and carries an explicit application without changing the default gesture', async () => {
  const applications = [{ id: '/Applications/Music.app', name: 'Music', default: true, icon: null }]
  const query = vi.fn(async () => ({ ok: true as const, value: applications }))
  const open = vi.fn(async () => ({ ok: true as const, value: { opened: true } }))
  const controller = new OpenInAppPathController(remoteOf({ workspacePathApplications: query, openWorkspacePath: open }))
  const signal = new AbortController().signal
  expect(await controller.applications('/file.mp3', signal)).toEqual(applications)
  expect(query).toHaveBeenCalledWith({ path: '/file.mp3' }, signal)
  await controller.openPath('/file.mp3', 'open', '/Applications/Music.app')
  expect(open).toHaveBeenLastCalledWith({ path: '/file.mp3', application: '/Applications/Music.app' })
  await controller.openPath('/file.mp3', 'open')
  expect(open).toHaveBeenLastCalledWith({ path: '/file.mp3' })
})


it('distinguishes failed association queries from an empty application list', async () => {
  const remote = remoteOf({ workspacePathApplications: async () => ({ ok: false, error: new RemoteError('gateway/internal', 'unavailable', {}) }) })
  const controller = new OpenInAppPathController(remote)
  expect(await controller.applications('/file.mp3', new AbortController().signal)).toBeNull()
  const rejecting = new OpenInAppPathController(remoteOf({ workspacePathApplications: async () => { throw new Error('disconnected') } }))
  expect(await rejecting.applications('/file.mp3', new AbortController().signal)).toBeNull()
})
