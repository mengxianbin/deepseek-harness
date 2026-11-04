/**
 * The 安康位 reconciliation (collab step1 §2.2 三不变量, step2 §4.3; step4b
 * 接力批2 件C5): the pure audit gets one violating and one balanced injection
 * per invariant, and the sweep integration proves the cadence actually
 * publishes the frame the client shield subscribes to.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SESSION_STATUS_SWEEP_MS } from '../src/index.ts'
import { reconcileSessionHealth } from '../src/health.ts'
import type { SessionHealthRow } from '../src/types.ts'
import { createSessionTestController } from './test-remote.ts'

// 批2 duty-shield-b2-1103: the sweep folds the 值守总账 into the SAME frame —
// the reader is mocked so this integration assertion stays machine-independent
// while still proving the CALL SITE (a sweep that stopped reading the ledger
// would drop the `duty` key and fail the toEqual below). The reader's own
// behavior — freshness, three states, fail-closed — lives in duty.spec.ts.
const { dutyFixture } = vi.hoisted(() => ({
  dutyFixture: {
    ok: true,
    fresh: true,
    ageSec: 42,
    counts: { total: 2, healthy: 1, disabled: 1, failed: 0 },
    items: [
      { id: 'DSH-Build-Watchdog', status: 'healthy' as const, intentional: false, reasons: [] },
      { id: 'taskbot-guard-check', status: 'disabled' as const, intentional: true, reasons: [] },
    ],
  },
}))
vi.mock('../src/duty.ts', () => ({ readDutyInventory: () => dutyFixture }))

// 2026-11-04 ruling: the auto-route poll ledger rides the SAME fold. The
// reader is mocked like duty's — machine-independent while still proving the
// CALL SITE (a sweep that stopped reading the ledger would drop the key).
// Setting `holder.autoRoute = undefined` = plugin absent → the key must vanish
// from the frame entirely; the reader's own threshold/freshness behavior
// lives in auto-route.spec.ts.
// The holder's type is declared on the callback return (a value-side `as`
// cast here reads as an unnecessary assertion to oxlint's type-aware rule);
// the property is a required key whose value may be `undefined` so both the
// fixture and the detach assignment stay legal under exactOptionalPropertyTypes.
const { autoRouteHolder } = vi.hoisted(
  (): { autoRouteHolder: { autoRoute: Record<string, unknown> | undefined } } => ({
    autoRouteHolder: {
      autoRoute: { ok: false, failingSince: 1, failingForSec: 300, sustained: true, error: 'boom', ageSec: 5 },
    },
  }),
)
vi.mock('../src/auto-route.ts', () => ({ readAutoRoutePoll: () => autoRouteHolder.autoRoute }))

const defaults = {
  defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

const sid = (value: string): SessionId => value as SessionId

/** One live projected sweep row with balanced defaults. */
function row(id: string, over: Partial<SessionHealthRow> = {}): SessionHealthRow {
  return { id: sid(id), live: true, projected: true, running: false, failed: false, ...over }
}

