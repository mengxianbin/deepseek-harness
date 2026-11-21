---
kind: upgrade-guide
description: "Composer Enter now inserts a line break and Shift+Enter sends the message."
---

# Composer Enter breaks the line and Shift+Enter sends

English | [中文](guide.zh.md)

## Change

The conversation composer swapped its two Enter gestures. Plain `Enter` used to send the draft and `Shift` + `Enter` inserted a line break; now `Enter` inserts a line break and `Shift` + `Enter` sends the draft. `Cmd`/`Ctrl` + `Enter` keeps its accelerated Queue/Steer delivery, and `Enter` with `Alt`, `AltGraph`, both `Ctrl` and `Cmd`, or `Shift` plus `Ctrl`/`Cmd` still leaves the draft unchanged for application shortcuts.

Every user of the Web app and the Desktop app observes the swap, and touch devices gain a line break they previously had no key for. Nothing else moves here: menus, dialogs, terminals, the queue-row editor, and the goal bar keep their own Enter behavior, and every other shortcut keeps its binding. The Keyboard shortcuts reference now lists `Shift` + `Enter` beside Send message and `Enter` beside New line; a later change in this release aligns the question composer with the same pair and renames the group to Text input (see [question composer Enter](../question-composer-enter-alignment/guide.md)).

## Migration

1. When typing a multi-line message, press `Enter` for a new line instead of `Shift` + `Enter`.
2. To send from the keyboard, press `Shift` + `Enter`; the Send button and `Cmd`/`Ctrl` + `Enter` are unchanged.
3. Update scripts, tests, and automations that drive the composer: a `press('Enter')` that sent becomes `press('Shift+Enter')`, and a `press('Shift+Enter')` that broke the line becomes `press('Enter')`.
4. Confirm in a session: type one line and press `Enter` (the draft grows a line and no message is sent), then press `Shift` + `Enter` (exactly one message arrives).
