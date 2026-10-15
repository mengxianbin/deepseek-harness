/**
 * Browser-durable bytes for unsent composer draft attachments.
 *
 * The draft's text lives in the per-Session `dsh.conversation.<id>` localStorage
 * record, but the attachment objects themselves are `File`s owned by the
 * Conversation service in page memory — a page reload, a Host restart, or a
 * client-plugin `rebuilt` frame (which tears the plugin fiber down and
 * re-applies it) dropped them and left only the text behind. This module keeps
 * those bytes in IndexedDB, keyed by the draft attachment id and stamped with
 * their Session and intake order, so the service can rehydrate the rail after
 * any of those restarts.
 *
 * Storage is best-effort by contract: a runtime without IndexedDB, a denied
 * database, or a failed write degrades to the old in-memory-only behavior and
 * never breaks composer intake (callers receive a rejected promise they log,
 * never an exception on the intake path).
 */
import type { DraftAttachmentId } from './contract/input.ts'

/** IndexedDB namespace for unsent draft attachment bytes. */
const DATABASE_NAME = 'dsh.conversation.draft-attachments'

/** Object store identity (keyPath `id`). */
const STORE_NAME = 'attachments'

/** Index selecting one Session's draft attachments. */
const SESSION_INDEX = 'bySession'

/** Schema version handed to `indexedDB.open`. */
const DATABASE_VERSION = 1

/** Restorable draft attachment shape persisted by {@link persistDraftAttachments}. */
export interface StoredDraftAttachment {
  /** Draft-local identity shared with the live rail. */
  readonly id: DraftAttachmentId
  /** Session whose unsent draft still owns this attachment. */
  readonly sessionId: string
  /** Intake order within the Session (ascending restore order). */
  readonly seq: number
  /** Descriptor kind, so a restore rebuilds the same rail row. */
  readonly kind: 'image' | 'file'
  /** Browser file name presented in the rail and the prompt. */
  readonly name: string
  /** Browser-declared MIME type selecting image versus file treatment. */
  readonly mediaType: string
  /** File last-modified stamp, restored onto the rebuilt File. */
  readonly lastModified: number
  /** Last intake or restore instant, the retention sweep's cutoff input. */
  readonly savedAt: number
  /** Original bytes, structured-cloned as a Blob. */
  readonly blob: Blob
}

/** One attachment the caller wants persisted for a Session's draft. */
export interface DraftAttachmentSeed {
  /** Draft-local identity shared with the live rail. */
  readonly id: DraftAttachmentId
  /** Descriptor kind, mirroring the live ComposerAttachment. */
  readonly kind: 'image' | 'file'
  /** Browser file carrying the bytes and identity fields. */
  readonly file: File
}

let connection: Promise<IDBDatabase> | undefined

/** The browser database factory, absent outside a browser runtime. */
function databaseFactory(): IDBFactory | undefined {
  return typeof indexedDB === 'undefined' ? undefined : indexedDB
}

/**
 * Open (and lazily upgrade) the draft-attachment database, cached for the
 * document lifetime. A failed open clears the cache so a later attempt can
 * retry instead of inheriting one transient rejection forever.
 * @returns the open connection, or undefined when IndexedDB is unavailable.
 */
function openDatabase(): Promise<IDBDatabase> | undefined {
  const factory = databaseFactory()
  if (factory === undefined) return undefined
  if (connection !== undefined) return connection
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex(SESSION_INDEX, 'sessionId')
      }
    }
    request.onerror = () => { reject(request.error ?? new Error('conversation: draft attachment store unavailable')) }
    request.onsuccess = () => { resolve(request.result) }
  })
  connection = pending.catch((error: unknown) => {
    connection = undefined
    throw error
  })
  return connection
}

/**
 * Persist one Session's newly picked draft attachments under its intake order.
 * @param sessionId - Session whose unsent draft owns the attachments.
 * @param seeds - attachments in intake order.
 * @returns after every record is written; rejects when storage is unavailable.
 */
export async function persistDraftAttachments(
  sessionId: string,
  seeds: readonly DraftAttachmentSeed[],
): Promise<void> {
  if (seeds.length === 0) return
  const database = openDatabase()
  if (database === undefined) return
  const db = await database
  const now = Date.now()
  const base = await nextSequence(db, sessionId)
  const records: StoredDraftAttachment[] = seeds.map((seed, index) => ({
    id: seed.id,
    sessionId,
    seq: base + index,
    kind: seed.kind,
    name: seed.file.name,
    mediaType: seed.file.type,
    lastModified: seed.file.lastModified,
    savedAt: now,
    blob: seed.file,
  }))
  await writeRecords(db, records)
}

/**
 * Read one Session's stored draft attachments in intake order, refreshing
 * their retention stamp: a draft the browser just restored is alive, so the
 * sweep must not read its age as abandonment.
 * @param sessionId - Session whose unsent draft owns the attachments.
 * @returns the stored records, or an empty list when none exist or storage is unavailable.
 */
export async function loadDraftAttachments(sessionId: string): Promise<readonly StoredDraftAttachment[]> {
  const database = openDatabase()
  if (database === undefined) return []
  const db = await database
  const records = await readSessionRecords(db, sessionId)
  const sorted = [...records].sort((left, right) => left.seq - right.seq)
  const savedAt = Date.now()
  await writeRecords(db, sorted
    .filter(record => record.savedAt !== savedAt)
    .map(record => ({ ...record, savedAt })))
  return sorted
}

