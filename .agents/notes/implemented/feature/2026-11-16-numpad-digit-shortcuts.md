# Agent Note: Numpad digits trigger digit-row shortcut bindings

Status: implemented

English | [中文](2026-11-16-numpad-digit-shortcuts.zh.md)

## Problem

Shortcut dispatch matches the physical `event.code` against a closed whitelist: [`normalizeBinding`](../../../../packages/client/shortcuts/src/binding.ts) accepts `Key[A-Z]`, `Digit[0-9]`, `F1`–`F24`, and a fixed punctuation, editing, and navigation table, and throws `Unsupported shortcut code` for everything else. A numeric keypad sends `Numpad0`–`Numpad9`, so the keypad can neither trigger a shortcut nor be recorded into one — the editor answers a keypad press with "This key is not supported." — and no commit in the shortcut packages ever discussed the exclusion (`git log -S Numpad` over `packages/client/shortcuts`, `packages/client/ui-shortcuts`, and `apps/desktop/src/keyboard.ts` is empty).

The exclusion is unexamined initial scope, not a recorded decision: the 2026-09-21 commit that introduced `binding.ts` already carried it, no test pins it, and the package's [known-limitations list](../../../../packages/client/shortcuts/README.md) does not name it. Nothing in the record preserves a rationale to honor, and the cost lands on users: at a full keyboard the keypad sits under the right hand, yet `Ctrl+1`/`Ctrl+2`/`Ctrl+3` still demand a reach to the digit row, so the same bindings get different ergonomics per device class.

Any fix must clear five constraints the whitelist has quietly been carrying:

- **Display.** [`presentBinding`](../../../../packages/client/shortcuts/src/binding.ts) strips only `Key` and `Digit` prefixes; a raw `Numpad1` would render as the literal keycap `Numpad1`.
- **ARIA.** `aria-keyshortcuts` names keys by [UI Events `key` values](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key), not by `code`; the keypad digit's `key` value is `1` with NumLock on and `End` with it off, so a first-class keypad binding has no stable name distinct from the digit row.
- **Persistence.** A saved `Numpad1` fails [`parseBinding`](../../../../packages/client/shortcuts/src/configuration.ts) on any build with the old whitelist, and one bad entry reads the whole preference document as invalid, locking settings editing until it is hand-repaired — the fail-closed read is recorded in the [preferences Agent Note](../../implemented/architecture/2026-09-20-device-local-shortcut-preferences.md).
- **Electron accelerators.** The menu vocabulary spells keypad keys `num1` and friends — a third spelling — and Electron does not fire a digit-row accelerator from the keypad ([electron#3332](https://github.com/electron/electron/issues/3332)).
- **Chords.** Two-key bindings sort and compare raw codes in [`keyboard.ts`](../../../../apps/desktop/src/keyboard.ts) and the recording editor; two vocabularies through that state machine invite mismatches.

## Decision

The keypad digits map onto the digit row at the three seams where a physical code enters the shortcut system, through one shared helper exported from the shortcut protocol: [`aliasKeypad`](../../../../packages/client/shortcuts/src/binding.ts) sits beside `bindingKey`, matches `^Numpad([0-9])$`, returns `Digit$1`, and passes every other code through unchanged — both adapters call it directly and the recording editor reaches it through the injected `Shortcuts.aliasCode` service method (client feature packages may not value-import across plugins), so one mapping serves all three seams instead of copies:

- [`dom.ts`](../../../../packages/client/shortcuts/src/client/dom.ts) — the gesture object is built with `code: aliasKeypad(event.code)`, so one line covers Web and Linux dispatch and every fixed sequence.
- [`keyboard.ts`](../../../../apps/desktop/src/keyboard.ts) — `beforeInput` aliases once at the top through a shadow copy of the Electron `Input`, so the match lookup, the held-key two-key state, the menu-close comparison, and the code forwarded to the renderer all see `Digit*` without a single downstream edit.
- [`Editor.tsx`](../../../../packages/client/ui-shortcuts/src/client/Editor.tsx) — both the `keydown` and `keyup` handlers alias `event.code` through `aliasCode`: recording stores the `Digit*` binding, two-key recording captures both keys alike, and the release comparison matches the aliased candidate — without the `keyup` alias the capture would never fire.

Everything downstream — registry index, conflict detection, keycaps, `aria-keyshortcuts`, preference documents — keeps consuming `Digit*` only, so no display, ARIA, accelerator, or schema surface changes and no preference document can ever contain `Numpad*`.

A keypad digit's `code` does not depend on NumLock (NumLock changes `event.key`), so the mapping holds with NumLock on or off, and an unbound keypad press still delivers its browser default — navigation with NumLock off.

Scope is `Numpad0`–`Numpad9` only. `NumpadEnter`, `NumpadDecimal`, and the arithmetic keys have no digit-row counterpart; they stay unsupported and deserve their own proposal if anyone wants them.

One binding, two triggers: the keypad cannot be bound to a different command from the digit row. That is the deliberate trade.

## Alternatives considered

**First-class `Numpad*` entries in the whitelist.** The keypad could then carry its own bindings, independent of the digit row. Rejected: it must teach three vocabularies at once — keycap display, `aria-keyshortcuts` (whose key-value names cannot distinguish the keypad from the digit row at all), and Electron's `num*` accelerator spelling — it doubles the conflict matrix for every digit binding, and decisively it turns every save into a compatibility event: a preference document containing `Numpad1` reads `invalid` on any older build and locks settings editing until hand-repaired. The capability bought is one nobody has asked for — a second binding for the same action.

**Alias only in the DOM adapter.** The smallest diff, and it would fix Web immediately. Rejected: Windows and macOS Desktop dispatch configurable commands exclusively from native `before-input-event` input (per the [package README](../../../../packages/client/shortcuts/README.md)), and that is precisely where a physical keypad lives.

**Alias inside `bindingKey`.** The shared index builder looks like the single choke point. Rejected: dispatch would start matching, but the editor rejects the keypad earlier — `describeBinding` runs `normalizeBinding` before any index lookup — so recording would still fail, leaving half the feature.

**Alias inside `normalizeBinding`.** The single validator that both registration and recording pass through. Rejected for two reasons: dispatch never calls it — `registry.dispatch` builds its lookup key straight from the gesture — so keypad presses still would not trigger; and it would start accepting `Numpad*` inside stored documents, reopening exactly the downgrade-lock surface the ingestion-point design avoids.

**Do nothing and document the gap.** Rejected: the gap has no recorded rationale behind it, the ergonomic complaint is concrete, and the fix touches input adapters only — deferring preserves an unexplained exclusion rather than a decision.

## Testing

What pins the shipped behavior:

- The registry spec carries the mapping unit cases: `Numpad0`/`Numpad7`/`Numpad9` alias to `Digit0`/`Digit7`/`Digit9`, while `NumpadEnter`, `NumpadDecimal`, `NumpadAdd`, `Digit7`, and `KeyB` pass through untouched — the scope boundary is asserted, not just documented.
- The DOM seam spec is the dispatch round-trip, on both runtimes: a `Numpad7` press runs the command bound to `Digit7` and a `Digit7` press runs it again — one binding, two triggers. After the alias no reader can tell the two rows apart, which is what makes the NumLock on/off and "focuses exactly as the digit row" acceptance hold by construction.
- The desktop keyboard spec drives `before-input-event` with `Numpad7`: the `Digit7` binding suppresses the menu and the renderer forward carries `code: 'Digit7'`; a second case proves a two-key binding matches with the keypad as either chord key.
- The editor spec records a `Numpad7` press as the `['Ctrl', '+', '7']` keycaps and asserts the stored preference document contains `Digit7` and no `Numpad` — the no-`Numpad*`-in-storage criterion is a literal string assertion on the written document.
- The existing suites, `pnpm typecheck`, oxlint, and `build:lib` stay green; this change's `doc-sync` gates (note pair, wrap, links) pass — the corpus-wide `doc-sync` run still reports pre-existing legacy reds tracked on the m-note board (`#translation-pairing-legacy-red-1116` pairing, `#harness-legacy-red-links-graph-1115` links), untouched by this change.

## Consequences

**Bought:** the keypad and the digit row trigger the same bindings everywhere dispatch runs — Web, Linux, and Windows/macOS Desktop, with NumLock on or off — and the editor records keypad digits instead of answering "unsupported key". Nothing downstream changed: keycaps, `aria-keyshortcuts`, Electron accelerators, the persistence schema, and the chord state machine keep consuming one vocabulary, and a preference document written by this build still parses on older builds, so the alias closes the downgrade-lock surface rather than opening it.

**Cost:** the alias fuses the two rows — a user who wants a *different* command on the keypad cannot get one; if that demand appears, first-class `Numpad*` is the follow-up, and this alias must be revisited rather than stacked on top of it. Windows/macOS Desktop admit modifier-less digit bindings in `bindingIssue`, so with NumLock off a keypad press fires such a binding where the user expects `End`-family navigation — every shipped default carries modifiers, so only users who deliberately record a bare digit meet this. The alias is invisible in the saved document and the reference UI — a keypad press looks exactly like the digit row everywhere, which is the intent — but a bug report about what the keypad did needs that in mind. A fourth input path added later without the mapping would silently reject the keypad again; the three-seam tests are the guard.
