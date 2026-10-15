// @vitest-environment jsdom
/** Draft attachments persist at intake and rehydrate the rail after a fiber restart. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { makeTranslate, SlotTestRuntime, TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import type { DraftAttachmentId } from '../src/client/contract/input.ts'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'
import { InputHub } from '../src/client/input/hub.ts'
import { zh } from '../src/client/locales.ts'
import { ConversationController } from '../src/client/service.ts'
import { FakeIndexedDB } from './support/fake-indexeddb.ts'

const fake = new FakeIndexedDB()

beforeEach(() => {
  fake.reset()
  vi.stubGlobal('indexedDB', fake)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** One simulated page: runtime, its input hub, and its Conversation service. */
async function page() {
  const runtime = await SlotTestRuntime.create()
  runtime.fileUpload.upload = (sessionId: SessionId, ...args: unknown[]) => {
    const session = runtime.sessions.behavior(sessionId) as {
      uploadFile?: (...input: unknown[]) => Promise<unknown>
    }
    if (session.uploadFile === undefined) throw new Error('test file upload has no Session override')
    return session.uploadFile(...args)
  }
  const prompt = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  await runtime.sessions.add({
    id: 's1',
    session: {
      prompt,
      updateQueue: vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } })),
      cancel: vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } })),
      loadOlder: vi.fn(() => Promise.resolve()),
      uploadFile: vi.fn((_file: Blob | Uint8Array, name?: string) => Promise.resolve({
        ok: true as const,
        value: {
          receiptId: `receipt-${name ?? 'file'}` as never,
          file: { attachmentId: `file-${name ?? 'file'}` as never, name: name ?? 'file', bytes: 1 },
        },
      })),
    },
  })
  const reference = runtime.sessions.retain('s1' as SessionId)
  await reference.ready
  const hub = new InputHub(runtime.ctx, makeTranslate(zh, {}))
  const fiber = runtime.ctx.plugin(ConversationController, {
    input: hub,
    blocks: new ComposerBlockRegistry(),
    maxConcurrentFileUploads: 2,
  })
  await fiber.await()
  const root = runtime.ctx.get('conversation') as ConversationController
  const binding = runtime.sessions.binding('s1')!
  return { runtime, fiber, hub, root, binding, reference }
}

/** A hub bench whose conversation service answers through the given stub. */
async function hubPage(conversation: unknown) {
  const id = SessionId(`restore-${randomUUID()}`)
  const ctx = new Context()
  const sessions = new TestSessions(async (operation) => { await operation() }, ctx)
  onTestFinished(async () => {
    await sessions.disposeScopes()
    await ctx.fiber.dispose()
  })
  ctx.provide('sessions', sessions)
  if (conversation !== undefined) {
    ctx.provide('conversation')
    ctx.set('conversation', conversation)
  }
  await sessions.add({ id })
  const reference = sessions.retain(id)
  onTestFinished(() => { reference.release() })
  await reference.ready
  const hub = new InputHub(ctx, makeTranslate(zh, {}))
  return { ctx, sessions, id, reference, binding: reference.binding, hub }
}

it('rebuilds a fresh service from the bytes persisted at intake', async () => {
  const created = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${randomUUID()}`)
  try {
    const before = await page()
    const drafts = before.root.createDrafts(before.binding.session.sessionId, [
      new File([Uint8Array.of(137, 80, 78, 71)], 'shot.png', { type: 'image/png' }),
      new File([Uint8Array.of(1)], 'note.txt', { type: 'text/plain' }),
    ])
    await vi.waitFor(() => { expect(fake.rows('attachments')).toHaveLength(2) })
    // The rebuild's fiber teardown: this service forgets its registry and dies.
    await before.fiber.dispose()
    await before.runtime.dispose()

    const after = await page()
    const restored = await after.root.restoreDraftAttachments(after.binding.session.sessionId)
    expect(restored).toEqual(drafts.map(draft => draft.id))
    const resolved = after.root.resolveDraftAttachments(restored)
    expect(resolved.map(attachment => attachment.kind)).toEqual(['image', 'file'])
    const [image, file] = resolved
    if (image?.kind !== 'image' || file?.kind !== 'file') throw new Error('restored descriptors missing')
    expect(image.file.name).toBe('shot.png')
    expect(image.previewUrl.startsWith('blob:')).toBe(true)
    expect(file.file.name).toBe('note.txt')
    // The restored file draft re-enters its background upload for this Session.
    await vi.waitFor(() => {
      expect(after.root.fileUploads.getSnapshot()[file.id]?.status).toBe('ready')
    })
    await after.runtime.dispose()
  } finally {
    created.mockRestore()
  }
})

it('releases the persisted bytes when the draft gives the attachment up', async () => {
  const created = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${randomUUID()}`)
  try {
    const before = await page()
    const [draft] = before.root.createDrafts(before.binding.session.sessionId, [
      new File([Uint8Array.of(1)], 'gone.png', { type: 'image/png' }),
    ])
    if (draft === undefined) throw new Error('draft missing')
    await vi.waitFor(() => { expect(fake.rows('attachments')).toHaveLength(1) })
    before.root.releaseDraftAttachment(draft.id)
    await vi.waitFor(() => { expect(fake.rows('attachments')).toHaveLength(0) })
    expect(before.root.resolveDraftAttachments([draft.id])).toEqual([])
    // The id is gone from storage, so a later restore has nothing to rebuild.
    await expect(before.root.restoreDraftAttachments(before.binding.session.sessionId)).resolves.toEqual([])
    await before.runtime.dispose()
  } finally {
    created.mockRestore()
  }
})

