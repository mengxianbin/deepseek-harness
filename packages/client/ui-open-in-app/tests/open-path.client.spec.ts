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
    expect(await controller.openPath('/w/clip.mp4', 'open')).toEqual({ kind: 'opened' })
    expect(await controller.openPath('/w/clip.mp4', 'reveal')).toEqual({ kind: 'revealed' })
    expect(openWorkspacePath.mock.calls.map(call => call[0])).toEqual([
      { path: '/w/clip.mp4' },
      { path: '/w/clip.mp4', action: 'reveal' },
    ])
  })

  it('names the failed gesture for a refused answer and for a rejecting carrier', async () => {
    const refused = new OpenInAppPathController(remoteOf({
      openWorkspacePath: async () => ({ ok: false, error: new RemoteError('gateway/internal', 'boom', {}) }),
    }))
    expect(await refused.openPath('/w/clip.mp4', 'open')).toEqual({ kind: 'failed', failure: 'openError' })
    expect(await refused.openPath('/w/clip.mp4', 'reveal')).toEqual({ kind: 'failed', failure: 'revealError' })

    const rejecting = new OpenInAppPathController(remoteOf({ openWorkspacePath: () => Promise.reject(new Error('down')) }))
    expect(await rejecting.openPath('/w/clip.mp4', 'open')).toEqual({ kind: 'failed', failure: 'openError' })
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

describe('OpenInAppPathController association answers', () => {
  type Answer = Awaited<ReturnType<SessionRemote['workspacePathApplications']>>
  const app = (name: string, icon: string | null = null) => ({ id: `/Applications/${name}.app`, name, default: true, icon })
  const answered = (...apps: ReturnType<typeof app>[]): Answer => ({ ok: true, value: apps })
  /** A Remote whose association queries settle when the test answers them, and reject once cancelled. */
  function deferredRemote() {
    const queries: { path: string; signal: AbortSignal | undefined; answer: (result: Answer) => void }[] = []
    const workspacePathApplications = vi.fn((request: { path: string }, signal?: AbortSignal) => new Promise<Answer>((answer, reject) => {
      queries.push({ path: request.path, signal, answer })
      signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
    }))
    return { queries, controller: new OpenInAppPathController(remoteOf({ workspacePathApplications })) }
  }

  it('shares an answer across files with the same final extension and keeps extensionless names apart', async () => {
    const answers: Record<string, Answer> = {
      '/w/notes.txt': answered(app('TextEdit')), '/w/Makefile': answered(app('Xcode')), '/w/.env': answered(app('Zed')),
    }
    const controller = new OpenInAppPathController(remoteOf({ workspacePathApplications: async ({ path }) => answers[path]! }))
    const signal = new AbortController().signal
    expect(controller.cachedApplications('/w/notes.txt')).toBeUndefined()
    for (const path of Object.keys(answers)) await controller.applications(path, signal)
    expect(controller.cachedApplications('/elsewhere/todo.txt')).toEqual([app('TextEdit')])
    expect(controller.cachedApplications('C:\\work\\archive.tar.txt')).toEqual([app('TextEdit')])
    expect(controller.cachedApplications('/w/NOTES.TXT')).toBeUndefined()
    expect(controller.cachedApplications('/w/Makefile')).toEqual([app('Xcode')])
    expect(controller.cachedApplications('/other/Makefile')).toBeUndefined()
    expect(controller.cachedApplications('/w/.env')).toEqual([app('Zed')])
    expect(controller.cachedApplications('/w/draft.')).toBeUndefined()
  })

  it('publishes changed answers only, and an earlier query never replaces a later answer', async () => {
    const { queries, controller } = deferredRemote()
    const signal = new AbortController().signal
    const earlier = controller.applications('/w/a.txt', signal)
    const later = controller.applications('/w/b.txt', signal)
    queries[1]!.answer(answered(app('Sublime Text', 'data:image/png;base64,c3Vi')))
    expect(await later).toEqual([app('Sublime Text', 'data:image/png;base64,c3Vi')])
    const published = controller.associations.getSnapshot()
    queries[0]!.answer(answered(app('TextEdit')))
    expect(await earlier).toEqual([app('TextEdit')])
    expect(controller.associations.getSnapshot()).toBe(published)
    expect(controller.cachedApplications('/w/a.txt')).toEqual([app('Sublime Text', 'data:image/png;base64,c3Vi')])
    const unchanged = controller.applications('/w/c.txt', signal)
    queries[2]!.answer(answered(app('Sublime Text', 'data:image/png;base64,c3Vi')))
    await unchanged
    expect(controller.associations.getSnapshot()).toBe(published)
    const changed = controller.applications('/w/c.txt', signal)
    queries[3]!.answer(answered(app('Sublime Text', 'data:image/png;base64,bmV3'), app('TextEdit')))
    await changed
    expect(controller.associations.getSnapshot()).not.toBe(published)
    expect(controller.cachedApplications('/w/a.txt')).toEqual([app('Sublime Text', 'data:image/png;base64,bmV3'), app('TextEdit')])
    const other = controller.applications('/w/d.md', signal)
    queries[4]!.answer(answered(app('Sublime Text', 'data:image/png;base64,bmV3')))
    await other
    expect(controller.cachedApplications('/w/e.md')).toEqual([app('Sublime Text', 'data:image/png;base64,bmV3')])
    expect(controller.cachedApplications('/w/e.txt')).toHaveLength(2)
  })

  it('keeps the recorded answer through refused and rejected queries', async () => {
    const workspacePathApplications = vi.fn<SessionRemote['workspacePathApplications']>()
      .mockResolvedValueOnce(answered(app('Preview')))
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'boom', {}) })
      .mockRejectedValueOnce(new Error('down'))
    const controller = new OpenInAppPathController(remoteOf({ workspacePathApplications }))
    const signal = new AbortController().signal
    await controller.applications('/w/a.png', signal)
    expect(await controller.applications('/w/a.png', signal)).toBeNull()
    expect(await controller.applications('/w/a.png', signal)).toBeNull()
    expect(controller.cachedApplications('/w/b.png')).toEqual([app('Preview')])
  })

  it('runs one background refresh at a time, cancelling the older for the newer file, and disposal cancels it', async () => {
    const { queries, controller } = deferredRemote()
    void controller.refreshApplications('/w/a.txt')
    void controller.refreshApplications('/w/b.txt')
    expect(queries.map(query => [query.path, query.signal?.aborted])).toEqual([['/w/a.txt', true], ['/w/b.txt', false]])
    queries[1]!.answer(answered(app('TextEdit')))
    await vi.waitFor(() => { expect(controller.cachedApplications('/w/c.txt')).toEqual([app('TextEdit')]) })
    void controller.refreshApplications('/w/d.md')
    controller.dispose()
    expect(queries[2]).toMatchObject({ path: '/w/d.md', signal: { aborted: true } })
    void controller.refreshApplications('/w/e.json')
    expect(queries).toHaveLength(3)
    expect(controller.cachedApplications('/w/a.txt')).toEqual([app('TextEdit')])
  })
})
