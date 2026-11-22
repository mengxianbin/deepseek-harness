/**
 * The mailbox panel's HTTP surface (改版 A/C, `alert-inbox-route.ts`): the
 * `connection/request` listener owns exactly `ALERT_INBOX_PATH` and delegates
 * every other path to the bridge (`next()`), so the panel's actions ride the
 * connection plugin's admission instead of opening an unfenced door.
 *
 * Actions go through the SAME single writer as the fold — `POST {id, action}`
 * applies 已读/恢复 and answers with the refreshed report (the panel's
 * optimistic flip reads this response); the listener itself never builds
 * document state.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { alertInboxRequest } from '../src/alert-inbox-route.ts'
import { syncAlertInbox } from '../src/alert-inbox.ts'
import { ALERT_INBOX_PATH } from '../src/types.ts'

/** One row of the report's two-column union (the fold's published entry view). */
interface ReportEntry {
  id: string
  cause: string
  lastAt: number
  count: number
  unread: boolean
  archived: boolean
}

/** The refreshed report the action face answers with (`reportOf` shape). */
interface Report {
  at: number
  unread: number
  escalated: number
  total: number
  entries: ReportEntry[]
}

/** The success envelope of GET/POST (`{ ok, report }` — read side of the route). */
interface Envelope {
  ok: boolean
  report: Report
}

/** The on-disk document this test reads (the single writer's `alert-inbox.json`). */
interface InboxFile {
  entries: ReportEntry[]
}

let home: string | undefined

afterEach(() => {
  vi.unstubAllEnvs()
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

function fakeRequest(method: string, url: string, body?: string): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

function fakeResponse(): { response: ServerResponse; state: { status?: number; body?: string } } {
  const state: { status?: number; body?: string } = {}
  const response = {
    writeHead(status: number): void {
      state.status = status
    },
    end(body?: string): void {
      if (body !== undefined) state.body = body
    },
  }
  return { response: response as unknown as ServerResponse, state }
}

async function call(
  method: string,
  url: string,
  body?: string,
): Promise<{ status?: number; body?: string; nextCalls: number }> {
  const { response, state } = fakeResponse()
  let nextCalls = 0
  await alertInboxRequest(fakeRequest(method, url, body), response, async () => { nextCalls += 1 })
  return { ...state, nextCalls }
}

/** A document the fold can own: one unread source class (改判 D 的出生形态). */
function seedInbox(): void {
  home = mkdtempSync(join(tmpdir(), 'inbox-route-'))
  vi.stubEnv('DSH_HOME', home)
  const at = Date.now()
  writeFileSync(join(home, 'restart-alert-source.json'), JSON.stringify({
    at,
    schema: 'restart-alert-source/1',
    facts: { 'restart-storm': { lastAt: at, count24h: 6 } },
  }), 'utf8')
  syncAlertInbox(at)
}

describe('alertInboxRequest', () => {
  it('wire path 双侧钉死: host 常量 == client 字面（跨插件不许 value import，靠两侧测试互锁）', () => {
    expect(ALERT_INBOX_PATH).toBe('/api/session-controller/alert-inbox')
  })

  it('owns only ALERT_INBOX_PATH — every other path delegates to the bridge', async () => {
    const result = await call('GET', '/api/elsewhere')
    expect(result.nextCalls).toBe(1)
    expect(result.status).toBeUndefined()
  })

  it('GET without an attached plane answers 200 with a null report (quiet, never broken)', async () => {
    home = mkdtempSync(join(tmpdir(), 'inbox-route-empty-'))
    vi.stubEnv('DSH_HOME', home)
    const result = await call('GET', ALERT_INBOX_PATH)
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body ?? '{}')).toEqual({ ok: true, report: null })
  })

  it('rejects a method other than GET/POST with 405', async () => {
    const result = await call('DELETE', ALERT_INBOX_PATH)
    expect(result.status).toBe(405)
  })

  it('rejects a malformed or incomplete action body with 400', async () => {
    seedInbox()
    expect((await call('POST', ALERT_INBOX_PATH, '{')).status).toBe(400)
    expect((await call('POST', ALERT_INBOX_PATH, JSON.stringify({ id: 'x' }))).status).toBe(400)
    expect((await call('POST', ALERT_INBOX_PATH, JSON.stringify({ id: 'x', action: 'forget' }))).status).toBe(400)
  })

  it('answers 404 for an unknown entry id (never invents a row)', async () => {
    seedInbox()
    const result = await call('POST', ALERT_INBOX_PATH, JSON.stringify({ id: 'fam-nope', action: 'read' }))
    expect(result.status).toBe(404)
  })

  it('已读 → 200 + refreshed report (unread flips out); 恢复 → flips back — single writer both ways', async () => {
    seedInbox()
    const inbox = (): InboxFile => JSON.parse(readFileSync(join(home as string, 'alert-inbox.json'), 'utf8')) as InboxFile
    const id = inbox().entries[0]?.id as string
    expect(inbox().entries[0]?.unread).toBe(true)

    const read = await call('POST', ALERT_INBOX_PATH, JSON.stringify({ id, action: 'read' }))
    expect(read.status).toBe(200)
    const { report: readReport } = JSON.parse(read.body ?? '{}') as Envelope
    expect(readReport.unread).toBe(0)
    expect(readReport.entries[0]).toMatchObject({ id, unread: false, archived: true })
    expect(inbox().entries[0]).toMatchObject({ id, unread: false, archived: true })

    const restore = await call('POST', ALERT_INBOX_PATH, JSON.stringify({ id, action: 'restore' }))
    expect(restore.status).toBe(200)
    const { report: restoreReport } = JSON.parse(restore.body ?? '{}') as Envelope
    expect(restoreReport.unread).toBe(1)
    expect(inbox().entries[0]).toMatchObject({ id, unread: true, archived: false })
  })

  it('GET after a fold returns the fresh report (the panel reload path)', async () => {
    seedInbox()
    const result = await call('GET', ALERT_INBOX_PATH)
    expect(result.status).toBe(200)
    const { report } = JSON.parse(result.body ?? '{}') as Envelope
    expect(report.unread).toBe(1)
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]?.cause).toBe('restart-storm')
  })
})
