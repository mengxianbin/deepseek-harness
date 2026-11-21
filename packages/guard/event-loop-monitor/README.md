---
description: "Event-loop health watch: a windowed monitorEventLoopDelay histogram plus eventLoopUtilization answers whether the main thread is stuck, a conditional aggregate log line speaks only when over threshold, a loopback state probe serves the same numbers, slice-overshoot accounting attributes spikes to a yield point, and unattributed spikes dump a process.report."
kind: "package-reference"
---

# @deepseek-ai/dsh-event-loop-monitor

## Summary

Use this package to know at runtime whether the host's main thread is stuck, instead of guessing after the fact. A `monitorEventLoopDelay({ resolution: 10 })` histogram and an `eventLoopUtilization()` delta are read once per window (default 60 s) into p50/p99/max/mean and a light (🟢/🟡/🔴): green stays silent, an over-threshold window prints one aggregate log line, and a red stretch stamps a fact file under the DSH home. The loopback probe `GET /api/event-loop/state` serves the same numbers to the settings health card, spike windows are attributed against the three cooperative-yield slice points (`list`, `migration`, `zstd`) that book their overshoot through `recordOvershoot`, and a spike with no slice in the window dumps `process.report.getReport()` into `.tmp/loop-report/`. The `dsh` base bundle already mounts the watch next to the unit-scheduler gate.

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

Nothing to mount by hand: the `dsh` base bundle already enables the watch, so the probe and the log line are live in every stock composition. This section reads what the watch does with one config, and when the numbers are worth touching.

### When to choose it

Keep the design defaults on a normal machine — 60 s windows keep the log quiet and a 2 s single-block threshold keeps routine jitter out of the alarm. Lower `maxBadMs` or `p99WarnMs` when you are actively hunting a stall (a 500 ms experiment only trips a 300 ms threshold), shorten `windowSec` for a denser timeline during an investigation, and reach for `disable` when a composition must not carry a watch at all.

### Setting it up

Mount the plugin with no configuration:

```yaml
- name: '@deepseek-ai/dsh-event-loop-monitor'
```

A profile that needs different numbers overrides only the fields it cares about:

| Field | Default | Meaning |
| --- | --- | --- |
| `disable` | `false` | Turn the whole watch off: no histogram, no timer, no probe route, no alert file (a quiet absence — the probe 404s). The yml-level `disabled: true` key skips the plugin entirely. |
| `windowSec` | `60` | Sampling window in seconds; each window reads the histogram, resets it, folds the light, and speaks only when over threshold. |
| `p99WarnMs` | `250` | p99 warn threshold in ms: one or two consecutive windows over it are 🟡, three are 🔴. |
| `maxBadMs` | `2000` | Single-block bad threshold in ms: one window above it is at least 🟡, and it is the boundary that decides spike attribution. |