describe('reconcileSessionHealth (安康位三不变量, collab step1 §2.2)', () => {
  it('对得上账: a mixed healthy sweep balances every bucket and reports no issue (三不变量反例)', () => {
    const report = reconcileSessionHealth([
      row('running-1', { running: true }),
      row('ask-1', { attention: 'question' }),
      row('failed-1', { failed: true }),
      row('rest-1'),
    ])
    expect(report).toEqual({
      ok: true,
      total: 4,
      counts: { running: 1, awaiting: 1, failed: 1, rest: 1 },
      issues: [],
    })
  })

  it('对得上账: an empty sweep is a trivially even account', () => {
    expect(reconcileSessionHealth([])).toEqual({
      ok: true,
      total: 0,
      counts: { running: 0, awaiting: 0, failed: 0, rest: 0 },
      issues: [],
    })
  })

  it('无读不到 正例: a dead sweep id reads unreadable, is named, and breaks the partition', () => {
    const report = reconcileSessionHealth([
      row('live-1', { running: true }),
      row('ghost', { live: false, projected: false }),
    ])
    expect(report.ok).toBe(false)
    expect(report.total).toBe(2)
    expect(report.counts).toEqual({ running: 1, awaiting: 0, failed: 0, rest: 0 })
    expect(report.issues).toContainEqual({ invariant: 'unreadable', sessionIds: [sid('ghost')] })
    expect(report.issues).toContainEqual({ invariant: 'total-partition', sessionIds: [sid('ghost')] })
  })

  it('无未分类 正例: a live row whose projection channel is down is unplaced and named', () => {
    const report = reconcileSessionHealth([
      row('rest-1'),
      row('blind', { projected: false }),
    ])
    expect(report.ok).toBe(false)
    expect(report.counts).toEqual({ running: 0, awaiting: 0, failed: 0, rest: 1 })
    expect(report.issues).toContainEqual({ invariant: 'unclassified', sessionIds: [sid('blind')] })
    expect(report.issues).toContainEqual({ invariant: 'total-partition', sessionIds: [sid('blind')] })
  })

  it('总数 = 各态和 正例: two bookkeeping holes surface as a partition issue naming both witnesses', () => {
    const report = reconcileSessionHealth([
      row('rest-1'),
      row('ghost', { live: false, projected: false }),
      row('blind', { projected: false }),
    ])
    expect(report.total).toBe(3)
    expect(report.counts.rest).toBe(1)
    expect(report.issues).toContainEqual({
      invariant: 'total-partition',
      sessionIds: [sid('ghost'), sid('blind')],
    })
  })

  it('桶位优先级: 等回话 outranks 在跑 and a failure残局 only counts while stopped', () => {
    const report = reconcileSessionHealth([
      row('ask-and-running', { running: true, attention: 'question' }),
      row('retrying', { failed: true, running: true }),
    ])
    expect(report.counts).toEqual({ running: 1, awaiting: 1, failed: 0, rest: 0 })
    expect(report.ok).toBe(true)
  })
})

describe('sweep publishes api-session/health (step2 §4.3 同一数据源同一周期)', () => {
  it('emits one audit per sweep over the published set, and re-emits the next tick', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    onTestFinished(() => {
      void ctx.fiber.dispose()
      vi.useRealTimers()
    })
    await mountAgentLoopTestDependencies(ctx)
    await mountAgentLoopTestHarness(ctx)
    const gateway: Partial<TypertGatewayService> = { getPendingRemoteEvents: () => [] }
    ctx.provide('typertGateway', gateway as TypertGatewayService)
    await createSessionTestController(ctx, defaults)
    const health = vi.fn()
    ctx.on('api-session/health', health)

    const session = ctx.sessions.create(SessionId('health-sweep'), { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    ctx.emit('agent/status', { agent, status: 'running' })
    await vi.advanceTimersByTimeAsync(SESSION_STATUS_SWEEP_MS)
    expect(health).toHaveBeenCalledTimes(1)
    expect(health.mock.calls[0]?.[0]).toEqual({
      ok: true,
      total: 1,
      counts: { running: 1, awaiting: 0, failed: 0, rest: 0 },
      issues: [],
      // 批2: the duty fold rides every sweep frame (同一 tick, 同一 frame).
      duty: dutyFixture,
      // 2026-11-04: so does the auto-route poll verdict (同一 fold, 同一 frame).
      autoRoute: autoRouteHolder.autoRoute,
    })

    await vi.advanceTimersByTimeAsync(SESSION_STATUS_SWEEP_MS)
    expect(health).toHaveBeenCalledTimes(2)
    expect(health.mock.calls[1]?.[0]).toEqual(health.mock.calls[0]?.[0])

    // Optional plane detaches cleanly: plugin absent → the key is gone from
    // the frame entirely, the rest of the audit is untouched (never broken).
    autoRouteHolder.autoRoute = undefined
    await vi.advanceTimersByTimeAsync(SESSION_STATUS_SWEEP_MS)
    expect(health).toHaveBeenCalledTimes(3)
    expect('autoRoute' in (health.mock.calls[2]?.[0] ?? {})).toBe(false)
    expect(health.mock.calls[2]?.[0]).toMatchObject({ ok: true, duty: dutyFixture })
    autoRouteHolder.autoRoute = { ok: false, failingSince: 1, failingForSec: 300, sustained: true, error: 'boom', ageSec: 5 }
  })
})
