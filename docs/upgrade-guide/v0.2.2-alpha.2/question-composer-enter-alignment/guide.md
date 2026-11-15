---
kind: upgrade-guide
description: "The question answer field now uses Enter for a line break and Shift+Enter to continue the flow."
---

# Question composer Enter follows the shared pair

English | [中文](guide.zh.md)

## Change

The question composer's answer field swapped its two Enter gestures to match the conversation composer. Plain `Enter` used to continue the flow (next question or submit) and `Shift` + `Enter` inserted a line break; now `Enter` inserts a line break and `Shift` + `Enter` (or `Cmd`/`Ctrl` + `Enter`) continues the flow. Enter during IME composition still only confirms the candidate, a highlighted `/` menu pick still settles through the menu, and Enter on a focused option button still submits the batch.

Every user of the Web app and the Desktop app who answers a question observes it: a long answer gains a line break it previously needed `Shift` + `Enter` for, which touch devices could not press. The Keyboard shortcuts reference now shows the pair under one group, Text input (renamed from Message input): `Enter` beside New line, and `Shift` + `Enter` beside both Send message and Next / Submit, the answer field's row registered from the same bindings the keys consume. The queue-row editor and the goal bar keep their own Enter behavior.

## Migration

1. In a question's text answer, press `Enter` for a new line instead of continuing the flow.
2. To continue from the keyboard, press `Shift` + `Enter`, or click Next / Submit; both remain unchanged for the Send button.
3. Update scripts, tests, and automations that drive a question answer: a `press('Enter')` that advanced becomes `press('Shift+Enter')`, and a `press('Shift+Enter')` that broke the line becomes `press('Enter')`.
4. Confirm in a session: type two lines in an answer field with `Enter` between them (the field grows, the flow stays), then press `Shift` + `Enter` (the flow advances).
