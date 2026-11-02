/**
 * Unit + real-load-path coverage for @deepseek-ai/dsh-unit-scheduler (P0
 * static scheduling gate). Each of the three deadlock-avoidance laws gets a
 * behavioral case: pass-through tools never enter the semaphore, the bounded
 * wait fails open (released without a slot, logged), and the per-session cap
 * queues one session's N+1th call while other sessions keep taking free
 * slots. Plus: reentrancy accounting-offset, prompt cancellation of queued
 * calls, fail-loud config, HMR disposal, and the loader load path.
 *
 * The P0.5 observation layer gets its own suites: the state endpoint's plan
 * §4.2c schema and counters read back through a stand-in webServer, its
 * loopback fence, the fail-open cause split (both values), and the
 * conditional aggregate log line (silence, shape, 分因, interval wiring).
 */

import { availableParallelism } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as unitScheduler from '@deepseek-ai/dsh-unit-scheduler'

afterEach(() => { vi.restoreAllMocks() })

let callSeq = 0

/** Structural owner-session key: the pipeline only ever reads `agent.id`. */
const agentOf = (id: string): Agent => ({ id }) as unknown as Agent

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Resolves with `'late'` instead of the value when `promise` misses the `ms` budget. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'late'> {
  return Promise.race([promise, sleep(ms).then(() => 'late' as const)])
}

/** Mount the registry + the scheduling gate under `config`. */
async function setup(config?: unitScheduler.Config) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const fiber = config === undefined
    ? await ctx.plugin(unitScheduler)
    : await ctx.plugin(unitScheduler, config)
  return { ctx, fiber }
}

/** A tool that signals `started` on entry and settles only when released — it holds its slot meanwhile. */
function gatedTool(name: string) {
  const started = Promise.withResolvers<undefined>()
  const gate = Promise.withResolvers<undefined>()
  const tool = defineContentToolFixture({
    name, description: 'holds its slot until released', parameters: {},
    async execute() {
      started.resolve(undefined)
      await gate.promise
      return [{ type: 'text' as const, text: `${name}: done` }]
    },
  })
  return { tool, started: started.promise, releaseGate: () => { gate.resolve(undefined) } }
}

/** A tool that settles immediately with a result marker. */
function instantTool(name: string) {
  const tool = defineContentToolFixture({
    name, description: 'settles immediately', parameters: {},
    async execute() { return [{ type: 'text' as const, text: `${name}: ran` }] },
  })
  return { tool }
}

/** Dispatch one call through the real pipeline, optionally keyed to an owner session. */
function call(ctx: Context, name: string, session?: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: ToolCallId(`c${++callSeq}`), name, arguments: '{}' }],
    ...(session === undefined ? {} : { agent: agentOf(session) }),
  })
}

describe('unit-scheduler classification (iron law 2 — pass-through vs slot-holding)', () => {
  it('routes the documented wait-on-others tools through the pass-through list', () => {
    const match = unitScheduler.compilePassThrough()
    const passThrough = [
      'ask_user_question',
      'job_output', 'job_list', 'job_kill',
      'web_fetch', 'web_search',
      'subagent', 'subagent_fork', 'workflow',
      'squads_run_member', 'squads_run_squad',
      'ui_present',
      'browser_navigate', 'browser_screenshot',
    ]
    for (const toolName of passThrough) expect(match(toolName)).toBe(true)
  })

  it('holds every other name, unknown tools included (fail-closed)', () => {
    const match = unitScheduler.compilePassThrough()
    const slotHolding = ['win_bash', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'skill', 'never_seen_tool']
    for (const toolName of slotHolding) expect(match(toolName)).toBe(false)
  })

  it('layers configured extra patterns over the built-in list', () => {
    const match = unitScheduler.compilePassThrough(['my_waiter_*'])
    expect(match('my_waiter_x')).toBe(true)
    expect(match('win_bash')).toBe(false)
    expect(match('job_output')).toBe(true)
  })
})

