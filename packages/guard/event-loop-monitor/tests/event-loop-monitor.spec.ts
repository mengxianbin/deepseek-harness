/**
 * Coverage for the thin-shell @deepseek-ai/dsh-event-loop-monitor
 * (m-note design `event-loop-monitor-offproc-design-1123.md` §六 stages
 * 2–3; user ruling 2026-11-24): the probe serves the external sampler's
 * state file behind the loopback fence — a fresh file passes its bytes
 * through verbatim (200), a missing / unparseable / not-an-object /
 * stale file answers 503 `{"ok":false,"error":"stale"}` (fail-soft:
 * consumers read any non-200 as absent), non-loopback callers get 403
 * before anything else, non-GET gets 405 with `allow: GET`, `disable`
 * keeps the route unregistered, and the judgment values stay the design
 * §二 60 s / 250 ms / 2000 ms (zero change).
 *
 * The state file resolves through `dshHomePath`, so every test points
 * `DSH_HOME` at a throwaway temp directory: nothing here can stamp the
 * real `~/.dsh/event-loop-state.json`.
 */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as eventLoopMonitor from '@deepseek-ai/dsh-event-loop-monitor'

const fibers: { dispose(): Promise<unknown> }[] = []
let tempHome = ''
let homeBackup: string | undefined

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'event-loop-monitor-home-'))
  homeBackup = process.env.DSH_HOME
  process.env.DSH_HOME = tempHome
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fibers.splice(0).map(fiber => fiber.dispose()))
  if (homeBackup === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = homeBackup
  rmSync(tempHome, { recursive: true, force: true })
})

/** Fields a test may override when forging the probe request. */
interface ProbeOptions {
  host?: string
  remote?: string
  method?: string
}

/** IncomingMessage stand-in carrying only what the probe handler and its fence read. */
function probeRequest(options: ProbeOptions): IncomingMessage {
  const headers: Record<string, string> = { host: options.host ?? '127.0.0.1:3080' }
  return {
    method: options.method ?? 'GET',
    headers,
    socket: { remoteAddress: options.remote ?? '127.0.0.1' },
  } as unknown as IncomingMessage
}

/** The payload shape the external sampler writes (design §五 字段生存表 — shape unchanged). */
function stateFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const at = Date.now()
  return {
    at,
    windowSec: 60,
    p50: 4,
    p99: 12,
    max: 40,
    mean: 7,
    elu: 0.31,
    light: 'green',
    consecutiveOver: 0,
    consecutiveNormal: 12,
    overWindows: 0,
    history: [{ at, p50: 4, p99: 12, max: 40, mean: 7, elu: 0.31, over: false, light: 'green' }],
    attribution: [],
    unattributed: { count: 0, worstMs: 0, lastAt: 0, dumps: 0 },
    events: [],
    ...overrides,
  }
}

/** Write the state file into the throwaway `DSH_HOME`, optionally back-dating its mtime. */
function writeState(body: unknown, options: { mtimeAgoSec?: number } = {}): string {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const file = join(tempHome, eventLoopMonitor.STATE_FILE)
  writeFileSync(file, raw)
  if (options.mtimeAgoSec !== undefined) {
    const past = new Date(Date.now() - options.mtimeAgoSec * 1000)
    utimesSync(file, past, past)
  }
  return raw
}

/**
 * Mount the plugin over a stand-in `webServer` that captures the probe
 * route, and hand back a caller that invokes it once and reads the
 * answer — the endpoint is asserted through its handler, exactly as the
 * fence and freshness gate are served, without binding a real listener.
 */