/**
 * Drop one attachment's bytes, releasing them the moment the draft gives it up.
 * @param id - draft attachment id.
 * @returns after the delete settles; rejects when storage is unavailable.
 */
export async function deleteDraftAttachment(id: DraftAttachmentId): Promise<void> {
  const database = openDatabase()
  if (database === undefined) return
  const db = await database
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id)
    request.onerror = () => { reject(request.error ?? new Error('conversation: draft attachment delete failed')) }
    request.onsuccess = () => { resolve() }
  })
}

/**
 * Re-key carried attachments onto their destination Session, appending them at
 * the destination's intake tail so a later restore keeps the carried order.
 * @param sessionId - destination Session receiving the carried draft.
 * @param ids - draft attachment ids moving to the destination.
 * @returns after every record is re-keyed; rejects when storage is unavailable.
 */
export async function moveDraftAttachments(sessionId: string, ids: readonly DraftAttachmentId[]): Promise<void> {
  if (ids.length === 0) return
  const database = openDatabase()
  if (database === undefined) return
  const db = await database
  const base = await nextSequence(db, sessionId)
  for (const [index, id] of ids.entries()) {
    const stored = await readRecord(db, id)
    /* v8 ignore next -- an id without bytes was never persisted; the rail already skips it. */
    if (stored === undefined) continue
    await writeRecord(db, { ...stored, sessionId, seq: base + index })
  }
}

/** Retention applied to a persisted draft attachment, in milliseconds. */
export const DRAFT_ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Delete attachments untouched longer than the retention window: the only
 * records that can outlive their draft are a removed Session's leftovers or a
 * write interrupted before its release reached storage. Intake and every
 * restore refresh the stamp, so a live draft is never swept.
 * @param retentionMs - age cutoff measured from the last intake or restore.
 * @param now - clock override for tests.
 * @returns the number of expired records removed.
 */
export async function sweepDraftAttachments(
  retentionMs = DRAFT_ATTACHMENT_RETENTION_MS,
  now = Date.now(),
): Promise<number> {
  const database = openDatabase()
  if (database === undefined) return 0
  const db = await database
  const records = await new Promise<StoredDraftAttachment[]>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll()
    request.onerror = () => { reject(request.error ?? new Error('conversation: draft attachment sweep read failed')) }
    request.onsuccess = () => { resolve((request.result as StoredDraftAttachment[] | undefined) ?? []) }
  })
  const expired = records.filter(record => record.savedAt < now - retentionMs)
  for (const record of expired) await deleteDraftAttachment(record.id)
  return expired.length
}

/**
 * Release a persisted record back into a live File for the restored rail.
 * @param record - stored attachment.
 * @returns the rebuilt browser File carrying the original identity fields.
 */
export function fileOfStoredDraftAttachment(record: StoredDraftAttachment): File {
  return new File([record.blob], record.name, {
    type: record.mediaType,
    lastModified: record.lastModified,
  })
}

/** @returns one Session's stored records from an open connection. */
async function readSessionRecords(db: IDBDatabase, sessionId: string): Promise<readonly StoredDraftAttachment[]> {
  return new Promise<StoredDraftAttachment[]>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly')
      .objectStore(STORE_NAME)
      .index(SESSION_INDEX)
      .getAll(sessionId)
    request.onerror = () => { reject(request.error ?? new Error('conversation: draft attachment read failed')) }
    request.onsuccess = () => { resolve((request.result as StoredDraftAttachment[] | undefined) ?? []) }
  })
}

/** @returns the intake sequence following a Session's highest stored attachment. */
async function nextSequence(db: IDBDatabase, sessionId: string): Promise<number> {
  const records = await readSessionRecords(db, sessionId)
  if (records.length === 0) return 0
  return Math.max(...records.map(record => record.seq)) + 1
}

/** @returns one stored attachment, or undefined when the id no longer resolves. */
async function readRecord(db: IDBDatabase, id: DraftAttachmentId): Promise<StoredDraftAttachment | undefined> {
  return new Promise<StoredDraftAttachment | undefined>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)
    request.onerror = () => { reject(request.error ?? new Error('conversation: draft attachment read failed')) }
    request.onsuccess = () => { resolve(request.result as StoredDraftAttachment | undefined) }
  })
}

/** Write one stored attachment back, re-keying it onto its destination Session. */
async function writeRecord(db: IDBDatabase, record: StoredDraftAttachment): Promise<void> {
  await writeRecords(db, [record])
}

/** Write a batch of stored attachments in one transaction, resolving when every put settles. */
async function writeRecords(db: IDBDatabase, records: readonly StoredDraftAttachment[]): Promise<void> {
  if (records.length === 0) return
  await new Promise<void>((resolve, reject) => {
    let pending = records.length
    const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME)
    for (const record of records) {
      const write = store.put(record)
      write.onerror = () => {
        reject(write.error ?? new Error('conversation: draft attachment write failed'))
        return
      }
      write.onsuccess = () => {
        pending -= 1
        if (pending === 0) resolve()
      }
    }
  })
}
