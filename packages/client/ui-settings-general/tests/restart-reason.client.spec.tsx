// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RESTART_PATH } from '../src/restart.ts'
import { restartDispatchReason } from '../src/client/restart-reason.ts'
import { RestartServerButton } from '../src/client/RestartServerButton.tsx'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** Locale seat: every key passes through verbatim, so assertions read the key. */
const t = ((key: string) => key) as PropsLocale<'settings'>['t']

/** Capture the fetch calls the button makes. */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => new Response(null, { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

/** Render the control, open its confirm dialog, and press confirm. */
function confirmClick(signal: RestartServerButtonPropsSignal): void {
  render(<RestartServerButton t={t} configured runningSessions={2} wide={false} signal={signal} />)
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(document.querySelector<HTMLElement>('[data-modal-autofocus]') as HTMLElement)
}

type RestartServerButtonPropsSignal = Parameters<typeof RestartServerButton>[0]['signal']

describe('restartDispatchReason', () => {
  it('names the judgment behind a lit lamp', () => {
    expect(restartDispatchReason({ state: 'NEED_RESTART', reason: 'config' })).toBe('signal-config')
    expect(restartDispatchReason({ state: 'NEED_RESTART', reason: 'built' })).toBe('signal-built')
    expect(restartDispatchReason({ state: 'BUILDING' })).toBe('signal-BUILDING')
    expect(restartDispatchReason({ state: 'NEED_BUILD' })).toBe('signal-NEED_BUILD')
  })

  it('is manual when the lamp is dark or undelivered', () => {
    expect(restartDispatchReason(undefined)).toBe('manual')
    expect(restartDispatchReason({ state: 'OK' })).toBe('manual')
    expect(restartDispatchReason({ state: 'CLIENT_UPDATED' })).toBe('manual')
  })
})

describe('RestartServerButton dispatch body (restart-attribution-inbox-1118 批1 L3)', () => {
  it('sends signal-config when the lamp is lit', async () => {
    const fetch = stubFetch()
    confirmClick({ state: 'NEED_RESTART', reason: 'config' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [path, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(path).toBe(RESTART_PATH)
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'signal-config' })
  })

  it('sends manual when the lamp is dark', async () => {
    const fetch = stubFetch()
    confirmClick({ state: 'OK' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [path, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(path).toBe(RESTART_PATH)
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'manual' })
  })
})
