/**
 * Brave Search-backed `WebSearchProvider` plugin. It contributes to the
 * `ctx.web` registry without owning the service. The API key resolves per
 * operation — a literal `apiKey`, else the credential the credentials service
 * holds for `apiKeyEnv`, else the launch environment — so a stored or rotated
 * key applies to the next search without a restart.
 * @module @deepseek-ai/dsh-web-search-brave
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  BRAVE_DEFAULT_API_KEY_ENV,
  BRAVE_DEFAULT_BASE_URL,
  BRAVE_DEFAULT_COUNT,
  BRAVE_MAX_COUNT,
  BraveSearchProvider,
} from './provider.ts'

export {
  BRAVE_DEFAULT_API_KEY_ENV,
  BRAVE_DEFAULT_BASE_URL,
  BRAVE_DEFAULT_COUNT,
  BRAVE_MAX_COUNT,
  BRAVE_PROVIDER_ID,
  BraveSearchProvider,
  mapBraveResponse,
  mapBraveResult,
} from './provider.ts'
export type { BraveSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-brave'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Settings read by the next search without re-registering the provider. */
export interface Config {
  /** Literal Brave API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each search; defaults to `BRAVE_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** API base including its `/res` prefix; `/v1/web/search` is appended. */
  baseURL: Volatile<string>
  /** Results per search, from 1 through 20; a smaller request bound wins. Defaults to 10. */
  count: Volatile<number>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(BRAVE_DEFAULT_API_KEY_ENV).volatile(),
  baseURL: z.string().default(BRAVE_DEFAULT_BASE_URL).volatile(),
  count: z.number().step(1).min(1).max(BRAVE_MAX_COUNT).default(BRAVE_DEFAULT_COUNT).volatile(),
})

/** Register the Brave search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new BraveSearchProvider(() => {
    const apiKeyEnv = credentialRef(config.apiKeyEnv.get())
    const literalApiKey = config.apiKey.get()
    return {
      ...literalApiKey !== undefined && literalApiKey.length > 0 ? { apiKey: literalApiKey } : {},
      resolveApiKey: async () => {
        const credentials = ctx.get('credentials')
        if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
        // Without the seam the environment is the whole credential plane.
        const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
        return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
      },
      apiKeyEnv,
      baseURL: config.baseURL.get(),
      count: config.count.get(),
    }
  }))
}
