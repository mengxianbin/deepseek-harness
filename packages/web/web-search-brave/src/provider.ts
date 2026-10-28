/**
 * `BraveSearchProvider`: a `WebSearchProvider` backed by the Brave Search API
 * (`GET {base}/v1/web/search` with `result_filter=web`). It maps each
 * `web.results[]` entry to a normalized source: `title` as `title`,
 * `description` as `snippet`, and `page_age` (an ISO date time) as
 * `publishedAt`. The human-readable `age` string is deliberately NOT mapped to
 * `publishedAt` — the seam's contract is provider-supplied ISO-8601, and
 * inventing a timestamp from prose would lie. Brave returns no generated
 * answer, so `content` is omitted.
 * @module @deepseek-ai/dsh-web-search-brave/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
/** Stable id this provider registers under. */
export const BRAVE_PROVIDER_ID = 'brave'

/** Default Brave Search endpoint base, including its `/res` prefix; `/v1/web/search` is appended. */
export const BRAVE_DEFAULT_BASE_URL = 'https://api.search.brave.com/res'

/** Default number of results requested per search, the service's own default. */
export const BRAVE_DEFAULT_COUNT = 10

/** Longest result count the Brave Search API accepts. */
export const BRAVE_MAX_COUNT = 20

/** Default credential reference resolved when a section names none. */
export const BRAVE_DEFAULT_API_KEY_ENV = 'BRAVE_API_KEY'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Credential, endpoint, and result settings snapshotted for one search. */
export interface BraveSearchProviderOptions {
  /** Literal Brave API key; takes precedence over the resolver. */
  apiKey?: string
  /** Resolve the current API key without retaining it. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by the missing-key diagnostic. */
  apiKeyEnv?: string
  /** API base including its `/res` prefix; `/v1/web/search` is appended. */
  baseURL: string
  /** Results requested per search, from 1 through 20; a smaller request bound wins. */
  count: number
}

/**
 * Map one Brave web result to a normalized source, or `undefined` when the
 * entry carries no URL (the one field the seam always requires).
 *
 * @param item - one entry of Brave's `web.results[]`, untrusted.
 * @returns the normalized source, or `undefined` when no URL survives.
 */
export function mapBraveResult(item: unknown): WebSearchSource | undefined {
  if (!isRecord(item)) return undefined
  const url = item.url
  if (typeof url !== 'string' || url.length === 0) return undefined
  const title = item.title
  const description = item.description
  const pageAge = item.page_age
  return {
    url,
    ...typeof title === 'string' && title.length > 0 ? { title } : {},
    ...typeof description === 'string' && description.length > 0 ? { snippet: description } : {},
    // `page_age` is Brave's ISO date time; `age` is prose ("2 days ago") and
    // would violate the seam's ISO-8601 `publishedAt` contract.
    ...typeof pageAge === 'string' && pageAge.length > 0 ? { publishedAt: pageAge } : {},
  }
}

/**
 * Map a Brave web-search response envelope to a normalized search result.
 * A response without a `web` block is an empty result, not an error.
 *
 * @param response - the parsed `/v1/web/search` response body.
 * @returns the normalized result; URL-less entries are dropped
 *   ({@link mapBraveResult}).
 * @throws {@link WebError} `WEB_PROVIDER_ERROR` when the body is not a
 *   recognizable Brave envelope.
 */
export function mapBraveResponse(response: unknown): WebSearchResult {
  if (!isRecord(response)) throw braveInvalidResponse()
  const web = response.web
  if (web === undefined) return { sources: [], truncated: false }
  if (!isRecord(web) || web.results !== undefined && !Array.isArray(web.results)) throw braveInvalidResponse()
  const results: unknown[] = Array.isArray(web.results) ? web.results : []
  const sources = results
    .map(mapBraveResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  // Brave returns no generated answer, so `content` is omitted. The web service
  // owns the final `maxResults` truncation, so this provider reports
  // `truncated: false`.
  return { sources, truncated: false }
}

/**
 * Search through the Brave Search API. HTTP redirects fail as
 * `WEB_PROVIDER_ERROR`; a missing key fails as `WEB_PROVIDER_CREDENTIAL_MISSING`
 * naming the credential reference.
 */
export class BraveSearchProvider implements WebSearchProvider {
  readonly id = BRAVE_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT search, read once at each
   * search's entry so one search never mixes two settings sections.
   */
  constructor(private readonly resolveOptions: () => BraveSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return (options.apiKey !== undefined && options.apiKey.length > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && isResultCount(options.count)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const apiKey = await resolveBraveApiKey(options, signal)
    // A per-request bound wins over the configured default; the seam enforces
    // the final bound regardless.
    const count = Math.min(options.count, request.maxResults ?? options.count)
    const query = new URLSearchParams({
      q: request.query,
      count: String(count),
      // Only the web block: news/videos/infobox carry no portable sources here.
      result_filter: 'web',
      // Keep snippets clean: decorations would leak into `snippet` text.
      text_decorations: 'false',
    })
    const endpoint = `${options.baseURL.replace(/\/+$/u, '')}/v1/web/search?${query.toString()}`

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'x-subscription-token': apiKey,
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw braveAborted(signal, error)
      throw new WebError(`Brave search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Brave API error (HTTP ${status})`
      try {
        const parsed: unknown = await response.json()
        if (isRecord(parsed)) {
          const detail = typeof parsed.message === 'string' ? parsed.message
            : typeof parsed.error === 'string' ? parsed.error
              : isRecord(parsed.error) && typeof parsed.error.message === 'string' ? parsed.error.message
                : undefined
          if (detail !== undefined && detail.length > 0) message += `: ${detail}`
        }
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be
        // swallowed into a generic HTTP-error message (the seam's
        // cancellation contract).
        if (signal?.aborted === true || isAbortError(error)) throw braveAborted(signal, error)
        // Otherwise the status line above already carries the real error; a
        // malformed/non-JSON body can only cost a richer message.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload: unknown = await response.json()
      throwIfBraveAborted(signal)
      return mapBraveResponse(payload)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw braveAborted(signal, error)
      const message = error instanceof WebError
        ? error.message
        : `Brave returned an unprocessable response body: ${String(error)}`
      throw new WebError(message, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/**
 * Resolve one operation's API key without retaining it on the provider.
 * @param options - the caller's snapshot, so the key and the endpoint it is
 * sent to come from one section.
 * @param signal - abort signal for the surrounding operation.
 * @returns the resolved key.
 */
async function resolveBraveApiKey(options: BraveSearchProviderOptions, signal?: AbortSignal): Promise<string> {
  throwIfBraveAborted(signal)
  if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
  const { resolveApiKey } = options
  if (resolveApiKey !== undefined) {
    try {
      const resolved = await resolveApiKey()
      if (resolved !== undefined && resolved.length > 0) return resolved
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw braveAborted(signal, error)
      throw new WebError(
        `Brave web credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  }
  const ref = options.apiKeyEnv ?? BRAVE_DEFAULT_API_KEY_ENV
  throw new WebError(
    `Brave web search has no API key for "${ref}"; store it through the credentials service`
      + ' (the web Web-search settings page writes it), export it in the launching environment,'
      + ' or set a literal "apiKey" in the web-search-brave config',
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
}

/** Report malformed upstream JSON without embedding response content. */
function braveInvalidResponse(): WebError {
  return new WebError('Brave returned an invalid response body', 'WEB_PROVIDER_ERROR')
}

/** Narrow a remote JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True for result counts the Brave API accepts (1 through 20). */
function isResultCount(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= BRAVE_MAX_COUNT
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfBraveAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw braveAborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function braveAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('Brave search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
