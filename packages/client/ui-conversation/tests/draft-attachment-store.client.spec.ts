// @vitest-environment jsdom
/** Draft attachment bytes persist, restore in intake order, and degrade without IndexedDB. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftAttachmentId } from '../src/client/contract/input.ts'
import {
  DRAFT_ATTACHMENT_RETENTION_MS, deleteDraftAttachment, fileOfStoredDraftAttachment,
  loadDraftAttachments, moveDraftAttachments, persistDraftAttachments, sweepDraftAttachments,
} from '../src/client/draft-attachment-store.ts'
import { FakeIndexedDB } from './support/fake-indexeddb.ts'

const fake = new FakeIndexedDB()

let idSequence = 0

/** One intake batch under readable, collision-free ids. */
function seeds(sessionId: string, names: readonly string[]): { id: DraftAttachmentId; kind: 'image' | 'file'; file: File }[] {
  return names.map((name) => {
    const image = name.endsWith('.png')
    idSequence += 1
    return {
      id: `${sessionId}-${idSequence}` as DraftAttachmentId,
      kind: image ? ('image' as const) : ('file' as const),
      file: new File([name], name, { type: image ? 'image/png' : 'text/plain' }),
    }
  })
}

beforeEach(() => {
  fake.reset()
  vi.stubGlobal('indexedDB', fake)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('draft attachment store', () => {
  it('degrades to no persistence without a browser database', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const [seed] = seeds('s1', ['shot.png'])
    await expect(persistDraftAttachments('s1', [seed!])).resolves.toBeUndefined()
    await expect(loadDraftAttachments('s1')).resolves.toEqual([])
    await expect(deleteDraftAttachment(seed!.id)).resolves.toBeUndefined()
    await expect(moveDraftAttachments('s2', [seed!.id])).resolves.toBeUndefined()
    await expect(sweepDraftAttachments()).resolves.toBe(0)
  })

  it('rejects the intake write when the database cannot open and recovers on retry', async () => {
    fake.failNextOpen = true
    const [seed] = seeds('s1', ['shot.png'])
    await expect(persistDraftAttachments('s1', [seed!])).rejects.toThrow('indexeddb open denied')
    // The failed open cleared its cached connection: the next attempt retries.
    await expect(persistDraftAttachments('s1', [seed!])).resolves.toBeUndefined()
    expect(fake.rows('attachments')).toHaveLength(1)
  })

  it('persists a batch and restores it in intake order with its original file identity', async () => {
    const batch = seeds('s1', ['first.png', 'note.txt'])
    await persistDraftAttachments('s1', batch)
    const stored = await loadDraftAttachments('s1')
    expect(stored.map(record => record.id)).toEqual(batch.map(seed => seed.id))
    expect(stored.map(record => record.kind)).toEqual(['image', 'file'])
    const [image] = stored
    const restored = fileOfStoredDraftAttachment(image!)
    expect(restored.name).toBe('first.png')
    expect(restored.type).toBe('image/png')
    expect(await restored.text()).toBe('first.png')
  })

  it('appends a later batch after the earlier intake order and isolates Sessions', async () => {
    const first = seeds('s1', ['first.png'])
    const later = seeds('s1', ['later.png'])
    const other = seeds('s2', ['other.png'])
    await persistDraftAttachments('s1', first)
    await persistDraftAttachments('s2', other)
    await persistDraftAttachments('s1', later)
    expect((await loadDraftAttachments('s1')).map(record => record.id))
      .toEqual([first[0]!.id, later[0]!.id])
    expect((await loadDraftAttachments('s2')).map(record => record.id)).toEqual([other[0]!.id])
    expect((await loadDraftAttachments('s1')).map(record => record.seq)).toEqual([0, 1])
  })

  it('drops only the released attachment', async () => {
    const batch = seeds('s1', ['first.png', 'note.txt'])
    await persistDraftAttachments('s1', batch)
    await deleteDraftAttachment(batch[1]!.id)
    expect((await loadDraftAttachments('s1')).map(record => record.id)).toEqual([batch[0]!.id])
    await deleteDraftAttachment(batch[0]!.id)
    expect(await loadDraftAttachments('s1')).toEqual([])
    // Deleting an id that never reached storage is a silent no-op.
    await expect(deleteDraftAttachment('ghost' as DraftAttachmentId)).resolves.toBeUndefined()
  })

  it('re-keys a carried attachment onto its destination draft tail', async () => {
    const origin = seeds('s1', ['carry.png'])
    const destination = seeds('s2', ['kept.png'])
    await persistDraftAttachments('s1', origin)
    await persistDraftAttachments('s2', destination)
    await moveDraftAttachments('s2', [origin[0]!.id])
    expect(await loadDraftAttachments('s1')).toEqual([])
    const moved = await loadDraftAttachments('s2')
    expect(moved.map(record => record.id)).toEqual([destination[0]!.id, origin[0]!.id])
    expect(moved[1]?.sessionId).toBe('s2')
    // Carrying an id that was never stored stays silent.
    await expect(moveDraftAttachments('s2', ['ghost' as DraftAttachmentId])).resolves.toBeUndefined()
    await expect(moveDraftAttachments('s3', [])).resolves.toBeUndefined()
  })

  it('sweeps attachments older than the retention window', async () => {
    const stale = seeds('s1', ['stale.png'])
    await persistDraftAttachments('s1', stale)
    const now = Date.now() + DRAFT_ATTACHMENT_RETENTION_MS + 1
    expect(await sweepDraftAttachments(DRAFT_ATTACHMENT_RETENTION_MS, now)).toBe(1)
    expect(await loadDraftAttachments('s1')).toEqual([])
  })

  it('keeps a fresh attachment when the sweep clock stays inside retention', async () => {
    const fresh = seeds('s1', ['fresh.png'])
    await persistDraftAttachments('s1', fresh)
    expect(await sweepDraftAttachments(DRAFT_ATTACHMENT_RETENTION_MS, Date.now())).toBe(0)
    expect(await loadDraftAttachments('s1')).toHaveLength(1)
  })

  it('refreshes retention on restore so a live draft is never swept', async () => {
    const batch = seeds('s1', ['kept.png'])
    await persistDraftAttachments('s1', batch)
    const [stored] = fake.rows('attachments')
    if (stored === undefined) throw new Error('stored record missing')
    // An intake far outside the window: only the restore can save it.
    stored['savedAt'] = 0
    expect(await loadDraftAttachments('s1')).toHaveLength(1)
    const [touched] = fake.rows('attachments')
    expect(touched?.['savedAt']).toBeGreaterThan(Date.now() - DRAFT_ATTACHMENT_RETENTION_MS)
    expect(await sweepDraftAttachments(DRAFT_ATTACHMENT_RETENTION_MS, Date.now())).toBe(0)
  })
})
