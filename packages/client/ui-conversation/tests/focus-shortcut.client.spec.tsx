// @vitest-environment jsdom
/** The focus shortcuts land the keyboard on the transcript and on the composer. */
import './control-row-dom.ts'
import { act } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ISession } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages,
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
  await runtime.mount({ inject: [...inject], apply })
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