it('answers an empty restore when the storage runtime is unavailable', async () => {
  vi.stubGlobal('indexedDB', undefined)
  const b = await page()
  await expect(b.root.restoreDraftAttachments(b.binding.session.sessionId)).resolves.toEqual([])
  await b.runtime.dispose()
})

it('restores persisted attachment ids into the shell that adopted the draft', async () => {
  const restore = vi.fn(async () => ['restored-image' as DraftAttachmentId])
  const b = await hubPage({ restoreDraftAttachments: restore, forgetDraftAttachment: vi.fn(), releaseDraftAttachment: vi.fn() })
  const shell = b.hub.shellFor(b.binding)
  await vi.waitFor(() => {
    expect(shell.snapshot.attachmentIds).toEqual(['restored-image' as DraftAttachmentId])
  })
  expect(restore).toHaveBeenCalledWith(b.id)
  shell.dispose()
})

it('leaves the input state untouched when storage restores nothing', async () => {
  const restore = vi.fn(async (): Promise<readonly DraftAttachmentId[]> => [])
  const b = await hubPage({ restoreDraftAttachments: restore, forgetDraftAttachment: vi.fn() })
  const shell = b.hub.shellFor(b.binding)
  await vi.waitFor(() => { expect(restore).toHaveBeenCalledWith(b.id) })
  expect(shell.snapshot.attachmentIds).toEqual([])
  shell.dispose()
})

it('skips the restore when no Conversation service is composed', async () => {
  const b = await hubPage(undefined)
  const shell = b.hub.shellFor(b.binding)
  expect(shell.snapshot.attachmentIds).toEqual([])
  shell.dispose()
})

it('keeps an older Conversation face without a restore verb working unchanged', async () => {
  const b = await hubPage({ forgetDraftAttachment: vi.fn() })
  const shell = b.hub.shellFor(b.binding)
  expect(shell.snapshot.attachmentIds).toEqual([])
  shell.dispose()
})

it('logs a failing restore instead of breaking the shell', async () => {
  const restore = vi.fn(async (): Promise<readonly DraftAttachmentId[]> => {
    throw new Error('storage exploded')
  })
  const b = await hubPage({ restoreDraftAttachments: restore, forgetDraftAttachment: vi.fn() })
  const warn = vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})
  const shell = b.hub.shellFor(b.binding)
  await vi.waitFor(() => { expect(warn).toHaveBeenCalledOnce() })
  expect(shell.snapshot.attachmentIds).toEqual([])
  shell.dispose()
})

it('keeps restored ids out of a shell the scope already tore down', async () => {
  let finish: ((ids: readonly DraftAttachmentId[]) => void) | undefined
  const pending = new Promise<readonly DraftAttachmentId[]>((resolve) => { finish = resolve })
  const forget = vi.fn()
  const b = await hubPage({
    restoreDraftAttachments: vi.fn(() => pending),
    forgetDraftAttachment: forget,
    releaseDraftAttachment: vi.fn(),
  })
  const shell = b.hub.shellFor(b.binding)
  b.reference.release()
  await b.sessions.disposeScopes()
  finish?.(['late' as DraftAttachmentId])
  await pending
  await vi.waitFor(() => { expect(shell.snapshot.attachmentIds).toEqual([]) })
  expect(forget).not.toHaveBeenCalled()
})

it('forgets (never releases) a scope-torn-down draft attachment', async () => {
  const forget = vi.fn()
  const release = vi.fn()
  const b = await hubPage({
    restoreDraftAttachments: vi.fn(async () => []),
    forgetDraftAttachment: forget,
    releaseDraftAttachment: release,
  })
  const shell = b.hub.shellFor(b.binding)
  shell.addAttachments(['held' as DraftAttachmentId])
  expect(shell.snapshot.attachmentIds).toEqual(['held' as DraftAttachmentId])
  b.reference.release()
  await b.sessions.disposeScopes()
  expect(forget).toHaveBeenCalledWith('held' as DraftAttachmentId)
  expect(release).not.toHaveBeenCalled()
})