The generated [configuration catalog entry](../../../docs/config-catalog.md#deepseek-aidsh-event-loop-monitor) carries the same field list with its source JSDoc.

### What you get

- **A direct measurement of "is it stuck"** — the delay histogram is the definition of a stall (the timer that should have fired did not), and ELU separates a busy loop from a blocked one.
- **Silence by default** — green windows log nothing; one conditional line per over-threshold window carries p99, max, ELU and the window size in the design's fixed shape.
- **Attribution, not just alarm** — a spike that lines up with a slice overshoot names the slice; a spike that does not dumps a `process.report` for forensics.
- **A loopback-only probe** — `GET /api/event-loop/state` answers the settings health card behind the unit-scheduler fence (non-loopback callers get 403), and the unit-scheduler queue card sits beside it so a full gate queue is never misread as a stuck loop.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Three layers (design event-loop-monitor-1108 §一)

1. **What**: `monitorEventLoopDelay({ resolution: 10 })` samples for the process lifetime; each window tick reads p50/p99/max/mean (ns → ms), takes an `eventLoopUtilization()` delta, and resets the histogram. The light fold is a pure function (`foldWindow`): 🟢 under both thresholds, 🟡 one or two consecutive p99-over windows or a single max breach, 🔴 three consecutive over-windows or three consecutive ELU-hot windows (the design's "ELU>90% 持续" gap-fill, mirroring the ≥3-window rule).
2. **Who**: the three cooperative-yield slice points already compare `performance.now() >= yieldDeadline`; inside that branch they call `recordOvershoot(slice, overMs)`, one map increment at a check they already run. The registry lives on `globalThis` under `Symbol.for('dsh.event-loop-monitor.overshoot')`, so every importer in the host process shares one accumulator. A window whose max crosses `maxBadMs` with no overshoot delta is unattributed and triggers the `process.report` dump (10-minute cooldown per watch).
3. **Don't misread**: `GET /api/event-loop/state` serves the same window numbers plus the light, the bounded history ring (sparkline), the cumulative attribution table, the unattributed tally and the bounded timeline — the settings card renders those five blocks next to the unit-scheduler card.

### Three channels (design §三)

- **a — log**: `formatAggregateLine` returns the design's line (`event-loop: p99 412ms max 2.1s elu 63% over 60s window`) for yellow/red and `undefined` for green; the tick logs it once per window.
- **b — alert fact file**: every red window stamps `<dsh-home>/event-loop-watch-state.json` with pure facts (auto-route poll-state shape); a recovery writes the recovered light and the red duration. Absence means "never red", never "broken" — the write is fail-soft and warned once.
- **c — probe**: registered from a child fiber waiting on `webServer` (the composition without an HTTP layer keeps the watch and simply has no route), fence before method check, `cache-control: no-store`.

### Source map

| File | Role |
| --- | --- |
| `src/index.ts` | The plugin: config schema, light fold, aggregate line, window tick, alert writer, dump, and the probe route. |
| `src/overshoot.ts` | The globalThis-keyed slice-overshoot registry the three yield points write and the tick diffs. |
| `tests/` | Design-table folds, line shape, registry diffing, probe schema/fence, `disable`, fail-loud config, loader shape, and two real-timer legs (500 ms busy-wait → spike + line; slice in window → attribution). |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Design: 事件循环监控方案设计](../../../content/tech/ai/dsh/event-loop-monitor-design-1108.md) — the single implementation basis (three layers, three channels, light table, UI five blocks).
- [Unit-scheduler observation layer](../unit-scheduler/README.md) — the P0.5 precedent this watch copies (conditional line, fenced probe, unref'd tick) and the queue card that keeps its numbers from being misread.
- [Gap argument](../../../content/tech/ai/dsh/async-main-thread-block-audit-1108.md) — why production had no runtime "is it stuck" signal before this package.
- [Configuration catalog entry](../../../docs/config-catalog.md#deepseek-aidsh-event-loop-monitor) — generated field reference for this package.
- [Guard group map](../README.md) — the other packages in this group.

-----

<a id="model-experience"></a>
## Model Experience

None, as observation policy only: it reads timers and logs; it registers no prompt, schema, or result text.

#### KV Cache effect

No direct invalidation: the package contributes no request tokens and never mutates a request prefix, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the watch stops answering. They are current package constraints, not a backlog.

- **A single spike under the thresholds is silent by design** — with defaults, one 500 ms block is below `maxBadMs` and too rare to move a 60 s p99; the design trades that miss for a quiet log (raise sensitivity by lowering the thresholds, or read the probe's `max` directly).
- **The first sampling interval after a window reset can miss a stall that starts inside it** — a Node histogram quirk measured during implementation (a `reset()` immediately followed by a block loses that block's sample); mid-window stalls are captured, and windows are long enough that the exposure is one resolution interval per window.
- **Channel b is a writer, not an alarm by itself** — the fact file is stamped for a future/auto-route-style reader; no reader folds it into a health frame yet, so today the log line and the probe are the live surfaces.
- **Unattributed dumps are rate-limited** — one `process.report` per 10 minutes per watch, so a sustained unattributed stall leaves the first scene and tallies the rest rather than flooding `.tmp/loop-report/`.
- **Process-local only** — the histogram and the registry live in one host process; a second host or a worker thread has its own watch and its own accumulator.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The watch is deliberately read-only: nothing it counts feeds back into scheduling or request handling, and the slice points' `recordOvershoot` calls are pure accounting at a branch they already execute. `foldWindow` and `formatAggregateLine` are pure so the design tables are testable without timers; the two real-timer tests use `windowSec: 1` with `maxBadMs: 300` to make a 500 ms busy-wait an over-threshold window within a bounded runtime — production keeps 60 s / 250 ms / 2000 ms. The alert-file write path is intentionally not driven red from tests (it would stamp the real `<dsh-home>` fact file); red logic lives in the pure fold.

</details>
