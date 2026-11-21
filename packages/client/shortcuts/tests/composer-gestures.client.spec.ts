import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { classifyComposerEnter, composerEnterDisplay, composerEnterGestures } from '../src/client/gestures.ts'

/** Read one gesture consumer's source, relative to this spec file. */
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

interface EnterEventFacts {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

const event = (overrides: Partial<EnterEventFacts> = {}): EnterEventFacts =>
  ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...overrides })

it('classifies the bare Enter as the newline gesture', () => {
  expect(classifyComposerEnter(event())).toBe('newline')
})

it('classifies the submit and accelerated variants', () => {
  expect(classifyComposerEnter(event({ shiftKey: true }))).toBe('submit')
  expect(classifyComposerEnter(event({ ctrlKey: true }))).toBe('accelerated')
  expect(classifyComposerEnter(event({ metaKey: true }))).toBe('accelerated')
})

it('refuses modifiers outside a binding exact set', () => {
  expect(classifyComposerEnter(event({ altKey: true }))).toBe('none')
  expect(classifyComposerEnter(event({ shiftKey: true, ctrlKey: true }))).toBe('none')
  expect(classifyComposerEnter(event({ ctrlKey: true, metaKey: true }))).toBe('none')
  expect(classifyComposerEnter(event({ key: 'a' }))).toBe('none')
})

it('keeps the behavioral pair and its display bindings aligned', () => {
  expect(composerEnterGestures.newline.map(binding => binding.modifiers)).toEqual([[]])
  expect(composerEnterGestures.submit.map(binding => binding.modifiers)).toEqual([['shift']])
  expect(composerEnterGestures.accelerated.map(binding => binding.modifiers)).toEqual([['control'], ['meta']])
  expect(composerEnterDisplay.accelerated.modifiers).toEqual(['primary'])
})

it('classifies every gesture consumer through the authority', () => {
  const keymap = read('../../ui-conversation/src/client/input/editor/keymap.ts')
  const apply = read('../../ui-conversation/src/client/apply.ts')
  const composer = read('../../ui-user-questions/src/client/QuestionComposer.tsx')
  const questionPlugin = read('../../ui-user-questions/src/client/index.ts')
  expect(keymap).toContain('classifyComposerEnter')
  expect(composer).toContain('classifyComposerEnter')
  expect(apply).toContain('composerEnterGestures')
  expect(questionPlugin).toContain('composerEnterGestures')
})

it('keeps raw Enter bindings and modifier-discriminating comparisons out of the consumers', () => {
  const keymap = read('../../ui-conversation/src/client/input/editor/keymap.ts')
  const apply = read('../../ui-conversation/src/client/apply.ts')
  const composer = read('../../ui-user-questions/src/client/QuestionComposer.tsx')
  const questionPlugin = read('../../ui-user-questions/src/client/index.ts')
  for (const source of [keymap, apply, composer, questionPlugin]) expect(source).not.toContain("code: 'Enter'")
  // The answer composer keeps one bare key comparison: Enter on a focused
  // option BUTTON confirms the batch. Gesture discrimination on
  // event.key + modifiers must stay inside the authority, never here.
  expect(composer).not.toMatch(/\.key\s*(!==|===)\s*['"]Enter['"]\s*\|\|/)
  expect(keymap).not.toMatch(/\.key\s*(!==|===)\s*['"]Enter['"]/)
})
