/**
 * FORK archive-seal-gate-ui-1028: the seal gate's client contract over a
 * stubbed global fetch — the C1 check (request shape, row parsing, the
 * fail-open answers) and the C4 write-back (transport outcomes and payload
 * shapes). The assembled three-tier flow is apply.client.spec's subject.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  archiveOverrideRequest, isGreenSeal, isStaleSeal, postArchiveOverride, requestSealCheck,
  sealLedgerToken, STALE_SEAL,
} from '../src/client/session-actions/seal.ts'

const sid = (id: string) => id as SessionId

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** One minimal ok response carrying a JSON payload. */
const okResponse = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload })

/** A silent console.warn spy, asserted by the caller. */
const warnSpy = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

describe('seal tier helpers', () => {
  it('keeps the four green groups quiet and the red tiers out of green', () => {
    for (const verdict of ['DONE', 'N_A', 'NEUTRAL', 'LEGACY'] as const) {
      expect(isGreenSeal({ verdict })).toBe(true)
    }
    expect(isGreenSeal({ verdict: 'UNSEALED' })).toBe(false)
    expect(isGreenSeal({ verdict: 'UNKNOWN' })).toBe(false)
  })

  it('marks exactly the sentinel-stale detail as the stale tier', () => {
    expect(isStaleSeal(STALE_SEAL)).toBe(true)
    expect(isStaleSeal({ verdict: 'UNSEALED', detail: 'sentinel-pending' })).toBe(false)
    expect(isStaleSeal({ verdict: 'UNKNOWN' })).toBe(false)
  })

  it('names the ledger token by detail when present, by verdict otherwise', () => {
    expect(sealLedgerToken({ verdict: 'UNSEALED', detail: 'save-tail-no-sentinel' })).toBe('save-tail-no-sentinel')
    expect(sealLedgerToken({ verdict: 'UNKNOWN' })).toBe('UNKNOWN')
  })
})

