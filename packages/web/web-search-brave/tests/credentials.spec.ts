/** API-key resolution for the Brave provider through the credential and launch-environment planes. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as bravePlugin from '@deepseek-ai/dsh-web-search-brave'

const BASE = 'https://api.brave.test/res'

/** Stub the search endpoint and read back the subscription token of every dispatched request. */
function captureToken(): () => (string | null)[] {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
    JSON.stringify({ web: { results: [] } }), { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetchMock)
  return () => fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-subscription-token'))
}

/**
 * Mount the web seam and the plugin with a fixed launch environment, so no ambient key leaks in.
 * @param ctx - the root context.
 * @param config - plugin configuration.
 * @param environment - launch-environment variables.
 */
async function mount(ctx: Context, config: Record<string, unknown>, environment: Record<string, string>): Promise<void> {
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: environment }]))
  await ctx.plugin(WebRuntime, { searchProvider: 'brave' })
  await ctx.plugin(bravePlugin, { baseURL: BASE, ...config })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('web-search-brave API-key resolution', () => {
  it('resolves the referenced credential for each request, so a stored or rotated key needs no restart', async () => {
    const token = captureToken()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-brave-credentials-'))
    const ctx = new Context()
    try {
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await mount(ctx, {}, {})
      const missing = ctx.web.search({ query: 'missing' })
      await expect(missing).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      await expect(missing).rejects.toThrow(/"apiKey" in the web-search-brave config/)
      const ref = credentialRef('BRAVE_API_KEY')
      await ctx.credentials.set(ref, 'stored-key')
      await ctx.web.search({ query: 'stored' })
      await ctx.credentials.set(ref, 'rotated-key')
      await ctx.web.search({ query: 'rotated' })
      expect(token()).toEqual(['stored-key', 'rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ['the default reference', {}, { BRAVE_API_KEY: 'env-key' }, 'env-key'],
    ['a configured reference', { apiKeyEnv: 'MY_BRAVE_KEY' }, { MY_BRAVE_KEY: 'custom-key' }, 'custom-key'],
    ['an empty literal key', { apiKey: '' }, { BRAVE_API_KEY: 'env-key' }, 'env-key'],
  ])('falls back to the launch environment for %s without a credentials service', async (_case, config, environment, expected) => {
    const token = captureToken()
    const ctx = new Context()
    try {
      await mount(ctx, config, environment)
      await ctx.web.search({ query: 'q' })
      expect(token()).toEqual([expected])
    } finally { await ctx.fiber.dispose() }
  })

  it('prefers a literal key over every other source', async () => {
    const token = captureToken()
    const ctx = new Context()
    try {
      await mount(ctx, { apiKey: 'literal-key' }, { BRAVE_API_KEY: 'env-key' })
      await ctx.web.search({ query: 'q' })
      expect(token()).toEqual(['literal-key'])
    } finally { await ctx.fiber.dispose() }
  })

  it('treats an empty environment value as missing', async () => {
    const token = captureToken()
    const ctx = new Context()
    try {
      await mount(ctx, {}, { BRAVE_API_KEY: '' })
      await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      expect(token()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('treats an empty credential value as missing', async () => {
    const token = captureToken()
    const ctx = new Context()
    try {
      ctx.provide('credentials', { resolve: async () => ({ value: '' }) } as never)
      await mount(ctx, {}, {})
      await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      expect(token()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })
})