describe('unit-scheduler slot gating (behavioral)', () => {
  it('a pass-through tool runs while the only slot is occupied', async () => {
    const { ctx } = await setup({ maxSlots: 1, maxSlotsPerSession: 1, waitTimeoutMs: 30_000 })
    const holder = gatedTool('win_bash')
    const { tool: passThroughTool } = instantTool('job_output')
    ctx.tools.register(holder.tool)
    ctx.tools.register(passThroughTool)

    const holding = call(ctx, 'win_bash', 'session-a')
    await holder.started
    // The single slot belongs to session-a; `job_output` must not queue for it.
    const raced = await within(call(ctx, 'job_output', 'session-a'), 1_000)
    expect(raced).not.toBe('late')
    expect(raced).toMatchObject({ results: [{ result: { isError: false } }] })

    holder.releaseGate()
    await holding
  })

  it('an unknown tool name still takes a slot (fail-closed control)', async () => {
    const { ctx } = await setup({ maxSlots: 1, maxSlotsPerSession: 2, waitTimeoutMs: 30_000 })
    const holder = gatedTool('mystery_tool')
    const { tool: alsoUnknown } = instantTool('another_mystery')
    ctx.tools.register(holder.tool)
    ctx.tools.register(alsoUnknown)

    const holding = call(ctx, 'mystery_tool', 'session-a')
    await holder.started
    // The only slot is taken, so a second unknown-named call must wait...
    const pending = call(ctx, 'another_mystery', 'session-b')
    expect(await within(pending, 500)).toBe('late')
    // ...and get its slot once one is released.
    holder.releaseGate()
    await holding
    expect(await within(pending, 2_000)).toMatchObject({ results: [{ result: { isError: false } }] })
  })

  it('a queued call fails OPEN after waitTimeoutMs: released without a slot and logged', async () => {
    const { ctx } = await setup({ maxSlots: 1, maxSlotsPerSession: 1, waitTimeoutMs: 50 })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const holder = gatedTool('win_bash')
    const { tool: worker } = instantTool('read')
    ctx.tools.register(holder.tool)
    ctx.tools.register(worker)

    const holding = call(ctx, 'win_bash', 'session-a')
    await holder.started
    const startedAt = Date.now()
    const raced = await within(call(ctx, 'read', 'session-b'), 2_000)
    const elapsed = Date.now() - startedAt
    // Fail-open: the tool RAN (no slot) after the bounded wait, not before it.
    expect(raced).toMatchObject({ results: [{ result: { isError: false } }] })
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unit-scheduler fail-open'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('read'))

    holder.releaseGate()
    await holding
  })

  it('the per-session cap queues the N+1th call of one session while other sessions keep taking free slots', async () => {
    const { ctx } = await setup({ maxSlots: 4, maxSlotsPerSession: 2, waitTimeoutMs: 30_000 })
    const a1 = gatedTool('shell-a1')
    const a2 = gatedTool('shell-a2')
    const a3 = gatedTool('shell-a3')
    const b1 = gatedTool('shell-b1')
    for (const gated of [a1, a2, a3, b1]) ctx.tools.register(gated.tool)

    // Session-a fills its own cap of 2 while the global pool (4) still has room.
    const a1Run = call(ctx, 'shell-a1', 'session-a')
    await a1.started
    const a2Run = call(ctx, 'shell-a2', 'session-a')
    await a2.started

    // The third same-session call queues even though two global slots are free.
    const a3Run = call(ctx, 'shell-a3', 'session-a')
    expect(await within(a3.started, 500)).toBe('late')

    // Another session is served immediately: the queue is a per-session cap, not a global block.
    const b1Run = call(ctx, 'shell-b1', 'session-b')
    expect(await within(b1.started, 1_000)).not.toBe('late')

    // Releasing one of session-a's slots unblocks its queued third call.
    a1.releaseGate()
    await a1Run
    expect(await within(a3.started, 1_000)).not.toBe('late')

    a2.releaseGate()
    a3.releaseGate()
    b1.releaseGate()
    await Promise.all([a2Run, a3Run, b1Run])
  })

  it('a nested dispatch rides the ancestor slot instead of queueing (reentrancy accounting offset)', async () => {
    const { ctx } = await setup({ maxSlots: 1, maxSlotsPerSession: 1, waitTimeoutMs: 50 })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const { tool: inner } = instantTool('inner_tool')
    let nested: unknown
    const outer = defineContentToolFixture({
      name: 'outer_tool', description: 'dispatches a nested tool while holding a slot', parameters: {},
      async execute() {
        nested = await call(ctx, 'inner_tool', 'session-a')
        return [{ type: 'text' as const, text: 'outer done' }]
      },
    })
    ctx.tools.register(inner)
    ctx.tools.register(outer)

    const raced = await within(call(ctx, 'outer_tool', 'session-a'), 2_000)
    expect(raced).toMatchObject({ results: [{ result: { isError: false } }] })
    expect(nested).toMatchObject({ results: [{ result: { isError: false } }] })
    // Without the accounting offset the nested call would queue, time out and fail open.
    expect(warn).not.toHaveBeenCalled()
  })

  it('aborting a queued call settles it promptly instead of waiting out the budget', async () => {
    const { ctx } = await setup({ maxSlots: 1, maxSlotsPerSession: 1, waitTimeoutMs: 30_000 })
    const holder = gatedTool('win_bash')
    const { tool: follower } = instantTool('shell-follower')
    ctx.tools.register(holder.tool)
    ctx.tools.register(follower)

    const holding = call(ctx, 'win_bash', 'session-a')
    await holder.started
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      signal: controller.signal,
      calls: [{ type: 'tool-call', id: ToolCallId(`c${++callSeq}`), name: 'shell-follower', arguments: '{}' }],
      agent: agentOf('session-b'),
    })
    await sleep(30)
    controller.abort('test cancel')
    // Prompt settle: the queue wait ends at abort, far short of the 30s budget.
    expect(await within(pending, 1_000)).not.toBe('late')

    holder.releaseGate()
    await holding
  })

  it('stops gating when the plugin fiber disposes (HMR safety)', async () => {
    const { ctx, fiber } = await setup({ maxSlots: 1, maxSlotsPerSession: 1, waitTimeoutMs: 30_000 })
    const holder = gatedTool('win_bash')
    const { tool: after } = instantTool('shell-after-dispose')
    ctx.tools.register(holder.tool)
    ctx.tools.register(after)

    const holding = call(ctx, 'win_bash', 'session-a')
    await holder.started
    await fiber.dispose()
    // The listener is gone: this call must not queue for the occupied slot.
    expect(await within(call(ctx, 'shell-after-dispose', 'session-b'), 1_000)).toMatchObject({ results: [{ result: { isError: false } }] })

    holder.releaseGate()
    await holding
  })
})