describe('requestSealCheck (contract C1)', () => {
  it('POSTs {ids} to the plugin route and parses verdict rows into a map', async () => {
    const fetchMock = vi.fn(async () => okResponse({ results: [
      { id: 'one', verdict: 'UNSEALED', detail: 'sentinel-stale', followUpCount: 3 },
      { id: 'two', verdict: 'DONE' },
    ] }))
    vi.stubGlobal('fetch', fetchMock)
    const seals = await requestSealCheck([sid('one'), sid('two')])
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      '/api/dsh-session-archive/seal-check',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ ids: ['one', 'two'] }) }),
    )
    expect(seals).not.toBeNull()
    expect(seals!.get(sid('one'))).toEqual({ verdict: 'UNSEALED', detail: 'sentinel-stale', followUpCount: 3 })
    expect(seals!.get(sid('two'))).toEqual({ verdict: 'DONE' })
  })

  it('drops malformed rows instead of guessing, keeping what is still well-formed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ results: [
      { id: 'one', verdict: 'TELEPORTED' },
      { id: 'two', verdict: 'UNSEALED', detail: 'mystery-detail' },
      'not-an-object',
      { verdict: 'DONE' },
      { id: 'three', verdict: 'NEUTRAL' },
    ] })))
    const seals = await requestSealCheck([sid('one'), sid('two'), sid('three')])
    expect(seals).not.toBeNull()
    // Unknown verdict: the row dies (the caller reads absence as fail-open).
    expect(seals!.has(sid('one'))).toBe(false)
    // Unknown detail: the verdict survives, the detail is dropped.
    expect(seals!.get(sid('two'))).toEqual({ verdict: 'UNSEALED' })
    expect(seals!.get(sid('three'))).toEqual({ verdict: 'NEUTRAL' })
  })

  it('answers null with a warning on a non-ok status (fail-open, e.g. plugin absent → 404)', async () => {
    const spy = warnSpy()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    expect(await requestSealCheck([sid('one')])).toBeNull()
    expect(spy).toHaveBeenCalledWith('seal check rejected: HTTP 404')
  })

  it('answers null with a warning when the transport throws (fail-open)', async () => {
    const spy = warnSpy()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused') }))
    expect(await requestSealCheck([sid('one')])).toBeNull()
    expect(spy).toHaveBeenCalledWith('seal check rejected:', expect.any(Error))
  })

  it('answers null with a warning when the payload has no results array', async () => {
    const spy = warnSpy()
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ nope: true })))
    expect(await requestSealCheck([sid('one')])).toBeNull()
    expect(spy).toHaveBeenCalledWith('seal check answered without a results array')
  })

  it('never hits the network for an empty id batch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await requestSealCheck([])).toEqual(new Map())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('drops rows that are null, id-less, or carry unusable extras', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ results: [
      null,
      { id: '', verdict: 'DONE' },
      { id: 'num', verdict: 7 },
      { id: 'extras', verdict: 'DONE', detail: 9, followUpCount: 'three' },
      { id: 'nan', verdict: 'DONE', followUpCount: Number.NaN },
      { id: 'ok', verdict: 'LEGACY' },
    ] })))
    const seals = await requestSealCheck([sid('ok')])
    expect(seals).not.toBeNull()
    // Null / id-less / non-string-verdict rows die; rows with unusable extras
    // survive with just those extras dropped.
    expect(seals!.size).toBe(3)
    expect(seals!.has(sid('num'))).toBe(false)
    expect(seals!.get(sid('extras'))).toEqual({ verdict: 'DONE' })
    expect(seals!.get(sid('nan'))).toEqual({ verdict: 'DONE' })
    expect(seals!.get(sid('ok'))).toEqual({ verdict: 'LEGACY' })
  })

  it('aborts a stalled seal check at the request ceiling and fails open', async () => {
    vi.useFakeTimers()
    try {
      const spy = warnSpy()
      vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => { reject(new Error('aborted by the ceiling')) })
        })))
      const pending = requestSealCheck([sid('one')])
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await pending).toBeNull()
      expect(spy).toHaveBeenCalledWith('seal check rejected:', expect.any(Error))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('postArchiveOverride (contract C4)', () => {
  it('POSTs the body to the plugin route and answers true', async () => {
    const fetchMock = vi.fn(async () => okResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    const body = { ids: [sid('one')], mode: 'note' as const, seal: 'stale' }
    expect(await postArchiveOverride(body)).toBe(true)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      '/api/dsh-session-archive/archive-override',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
    )
  })

  it('answers false with a warning on a rejected status and never throws', async () => {
    const spy = warnSpy()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    expect(await postArchiveOverride({ ids: [sid('one')], mode: 'force', seal: 'UNKNOWN' })).toBe(false)
    expect(spy).toHaveBeenCalledWith('archive override write-back rejected: HTTP 500')
  })

  it('answers false with a warning when the transport throws', async () => {
    const spy = warnSpy()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await postArchiveOverride({ ids: [sid('one')], mode: 'force', seal: 'sentinel-pending' })).toBe(false)
    expect(spy).toHaveBeenCalledWith('archive override write-back rejected:', expect.any(Error))
  })

  it('aborts a stalled write-back at the request ceiling and answers false', async () => {
    vi.useFakeTimers()
    try {
      const spy = warnSpy()
      vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => { reject(new Error('aborted by the ceiling')) })
        })))
      const pending = postArchiveOverride({ ids: [sid('one')], mode: 'note', seal: 'stale' })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await pending).toBe(false)
      expect(spy).toHaveBeenCalledWith('archive override write-back rejected:', expect.any(Error))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('archiveOverrideRequest (contract C4 payload shapes)', () => {
  it('stale → note with the pinned seal token and no reason', () => {
    expect(archiveOverrideRequest(sid('one'), { verdict: 'UNSEALED', detail: 'sentinel-stale', followUpCount: 7 }, 'ignored'))
      .toEqual({ ids: ['one'], mode: 'note', seal: 'stale' })
  })

  it('red → force with the verdict token and the trimmed reason', () => {
    expect(archiveOverrideRequest(sid('one'), { verdict: 'UNSEALED', detail: 'sentinel-pending' }, '  任务书授权强归  '))
      .toEqual({ ids: ['one'], mode: 'force', seal: 'sentinel-pending', reason: '任务书授权强归' })
  })

  it('a blank reason stays absent — the server normalizes it to override:no-reason', () => {
    expect(archiveOverrideRequest(sid('one'), { verdict: 'UNKNOWN' }, '   '))
      .toEqual({ ids: ['one'], mode: 'force', seal: 'UNKNOWN' })
    expect(archiveOverrideRequest(sid('one'), { verdict: 'UNKNOWN' }))
      .toEqual({ ids: ['one'], mode: 'force', seal: 'UNKNOWN' })
  })
})
