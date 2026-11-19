/**
 * The mailbox panel's HTTP surface (改版 A/C, 设计档 §七 双栏视图): `GET` returns
 * the fresh fold report, `POST { id, action: 'read' | 'restore' }` applies one
 * human action through the SAME single writer as the fold
 * ({@link acknowledgeAlert} / {@link restoreAlert}) and answers with the
 * refreshed report — the panel never writes the box itself.
 *
 * Mounted on the `connection/request` waterfall, which the connection plugin
 * runs **after** admission: an unauthenticated request never reaches this
 * listener (401 from the fence), so the route inherits the /api auth instead of
 * opening a second, unfenced door. Listeners that do not own the path call
 * `next()` and fall through to the bridge.
 * @module session-controller/alert-inbox-route
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { acknowledgeAlert, restoreAlert, syncAlertInbox } from './alert-inbox.ts'
import { ALERT_INBOX_PATH } from './types.ts'

/** Bounded body read — the panel posts two fields; anything bigger is a mistake. */
const MAX_BODY_BYTES = 16 * 1024

function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * `connection/request` listener owning {@link ALERT_INBOX_PATH}.
 * @param request - the admitted inbound request.
 * @param response - the response to write when this path is owned.
 * @param next - the bridge fallback for every other path.
 * @returns nothing; unmatched paths delegate.
 */
export async function alertInboxRequest(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => Promise<void>,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (url.pathname !== ALERT_INBOX_PATH) {
    await next()
    return
  }
  if (request.method === 'GET') {
    send(response, 200, { ok: true, report: syncAlertInbox() ?? null })
    return
  }
  if (request.method !== 'POST') {
    send(response, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  const raw = await readBody(request)
  if (raw === undefined) {
    send(response, 413, { ok: false, error: 'body-too-large' })
    return
  }
  let id: unknown
  let action: unknown
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      id = Reflect.get(parsed, 'id')
      action = Reflect.get(parsed, 'action')
    }
  } catch { /* fall through to the 400 below */ }
  if (typeof id !== 'string' || id === '' || (action !== 'read' && action !== 'restore')) {
    send(response, 400, { ok: false, error: 'bad-request' })
    return
  }
  const applied = action === 'read' ? acknowledgeAlert(id) : restoreAlert(id)
  if (!applied) {
    send(response, 404, { ok: false, error: 'unknown-entry' })
    return
  }
  send(response, 200, { ok: true, report: syncAlertInbox() ?? null })
}
