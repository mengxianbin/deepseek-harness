# Agent Note: One fact, one alarm surface for the auto-route controller

Status: implemented

English | [中文](2026-11-04-auto-route-poll-alarm.zh.md)

## Problem

The usage glance's source badge rendered a red dot whenever the `dsh-auto-route` controller failed its meter poll, and a warn dot whenever the default source diverged from the in-flight source (the 95–99 dead zone). Both dots competed with the progress bars' own warning colors for the same glance column, and a transient connection blip — observed at roughly 90 seconds, self-healing — lit the dot as loudly as a real outage would. Meanwhile the actual availability question (the controller being unable to read its meters for minutes) had no ambient surface at all: the sidebar dot was the only signal, it disappeared on self-heal, and the controller's warn log lines reach no persistent file in the web profile.

## Decision

Each fact gets exactly one alarm surface, tiered by duration (2026-11-04 ruling). Both source dots are retired: usage warnings speak through the bar colors alone, the source state through the dimmed Go window rows plus the button tooltip, and the fork state needs no chrome at all. A transient poll failure survives only as one hover-revealed line on the glance button's `title` (`glance.source.pollError`) — never standing, never ambient. A sustained failure (the consecutive-miss streak reaching ~5 minutes, ≈ N=7 at the 45 s cadence) reddens the 安康盾 and inserts the queue alarm row with their own dedicated text, and the shared health detail gains a third section showing the raw error and the streak age.

The sustained verdict rides the existing health frame rather than a new client fetch: the controller stamps `<dsh-home>/auto-route-poll-state.json` after every tick — success or failure, because a quiet writer reads as a dead loop — carrying only facts (`at`, `ok`, bounded `error`, `failingSince` at the streak's first miss). The session-controller's heartbeat sweep reads that file beside the 值守总账 and folds an optional `autoRoute` plane into the same `api-session/health` frame; the fold, not the writer, computes `sustained`, so the alarm threshold lives next to its consumer. Absence semantics invert duty's fail-closed on purpose: duty's collector is mandatory, this plugin is optional, so a missing, unparseable, or stale ledger detaches the plane and the client renders a quiet "not wired" line — never broken, never a false red. Version skew fails toward transient: a writer without `failingSince` can never prove duration, so it reads non-sustained forever rather than ringing the shield.

## Alternatives considered

**Keep the red dot, add a shield alarm.** Rejected: two surfaces for one fact double the meaning of the dot, which is exactly the dilution the retirement removes.

**Amber/dark styling to encode both usage warning and poll failure on one chip.** Rejected by the user: a chip carrying two meanings destroys the UI's ability to say which fact it is reporting.

**Flash the 安康盾 on every blip.** Rejected as 狼来了: sub-minute connection resets would ring the availability alarm ten times a day and train the user to ignore it.

**Merge auto-route's fetch with dsh-usage's.** Rejected: the two consumers isolate their failure domains deliberately; the ruling keeps the dual fetch.

**Producer-side `sustained` flag in the state file.** Rejected: the threshold is a UI-policy constant, and computing it in the fold keeps the writer a pure fact recorder while letting the verdict refresh on every 15 s sweep instead of every 45 s tick.

**A push API on `sessionController`.** Rejected in favor of the duty-file style: the file decouples the two repositories, is inspectable evidence for incident forensics, and mirrors the existing 值守总账 precedent exactly.

## Consequences

The glance column returns to the pre-badge layout byte for byte at rest, and a self-healing blip now leaves no trace in the sidebar — the drill-down surfaces (button tooltip, shield detail) still show the current raw state for investigation. The queue alarm gains a third branch with text that never borrows "reconciliation broken", because the books balance while the controller is blind. The state file adds one small write per ≤60 s tick and one small read per 15 s sweep, both best-effort: a failed write or an absent file degrades to a detached plane, never to a false alarm. The `meters.ts` error string now appends the bounded `error.cause` chain (three links, 160 chars each, secret-free — the bearer key lives in headers), so a bare `fetch failed` no longer hides whether the break was DNS, proxy, or TCP. Client-side changes take effect on the next bundle build plus reload; the frame fold and the writer ride the next merged restart of the host and the web profile together — each side degrades gracefully if only one has landed.
