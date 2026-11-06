# Agent Note: Session row relay: dispatch, open, archive

Status: implemented

English | [中文](2026-11-06-session-relay-button.zh.md)

## Problem

The relay discipline (P1 300k stop-loss, P2 idle wake) has the operator hand three surfaces in sequence: save the outgoing session, dispatch a fresh one carrying a seed, then archive the old row — and the seam between them is exactly where stale context slips in: chatter can land after the last DONE save, so a relay that races the save inherits unsaved or unfinished work. The session row already offered archive and pin on hover, but nothing on the row could say "continue this session's work elsewhere" in one click, and any orchestration that waited on save inside the click would make the button answer at save's speed rather than the UI's.

## Decision

The relay button is a thin orchestrator over two server calls; save never enters the click path (direction 7). One click runs the chain in order: `POST /api/session-dispatch` — the owning Workspace looked up from the workspace snapshot, the localized seed carrying the source Session id, the source's display title so the continuation keeps the name, and the explicit `danger-full-access` pin the 2026-11-04 dispatch ruling requires — then, only on a 200, the new Session is seated locally (the same cross-transport seat `createNamed` uses), opened as the main view, and only then is the source archived through the existing seal-gated archive flow (quiet green with the undo notice, the stale one-line prompt, the red confirmation — all untouched). Create-new first, archive-last, forward-only: a failed dispatch archives nothing and raises the retryable `relayFailed` notice with the server's own message; an archive that fails after the successor exists raises `relayArchiveFailed` and never rolls the created Session back — the row keeps its plain archive entry for a manual retry. The button is hover-only: no menu row, locked scope.

The display gate is fail-closed where the archive gate is fail-open. The button is visible on every real row (not the blank placeholder, not archived, not without `workspace/archiveSession` access) and stays disabled, with its reason in the tooltip, until the row's C1 seal verdict is exactly `DONE` and the Session is stopped: the archive gate forgives an unreachable seal service because nothing is being created, while dispatch must never race a save, so only a proven DONE relays — the N_A/NEUTRAL/LEGACY green groups stay disabled here. Disabled renders through `aria-disabled` plus `data-unavailable` instead of the native `disabled` attribute, because a native disabled button stops delivering the hover and focus events Tooltip needs to explain the reason (the `MessageIconActions` unavailable-branch precedent), and the reason line rides both the tooltip label and an `aria-describedby` visually-hidden span. While the dispatch is in flight the button shows the pending reason and cannot fire twice; a successor already dispatched spends the row — the button hides rather than ever offering a second relay.

## Alternatives considered

**Wait for save inside the click (save → dispatch → archive as one synchronous flow).** Rejected: the button must answer at server-call speed, and save is the slow, interruptible half — holding the button on it produces exactly the spinning-wait experience the direction-7 ruling rules out.

**Hide the button on rows that are not sealed DONE.** Rejected by decision: a disabled button whose tooltip names the reason ("save first", the running state, the in-flight state) teaches the operator what to do next; an invisible action leaves no trace that the capability exists.

**Relay through the archive gate's fail-open green groups (N_A/NEUTRAL/LEGACY count as relayable).** Rejected: the gates answer different questions. The archive gate forgives an unreachable seal service because archiving preserves the log; dispatch creates a live Session and queues a prompt, so a verdict that is not exactly DONE means the seed may race trailing chatter. The asymmetry is deliberate and lives in the two gates' comments.

**Roll back the created Session when the archive half fails.** Rejected: forward-only. The successor is already seated, open, and seeded — destroying working state to restore a tidy list is the wrong trade; the `relayArchiveFailed` notice names the missing half and the row keeps its archive entry.

**Add a menu row for touch access (the slot doc's hoverless guidance).** Deferred: the locked scope is the hover button first; the inject face and chain are menu-ready whenever touch access is scheduled.

**Dispatch title inherited from the source vs. a fresh auto-title.** Inherited: the continuation is the same thread of work, the source archives out of the default list, and the dispatch route has no auto-title mechanism — passing the source's display title keeps both halves recognizable with one field.

## Consequences

The row strip now reads relay → archive → pin, and the button's three disabled reasons are typed locale copy in all eight dictionaries (the seed prompt included, since it is user-visible transcript text). The dispatch client bounds its wait at fifteen seconds so a wedged host cannot pin the row pending forever; an abort cancels the wait, not the request, so a server that completed after the timeout leaves a visible successor that a retry may duplicate — visible and archivable, never hidden. `archiveQuietly`/`archiveSealGated` gained an optional `onHardFailure` callback so a chain can learn when the archive half died after its own work succeeded; existing callers pass nothing and behave exactly as before. The apply-side tests pin the chain order (dispatch body → seat → open → archive) and both failure notices; the component tests pin the exact-DONE gate, the running and pending reasons, and the spend-the-row behavior. Touch and keyboard-only users do not get the relay until a menu row is added.
