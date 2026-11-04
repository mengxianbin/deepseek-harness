---
description: "Host audit journal helper: append one local-timestamped access, resume, or profile-patch line straight to process stdout so dsh-web.log keeps a forensics trail."
kind: "package-library"
---

# @deepseek-ai/dsh-audit-line

English | [中文](README.zh.md)

## Summary

`dsh-audit-line` appends one timestamped line per audited Host action to process stdout, which the launcher captures as `dsh-web.log`. The host webserver, session-controller, and config-editor import `auditLine()` so access, session-resume, and profile-patch records share one `[yyyy-MM-dd HH:mm:ss]` local-time prefix. The library keeps no state and owns no record vocabulary: each caller formats its body (`access …`, `resumed session …`, `patch written …`) and passes one line of text. It writes stdout directly because the shipped profile mounts no logger console exporter, so a line sent through `ctx.logger` would never reach the log file.

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

### When to use it

Reach for this helper whenever a Host-side audit fact must survive in the launcher-captured journal: the webserver's request-exit `access` lines, the session-controller's `resumed session` lines after a successful `ctx.agents.resume`, and the config-editor's `patch written` line after a profile patch commits. A caller that already routes records through `ctx.logger` keeps doing so; this package exists only for stdout-persisted audit lines the rotation log must retain.

### Entry point

```ts
import { auditLine } from '@deepseek-ai/dsh-audit-line'

auditLine('access GET /api/probe 401 127.0.0.1 3')
```

Success looks like one line on the process stdout stream — `[2026-11-04 18:09:59] access GET /api/probe 401 127.0.0.1 3` — captured by the launcher redirection into `dsh-web.log`; there is no failure mode, return value, or thrown error. Message line breaks are folded to spaces so one call always yields exactly one journal line. See the contracts in [`src/index.ts`](src/index.ts) for exact detail.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`auditTimestamp` renders the local wall clock as zero-padded `yyyy-MM-dd HH:mm:ss`, matching the launcher journal's own prefix so incident timelines cross-align. `auditLine` brackets that prefix, normalizes embedded line breaks, and appends `message` plus a newline through `process.stdout.write`; nothing is buffered or batched.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Timestamp renderer and single-line stdout writer |
| [`tests/audit-line.spec.ts`](tests/audit-line.spec.ts) | Prefix format, single-line guarantee, and bracketed output |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Utility package map](../README.md) — shared primitives.
- [Webserver route registration](../../host/webserver/src/index.ts) — the request-exit `access` line's production call site.

-----

<a id="model-experience"></a>
## Model Experience

None, as this journal helper appends Host log lines that no request assembles into model context.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Launcher-captured stdout only** — the line survives in `dsh-web.log` only while the launcher redirects the Host's stdout; a process started without that redirection prints the line to its own console and loses it on rotation-less exits.
- **Caller-owned vocabulary** — the helper cannot stop a caller from omitting the timestamp or folding fields; record shapes stay enforced by each call site's tests.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Added with the N1/N2/N3 audit-gap batch so access, resume, and profile-patch writes share one stdout journal line format.

</details>
