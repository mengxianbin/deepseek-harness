---
description: "The Brave-backed search provider for ctx.web: how deployments mount vendor-native web search whose key resolves per search through the credentials service."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-brave

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-brave`, the harness searches the web through the Brave Search API and gets vendor-native results with plain-text snippets and provider-computed dates. Choose it when a deployment holds a Brave Search API token: the key resolves on every search — a literal config value, the credentials service reference `apiKeyEnv`, or the launch environment — so a rotated key applies to the next search without a restart. Brave returns no generated answer, so results carry only citeable sources. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `brave` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: brave`.

### When to choose it

Choose this backend when a deployment holds a Brave Search API token and wants Brave's index with per-result description snippets and page dates. The provider is unavailable — and every search call fails with a structured error — when no key can be resolved from any plane, the endpoint base does not parse, or `count` falls outside 1 through 20.

### Minimal configuration

Load the web service and the provider; every setting has a safe default, and the key needs no configuration file entry.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-brave'
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | (unset) | Literal Brave token; prefer `apiKeyEnv` so no secret enters a configuration file |
| `apiKeyEnv` | `BRAVE_API_KEY` | Credential reference resolved through the credentials service on each search (the Web search settings page writes it), falling back to the launch environment |
| `baseURL` | `https://api.search.brave.com/res` | Endpoint base; `/v1/web/search` is appended. An unparseable value makes the provider unavailable |
| `count` | `10` | Results requested per search, an integer from 1 through 20; a smaller request bound wins |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-brave) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each Brave entry maps to a `WebSearchSource`: `url`, `title`, `description` as `snippet`, and the ISO `page_age` as `publishedAt`; an entry without a URL is dropped, blank optional fields are omitted, and the human-readable `age` prose is never mapped to `publishedAt`. The request asks only for the web result block with `result_filter=web` and undecorated text via `text_decorations=false`, so snippets arrive as plain text. The configured `count` and the request's `maxResults` yield the smaller bound; the service applies the final `maxResults` truncation. Brave returns no generated answer, so the result carries no `content`.

### Failures and recovery

Provider failures surface as `WebError` `WEB_PROVIDER_ERROR`: HTTP errors carry the status line plus the provider's detail, network failures, and unrecognizable or unprocessable response bodies. A missing key surfaces as `WEB_PROVIDER_CREDENTIAL_MISSING`, naming the credential reference and the three planes that can supply it. An aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted, so the subscription token is never replayed to another host. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Brave's Web Search API with three deliberate rules:

- **ISO dates only.** `page_age` is Brave's ISO date time; the `age` prose would violate the seam's `publishedAt` contract, so it is never mapped — a wrong timestamp is worse than an absent one.
- **One settings snapshot per search.** Credential, endpoint, and count are read once at each search's entry, so one search never mixes two settings sections.
- **No invented answers.** Brave returns no generated answer, so `content` is omitted rather than fabricating provider prose the model might trust.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: volatile config schema, per-search credential resolution, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `BraveSearchProvider`: request dispatch, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | Brave wire types: response envelope, result entry, error envelope |

### Request and mapping flow

`search()` resolves the key (literal, then the credentials service, then the launch environment), takes the smaller of the configured `count` and the request's `maxResults`, and issues a `GET {baseURL}/v1/web/search?q&count&result_filter=web&text_decorations=false` with `x-subscription-token` and `redirect: 'error'`, so a redirect fails the request without contacting the target or replaying the token. The parsed `web.results[]` are mapped one by one, URL-less entries dropped, and the service applies the final `maxResults` bound on the way back. An already-aborted signal or a `DOMException` named `AbortError` becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the seven-package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-brave) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, description snippets, and page dates or its exact `Brave search aborted`, `Brave search request failed: <error>`, `Brave returned an unprocessable response body: <error>`, and `Brave web search has no API key for "<ref>"` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **`count` cannot exceed 20** — Brave's Web Search API accepts at most 20 results per query (verified 2026-10-20), so a larger request bound is clamped by the configured value.
- **Only `apiKey`/`apiKeyEnv`/`baseURL`/`count` are exposed** — Brave's other controls (freshness, country, search language, safesearch, goggles, non-web result blocks, summarizer) wait on provider-neutral service fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **A response without a `web` block is an empty result, not an error** — callers cannot distinguish "no matches" from a filtered response.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: wider Brave control surface

Brave's freshness, country/language, safesearch, goggles, non-web blocks, and summarizer polling stay unexposed. Exposing them needs provider-neutral service fields first, so the family adds one coordinated control rather than a vendor-specific argument. Adding `exa` and `perplexity` to the settings page needs each of those plugins to grow its own settings namespace first.

</details>