async function setupProbe(config: eventLoopMonitor.Config) {
  const ctx = new Context()
  const routes = new Map<string, WebRoute['handler']>()
  ctx.provide('webServer', {
    register(route: WebRoute): () => void {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  } as never)
  const fiber = await ctx.plugin(eventLoopMonitor, config)
  fibers.push(fiber)
  if (config.disable === true) {
    // A disabled component must stay a quiet absence: give the child
    // fiber a beat to prove it never registers, then assert zero routes.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(routes.size).toBe(0)
    return { ctx, routes }
  }
  // The route registers from a child fiber waiting on `webServer`.
  await vi.waitFor(() => { expect(routes.size).toBe(1) }, { timeout: 2000 })
  const handler = routes.get(eventLoopMonitor.STATE_PATH)
  if (handler === undefined) throw new Error(`probe route ${eventLoopMonitor.STATE_PATH} did not register`)
  const probe = async (options: ProbeOptions = {}): Promise<{ status: number; body: string; headers: Record<string, string> }> => {
    const captured = { status: 0, body: '', headers: {} as Record<string, string> }
    const res = {
      writeHead(status: number, headers: Record<string, string> = {}): void {
        captured.status = status
        captured.headers = headers
      },
      end(body?: string): void { captured.body = body ?? '' },
    } as unknown as ServerResponse
    await handler(probeRequest(options), res)
    return captured
  }
  return { ctx, routes, probe }
}

/** Every field of the `GET /api/event-loop/state` payload (shape contract, design §五). */
const STATE_SHAPE_KEYS = [
  'at', 'windowSec', 'p50', 'p99', 'max', 'mean', 'elu', 'light',
  'consecutiveOver', 'consecutiveNormal', 'overWindows', 'history',
  'attribution', 'unattributed', 'events',
] as const

describe('GET /api/event-loop/state — fresh state file passes through (200)', () => {
  it('serves the file bytes verbatim with the full response shape', async () => {
    const raw = writeState(stateFixture())
    const { probe } = await setupProbe({})
    const { status, body, headers } = await probe()
    expect(status).toBe(200)
    expect(body).toBe(raw)
    expect(headers['content-type']).toBe('application/json; charset=utf-8')
    expect(headers['cache-control']).toBe('no-store')
    const parsed = JSON.parse(body) as Record<string, unknown>
    for (const key of STATE_SHAPE_KEYS) expect(parsed, `shape key ${key}`).toHaveProperty(key)
    expect(Array.isArray(parsed.attribution)).toBe(true)
    expect(parsed.attribution).toEqual([])
    expect(parsed.light).toBe('green')
    expect(typeof parsed.elu).toBe('number')
  })

  it('sizes freshness from the file\'s own windowSec (2× window margin)', async () => {
    writeState(stateFixture({ windowSec: 1 }), { mtimeAgoSec: 1 })
    const { probe } = await setupProbe({})
    expect((await probe()).status).toBe(200)
  })

  it('falls back to the default 60 s window when the file carries none', async () => {
    const { windowSec: _dropped, ...withoutWindow } = stateFixture()
    writeState(withoutWindow, { mtimeAgoSec: 119 })
    const { probe } = await setupProbe({})
    expect((await probe()).status).toBe(200)
  })
})

describe('GET /api/event-loop/state — stale or absent answers 503 (fail-soft)', () => {
  it('answers stale when the file outlived twice its window', async () => {
    writeState(stateFixture(), { mtimeAgoSec: 121 })
    const { probe } = await setupProbe({})
    const { status, body, headers } = await probe()
    expect(status).toBe(503)
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'stale' })
    expect(headers['content-type']).toBe('application/json; charset=utf-8')
    expect(headers['cache-control']).toBe('no-store')
  })

  it('answers stale when the file is missing', async () => {
    const { probe } = await setupProbe({})
    const { status, body } = await probe()
    expect(status).toBe(503)
    expect(JSON.parse(body)).toEqual(eventLoopMonitor.STALE_BODY)
  })

  it('answers stale when the file is not JSON', async () => {
    writeState('not json at all')
    const { probe } = await setupProbe({})
    const { status, body } = await probe()
    expect(status).toBe(503)
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'stale' })
  })

  it('answers stale when the file is not a JSON object', async () => {
    writeState('[1,2,3]')
    const { probe } = await setupProbe({})
    const { status, body } = await probe()
    expect(status).toBe(503)
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'stale' })
  })
})

describe('GET /api/event-loop/state — fence and method', () => {
  it('refuses non-loopback callers before reading any state (403)', async () => {
    writeState(stateFixture())
    const { probe } = await setupProbe({})
    const { status, body } = await probe({ remote: '10.1.2.3' })
    expect(status).toBe(403)
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'forbidden: loopback-only' })
  })

  it('answers 405 with allow: GET for other methods', async () => {
    writeState(stateFixture())
    const { probe } = await setupProbe({})
    const { status, body, headers } = await probe({ method: 'POST' })
    expect(status).toBe(405)
    expect(headers.allow).toBe('GET')
    expect(body).toBe('')
  })
})

describe('disable — quiet absence', () => {
  it('registers no route at all', async () => {
    const { routes } = await setupProbe({ disable: true })
    expect(routes.size).toBe(0)
  })
})

describe('judgment values and contract constants (zero change, design §二)', () => {
  it('keeps the design defaults 60 s / 250 ms / 2000 ms', () => {
    expect(eventLoopMonitor.DEFAULT_WINDOW_SEC).toBe(60)
    expect(eventLoopMonitor.DEFAULT_P99_WARN_MS).toBe(250)
    expect(eventLoopMonitor.DEFAULT_MAX_BAD_MS).toBe(2000)
    // schemastery schemas are callable functions (no `.parse` method).
    expect(eventLoopMonitor.Config({})).toEqual({
      disable: false,
      windowSec: 60,
      p99WarnMs: 250,
      maxBadMs: 2000,
    })
  })

  it('keeps the route, the state file name and the freshness margin', () => {
    expect(eventLoopMonitor.STATE_PATH).toBe('/api/event-loop/state')
    expect(eventLoopMonitor.STATE_FILE).toBe('event-loop-state.json')
    expect(eventLoopMonitor.FRESHNESS_WINDOWS).toBe(2)
    expect(eventLoopMonitor.STALE_BODY).toEqual({ ok: false, error: 'stale' })
  })
})
