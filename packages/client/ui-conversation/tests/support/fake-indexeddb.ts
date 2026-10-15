/**
 * Minimal in-memory IndexedDB stand-in for the jsdom test lane.
 *
 * jsdom ships no `indexedDB`, so the draft-attachment store's browser path
 * needs a small faithful surface: `open` with an upgrade step, one object
 * store with a keyPath, `put`/`get`/`delete`/`getAll`, and the `bySession`
 * index. Everything answers on a microtask, matching the real API's
 * asynchronous handler delivery (callers assign handlers before they fire).
 */

/** Request handler shape used by both the fake and the module under test. */
type Handler = ((event: { target: unknown }) => void) | null

/** One stored row (the module's StoredDraftAttachment records). */
type Row = Record<string, unknown>

/** One pending request, mirroring the IDBRequest surface the store uses. */
class FakeRequest<T> {
  result: T | undefined = undefined
  error: Error | null = null
  onsuccess: Handler = null
  onerror: Handler = null
  onupgradeneeded: Handler = null

  succeed(value: T): void {
    queueMicrotask(() => {
      this.result = value
      this.onsuccess?.({ target: this })
    })
  }

  fail(message: string): void {
    queueMicrotask(() => {
      this.error = new Error(message)
      this.onerror?.({ target: this })
    })
  }
}

/** Shared index definitions: index name → queried field. */
type IndexSchema = Map<string, string>

/** One object store over its stable row map. */
class FakeObjectStore {
  constructor(private readonly rows: Map<string, Row>, private readonly indexes: IndexSchema) {}

  createIndex(name: string, field: string): void {
    this.indexes.set(name, field)
  }

  put(value: Row): FakeRequest<void> {
    const key = value['id']
    if (typeof key !== 'string') {
      const request = new FakeRequest<void>()
      request.fail('keyPath value missing')
      return request
    }
    this.rows.set(key, value)
    const request = new FakeRequest<void>()
    request.succeed(undefined)
    return request
  }

  get(key: string): FakeRequest<Row | undefined> {
    const request = new FakeRequest<Row | undefined>()
    request.succeed(this.rows.get(key))
    return request
  }

  delete(key: string): FakeRequest<void> {
    this.rows.delete(key)
    const request = new FakeRequest<void>()
    request.succeed(undefined)
    return request
  }

  getAll(): FakeRequest<Row[]> {
    const request = new FakeRequest<Row[]>()
    request.succeed([...this.rows.values()])
    return request
  }

  index(name: string): FakeIndex {
    return new FakeIndex(this.rows, this.indexes.get(name) ?? name)
  }
}

/** One index query: all rows whose indexed field equals the key. */
class FakeIndex {
  constructor(private readonly rows: Map<string, Row>, private readonly field: string) {}

  getAll(key: string): FakeRequest<Row[]> {
    const request = new FakeRequest<Row[]>()
    request.succeed([...this.rows.values()].filter(row => row[this.field] === key))
    return request
  }
}

/** One transaction: the store hand-out the module chains its requests from. */
class FakeTransaction {
  constructor(
    private readonly stores: Map<string, Map<string, Row>>,
    private readonly indexes: IndexSchema,
  ) {}

  objectStore(name: string): FakeObjectStore {
    const rows = this.stores.get(name)
    if (rows === undefined) throw new Error(`fake indexeddb: no object store ${name}`)
    return new FakeObjectStore(rows, this.indexes)
  }
}

/** One open database over the factory's stable store maps. */
class FakeDatabase {
  readonly objectStoreNames: { contains: (name: string) => boolean }

  constructor(
    private readonly stores: Map<string, Map<string, Row>>,
    private readonly indexes: IndexSchema,
  ) {
    this.objectStoreNames = { contains: name => this.stores.has(name) }
  }

  createObjectStore(name: string): FakeObjectStore {
    const rows = new Map<string, Row>()
    this.stores.set(name, rows)
    return new FakeObjectStore(rows, this.indexes)
  }

  transaction(name: string): FakeTransaction {
    if (!this.stores.has(name)) throw new Error(`fake indexeddb: no object store ${name}`)
    return new FakeTransaction(this.stores, this.indexes)
  }
}

/** The installable factory: one shared database image for a test file. */
export class FakeIndexedDB {
  /** Stable store image; `reset()` empties it in place so open handles stay live. */
  private readonly stores = new Map<string, Map<string, Row>>()
  private readonly indexes: IndexSchema = new Map()
  private readonly upgraded = new Set<string>()
  /** When set, the next `open` fails instead of resolving. */
  failNextOpen = false

  /** @returns this factory, ready to install with `vi.stubGlobal('indexedDB', ...)`. */
  get factory(): this {
    return this
  }

  /** Rows currently stored under one object store, for direct assertions. */
  rows(store: string): readonly Row[] {
    return [...(this.stores.get(store) ?? new Map<string, Row>()).values()]
  }

  /** Empty the database image without invalidating already-open handles. */
  reset(): void {
    for (const rows of this.stores.values()) rows.clear()
    this.upgraded.clear()
    this.failNextOpen = false
  }

  /** @param name - database name (the upgrade step keys off it). @param _version - requested schema version. */
  open(name: string, _version?: number): FakeRequest<FakeDatabase> {
    const request = new FakeRequest<FakeDatabase>()
    queueMicrotask(() => {
      if (this.failNextOpen) {
        this.failNextOpen = false
        request.fail('indexeddb open denied')
        return
      }
      const database = new FakeDatabase(this.stores, this.indexes)
      request.result = database
      if (!this.upgraded.has(name)) {
        this.upgraded.add(name)
        request.onupgradeneeded?.({ target: request })
      }
      request.succeed(database)
    })
    return request
  }
}
