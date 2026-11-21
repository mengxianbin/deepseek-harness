/**
 * The single source of truth for text-composer Enter gestures. Every composer
 * (the conversation message input, the question answer field, …) classifies
 * its Enter keydowns here, and the shortcut reference renders its input-group
 * rows from the same bindings, so one edit moves behavior and display
 * together and the reference cannot drift from what the keys actually do.
 *
 * The pair (aligned 2026-11-15): plain Enter breaks a line, Shift+Enter runs
 * the primary action (send the message / continue the question flow), and
 * Ctrl/Cmd+Enter is that action's accelerated variant. Modifiers outside a
 * binding's exact set classify as `none` and belong to application
 * shortcuts. Bindings use literal modifiers — `primary` is a display-only
 * concept and is not expanded here.
 */
import type { ShortcutBinding, ShortcutModifier } from '../binding.ts'

/** Which composer action an Enter keydown asks for. */
export type ComposerEnterGesture = 'newline' | 'submit' | 'accelerated' | 'none'

/** The keydown facts classification needs; KeyboardEvent and React's synthetic event both satisfy it. */
export interface ComposerEnterEvent {
  readonly key: string
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
}

/** One or more physical bindings per gesture: at least one combination must exist. */
export type ComposerEnterBindings = readonly [ShortcutBinding, ...ShortcutBinding[]]

/** Behavioral bindings: handlers consume these, conflict checks reserve these. */
export const composerEnterGestures: Readonly<Record<'newline' | 'submit' | 'accelerated', ComposerEnterBindings>> = {
  newline: [{ code: 'Enter', modifiers: [] }],
  submit: [{ code: 'Enter', modifiers: ['shift'] }],
  accelerated: [{ code: 'Enter', modifiers: ['control'] }, { code: 'Enter', modifiers: ['meta'] }],
}

/** Keycap rendering for each gesture: the accelerated pair shows its logical primary (⌘ / Ctrl). */
export const composerEnterDisplay: Readonly<Record<'newline' | 'submit' | 'accelerated', ShortcutBinding>> = {
  newline: { code: 'Enter', modifiers: [] },
  submit: { code: 'Enter', modifiers: ['shift'] },
  accelerated: { code: 'Enter', modifiers: ['primary'] },
}

/** Whether a keydown's exact modifier set equals one binding's declared set. */
function claims(binding: ShortcutBinding, active: ReadonlySet<ShortcutModifier>): boolean {
  return binding.modifiers.length === active.size && binding.modifiers.every(modifier => active.has(modifier))
}

/**
 * Classify one Enter keydown against {@link composerEnterGestures}.
 * @param event - keydown facts from any event shape carrying them.
 * @returns the gesture whose binding matches exactly, or `none`.
 */
export function classifyComposerEnter(event: ComposerEnterEvent): ComposerEnterGesture {
  if (event.key !== 'Enter') return 'none'
  const active = new Set<ShortcutModifier>()
  if (event.ctrlKey) active.add('control')
  if (event.altKey) active.add('alt')
  if (event.shiftKey) active.add('shift')
  if (event.metaKey) active.add('meta')
  for (const gesture of ['newline', 'submit', 'accelerated'] as const) {
    if (composerEnterGestures[gesture].some(binding => claims(binding, active))) return gesture
  }
  return 'none'
}
