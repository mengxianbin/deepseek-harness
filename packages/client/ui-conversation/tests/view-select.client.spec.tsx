// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createConversationStore } from '../src/client/stores.ts'
import { ViewSelect, type ViewSelectProps } from '../src/client/skeleton/ViewSelect.tsx'
import type { ViewTab } from '../src/client/contract/views.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SID = 's1' as SessionId
const CHAT: ViewTab = { id: 'chat', label: 'Chat' }
const TRAJECTORY: ViewTab = { id: 'trajectory', label: 'Trajectory' }

function mountViewSelect(options: {
  /** View ledger handed to the injected roster hook. */
  viewTabs?: readonly ViewTab[]
  /** Persisted selection in the Conversation store; omitted keeps its null default. */
  selectedId?: string
  /** Whether renderViewsActions yields rows, as it does with a registered views.actions entry. */
  withViewActions?: boolean
} = {}) {
  const viewTabs = options.viewTabs ?? [CHAT, TRAJECTORY]
  const store = createConversationStore().create()
  if (options.selectedId !== undefined) store.actions.setView(options.selectedId)
  const selectView = vi.fn((view: string) => { store.actions.setView(view) })
  const renderViewsActions = options.withViewActions === true
    ? (onDismiss: () => void) => (
      <button type="button" role="menuitem" onClick={onDismiss}>Header view action</button>
    )
    : undefined
  const makeElement = () => (
    <ViewSelect {...({
      sessionId: SID,
      useStore: bindSnapshotSelector(store),
      useConversationViews: (selector: (value: readonly ViewTab[]) => unknown) => selector(viewTabs),
      selectView,
      renderViewsActions,
    } as unknown as ViewSelectProps)} />
  )
  const view = render(makeElement())
  return {
    view, store, selectView,
    rerender: () => { view.rerender(makeElement()) },
  }
}

/** The in-place Menu anchor; stable across open and closed states. */
function trigger(): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>('[data-conversation-view-select]')
  if (element === null) throw new Error('view dropdown trigger not rendered')
  return element
}

function menuItems(): HTMLElement[] {
  return within(screen.getByRole('menu')).getAllByRole('menuitem')
}

describe('ViewSelect', () => {
  it('names the trigger after the current View and keeps the menu closed', () => {
    mountViewSelect()
    expect(trigger().textContent).toBe('Chat')
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('lists every View with the current one marked, Chat leading', () => {
    mountViewSelect({
      viewTabs: [{ id: 'notes', label: 'Notes' }, TRAJECTORY, CHAT],
      selectedId: 'trajectory',
    })
    expect(trigger().textContent).toBe('Trajectory')
    fireEvent.click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(menuItems().map(item => [item.textContent, item.getAttribute('aria-current')])).toEqual([
      ['Chat', null],
      ['Notes', null],
      ['Trajectory', 'page'],
    ])
  })

  it('selects a View from the menu, closes it, and renames the trigger', () => {
    const b = mountViewSelect()
    fireEvent.click(trigger())
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Trajectory' }))
    expect(b.selectView).toHaveBeenCalledExactlyOnceWith('trajectory')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger().textContent).toBe('Trajectory')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('hosts the header-owned view-actions rows and dismisses the menu with them', () => {
    mountViewSelect({ withViewActions: true })
    fireEvent.click(trigger())
    expect(menuItems().map(item => item.textContent)).toEqual([
      'Chat', 'Trajectory', 'Header view action',
    ])
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Header view action' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('renders with Chat as the only registered View', () => {
    mountViewSelect({ viewTabs: [CHAT] })
    expect(trigger().textContent).toBe('Chat')
    fireEvent.click(trigger())
    expect(menuItems()).toHaveLength(1)
  })

  it('renders nothing while no View is registered', () => {
    const { view } = mountViewSelect({ viewTabs: [] })
    expect(view.container.innerHTML).toBe('')
  })

  it('follows View roster changes without remounting', () => {
    const viewTabs: ViewTab[] = [CHAT]
    const b = mountViewSelect({ viewTabs })
    fireEvent.click(trigger())
    expect(menuItems().map(item => item.textContent)).toEqual(['Chat'])
    viewTabs.push(TRAJECTORY)
    b.rerender()
    expect(menuItems().map(item => item.textContent)).toEqual(['Chat', 'Trajectory'])
  })

  it('falls back to Chat when the persisted id names no registered View', () => {
    mountViewSelect({ selectedId: 'removed-view' })
    expect(trigger().textContent).toBe('Chat')
  })
})
