import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  BRAVE_DEFAULT_BASE_URL,
  BRAVE_PROVIDER_ID,
  BraveSearchProvider,
} from '@deepseek-ai/dsh-web-search-brave'
import * as bravePlugin from '@deepseek-ai/dsh-web-search-brave'
import { mapBraveResponse, mapBraveResult } from '../src/provider.ts'

const options = { apiKey: 'brave-key', baseURL: 'https://api.brave.test/res', count: 10 }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** The dispatched request's URL and init, from the one fetch call. */
function dispatched(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls[0] as unknown as [string, RequestInit]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Brave result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapBraveResult({
      url: 'https://a.test',
      title: 'A',
      description: 'a salient snippet',
      age: '2 days ago',
      page_age: '2026-10-18T09:30:00',
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'a salient snippet', publishedAt: '2026-10-18T09:30:00' })
  })

  it('never maps the human-readable age into publishedAt (ISO-8601 contract)', () => {
    expect(mapBraveResult({ url: 'https://a.test', age: '2 days ago' }))
      .toEqual({ url: 'https://a.test' })
  })

  it('drops a result without a URL, and any non-record entry', () => {
    expect(mapBraveResult({ title: 'no url' })).toBeUndefined()
    expect(mapBraveResult({ url: '' })).toBeUndefined()
    expect(mapBraveResult('surprise')).toBeUndefined()
    expect(mapBraveResult(null)).toBeUndefined()
  })

  it('omits blank or wrongly-typed optional fields rather than emitting them', () => {
    expect(mapBraveResult({ url: 'https://a.test', title: '', description: 42, page_age: null }))
      .toEqual({ url: 'https://a.test' })
  })

  it('maps a response to a result with no content and filtered sources', () => {
    const result = mapBraveResponse({
      web: {
        results: [
          { url: 'https://a.test', description: 'one' },
          { title: 'no url' },
          { url: 'https://c.test', title: 'C', page_age: '2026-10-01T00:00:00' },
        ],
      },
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://c.test', title: 'C', publishedAt: '2026-10-01T00:00:00' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('treats a response without web results as an empty result', () => {
    expect(mapBraveResponse({}).sources).toEqual([])
    expect(mapBraveResponse({ web: {} }).sources).toEqual([])
    expect(mapBraveResponse({ web: { results: [] } }).sources).toEqual([])
  })

  it('rejects a well-formed body of the wrong shape as WEB_PROVIDER_ERROR', () => {
    expect(() => mapBraveResponse({ web: { results: {} } }))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(() => mapBraveResponse('surprise'))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('BraveSearchProvider availability', () => {
  it('is available with a key', () => {
    expect(new BraveSearchProvider(() => options).available()).toBe(true)
  })

  it('is unavailable without any key source', () => {
    expect(new BraveSearchProvider(() => ({ ...options, apiKey: '' })).available()).toBe(false)
  })

  it('counts a wired credential resolver as a key source', () => {
    expect(new BraveSearchProvider(() => ({ ...options, apiKey: '', resolveApiKey: async () => 'from-store' })).available())
      .toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(new BraveSearchProvider(() => ({ ...options, baseURL: 'not a url' })).available()).toBe(false)
  })

  it.each([0, 21, 1.5, -1])('is misconfigured when count is not an integer from 1 to 20: %s', (count) => {
    expect(new BraveSearchProvider(() => ({ ...options, count })).available()).toBe(false)
  })

  it.each([1, 20])('is available at the documented count boundary %s', (count) => {
    expect(new BraveSearchProvider(() => ({ ...options, count })).available()).toBe(true)
  })
})

describe('BraveSearchProvider request mapping', () => {
  it('GETs the search endpoint with the token header and fixed query controls', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)

    await new BraveSearchProvider(() => options).search({ query: 'hello world', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = dispatched(fetchMock)
    expect(url).toBe('https://api.brave.test/res/v1/web/search?q=hello+world&count=5&result_filter=web&text_decorations=false')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('brave-key')
  })

  it('caps the wire count at the configured count when a request bound is larger', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await new BraveSearchProvider(() => ({ ...options, count: 3 })).search({ query: 'q', maxResults: 9 })
    const [url] = dispatched(fetchMock)
    expect(url).toContain('count=3')
  })

  it('falls back to the configured count when a request omits maxResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await new BraveSearchProvider(() => options).search({ query: 'q' })
    const [url] = dispatched(fetchMock)
    expect(url).toContain('count=10')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new BraveSearchProvider(() => options).search({ query: 'q' }, controller.signal)
    const [, init] = dispatched(fetchMock)
    expect(init.signal).toBe(controller.signal)
  })
})

describe('BraveSearchProvider credential resolution', () => {
  it('prefers the literal key over the resolver', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const resolveApiKey = vi.fn(async () => 'stored-key')
    await new BraveSearchProvider(() => ({ ...options, resolveApiKey })).search({ query: 'q' })
    const [, init] = dispatched(fetchMock)
    expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('brave-key')
    expect(resolveApiKey).not.toHaveBeenCalled()
  })

  it('resolves the key per search, so a rotated key applies without re-registration', async () => {
    const fetchMock = vi.fn(async (_url?: unknown, _init?: RequestInit) => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    let key = 'stored-key'
    const provider = new BraveSearchProvider(() => ({ ...options, apiKey: '', apiKeyEnv: 'BRAVE_API_KEY', resolveApiKey: async () => key }))
    await provider.search({ query: 'q' })
    key = 'rotated-key'
    await provider.search({ query: 'q' })
    const tokens = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-subscription-token'))
    expect(tokens).toEqual(['stored-key', 'rotated-key'])
  })

  it('fails with WEB_PROVIDER_CREDENTIAL_MISSING naming the reference when no source yields a key', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const provider = new BraveSearchProvider(() => ({ ...options, apiKey: '', apiKeyEnv: 'MY_BRAVE_KEY', resolveApiKey: async () => undefined }))
    await expect(provider.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/"MY_BRAVE_KEY"/)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('maps a failing resolver to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const provider = new BraveSearchProvider(() => ({ ...options, apiKey: '', resolveApiKey: () => Promise.reject(new Error('store locked')) }))
    await expect(provider.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('BraveSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'bad token' }, { status: 401 })))
    await expect(new BraveSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Brave API error (HTTP 401): bad token' }))
  })

  it('reads a nested error.message from the failure body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'too many queries' } }, { status: 429 })))
    await expect(new BraveSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Brave API error (HTTP 429): too many queries' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(new BraveSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Brave API error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(new BraveSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Brave API error (HTTP 500)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new BraveSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new BraveSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an already-aborted signal before any resolution or fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    await expect(new BraveSearchProvider(() => options).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(new BraveSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a wrong-shape success body to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ web: { results: {} } }, { status: 200 })))
    await expect(new BraveSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new BraveSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new BraveSearchProvider(() => options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-brave plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ web: { results: [] } })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
    const fiber = await ctx.plugin(bravePlugin, { apiKey: 'brave-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in bravePlugin).toBe(false)
  })

  it('threads the count config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
    const fiber = await ctx.plugin(bravePlugin, { apiKey: 'brave-key', count: 4 })
    await ctx.web.search({ query: 'q' })
    const [url] = dispatched(fetchMock)
    expect(url).toContain('count=4')
    await fiber.dispose()
  })

  it('falls back to $BRAVE_API_KEY and the default base URL when config omits them', async () => {
    const prev = process.env.BRAVE_API_KEY
    process.env.BRAVE_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
      const fiber = await ctx.plugin(bravePlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url, init] = dispatched(fetchMock)
      expect(url).toBe(`${BRAVE_DEFAULT_BASE_URL}/v1/web/search?q=q&count=10&result_filter=web&text_decorations=false`)
      expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('env-key')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.BRAVE_API_KEY
      else process.env.BRAVE_API_KEY = prev
    }
  })

  it('searches with the stored credential the section names', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    ctx.provide('credentials', { resolve: async () => ({ value: 'stored-key' }) } as never)
    await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
    const fiber = await ctx.plugin(bravePlugin, {})
    await ctx.web.search({ query: 'q' })
    const [, init] = dispatched(fetchMock)
    expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('stored-key')
    await fiber.dispose()
  })
})