describe('unit-scheduler configuration', () => {
  it('boots with no config at all: defaults apply and maxSlots is machine-derived', async () => {
    const { ctx } = await setup()
    const holder = gatedTool('win_bash')
    const { tool: follower } = instantTool('shell-no-config')
    ctx.tools.register(holder.tool)
    ctx.tools.register(follower)
    // The derived budget is at least one slot: the first call must get it.
    const holding = call(ctx, 'win_bash', 'session-a')
    await holder.started
    holder.releaseGate()
    await holding
    expect(await within(call(ctx, 'shell-no-config', 'session-a'), 2_000)).toMatchObject({ results: [{ result: { isError: false } }] })
  })

  it('derives the documented default budget from the machine', () => {
    expect(unitScheduler.defaultMaxSlots()).toBe(Math.max(1, availableParallelism() - 4))
    expect(unitScheduler.defaultMaxSlots()).toBeGreaterThanOrEqual(1)
  })

  it('rejects an out-of-range config at plugin load (fail loud, no silent fallback)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await expect(async () => { await ctx.plugin(unitScheduler, { maxSlots: 0 }) }).rejects.toThrow(/maxSlots/)
  })
})

describe('unit-scheduler real-load-path guard', () => {
  it('has no default export and keeps name/inject through unwrapExports', () => {
    expect('default' in unitScheduler).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(unitScheduler) as Record<string, unknown>
    expect(unwrapped).toBe(unitScheduler)
    expect(unwrapped.name).toBe('unit-scheduler')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over ctx.tools through the unwrapped module and passes a held call', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(unitScheduler) as Parameters<Context['plugin']>[0]
    await ctx.plugin(unwrapped, { maxSlots: 1, maxSlotsPerSession: 1, waitTimeoutMs: 50 })
    ctx.tools.register(instantTool('probe').tool)
    const result = await call(ctx, 'probe', 'session-a')
    expect(result).toMatchObject({ results: [{ result: { isError: false } }] })
  })
})

