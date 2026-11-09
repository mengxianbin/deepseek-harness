---
description: "Whole-log turn outline for clients and maintainers composing or debugging the turnOutline projection unit behind full-session turn navigation."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-turn-outline

English | [中文](README.zh.md)

## Summary

This package gives history clients a whole-session outline of every started turn: bounded prompt and settled-response previews, plus the human interventions inside each turn — an answered decision request, or a later human message admitted into a running turn. Clients can navigate turns that are not yet loaded and page backward from the exact event sequence needed to load a selected turn, or a selected intervention inside one. It fits assemblies that provide session projections; elsewhere, clients continue using loaded-window navigation. Previews exclude injected context and tool results, and a response appears only after its turn settles.

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

Mount the plugin beside the session store and the projection registry when clients should navigate every turn of a session without holding its complete event log. The unit registers only when the registry is present.

### Composition

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-session-turn-outline'
```

### What an entry means

| Field | Meaning |
|---|---|
| `turn` | Host-assigned turn number from the `turn/start` payload |
| `seq` | The turn's `turn/start` event seq — paging a window back through this seq loads the whole turn |
| `prompt` | Preview of the turn's first human prompt (space-joined text blocks, collapsed whitespace, 50-character cap with a trailing ellipsis when clipped — one rail-card line); `''` until an eligible prompt lands |
| `response` | Preview of the turn's final text-bearing assistant message (same normalization, 120-character cap — up to three rail-card lines); `''` until the turn ends with assistant text |
| `interventions` | Human interventions inside the turn, ascending by seq: `seq` is the intervention's own event seq (the row a jump aligns), `kind` is `question` for an answered decision request or `input` for a later human message, and `preview` is a 50-character cap of what was asked or written (`''` when it cannot be derived) |

The wire value is the complete entry array, strictly increasing by `turn` (whole-value rule): consumers replace, never merge. Prompts fill only from `user/message` events with the human `user` source, so injected context and tool results never leak into navigation; a turn whose prompt is images-only keeps `''` and consumers label it by number. A later human message in the same turn never rewrites the prompt — it appends an `input` intervention instead. An answered decision request appends a `question` intervention only once its `tool/result` lands, because that result's seq is the row the rail aligns while the `tool/call` itself may sit under a streamed chunk's seq; the call id is remembered while it waits, and a call that never returns is dropped by a fixed-size bound. The response buffers as a draft while its turn streams and commits at `turn/end`; draft-only and pending-only changes keep the `turns` array's identity, so the identity-gated change feed stays quiet until a served value moves — boundary, prompt, intervention, settled response. Preview budgets match the chat rail's loaded-turn previews, so a turn shows the same words before and after its events load.

### Failures and recovery

The unit is inert without the projection registry: `inject` keeps the fiber pending and nothing registers, so other assemblies lack the `turnOutline` key. Unmounting the plugin removes the key, because registrations are effects on the mounting fiber. Persisted-cache rows are schema-validated on restore — including the strictly-increasing turn order — so a corrupt row is discarded instead of seeding a broken fold.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the fold behind the outline; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The unit is a pure fold over committed session events. `turn/start` — not the prompt `user/message` — anchors each entry because its seq is the load-through target for a jump: the agent loop logs `turn/start` before the turn's prompt and steps, so a window paged back through that seq contains the whole turn. The prompt fills from the first human `user/message`, and only while the newest entry is still empty — later human messages in the same turn (steering) append an `input` intervention instead, so the first preview stands. An answered `ask_user_question` or `request_user_input` call appends a `question` intervention when its `tool/result` arrives: the answer bubble's row anchors at that result's seq, which is the exact row a jump aligns, while the call itself may sit under a streamed chunk's seq; a result whose turn is no longer the newest entry lands nowhere. The response cannot fill the same way (`turn/end` carries no text), so each text-bearing `assistant/message` overwrites a state draft and `turn/end` commits the survivor — the newest text, which is the loaded rail's `findLast` semantic.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `inject`, unit registration on the mounting fiber |
| [`src/projection.ts`](src/projection.ts) | The fold: entry append, preview fill, wire view |
| [`src/types.ts`](src/types.ts) | One home of the `turnOutline` projection-key declaration and entry types |

### Fold rules

- Uninteresting events return the same state reference, and draft-only or pending-only changes keep the `turns` array's identity; the registry's two `Object.is` gates then hold the feed quiet until a served value moves.
- A `turn/start` that does not advance the turn number is skipped, keeping the outline sorted; a retried boundary's previews then land on the standing entry.
- Interventions are capped — 64 per turn and 32 pending decision requests — so a runaway log stops growing the mark ladder rather than the wire.
- The wire view projects `state.turns`; the persisted-cache state schema wraps the wire schema with the draft and pending-request fields.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the unit's contract is not enough. They move from the registry that drives units to adjacent session packages.

- [Session projection subsystem](../../../docs/subsystems/session-projection.md) — the registry that drives units and serves snapshot and change-feed values.
- [Session projection registry package](../session-projection/README.md) — the registry contract units register against.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the turnOutline unit folds already-logged turn boundaries into a client-facing read model and registers nothing model-facing.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the outline describes and when the unit is absent. They are current package constraints.

- **The wire value grows with the session** — every push carries the complete outline (whole-value rule), up to ~600 bytes per turn at full CJK budgets and typically far less (each intervention costs more, its preview capped at the same 50 characters); splitting previews into an on-demand read is deferred until sessions with many thousands of turns need it.
- **The response previews only settled turns** — it commits at `turn/end`, so an open turn (or one whose end never logged) shows a prompt-only preview until the boundary lands.
- **Interventions are bounded** — at most 64 per turn and 32 pending decision requests; past either bound the turn keeps its mark and stops adding intervention marks.
- **A turn without eligible text keeps `''`** — images-only and command-only turns are navigable but labeled by number, and a turn whose steps emit no text gets no response preview.
- **Mounted only where the projection registry is composed** — other assemblies serve no `turnOutline` key, and their consumers fall back to loaded-window navigation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
