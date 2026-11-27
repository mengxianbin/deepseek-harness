// @vitest-environment jsdom
/** The focus shortcuts land the keyboard on the transcript and on the composer. */
import './control-row-dom.ts'
import { act } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ISession } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  SlotTestRuntime, stubConfigForm, syncedConfig, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import type { ShortcutCommand, ShortcutContext } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'

usePinnedBrowserLanguages('zh-CN')

const SID = 's1' as SessionId
const context: ShortcutContext = { region: 'page', modal: null, target: null }

async function bench(options: { open?: boolean } = {}) {
  const runtime = await SlotTestRuntime.create()
  let mainReference: ReturnType<typeof runtime.sessions.retain> | undefined
  const openSession = (id: SessionId): void => {
    const next = runtime.sessions.retain(id, { source: 'mainView' })
    mainReference?.release()
    mainReference = next
  }
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
      beforeOpen(SID)
      openSession(SID)
    }),
    openSession: vi.fn((id: SessionId) => { openSession(id) }),
  } as never)
  runtime.ctx.provide('configForms', {
    developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope,
  } as never)
  const commands = new Map<string, ShortcutCommand>()
  runtime.ctx.provide('shortcuts', {
    stopSequenceMs: 500,
    catalog: createSnapshotStore([]),
    register: (command: ShortcutCommand) => {
      commands.set(command.id, command)
      return () => { commands.delete(command.id) }
    },
    registerFixed: () => () => {},
    describeBinding: () => ({ binding: null, keys: [], issue: null, conflicts: [] }),
    observeFixedInput: () => () => {},
  } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.sessions.add({
    id: SID,
    summary: { title: 'S', displayTitle: 'S', cwd: '/proj' },
    session: {
      loadOlder: vi.fn<ISession['loadOlder']>(),
      prompt: vi.fn<ISession['prompt']>(async () => ({ ok: true, value: { accepted: true } })),
    },
  })
  if (options.open !== false) openSession(SID)
  await runtime.root.declare({ 'main': { kind: 'keyed', scope: 'root' } }, ({ renderSlot }) => (
    <>{renderSlot('main', {}, { entryKey: 'conversation' })}</>
  ))
  // The activation's config is an explicit mount argument since upstream dropped
  // apply's default parameter; the synced fields default through the schema.
  await runtime.mount({ inject: [...inject], apply }, syncedConfig({ busyEnter: 'queue', maxConcurrentFileUploads: 2 }))
  const view = runtime.renderRoot()
  const run = (id: string): void => {
    const resolution = commands.get(id)!.resolve(context)
    expect(resolution.status).toBe('handled')
    if (resolution.status !== 'handled') throw new Error(`${id} did not resolve`)
    resolution.run()
  }
  return { runtime, view, commands, run, mainRelease: () => mainReference?.release() }
}

