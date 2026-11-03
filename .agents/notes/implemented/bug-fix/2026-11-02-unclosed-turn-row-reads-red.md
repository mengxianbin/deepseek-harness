# Agent Note: Unclosed turn reads red without reopening the Session

Status: implemented

English | [中文](2026-11-02-unclosed-turn-row-reads-red.zh.md)

## Problem

After a Host restart, a Session whose turn the process left open kept a silent row — or a stale green one — until someone opened it. `lastTurnOutcome` folds only committed `turn/end` events, and the `interrupted` closer that ends such a turn is written solely when the Session is resumed, so the header-only list path can never produce it. Measured on this machine at 2026-11-02 22:29 across 1401 stored projection records: of the 12 cold Sessions whose `turnBoundary.openTurnStartSeq` was still set, 7 folded `lastTurnOutcome` to `null` and rendered no dot at all, 1 folded to a pre-crash `completed` and rendered green, and only the 4 whose previous turn had also been interrupted rendered red. Opening each Session wrote the closer and turned it red, which is what made the defect look like a per-row chore.

## Decision

`turnBoundary` is registered with a `wire`, so it joins `summaryKeys()` and rides every list row. Its `stateVersion` stays 2 and its stored rows already read 2, so nothing goes stale, no cold refold is scheduled, and the list serves the fact on the first pull after deploy. `UiSession.publishStatus` derives `diedMidTurn = openTurnStartSeq != null && running === false` and feeds it into `durableFailed`, the same chain the `interrupted` closer feeds, so the row dot, the read mark, and the queue priority all keep one vocabulary.

The pair is exact rather than heuristic. The Host appends `turn/start` only after `wakeDriver` publishes the running transition, and `kick` appends `turn/end` before the phase returns to idle, so a Session with a live Agent reports running for as long as its own turn stays open; a cold row reports `running: false` from `summarizeCold`. An unclosed turn on a not-running Session therefore means nothing will ever close it. A fork seed never reaches that state because `buildForkSeed` closes its inherited turn with the `forked` reason.

## Alternatives considered

**Fold `interruptedTurnClosers` into the cold refold.** `repairColdRow` reads the stored log through `SessionHandle.read`, and balancing it with the synthetic closers before `coldSnapshot` would make `lastTurnOutcome` produce `interrupted` directly. The closers take seqs past the end of the stored log, so the checkpoint would claim events the log has not accepted — the invariant that function's own JSDoc states, and the ordering the write path's flush exists to protect. A torn tail later rewritten by the write path would land on seqs the checkpoint already claimed, and the next fold would skip those real events. Rejected for a data-loss path, not for effort.

**Extend `lastTurnOutcome` to express an open turn and bump `stateVersion` 2→3.** The fold would stay single-sourced and the row dot, the 安康 shield, and a future nudge would all read one key. A version bump makes every stored row unusable at once, so the list would serve all 1191 of them blank until the serial repair pump refolded them one log read at a time — deploying the mass-blank outage this change exists to remove. Rejected on the deploy window, not on the design.

**Guard on `agentAvailable` instead of `running`.** The Host's list row carries it, but the client's `SessionSummary` does not: `lineage` strips it while building `SessionListEntry`, and adding it to the wire would widen a contract to express something `running` already proves. Rejected as redundant.

## Consequences

- A cold Session with an unclosed final turn reads red on the first list pull after deploy, with no refold and no blank window; opening it still writes the real closer and the mark it already carried is unchanged.
- Every list row carries four extra small fields, and `turnBoundary` now publishes a control frame on each turn and step boundary change. The control stream already carried units that change per step, so this adds volume rather than a new kind of traffic.
- The running guard rests on one ordering in `agent-loop`. If `turn/start` were ever appended before the running transition is published, a live Session would flash red as it starts a turn; nothing else in this change would catch that.
- The 安康 shield still reads `lastTurnOutcome` and sweeps only Sessions with a live Agent, so a cold interrupted Session is counted by the row dot and not by the shield. The two stay consistent because both treat `interrupted` and an unclosed turn as the same stopped outcome, but they do not count the same set.
- [`ui-session.client.spec.ts`](../../../../packages/client/ui-session/tests/ui-session.client.spec.ts) covers the open-turn red mark, the pre-crash green value it overrides, and the running guard. [`session-projections.host.spec.ts`](../../../../packages/api/session-controller/tests/session-projections.host.spec.ts) now collects only the keys it asserts, so an unrelated unit's frame cannot starve its assertions.
- An auto-nudge that must decide "did this Session stop mid-turn" reads `turnBoundary.openTurnStartSeq` plus `running` on the Host, both already available without opening the Session.
