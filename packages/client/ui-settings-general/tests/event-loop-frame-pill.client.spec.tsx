// @vitest-environment jsdom
/**
 * Frame-interval pill fixtures (event-loop-frame-pill-1123): the fail-soft
 * contract both ways — a refused `GET /api/event-loop/state` must leave no
 * face at all (pill 消失, no console error, no unhandled rejection), and a
 * healthy answer must render the rounded p99 with the monitor's light.
 * The pull rides the shared chain (pullEventLoopHealth), so the fetch seam
 * here is the page-global one the chain resolves at call time.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { EventLoopFramePill } from '../src/client/EventLoopFramePill.tsx'
import { en } from '../src/client/locales.ts'
import type { EventLoopFramePillProps } from '../src/client/EventLoopFramePill.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Dictionary stub: the seat's keys resolve, parameters stay literal (copy shape is asserted elsewhere). */
const t: EventLoopFramePillProps['t'] = key => (en as Record<string, string>)[key] ?? key

const VALID_LOOP = {
  at: 1_795_400_000_000,
  windowSec: 60,
  p99: 12.4,
  max: 30,
  p50: 4,
  mean: 6,
  elu: 0.12,
  light: 'green',
  consecutiveOver: 0,
  consecutiveNormal: 5,
  overWindows: 0,
  history: [],
  attribution: [],
  unattributed: { count: 0, worstMs: 0, lastAt: 0, dumps: 0 },
  events: [],
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('EventLoopFramePill fail-soft', () => {
  it('renders nothing when the state probe is refused (pill 消失, 页面无报错)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fixture: connection refused'))))

    const { container } = render(<EventLoopFramePill t={t} />)
    // The refused pull settles into the null state; give the microtasks a beat.
    await waitFor(() => {
      expect(fetch).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(container.querySelector('[data-event-loop-pill]')).toBeNull()
    })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('renders the rounded p99 with the monitor light when the probe answers', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string) => Promise.resolve(
      input.includes('/api/event-loop/state')
        ? jsonResponse(VALID_LOOP)
        : jsonResponse({ at: 1, maxSlots: 4, held: 0, queued: 0, queueOldestMs: 0, waitP95: 0 }),
    )))

    const { container } = render(<EventLoopFramePill t={t} />)
    const pill = await waitFor(() => {
      const node = container.querySelector('[data-event-loop-pill]')
      expect(node).not.toBeNull()
      return node as HTMLElement
    })
    // formatDelay(12.4) === '12ms' (round), light comes straight from the probe.
    expect(pill.getAttribute('data-event-loop-pill')).toBe('12ms')
    expect(pill.getAttribute('data-light')).toBe('green')
    expect(pill.textContent).toContain('12ms')
    // The lamp dot carries the probe's green class (CSS-module hashed name).
    expect(pill.querySelector('[aria-hidden="true"]')?.className).toMatch(/dot_green|dot_/)
  })

  it('keeps the pill hidden while the first pull is still in flight', () => {
    // Never-resolving fetch: the seat must paint nothing rather than a guess.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const { container } = render(<EventLoopFramePill t={t} />)
    expect(container.querySelector('[data-event-loop-pill]')).toBeNull()
  })
})
