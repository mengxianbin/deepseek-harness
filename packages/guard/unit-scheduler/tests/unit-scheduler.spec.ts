/**
 * Unit + real-load-path coverage for @deepseek-ai/dsh-unit-scheduler (P0
 * static scheduling gate). Each of the three deadlock-avoidance laws gets a
 * behavioral case: pass-through tools never enter the semaphore, the bounded
 * wait fails open (released without a slot, logged), and the per-session cap
 * queues one session's N+1th call while other sessions keep taking free
 * slots. Plus: reentrancy accounting-offset, prompt cancellation of queued
 * calls, fail-loud config, HMR disposal, and the loader load path.
 */

import { availableParallelism } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
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
    callId: ToolCallId(`c${++callSeq}`),
    name,
    arguments: {},
    signal: new AbortController().signal,
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
    expect(raced).toMatchObject({ isError: false })

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
    expect(await within(pending, 2_000)).toMatchObject({ isError: false })
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
    expect(raced).toMatchObject({ isError: false })
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
    expect(raced).toMatchObject({ isError: false })
    expect(nested).toMatchObject({ isError: false })
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
      callId: ToolCallId(`c${++callSeq}`),
      name: 'shell-follower',
      arguments: {},
      signal: controller.signal,
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
    expect(await within(call(ctx, 'shell-after-dispose', 'session-b'), 1_000)).toMatchObject({ isError: false })

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
    expect(await within(call(ctx, 'shell-no-config', 'session-a'), 2_000)).toMatchObject({ isError: false })
  })

  it('derives the documented default budget from the machine', () => {
    expect(unitScheduler.defaultMaxSlots()).toBe(Math.max(1, availableParallelism() - 4))
    expect(unitScheduler.defaultMaxSlots()).toBeGreaterThanOrEqual(1)
  })

  it('rejects an out-of-range config at plugin load (fail loud, no silent fallback)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
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
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(unitScheduler) as Parameters<Context['plugin']>[0]
    await ctx.plugin(unwrapped, { maxSlots: 1, maxSlotsPerSession: 1, waitTimeoutMs: 50 })
    ctx.tools.register(instantTool('probe').tool)
    const result = await call(ctx, 'probe', 'session-a')
    expect(result).toMatchObject({ isError: false })
  })
})
