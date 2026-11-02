---
description: "Cross-session unit-operation scheduling gate: slot-holding tool calls queue on one host-global semaphore with a per-session cap, FIFO waiting, and a bounded wait that fails open instead of hanging a session."
kind: "package-reference"
---

# @deepseek-ai/dsh-unit-scheduler

## Summary

Use this package to keep concurrent sessions from saturating the host: slot-holding tool calls queue on one host-global semaphore instead of every session running at full parallelism. A per-session cap stops a single session from taking the whole budget, the queue grants in order, and a bounded wait fails open so a session never hangs. Pass-through tools such as `job_output` and `subagent` skip the queue entirely. The `dsh` base bundle already mounts the gate with defaults derived from `availableParallelism()`.

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

Nothing to mount by hand: the `dsh` base bundle already enables the plugin, so every session's tool calls already pass through the gate. This section reads what the gate does with one call, and when the four config fields are worth touching.

### When to choose it

Keep the derived defaults when a handful of sessions share one machine — the budget leaves four cores for the host and the desktop, and the per-session cap keeps any one session from starving the rest. Change a field only when the machine or the workload says otherwise: raise `maxSlots` on a large dedicated host, lower `maxSlotsPerSession` when one session's fan-out is known to be heavy, or shorten `waitTimeoutMs` when waiting longer is worse for the user than running without a slot.

### Setting it up

Mount the plugin with no configuration:

```yaml
- name: '@deepseek-ai/dsh-unit-scheduler'
```

A profile that needs different numbers overrides only the fields it cares about:

| Field | Default | Meaning |
| --- | --- | --- |
| `maxSlots` | `max(1, availableParallelism() - 4)` | Host-global slot budget across every session, subagent, and workflow child on this host; computed when the plugin loads. |
| `maxSlotsPerSession` | `2` | Most slots one session may hold at once; its further calls wait in the shared FIFO queue. |
| `waitTimeoutMs` | `60000` | Bounded wait for a slot before the call is released without one; `0` releases immediately whenever a slot is unavailable. |
| `passThroughTools` | `[]` | Extra pass-through patterns layered over the built-in list; each is an exact tool name or a `*` wildcard such as `browser_*`. |

The generated [configuration catalog entry](../../../docs/config-catalog.md#deepseek-aidsh-unit-scheduler) carries the same field list with its source JSDoc.

### What you get

- **A machine-shaped ceiling** — at most `maxSlots` slot-holding calls run at once across the whole host, whatever mix of sessions, subagents, and workflow children is dispatching.
- **Fairness without a scheduler** — one session cannot hold more than `maxSlotsPerSession` slots, so the shared queue keeps moving for everyone else.
- **A gate that cannot hang a session** — a waiter that outlives `waitTimeoutMs` is released without a slot and logged under the `unit-scheduler fail-open` token.
- **Deadlock resistance by construction** — tools that wait on someone else (a human, the network, a background job, a derived session) never take a slot, and a nested dispatch rides its ancestor's slot instead of queueing for a second one.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Every session, subagent, and workflow child issues tool calls through one `ctx.tools.execute()` pipeline, so the plugin wraps that pipeline's around-dispatch and touches nothing else. A slot is taken immediately before the call runs and released the moment it settles: the slot covers only the local execution segment, never an LLM stream or any wait that outlives the call. The plugin loads with `inject: ['tools']`, which is why a composition with no HTTP layer still gets the gate.

### Three iron laws

1. **Only the local execution segment holds a slot.** Model and network waits happen outside the wrapper, so they can never consume the budget the gate exists to protect.
2. **Tools split into two kinds.** Pass-through tools — the built-in list plus `passThroughTools` patterns — never touch the semaphore, which is what breaks the classic ring of a tool holding a slot while waiting for `job_output` or a subagent whose own calls need slots. Everything else, including tool names this plugin has never heard of, holds a slot: fail-closed rather than leak concurrency.
3. **Re-entry rides the ancestor's slot.** A nested dispatch inside an ancestor that already holds a slot is recorded as an accounting offset through `AsyncLocalStorage` — no queueing and no second slot. Tools that wait on derived sessions (`subagent`, `workflow`, `squads_*`) are pass-through instead, so each child books its own slot against the same semaphore with the same bounded wait.

The built-in pass-through coverage is `ask_user_question`, `job_output`, `job_list`, `job_kill`, `web_fetch`, `web_search`, `subagent`, `subagent_fork`, `workflow`, `squads_run_member`, `squads_run_squad`, `ui_present`, and `browser_*`.

### Source map

| File | Role |
| --- | --- |
| `src/index.ts` | The whole package: the around-dispatch wrapper, the pass-through predicate, `UnitSlotSemaphore`, and the observation counters. |
| `tests/` | Iron-law coverage: pass-through bypass, bounded-wait fail-open, the per-session cap, re-entry, abort, and config validation. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tools subsystem](../../../docs/subsystems/tools.md) — the `execute` pipeline this gate wraps, in pipeline order.
- [`dsh-tool-call-timeout-policy`](../timeout-policy/README.md) — the sibling around-dispatch wrapper; the two compose without sharing state.
- [Configuration catalog entry](../../../docs/config-catalog.md#deepseek-aidsh-unit-scheduler) — generated field reference for this package.
- [Guard group map](../README.md) — the other packages in this group.

-----

<a id="model-experience"></a>
## Model Experience

None, as scheduling policy only: it changes when slot-holding tool calls run and registers no prompt, schema, or result text.

#### KV Cache effect

No direct invalidation: the package contributes no request tokens and never mutates a request prefix, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the gate stops bounding concurrency. They are current package constraints, not a backlog.

- **Background job runtimes are not gated** — the wrapper releases a slot as soon as the tool call settles, so a job that call spawned keeps running outside any slot; the job layer's own lock is a separate mechanism. `job_output` stays pass-through so waiting for that job can never close a ring.
- **One host process only** — the semaphore is host-process-wide around this process's `execute` pipeline. A second host, a terminal, or any process outside that pipeline books no slots, so external CLI parallelism is not counted against the budget.
- **One slot per call, not per unit of work** — a single tool call holds one slot no matter how many workers it fans out internally; an environment cap such as `VITEST_MAX_WORKERS` is a different layer and is not read here.
- **The bounded wait fails open by design** — a waiter that outlives `waitTimeoutMs` (default 60 seconds) is released without a slot and logged under `unit-scheduler fail-open`. Under sustained pressure the gate therefore admits more than its budget instead of hanging a session; that partial bypass is the intended trade, not a defect.
- **Contention cause is observed, not scheduled on** — an expired wait can be a globally full pool or this session's own `maxSlotsPerSession` cap, and the gate does not distinguish them when admitting work. The split (`global-full` versus `session-cap`) lives only in the observation layer — the fail-open tally, the five-minute aggregate line, and `GET /api/unit-scheduler/state` from the P0.5 probe (task anchor `#unit-scheduler-p05-1102`) — and nothing there feeds back into scheduling.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The gate is deliberately static: `maxSlots` derives once when the plugin loads, and no signal — queue depth, wait percentiles, or system load — feeds back into a scheduling decision. The observation counters, the aggregate line, and the state endpoint report what the gate already does; wiring any of them into the budget would be a behavior change rather than a tuning step. Unknown tool names hold a slot on purpose, so a newly added tool is gated by default instead of silently bypassing the budget.

</details>