// ───────────────────────── P0.5 observation probe ─────────────────────────

/** Fields a test may override when forging the probe request. */
interface ProbeOptions {
  host?: string
  remote?: string
  method?: string
  origin?: string
  secFetchSite?: string
}

/** IncomingMessage stand-in carrying only what the probe handler and its fence read. */
function probeRequest(options: ProbeOptions): IncomingMessage {
  const headers: Record<string, string> = { host: options.host ?? '127.0.0.1:3080' }
  if (options.origin !== undefined) headers.origin = options.origin
  if (options.secFetchSite !== undefined) headers['sec-fetch-site'] = options.secFetchSite
  return {
    method: options.method ?? 'GET',
    headers,
    socket: { remoteAddress: options.remote ?? '127.0.0.1' },
  } as unknown as IncomingMessage
}

/**
 * Mount registry + gate over a stand-in `webServer` that captures the probe
 * route, and hand back callers that invoke it once and read the answer — the
 * endpoint is asserted through its handler, exactly as the plan §4.2c schema
 * is served, without binding a real listener.
 */
async function setupProbe(config: unitScheduler.Config) {
  const ctx = new Context()
  const routes = new Map<string, WebRoute['handler']>()
  ctx.provide('webServer', {
    register(route: WebRoute): () => void {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const fiber = await ctx.plugin(unitScheduler, config)
  // The route registers from a child fiber waiting on `webServer`.
  await vi.waitFor(() => { expect(routes.size).toBe(1) })
  const handler = routes.get(unitScheduler.STATE_PATH)
  if (handler === undefined) throw new Error(`probe route ${unitScheduler.STATE_PATH} did not register`)
  const probe = async (options: ProbeOptions = {}): Promise<{ status: number; body: string }> => {
    const captured = { status: 0, body: '' }
    const res = {
      writeHead(status: number): void { captured.status = status },
      end(body?: string): void { captured.body = body ?? '' },
    } as unknown as ServerResponse
    await handler(probeRequest(options), res)
    return captured
  }
  const readState = async (): Promise<unitScheduler.UnitSchedulerState> => {
    const { status, body } = await probe()
    expect(status).toBe(200)
    return JSON.parse(body) as unitScheduler.UnitSchedulerState
  }
  return { ctx, fiber, probe, readState }
}

describe('unit-scheduler P0.5 state endpoint', () => {
  it('serves the plan §4.2c schema verbatim and counts held slots, the queue and its oldest wait', async () => {
    const { ctx, readState } = await setupProbe({ maxSlots: 4, maxSlotsPerSession: 2, waitTimeoutMs: 30_000 })
    const a1 = gatedTool('p5-a1')
    const a2 = gatedTool('p5-a2')
    const a3 = gatedTool('p5-a3')
    const b1 = gatedTool('p5-b1')
    for (const gated of [a1, a2, a3, b1]) ctx.tools.register(gated.tool)

    const a1Run = call(ctx, 'p5-a1', 'session-a')
    await a1.started
    const a2Run = call(ctx, 'p5-a2', 'session-a')
    await a2.started
    const b1Run = call(ctx, 'p5-b1', 'session-b')
    await b1.started
    // Session-a's third call queues on its own cap while the pool still has room.
    const a3Run = call(ctx, 'p5-a3', 'session-a')
    expect(await within(a3.started, 300)).toBe('late')

    const queued = await readState()
    // Exact key sets: the payload is the plan §4.2c schema, nothing more.
    expect(Object.keys(queued).sort()).toEqual([
      'at', 'failOpen', 'held', 'heldBySession', 'maxSlots', 'queueOldestMs', 'queued', 'waitP50', 'waitP95',
    ])
    expect(Object.keys(queued.failOpen).sort()).toEqual(['cause', 'lastAt', 'lastMs', 'total'])
    expect(queued).toMatchObject({
      maxSlots: 4,
      held: 3,
      heldBySession: { 'session-a': 2, 'session-b': 1 },
      queued: 1,
      failOpen: { total: 0, lastMs: 0, lastAt: 0, cause: null },
    })
    expect(queued.queueOldestMs).toBeGreaterThanOrEqual(0)
    expect(queued.at).toBeGreaterThan(0)
    expect(queued.waitP50).toBeGreaterThanOrEqual(0)
    expect(queued.waitP95).toBeGreaterThanOrEqual(0)

    // Releasing one slot grants the queued call after a real wait; the window records it.
    a1.releaseGate()
    await a1Run
    expect(await within(a3.started, 1_000)).not.toBe('late')
    const granted = await readState()
    expect(granted.queued).toBe(0)
    expect(granted.heldBySession).toEqual({ 'session-a': 2, 'session-b': 1 })
    expect(granted.waitP95).toBeGreaterThanOrEqual(40)

    a2.releaseGate()
    a3.releaseGate()
    b1.releaseGate()
    await Promise.all([a2Run, a3Run, b1Run])
    const idle = await readState()
    expect(idle).toMatchObject({ held: 0, queued: 0, queueOldestMs: 0, heldBySession: {} })
  })

  it('fences the probe: loopback passes, a rebinding Host, a LAN socket and cross-site markers get 403', async () => {
    const { probe } = await setupProbe({ maxSlots: 2, maxSlotsPerSession: 2, waitTimeoutMs: 30_000 })

    const loopback = await probe()
    expect(loopback.status).toBe(200)
    expect(JSON.parse(loopback.body)).toMatchObject({ maxSlots: 2 })
    // IPv4-mapped loopback and `localhost` are the same loopback caller.
    expect((await probe({ remote: '::ffff:127.0.0.1' })).status).toBe(200)
    expect((await probe({ host: 'localhost:3080' })).status).toBe(200)
    // The Host fence (DNS rebinding), the socket peer (LAN) and browser
    // same-origin markers each refuse on their own.
    expect((await probe({ host: '203.0.113.9:3080' })).status).toBe(403)
    expect((await probe({ remote: '10.1.2.3' })).status).toBe(403)
    expect((await probe({ secFetchSite: 'cross-site' })).status).toBe(403)
    expect((await probe({ origin: 'http://evil.example' })).status).toBe(403)
    // A same-origin Origin still passes; the fence is not an Origin lockout.
    expect((await probe({ origin: 'http://127.0.0.1:3080' })).status).toBe(200)
    // Method check runs after the fence: an untrusted POST never learns it exists.
    expect((await probe({ method: 'POST' })).status).toBe(405)
  })

  it('attributes a fail-open to global-full when the pool itself was full', async () => {
    const { ctx, readState } = await setupProbe({ maxSlots: 1, maxSlotsPerSession: 1, waitTimeoutMs: 50 })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const holder = gatedTool('p5-gf-holder')
    const { tool: waiter } = instantTool('p5-gf-waiter')
    ctx.tools.register(holder.tool)
    ctx.tools.register(waiter)

    const holding = call(ctx, 'p5-gf-holder', 'session-a')
    await holder.started
    expect(await within(call(ctx, 'p5-gf-waiter', 'session-b'), 2_000)).toMatchObject({ results: [{ result: { isError: false } }] })
    const state = await readState()
    expect(state.failOpen).toMatchObject({ total: 1, cause: 'global-full' })
    expect(state.failOpen.lastMs).toBeGreaterThanOrEqual(40)
    expect(state.failOpen.lastAt).toBeGreaterThan(0)
    // The per-fail-open warn line is untouched by the probe.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unit-scheduler fail-open'))

    holder.releaseGate()
    await holding
  })

  it('attributes a fail-open to session-cap when only the per-session cap blocked it', async () => {
    const { ctx, readState } = await setupProbe({ maxSlots: 4, maxSlotsPerSession: 2, waitTimeoutMs: 50 })
    const a1 = gatedTool('p5-sc-1')
    const a2 = gatedTool('p5-sc-2')
    const { tool: a3 } = instantTool('p5-sc-3')
    for (const tool of [a1.tool, a2.tool, a3]) ctx.tools.register(tool)

    const a1Run = call(ctx, 'p5-sc-1', 'session-a')
    await a1.started
    const a2Run = call(ctx, 'p5-sc-2', 'session-a')
    await a2.started
    // Two global slots stay free: only session-a's cap of 2 blocks the third call.
    expect(await within(call(ctx, 'p5-sc-3', 'session-a'), 2_000)).toMatchObject({ results: [{ result: { isError: false } }] })
    const state = await readState()
    expect(state).toMatchObject({ maxSlots: 4, held: 2, heldBySession: { 'session-a': 2 } })
    expect(state.failOpen).toMatchObject({ total: 1, cause: 'session-cap' })

    a1.releaseGate()
    a2.releaseGate()
    await Promise.all([a1Run, a2Run])
  })
})

describe('unit-scheduler P0.5 aggregate log line', () => {
  /** A plan §4.2c state with idle defaults; an override replaces whole fields. */
  const idleState = (overrides: Partial<unitScheduler.UnitSchedulerState> = {}): unitScheduler.UnitSchedulerState => ({
    at: 1_000_000,
    maxSlots: 12,
    held: 8,
    heldBySession: {},
    queued: 0,
    queueOldestMs: 0,
    waitP50: 0,
    waitP95: 0,
    failOpen: { total: 0, lastMs: 0, lastAt: 0, cause: null },
    ...overrides,
  })
  const tally = (globalFull: number, sessionCap: number): Readonly<Record<unitScheduler.FailOpenCause, number>> => ({
    'global-full': globalFull,
    'session-cap': sessionCap,
  })

  it('stays silent when the queue is empty and no fail-open happened in the window', () => {
    expect(unitScheduler.formatAggregateLine(idleState(), 0, tally(0, 0))).toBeUndefined()
  })

  it('prints the plan §4.2a shape when the queue is non-empty', () => {
    const line = unitScheduler.formatAggregateLine(idleState({ queued: 3, waitP95: 420 }), 0, tally(0, 0))
    expect(line).toBe('unit-scheduler: held 8/12 queued 3 wait-p95 420ms fail-open 0/last never')
  })

  it('prints for a fail-open in the window and carries its age plus the per-cause split', () => {
    const at = 1_000_000
    const line = unitScheduler.formatAggregateLine(
      idleState({
        at,
        queued: 0,
        failOpen: { total: 3, lastMs: 60_000, lastAt: at - 12 * 60_000, cause: 'global-full' },
      }),
      1,
      tally(2, 1),
    )
    expect(line).toBe('unit-scheduler: held 8/12 queued 0 wait-p95 0ms fail-open 3/last 12m (global-full 2, session-cap 1)')
  })

  it('ticks once per interval and logs only when the queue or the fail-open window says so', async () => {
    // Fake only the interval: the gate's own bounded wait stays a real timer.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NativeToolExecutor)
      const info = vi.spyOn(ctx.logger, 'info')
      const fiber = await ctx.plugin(unitScheduler, { maxSlots: 1, maxSlotsPerSession: 1, waitTimeoutMs: 50 })

      // Idle gate: a whole interval passes with nothing to report → silence.
      vi.advanceTimersByTime(unitScheduler.AGGREGATION_INTERVAL_MS)
      expect(info).not.toHaveBeenCalledWith(expect.stringContaining('unit-scheduler: held'))

      const holder = gatedTool('p5-tick-holder')
      const { tool: waiter } = instantTool('p5-tick-waiter')
      ctx.tools.register(holder.tool)
      ctx.tools.register(waiter)
      const holding = call(ctx, 'p5-tick-holder', 'session-a')
      await holder.started
      void call(ctx, 'p5-tick-waiter', 'session-b')
      await sleep(0)

      // Non-empty queue → one line, plan shape included.
      vi.advanceTimersByTime(unitScheduler.AGGREGATION_INTERVAL_MS)
      expect(info).toHaveBeenCalledWith(expect.stringContaining('unit-scheduler: held 1/1 queued 1'))

      // The bounded wait expires on the real timer: the next tick reports the
      // fail-open with its window count and cause.
      await sleep(80)
      vi.advanceTimersByTime(unitScheduler.AGGREGATION_INTERVAL_MS)
      expect(info).toHaveBeenCalledWith(expect.stringContaining('fail-open 1/last'))
      expect(info).toHaveBeenCalledWith(expect.stringContaining('global-full 1'))

      holder.releaseGate()
      await holding
      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
