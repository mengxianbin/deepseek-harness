---
description: "Web ask_user_question feature for the dsh web client: the native composer answer surface, timed wait, drafts, late replies, and the plan-review approval card."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-user-questions

English | [中文](README.zh.md)

## Summary

The Web client answers an agent's question beside the chat input on a native input surface: read the one-line hint that carries the questions, type a free-text answer, skip, or submit. There is no option-card presentation — the question itself lives in the agent's transcript, and this surface only collects the answer. A timed surface counts down; focus pauses it, editing or `Take time` holds it, and expiry lets the agent continue while the question stays answerable. Closing a surface linked to a tool call hides it; its tool row reopens it and later shows the recorded answers as a summary. The Host preserves the question across restart, while this browser preserves unfinished input across reload.

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

When the agent asks a question, the answer surface temporarily occupies the composer seat: a one-line hint joins the batch's question texts (` · ` separated, single-line ellipsis), a block text field collects the answer, and the footer offers **Skip** and **Submit**. Enter in the field breaks a line, while Shift+Enter (or Ctrl+Enter) submits — the shared composer gesture pair the message input also uses, classified and displayed from one authority in the shortcuts package (during IME composition Enter only confirms the input candidate without submitting). Submit is disabled while the field is empty or the answer channel is not ready; an empty submit reports `error.incomplete`. The header keeps the wait controls: countdown status, `Take time`, the `continued` / `held` markers, and Close. A running countdown pauses while focus stays inside the answer surface and resumes its remainder on blur.

### Answering

The submitted text is the answer. A batch of exactly one question fills that item's `custom` field directly; a multi-question batch lifts the text to the batch-level `note` and leaves one empty `{ selected: [] }` entry per question — the `BAD_ANSWER` contract (every question answered exactly once) documented on `AskUserQuestionAnswer` in `user-questions` owns this assembly. "Skip" retains other drafts and emits the existing blank `{ selected: [] }` result for every item. Attachments collected on the batch surface appear as chips above the field. Close is not an answer: a question the Host named by tool call only leaves the composer seat, and its `ask_user_question` tool call row brings the surface back; a request that carries no tool call has no row to return from, so closing it rejects the whole wait as `ASK_CANCELLED`.

Fixed approval questions use the same pending-question and answer channel, and a feature plugin can supply a higher-priority composer presentation. The `QuestionComposer` entry performs one intent election: a `plan-review` intent renders `PlanReviewPanel`, an approval intent renders the `QuestionFlow` option form (the caller still decides which responses grant permission), and any other question renders this native input.

### Reading a settled question back

Each answered batch appears once in a right-aligned user-style bubble after its answer is recorded, for native and PTC blocking questions and late replies. The bubble shows every question above its selected choices and custom answer, uses lighter question text, and stays visible when process groups or the containing Turn are folded. A blocking-question answer bubble does not prevent completed work steps from collapsing. Late replies admitted after the opening step are interleaved Turn inputs and keep that Turn open. Each bubble separates the process runs before and after its recorded answer. Unanswered questions remain in the answer surface and tool row.

A question that already settled closes its surface — there is no read-only card. The tool call row keeps the recorded answers as its `ask.answered` summary, and only a still-answerable call earns a reopen button; the summary never opens a card.

### The plan-review card

A `plan-review` intent — set by `dsh-plan-mode` on the `exit_plan_mode` review — renders a compact approval card: a `Plan review` strip with a `View full plan` link, the plan title and a two-line plain-text summary, and `Request changes` / `Approve` actions. The strip uses the shared warning dot and changes it to the ongoing loader while either action settles. The complete plan opens in the sidebar through the link or its permanent Chat card. Approve answers with the asker's approval label; `Request changes` rejects the wait as `ASK_CANCELLED`, returning the composer for the user's feedback without submitting an approval. The card has no separate refusal button.

### Failure and recovery

An answer field autofocuses only when its answer channel is ready and no countdown exists. Manual focus and blur during the claim handshake are retained: the countdown starts paused only if the answer surface still has focus when the remaining duration arrives.

Returning a local answer does not release its foreground claim: the Host closes that stream after accepting the waterfall outcome. The plugin owns the claim through this delivery interval. Explicit delegation releases it before calling the next answerer, and plugin disposal cancels any remaining claims.

The surface has two sources. A live Host request creates it and carries the answer back. For a timed request, the Client first opens the question-owned `attachWait` stream and derives a local deadline from its remaining-duration frame. The surface remains live while that first frame is pending. The claim lasts until the request settles or the Client disconnects, including while the surface is hidden. The surface owns the countdown; at zero it rejects with `ASK_TIMED_OUT` and stays available. Once the projection lists the call as continued, answers use the `answer` Remote method. Surface removal follows the projection, and plugin teardown releases its requests and claims.

