/**
 * Wire types for the Brave Search API (`GET {base}/v1/web/search`). Types only
 * — no runtime code. Brave answers with a family of typed result blocks
 * (web, news, videos, infobox, ...); this provider requests only `web`
 * (`result_filter=web`) and maps its flat `web.results[]`.
 *
 * @module @deepseek-ai/dsh-web-search-brave/types
 */

/** One entry of Brave's `web.results[]`. */
export interface BraveWebResult {
  /** Destination URL of the result. */
  url: string
  /** Result title. */
  title?: string
  /** Snippet text; delivered without decoration markers when `text_decorations=false`. */
  description?: string
  /** Human-readable age of the page, e.g. `2 days ago` — NOT an ISO-8601 timestamp. */
  age?: string
  /** The page's date, as an ISO date time, when Brave could determine one. */
  page_age?: string
}

/** Brave's web-search response envelope, restricted to the `web` result block. */
export interface BraveSearchResponse {
  /** The web results block; absent when the query matched nothing. */
  web?: {
    /** Web results in relevance order. */
    results?: BraveWebResult[]
  }
}

/** Brave's error response envelope (best-effort; fields vary by failure). */
export interface BraveError {
  /** HTTP status mirrored by the service, when present. */
  status?: number
  /** Human-readable failure description. */
  message?: string
}
