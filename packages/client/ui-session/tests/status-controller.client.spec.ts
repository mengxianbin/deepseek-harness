/** Running-state ownership across the real Controller catalog and UI status source. */
import { expect, vi } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'

const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-client-ui-session']) })
const parentId = 'status-parent' as SessionId
const childId = 'status-child' as SessionId

it('preserves unlisted child status through metadata updates and keeps it lit through main-view entry (点名不改态)', async ({ mock, start }) => {
  mock.remote.session.list.mockResolvedValue(ok({ items: [{
    sessionId: parentId, updatedAt: 1, running: false, blank: false, agentAvailable: true,
  }] }))
  mock.remote.session.projections.mockResolvedValue(ok({
    kind: 'sequenced',
    asOfSeq: 0,
    values: { subagentCatalog: [{ id: childId, createdAt: 1, mode: 'continuable', label: 'Child' }] },
  }))
  mock.stream('session/follow', (_request, stream) => {
    stream.push({
      type: 'snapshot',
      header: { version: SESSION_FORMAT_VERSION, id: childId, createdAt: 1, isSeeded: false,
        parentSession: parentId, origin: 'subagent' },
      cursor: -1, records: [], hasMore: false,
      projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 },
    } satisfies SessionFollowFrame)
  })
  const client = await start()
  const sessions = client.ctx.sessions
  const ui = client.ctx.uiSession
  await sessions.refresh()
  await sessions.refreshProjections(parentId)
  await client.flush()
  expect(sessions.list.getSnapshot().ids).toEqual([parentId])
  expect(sessions.binding(childId)).toBeUndefined()
  expect(ui.sessionStatus.getSnapshot().get(childId)).toMatchObject({ running: undefined, completionUnread: false })

  mock.streams.push('$events', { type: 'emit', event: 'api-session/status', args: [childId, true] })
  await mock.streams.drained('$events')
  await client.flush()
  expect(ui.sessionStatus.getSnapshot().get(childId)).toMatchObject({ running: true, completionUnread: false })

  mock.streams.push('$events', { type: 'emit', event: 'api-session/activity', args: [parentId, 2] })
  await mock.streams.drained('$events')
  await client.flush()
  expect(sessions.list.getSnapshot().byId[parentId]?.updatedAt).toBe(2)
  expect(ui.sessionStatus.getSnapshot().get(childId)).toMatchObject({ running: true, completionUnread: false })

  // The Host failure report reaches the UI before the stop it ends, so the
  // stop acknowledges as failed instead of completed.
  mock.streams.push('$events', { type: 'emit', event: 'api-session/error', args: [childId, 'Connection error'] })
  await mock.streams.drained('$events')
  await client.flush()
  expect(ui.sessionStatus.getSnapshot().get(childId)).toMatchObject({ running: true, completionUnread: false })

  mock.streams.push('$events', { type: 'emit', event: 'api-session/status', args: [childId, false] })
  await mock.streams.drained('$events')
  await client.flush()
  expect(ui.sessionStatus.getSnapshot().get(childId)).toMatchObject({
    running: false, completionUnread: true, completionOutcome: 'failed',
  })

  using reference = sessions.retain(childId, { source: 'mainView' })
  await reference.ready
  expect(sessions.list.getSnapshot().ids).not.toContain(childId)
  // 点名不改态 (collab step3 §四): the row becoming main keeps the failure lit
  // and arms only the secondary 已阅 check.
  await vi.waitFor(() => {
    expect(ui.sessionStatus.getSnapshot().get(childId)).toMatchObject({
      running: false, completionUnread: true, completionOutcome: 'failed', readMarked: true,
    })
  })
  reference.release()
  await client.flush()
  // Navigating away changes nothing either: the failure and its check survive
  // until a real transition supersedes them.
  expect(ui.sessionStatus.getSnapshot().get(childId)?.completionUnread).toBe(true)
  expect(ui.sessionStatus.getSnapshot().get(childId)?.completionOutcome).toBe('failed')
  expect(ui.sessionStatus.getSnapshot().get(childId)?.readMarked).toBe(true)
})

it('keeps a running child lit across a Host-generation repair (投影清库窗口不剪枝)', async ({ mock, start }) => {
  // The narrow listing carries the parent's catalog (cold rows are its only
  // source), so the repair's own re-pull is what puts the child back in `byId`.
  mock.remote.session.list.mockResolvedValue(ok({ items: [{
    sessionId: parentId, updatedAt: 1, running: false, blank: false, agentAvailable: true,
    projections: { kind: 'sequenced' as const, asOfSeq: 0, values: {
      subagentCatalog: [{ id: childId, createdAt: 1, mode: 'continuable' as const, label: 'Child' }],
    } },
  }] }))
  const client = await start()
  const sessions = client.ctx.sessions
  const ui = client.ctx.uiSession
  await sessions.refresh()
  await client.flush()
  expect(sessions.list.getSnapshot().projectionsBySession[parentId]?.values.subagentCatalog).toHaveLength(1)
  expect(ui.sessionStatus.getSnapshot().get(childId)).toMatchObject({ running: undefined })

  mock.streams.push('$events', { type: 'emit', event: 'api-session/status', args: [childId, true] })
  await mock.streams.drained('$events')
  await client.flush()
  expect(ui.sessionStatus.getSnapshot().get(childId)).toMatchObject({ running: true })

  // A Host-generation repair discards every projection cut before the re-pull
  // lands. The catalog row is the only thing holding this child in `byId`, so
  // for that window the child drops out of `byId` while `list.phase` stays
  // 'ready' — the reconcile prune must not destroy the running fact the Host
  // already reported for it.
  //
  // `handleConnected` is the client's own generation-repair hook: deliberately
  // absent from the `ISessions` contract face (hand-built fakes implement that
  // interface), and "generation change → handleConnected" is already covered by
  // `client-apply.client.spec.ts`. This test owns the other half — what the
  // repair does to an unlisted child's observed running fact.
  const repair = sessions as unknown as { handleConnected(): void }
  repair.handleConnected()
  // Drain the window: the clear, the reconcile that used to prune in it, and
  // the repair's own re-pull that restores the catalog behind it.
  await client.flush()
  await vi.waitFor(() => {
    expect(sessions.list.getSnapshot().projectionsBySession[parentId]?.values.subagentCatalog).toHaveLength(1)
  })
  expect(ui.sessionStatus.getSnapshot().get(childId)).toMatchObject({ running: true })
})