describe('focus shortcuts', () => {
  it('registers both commands against the conversation namespace labels', async () => {
    const b = await bench()
    expect([...b.commands.keys()].filter(id => id.startsWith('focus.'))).toEqual([
      'focus.conversation', 'focus.composer',
    ])
    expect(b.commands.get('focus.conversation')!.label()).toBe('聚焦对话内容')
    expect(b.commands.get('focus.composer')!.label()).toBe('聚焦输入框')
    expect(b.commands.get('focus.conversation')!.defaults['web:windows']).toEqual({
      code: 'Digit2', modifiers: ['primary', 'alt'],
    })
    expect(b.commands.get('focus.composer')!.defaults['desktop:windows']).toEqual({
      code: 'Digit3', modifiers: ['primary'],
    })
    await b.runtime.dispose()
  })

  it('moves focus from the composer to the transcript and back', async () => {
    const b = await bench()
    const scroll = b.view.container.querySelector<HTMLElement>('[data-conversation-scroll]')!
    const composer = b.view.container.querySelector<HTMLElement>('[data-composer-input]')!
    expect(scroll).not.toBeNull()
    expect(scroll.tabIndex).toBe(0)
    composer.focus()
    expect(document.activeElement).toBe(composer)
    b.run('focus.conversation')
    expect(document.activeElement).toBe(scroll)
    b.run('focus.composer')
    expect(document.activeElement).toBe(composer)
    await b.runtime.dispose()
  })

  /** Wait out one animation frame: focus.composer parks its card-target focus in a rAF. */
  const nextFrame = (): Promise<void> =>
    new Promise(resolve => requestAnimationFrame(() => { resolve() }))

  /** The main Session's conversation element, where a takeover card may sit. */
  const mainSessionEl = (b: Awaited<ReturnType<typeof bench>>): HTMLElement => {
    const occurrence = [...b.view.container.querySelectorAll<HTMLElement>('[data-conversation-session]')]
      .find(element => element.dataset.conversationSession === SID)
    expect(occurrence).toBeDefined()
    return occurrence as HTMLElement
  }

  // FORK dsh-local (ask-keys-focus 2026-11-17 裁定 B): a takeover card in the
  // seat owns focus.composer — frame first (which lifts an auto-fold), then
  // the card's first safe target on the next frame.
  it('lands on a takeover question card: frame first, then the first enabled option', async () => {
    const b = await bench()
    const card = document.createElement('div')
    card.tabIndex = -1
    card.dataset.questionKey = 'question:1'
    card.dataset.composerCard = ''
    const row = document.createElement('div')
    row.dataset.optionRow = ''
    const disabled = document.createElement('button')
    disabled.disabled = true
    const option = document.createElement('button')
    option.textContent = 'Alpha'
    row.append(disabled, option)
    const field = document.createElement('textarea')
    field.placeholder = '输入你的答案'
    card.append(row, field)
    mainSessionEl(b).append(card)

    expect(document.activeElement).not.toBe(card)
    b.run('focus.composer')
    expect(document.activeElement).toBe(card)
    await nextFrame()
    // The disabled sibling never wins: the first enabled option takes focus.
    expect(document.activeElement).toBe(option)
    await b.runtime.dispose()
  })

  it('falls back to the answer field when the card has no option rows', async () => {
    const b = await bench()
    const card = document.createElement('div')
    card.tabIndex = -1
    card.dataset.questionKey = 'question:2'
    card.dataset.composerCard = ''
    const field = document.createElement('textarea')
    card.append(field)
    mainSessionEl(b).append(card)

    b.run('focus.composer')
    expect(document.activeElement).toBe(card)
    await nextFrame()
    expect(document.activeElement).toBe(field)
    await b.runtime.dispose()
  })

  it('lands a plan review on its discussion button, never the approval', async () => {
    const b = await bench()
    const card = document.createElement('div')
    card.tabIndex = -1
    card.dataset.planReviewKey = 'plan-review:1'
    const discuss = document.createElement('button')
    discuss.dataset.planReviewFirst = ''
    const approve = document.createElement('button')
    card.append(discuss, approve)
    mainSessionEl(b).append(card)

    b.run('focus.composer')
    expect(document.activeElement).toBe(card)
    await nextFrame()
    expect(document.activeElement).toBe(discuss)
    await b.runtime.dispose()
  })

  it('ignores a takeover card that belongs to another Session', async () => {
    const b = await bench()
    const other = document.createElement('div')
    other.dataset.conversationSession = 'other-session'
    const card = document.createElement('div')
    card.tabIndex = -1
    card.dataset.questionKey = 'question:other'
    other.append(card)
    b.view.container.append(other)

    b.run('focus.composer')
    await nextFrame()
    // No card in the main Session: the composer input keeps the focus.
    expect(document.activeElement).toBe(b.view.container.querySelector('[data-composer-input]'))
    expect(document.activeElement).not.toBe(card)
    await b.runtime.dispose()
  })

  it('keeps the keyboard where it is while no main Conversation is published', async () => {
    const b = await bench({ open: false })
    const composer = b.view.container.querySelector<HTMLElement>('[data-composer-input]')!
    composer.focus()
    expect(b.view.container.querySelector('[data-conversation-session]')).toBeNull()
    b.run('focus.conversation')
    expect(document.activeElement).toBe(composer)
    b.run('focus.composer')
    expect(document.activeElement).toBe(composer)
    await b.runtime.dispose()
  })

  it('unregisters both commands with the plugin', async () => {
    const b = await bench()
    await act(async () => { await b.runtime.dispose() })
    expect(b.commands.has('focus.conversation')).toBe(false)
    expect(b.commands.has('focus.composer')).toBe(false)
  })
})
