---
description: "Event-loop state probe: a thin shell that serves the external sampler's state file — the loopback-fenced GET /api/event-loop/state passes a fresh <dsh-home>/event-loop-state.json through verbatim (200) and answers 503 stale when the file is missing, malformed or older than twice its window; the in-process histogram/ELU watch, slice-overshoot attribution and loop-report output scheme are retired with internal sampling."
kind: "package-reference"
---

# @deepseek-ai/dsh-event-loop-monitor

## Summary

Use this package to keep answering "is the main thread stuck" after the watch moved out of process (m-note design `event-loop-monitor-offproc-design-1123.md` §六 stages 2–3; user ruling 2026-11-24: mechanism A = external RTT probe plus on-demand external capture, `elu` = external CPU% proxy, package kept as a shell). The in-process watch this package used to be — a `monitorEventLoopDelay({ resolution: 10 })` histogram, an `eventLoopUtilization()` delta, the 60 s window tick, the light fold, the conditional aggregate log line, the slice-overshoot registry, the red-window alert fact file and the loop-report-sign-1123 signature/cold-layer output scheme — is retired: a frozen main thread cannot sample itself (the「事后 dump 栈永远是报案人栈」structural blind spot), and all sampling now lives in an external process (availability gate `rule/dsh-availability-gate.md` §二 first choice「外移出宿主」: the external collector computes, the host only reads and answers). What remains is the answer surface the settings card already polls: the loopback-fenced probe `GET /api/event-loop/state` reads the external sampler's one small file, `<dsh-home>/event-loop-state.json`, and passes its bytes through verbatim when fresh (200); a missing / unreadable / malformed / stale file answers 503 `{"ok":false,"error":"stale"}`, and because consumers already treat any non-200 as absent, a dead sampler is a quiet absence, never a broken face. The `dsh` base bundle already mounts the shell next to the unit-scheduler gate.

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

Nothing to mount by hand: the `dsh` base bundle already enables the probe, so the endpoint is live in every stock composition. This section reads what the shell does with one config, and when its knobs are worth touching.

### When to choose it

