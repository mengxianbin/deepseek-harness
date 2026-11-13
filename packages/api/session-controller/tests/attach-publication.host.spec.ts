/**
 * Workspace-attach publication ordering over the REAL agent-loop factory.
 *
 * These pin the S2 flash fix where the mock publication-contract factory
 * could not: the production loop publishes a Session before its setup window
 * runs the Workspace attach, so the first `api-session/added` frame used to
 * surface the row before its group existed. The gate must make the row's
 * first visible frame land after the attach — exactly once, and on the
 * failure path too — without touching non-attaching creates.
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { SessionPublicationGate } from '../src/publication-gate.ts'
import type { SessionSummary } from '../src/types.ts'
import { createSessionTestRemote } from './test-remote.ts'
import type { TestSessionRemote } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

/** One unit harness: real loop, full Session Controller, timeline-recording Workspace. */
interface AttachHarness {
  readonly ctx: Context
  readonly workspace: Workspace & { sessionIds: SessionId[] }
  readonly remote: TestSessionRemote
  /** Ordered trace of `attach` steps and `added:<id>` frames. */
  readonly timeline: string[]
}

async function harness(options: { readonly attachError?: Error } = {}): Promise<AttachHarness> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('fixture')]))
  const timeline: string[] = []
  const sessionIds: SessionId[] = []
  const path = mkdtempSync(join(tmpdir(), 'dsh-attach-publication-'))
  onTestFinished(() => {
    rmSync(path, { recursive: true, force: true })
  })
  const id = 'workspace-attach-publication' as WorkspaceId
  const workspace = {
    id,
    path,
    sessionIds,
    attachSession: async (sessionId: SessionId) => {
      timeline.push('attach')
      // The real loop announces the Session before its setup window
      // attaches: this is exactly the order the gate must survive.
      expect(ctx.sessions.get(sessionId)).toBeDefined()
      if (options.attachError !== undefined) throw options.attachError
      sessionIds.push(sessionId)
    },
  }
  ctx.provide('workspaceRegistry', {
    get: (requested: WorkspaceId) => requested === id ? workspace : undefined,
    list: () => [workspace],
    archivedSessionIds: [],
  } as never)
  ctx.on('api-session/added', (summary: SessionSummary) => {
    timeline.push(`added:${summary.sessionId}`)
  })
  const remote = await createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
    cwd: workspace.path,
  })
  return {
    ctx,
    workspace: workspace as unknown as Workspace & { sessionIds: SessionId[] },
    remote,
    timeline,
  }
}

describe('attach publication over the real agent-loop factory', () => {
  it('publishes a Workspace-attached create exactly once, after its attach', async () => {
    const { workspace, remote, timeline } = await harness()
    const response = await remote.create({ workspaceId: workspace.id })
    if (!response.ok) throw new Error(`create failed: ${response.error.message}`)
    expect(timeline).toEqual(['attach', `added:${response.value.sessionId}`])
    expect(workspace.sessionIds).toContain(response.value.sessionId)
  })

  it('still surfaces the row when the attach fails, then reports the failure', async () => {
    const { workspace, remote, timeline } = await harness({ attachError: new Error('workspace is read-only') })
    const response = await remote.create({ workspaceId: workspace.id })
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe('session/workspace-attach-failed')
    const { sessionId } = response.error.details as { sessionId: SessionId }
    // The row must never disappear with the failed attach: it lands
    // Ungrouped, exactly as the pre-regression contract promised.
    expect(timeline).toEqual(['attach', `added:${sessionId}`])
    expect(workspace.sessionIds).not.toContain(sessionId)
  })

  it('leaves a create without a Workspace attach untouched', async () => {
    const { remote, timeline } = await harness()
    const response = await remote.create({})
    if (!response.ok) throw new Error(`create failed: ${response.error.message}`)
    // Ungated creations keep their historical frames: session/created, then
    // the agent/created availability update.
    expect(timeline).toEqual([
      `added:${response.value.sessionId}`,
      `added:${response.value.sessionId}`,
    ])
  })

  it('publishes a fork child exactly once, after its attach', async () => {
    const { ctx, workspace, remote, timeline } = await harness()
    const source = ctx.sessions.create(sid('fork-attach-source'), { meta: { cwd: workspace.path } })
    source.append('turn/start', { turn: 1 })
    source.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'seed' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    workspace.sessionIds.push(source.id)
    timeline.length = 0
    const response = await remote.fork({ sessionId: source.id })
    if (!response.ok) throw new Error(`fork failed: ${response.error.message}`)
    expect(timeline).toEqual(['attach', `added:${response.value.sessionId}`])
  })
})

describe('SessionPublicationGate state machine', () => {
  const session = { id: sid('gated') } as Session
  function gated(): { gate: SessionPublicationGate; published: string[] } {
    const gate = new SessionPublicationGate()
    const published: string[] = []
    gate.publish = publishedSession => published.push(publishedSession.id)
    return { gate, published }
  }

  it('withholds the announcement and publishes at the attach settle (announce-first loop)', () => {
    const { gate, published } = gated()
    gate.hold(session.id)
    expect(gate.sessionCreated(session)).toBe(false)
    expect(published).toEqual([])
    gate.attachSettled(session.id)
    expect(published).toEqual([session.id])
    expect(gate.agentCreated(session.id)).toBe(false)
    expect(published).toEqual([session.id])
  })

  it('publishes on the announcement when the attach settled first (setup-first loop)', () => {
    const { gate, published } = gated()
    gate.hold(session.id)
    gate.attachSettled(session.id)
    expect(published).toEqual([])
    expect(gate.sessionCreated(session)).toBe(false)
    expect(published).toEqual([session.id])
    expect(gate.agentCreated(session.id)).toBe(false)
    expect(published).toEqual([session.id])
  })

  it('withholds an agent announced before its attach, then publishes at the settle', () => {
    const { gate, published } = gated()
    gate.hold(session.id)
    expect(gate.sessionCreated(session)).toBe(false)
    expect(gate.agentCreated(session.id)).toBe(false)
    expect(published).toEqual([])
    gate.attachSettled(session.id)
    expect(published).toEqual([session.id])
  })

  it('passes ungated sessions through every listener untouched', () => {
    const { gate } = gated()
    expect(gate.sessionCreated(session)).toBe(true)
    expect(gate.agentCreated(session.id)).toBe(true)
    expect(gate.agentDisposed(session.id)).toBe(true)
  })

  it('releases a folded-back creation without publishing', () => {
    const { gate, published } = gated()
    gate.hold(session.id)
    expect(gate.sessionCreated(session)).toBe(false)
    gate.release(session.id)
    gate.attachSettled(session.id)
    expect(published).toEqual([])
  })

  it('swallows the disposal of a still-gated creation', () => {
    const { gate, published } = gated()
    gate.hold(session.id)
    expect(gate.sessionCreated(session)).toBe(false)
    expect(gate.agentDisposed(session.id)).toBe(false)
    expect(published).toEqual([])
  })
})
