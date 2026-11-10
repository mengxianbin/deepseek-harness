// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ShortcutFixedInput, Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'
import { installInterventionStep, type InterventionStep } from '../src/client/intervention-step.ts'

let handler: ((input: ShortcutFixedInput) => void) | undefined

const shortcuts: Pick<Shortcuts, 'observeFixedInput'> = {
  observeFixedInput: (listener) => {
    handler = listener
    return () => { handler = undefined }
  },
}

interface KeyOptions {
  readonly code?: string
  readonly alt?: boolean
  readonly control?: boolean
  readonly repeat?: boolean
  readonly region?: 'page' | 'editable' | 'terminal'
  readonly modal?: string | null
  readonly target?: Element | null
}

/** One fixed keydown with only the fields a test actually varies. */
function keydown(options: KeyOptions = {}): { input: ShortcutFixedInput; consume: ReturnType<typeof vi.fn> } {
  const consume = vi.fn()
  return {
    consume,
    input: {
      type: 'keydown',
      gesture: {
        code: options.code ?? 'ArrowDown',
        control: options.control ?? false,
        alt: options.alt ?? true,
        shift: false,
        meta: false,
        repeat: options.repeat ?? false,
        composing: false,
        defaultPrevented: false,
      },
      context: { region: options.region ?? 'page', modal: options.modal ?? null, target: options.target ?? null },
      consume,
    },
  }
}

/** A conversation on screen with an explicit visible height. */
function conversation(id: string, visible: number): HTMLElement {
  const element = document.createElement('div')
  element.dataset.conversationSession = id
  document.body.append(element)
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: visible, width: 200, height: visible }),
  })
  return element
}

afterEach(() => {
  handler = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('installInterventionStep', () => {
  it('steps the conversation the gesture landed in and consumes the chord', () => {
    const step = vi.fn()
    const railSteps = new Map<SessionId, InterventionStep>([[SessionId('chat-a'), step]])
    installInterventionStep(shortcuts, railSteps)
    conversation('chat-a', 400)

    const { input, consume } = keydown({ target: document.body.firstElementChild })
    handler?.(input)
    expect(consume).toHaveBeenCalledTimes(1)
    expect(step).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('routes an arrow pair in both directions', () => {
    const step = vi.fn()
    installInterventionStep(shortcuts, new Map([[SessionId('chat-a'), step]]))
    const target = conversation('chat-a', 400)

    const up = keydown({ code: 'ArrowUp', target })
    handler?.(up.input)
    const down = keydown({ code: 'ArrowDown', target })
    handler?.(down.input)
    expect(step.mock.calls).toEqual([[-1], [1]])
  })

  it('leaves the chord to the browser when a modifier, repeat, or other key rides along', () => {
    const step = vi.fn()
    installInterventionStep(shortcuts, new Map([[SessionId('chat-a'), step]]))
    const target = conversation('chat-a', 400)

    for (const options of [{ alt: false }, { control: true }, { repeat: true }, { code: 'PageDown' }]) {
      const { input, consume } = keydown({ ...options, target })
      handler?.(input)
      expect(consume).not.toHaveBeenCalled()
    }
    expect(step).not.toHaveBeenCalled()
  })

  it('yields to an open dialog and to a terminal', () => {
    const step = vi.fn()
    installInterventionStep(shortcuts, new Map([[SessionId('chat-a'), step]]))
    const target = conversation('chat-a', 400)

    handler?.(keydown({ modal: 'other', target }).input)
    handler?.(keydown({ region: 'terminal', target }).input)
    expect(step).not.toHaveBeenCalled()
  })

  it('steps from the composer, whose caret is inside the conversation', () => {
    const step = vi.fn()
    installInterventionStep(shortcuts, new Map([[SessionId('chat-a'), step]]))
    const conversationElement = conversation('chat-a', 400)
    const composer = document.createElement('div')
    conversationElement.append(composer)

    const { input, consume } = keydown({ region: 'editable', target: composer })
    handler?.(input)
    expect(consume).toHaveBeenCalledTimes(1)
    expect(step).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('falls back to the conversation on screen when focus names none', () => {
    const visible = vi.fn()
    const hidden = vi.fn()
    installInterventionStep(shortcuts, new Map([
      [SessionId('chat-visible'), visible],
      [SessionId('chat-hidden'), hidden],
    ]))
    conversation('chat-visible', 500)
    conversation('chat-hidden', 0)

    const { input, consume } = keydown({ target: document.body })
    handler?.(input)
    expect(consume).toHaveBeenCalledTimes(1)
    expect(visible).toHaveBeenCalledExactlyOnceWith(1)
    expect(hidden).not.toHaveBeenCalled()
  })

  it('stays out of an editable field outside every conversation', () => {
    const step = vi.fn()
    installInterventionStep(shortcuts, new Map([[SessionId('chat-a'), step]]))
    conversation('chat-a', 400)
    const field = document.createElement('input')
    document.body.append(field)

    const { input, consume } = keydown({ region: 'editable', target: field })
    handler?.(input)
    expect(consume).not.toHaveBeenCalled()
    expect(step).not.toHaveBeenCalled()
  })

  it('ignores a conversation that published no step, and a reset', () => {
    const step = vi.fn()
    installInterventionStep(shortcuts, new Map([[SessionId('chat-a'), step]]))
    const stranger = conversation('chat-other', 400)

    const { input, consume } = keydown({ target: stranger })
    handler?.(input)
    expect(consume).not.toHaveBeenCalled()
    handler?.({ type: 'reset' })
    expect(step).not.toHaveBeenCalled()
  })

  it('releases its subscription when disposed', () => {
    const step = vi.fn()
    const dispose = installInterventionStep(shortcuts, new Map([[SessionId('chat-a'), step]]))
    dispose()
    expect(handler).toBeUndefined()
  })
})