The shell decides nothing: the external sampler owns the window, the thresholds (design §二 60 s / 250 ms / 2000 ms, judgment values unchanged) and the capture legs. Keep the defaults on a normal machine, and reach for `disable` when a composition must not carry the probe at all — a disabled component is a quiet absence (the probe 404s through the webserver's unmatched path), never a broken face.

### Setting it up

Mount the plugin with no configuration:

```yaml
- name: '@deepseek-ai/dsh-event-loop-monitor'
```

A profile that needs different numbers overrides only the fields it cares about:

| Field | Default | Meaning |
| --- | --- | --- |
| `disable` | `false` | Turn the probe off entirely: no route registers (a quiet absence — the probe 404s). The yml-level `disabled: true` key skips the plugin entirely. |
| `windowSec` | `60` | Retired with internal sampling (held by the external sampler): accepted for profile compatibility, no effect here; the default still sizes the freshness fallback. |
| `p99WarnMs` | `250` | Retired with internal sampling (held by the external sampler): accepted for profile compatibility, no effect here. |
| `maxBadMs` | `2000` | Retired with internal sampling (held by the external sampler): accepted for profile compatibility, no effect here. |

### What you get

- **A fresh-state pass-through** — a fresh `<dsh-home>/event-loop-state.json` is served byte-for-byte (200), so the settings health card and the gear-adjacent frame pill keep their exact response shape and their exact numbers.
- **Fail-soft by construction** — a missing / unreadable / unparseable / stale file answers 503 `{"ok":false,"error":"stale"}`; the client pull chain (`pullOne` → `null`) already renders that as the card's unavailable line and no pill face, so a dead sampler is a quiet absence (availability Q4: 面消失 ≠ 面变坏).
- **A loopback-only probe** — non-loopback callers get 403 before any state is read, non-GET gets 405 with `allow: GET`, and every answer carries `cache-control: no-store` (unchanged fence semantics from the unit-scheduler precedent).
- **Nothing else** — no timers, no sampling, no writes: one small-file read per poll (availability gate §二 first choice, duty-inventory「one small file, never a per-tick schedule query」先例).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Freshness gate (design `event-loop-monitor-offproc-design-1123.md` §六 stage 2)

The handler reads the state file, parses it, takes the payload's own `windowSec` (60 when absent or unusable) as the window, and compares the file's mtime against twice that window (`FRESHNESS_WINDOWS = 2`). Fresh → the file's bytes go out verbatim; anything the gate cannot prove fresh — missing, unreadable, not a JSON object, or too old — returns `undefined` and the handler answers 503 stale. Every failure path is a caught `undefined`: the gate never throws into a request.

### Response shape contract

`EventLoopState` (exported types) documents the payload byte-for-byte what the external sampler writes: `at`, `windowSec`, `p50`, `p99`, `max`, `mean`, `elu`, `light`, `consecutiveOver`, `consecutiveNormal`, `overWindows`, `history`, `attribution`, `unattributed`, `events`. The client's `parseEventLoop` guards the load-bearing keys and drops anything malformed to `null`; an empty `attribution` array renders the health card's table with only its gray unattributed row, and `elu` carries the external CPU% proxy (labeled「进程外代理」in all eight locales, ruling 2026-11-24).

### Source map

| File | Role |
| --- | --- |
| `src/index.ts` | The whole shell: config schema (historical keys retained, only `disable` effective), the freshness gate, and the fenced probe route. |
| `tests/` | Thin-shell contract: fresh 200 byte pass-through with the full shape, stale/missing/malformed 503, fence 403, method 405, `disable` quiet absence, judgment-value zero-change pins. |

`src/overshoot.ts` (slice-overshoot registry) and `src/signature.ts` (loop-report-sign-1123 output scheme) were deleted with the internal watch; the three cooperative-yield slice points keep their yield logic and no longer book overshoot.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Design: 进程外事件循环监视器设计档](../../../content/tech/ai/dsh/event-loop-monitor-offproc-design-1123.md) — the single implementation basis for this shell (sampling options, state-face wiring, deprecation route).
- [Design: 事件循环监控方案设计](../../../content/tech/ai/dsh/event-loop-monitor-design-1108.md) — the original in-process watch this shell replaces (three layers, three channels, light table, UI five blocks).
- [Unit-scheduler observation layer](../unit-scheduler/README.md) — the P0.5 precedent the fence and route registration still copy, and the queue card that keeps its numbers from being misread.
- [Configuration catalog entry](../../../docs/config-catalog.md#deepseek-aidsh-event-loop-monitor) — generated field reference for this package.
- [Guard group map](../README.md) — the other packages in this group.

-----

<a id="model-experience"></a>
## Model Experience

None, as observation policy only: it reads one small file and answers an HTTP probe; it registers no prompt, schema, or result text.

#### KV Cache effect

No direct invalidation: the package contributes no request tokens and never mutates a request prefix, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the shell stops answering. They are current package constraints, not a backlog.

- **The probe answers 503 until the external sampler starts writing the state file** — after this shell lands and dsh web restarts (restart is always a human step), the settings card shows its unavailable line and the frame pill shows no face until the sampler ships its first fresh file; that transition window is the design's quiet absence, not a regression of the face logic.
- **The shell computes nothing** — `p50`/`p99`/`max`/`elu`/`light`/`history`/`attribution`/`events` are exactly what the file carries; a well-formed JSON object with wrong field values passes through (the client's shape guard is the second line of defense, dropping it to an absent face).
- **Freshness granularity is the sampler's window** — the file's mtime is the writer's liveness signal, so the card carries at least the design's 60 s lag by construction (unchanged from the in-process watch's window semantics).
- **`windowSec` / `p99WarnMs` / `maxBadMs` are inert here** — profiles may keep setting them without error, but only the external sampler reads them; changing them in a profile changes nothing until the sampler is configured to match.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The shell is deliberately read-only: nothing it reads feeds back into scheduling or request handling. Freshness uses `statSync(...).mtimeMs`, not the payload's `at` field — mtime is the writer's liveness signal and cannot be forged by a stalled payload clock. Tests point `DSH_HOME` at a throwaway temp directory (`resolveDshHome` reads `process.env.DSH_HOME` at call time, ahead of `data-root.json`), so no test can stamp the real `~/.dsh/event-loop-state.json`; the old throwaway-cwd discipline for `.tmp/loop-report/` retired with `src/signature.ts`. The judgment values stay pinned by test: 60 s window, 250 ms p99 warn, 2000 ms single-block bad (design §二, zero change per the task boundary).

</details>