A submission through the pending request is sent, not confirmed: when another browser settled the same request first, the gateway drops the late outcome silently. The surface therefore keeps its draft until the projection closes it, and if the call turns continued while a submission is in flight, the controls re-arm with a hint so the same draft goes through the Remote path. An accepted Remote answer steers the agent at its nearest step. While its steer waits in the durable Inbox, the editable surface closes and the question row shows the submitted answers as its read-only summary, including after a browser reconnect. Multiple pending steers are admitted together at that boundary; an active tool wait must finish before the agent can read them. Discarding a pending steer leaves the question answerable, and the user can reopen its row to submit again. A second answer while the first remains pending reports `REPLY_QUEUED`. Pristine focus freezes this browser's remaining countdown and blur resumes that remainder. The first answer mutation changes the local wait to indefinite, and `Take time` does the same explicitly. Those choices persist with this browser's draft across Session navigation and, for tool-call-keyed requests, reload. Another browser has its own countdown and can still settle the shared request; the Host projection remains the authority for whether the question is open or continued.

Each Session and pending request has an independent draft in browser storage. A tool-call-keyed request restores unfinished input after Session navigation, page reload, or browser restart; progress that no longer matches the question batch is ignored. An unnamed legacy request has a unique card key and cannot be restored after reload. A hidden surface keeps its draft for the next opening; a mounted closed surface clears its own draft, and the next mounted surface prunes drafts no live surface owns. Drafts do not synchronize to another browser or device; the Host-projected question does.

A browser that reconnects while the tool call is open receives the pending request again and can still complete it with the remaining time. A Session reopened after the agent or process ended shows the surface as continued; submitting resumes the Session's root agent and enters the answer as a new user turn.

The settled bubble is fully visible and has no disclosure control. Question and answer text renders as plain text; question detail and unselected options are omitted. Its copy action writes each question with the answer the user gave, without reopening the tool call or submitting another answer.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is one ownership rule: rendering a question is a host UI capability, having the tool is an agent capability, so the `tool-ask-user` row belongs to the presets that want it (and to the TUI composition, which has no presets).

### Reopening a surface

This package fills `userQuestionPanels`, the optional capability `dsh-client-ui-tool` declares for its `ask_user_question` row. `reveal(sessionId, callId)` republishes that call's surface as the last equal-precedence pending interaction, so the composer seat shows it again, and returns `false` when this Client holds no surface for the call — a legacy unkeyed request, another browser's question, or a request the projection already closed. Whether a question still takes an answer comes from the `userQuestions` Session projection, which the row reads directly, so the capability carries no state of its own. The capability carries only `reveal`: a settled call is never reopened as a card, because the row already shows its recorded answers as a summary.

### Intent surface election

The `QuestionComposer` entry performs one intent election in one place. A `plan-review` question renders `PlanReviewPanel`: it accepts one question declaring the intent, carrying the plan as `detail`, and offering the named approve label, with at most one alternative and no multi-select; its secondary action returns to the composer for change requests. An approval intent renders the `QuestionFlow` option form over the same pending-question channel. Any other question renders the native input above. A plan review exposes `conversation.plan-review.actions` with its request key, full text, and optional invocation identity; the plan plugin opens logged plans from history and unlogged reviews as temporary sidebar previews, and opening a document does not answer or dismiss the review.

### Copy and locale

Composer chrome copy (buttons, placeholders, validation feedback) is bilingual: the plugin registers zh/en dictionaries under the `question` namespace of `dsh-client-locale` and hands the entry its bound translator plus the locale snapshot source through the inject face, so a locale switch re-renders a mounted composer. Question, hint, and option text arrives from the model and renders verbatim; carrier failure messages also display untranslated.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the composer host, the tool seam, and the plan-mode consumer.

- [ui-conversation](../ui-conversation/README.md) — the chat surface owning the `conversation.composer` slot.
- [ui-tool](../ui-tool/README.md) — the tool call transcript whose `ask_user_question` row reopens a hidden surface.
- [tool-ask-user](../../interaction/tool-ask-user/README.md) — the model-facing tool whose schema and answers this UI renders.
- [ui-plan](../ui-plan/README.md) — the plan-mode surface that sets the `plan-review` intent.
- [user-questions](../../interaction/user-questions/README.md) — the Host-side question seam and its answerer waterfall.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-ask-user`, whose model-visible schema and answer rendering this package presents in the Web client.

#### KV Cache effect

No direct invalidation; `dsh-tool-ask-user` owns the model-visible tool call and result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define answer-surface ownership and cross-client behavior; they are current package constraints.

- **Unsubmitted drafts are local to one browser** — Session navigation, page reload, and browser restart preserve them, but another browser or device reconstructs only the Host-stored question.
- **One request owns the answer surface at a time** — later pending requests remain in the session snapshot and become visible after the earlier request resolves.
- **Questions appear in the active Session composer** — durable pending questions do not add a separate sidebar inbox; reopen the owning Session to answer one.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

The Host Session projection is authoritative for durable timed questions. Browser storage only preserves unfinished input and never creates or keeps a question open.
