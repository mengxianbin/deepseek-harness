// @vitest-environment jsdom
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { HoverCardGroup, MenuItemButton, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { MenuOpenState, SessionRowOwnerProps } from '../src/client/contract/slots.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { RowDragProps } from '../src/client/rows/Rows.tsx'
import {
  ProjectRowItem as ProjectRowItemComponent, SearchResultItem, SessionNodeItem as SessionNodeItemComponent,
} from '../src/client/rows/Rows.tsx'
import type { GroupNode, SearchResultNode, SessionNode } from '../src/client/tree.ts'
import { en, zh } from '../src/client/locales.ts'
import rowCss from '../src/client/rows/Rows.module.css'
import { renderMenuButton } from './menu-button.tsx'

afterEach(cleanup)
beforeEach(() => { vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(any-hover: hover)' })) })
afterEach(() => { vi.unstubAllGlobals() })

const t = makeTranslate(zh, commonZh) as never
const tEn = makeTranslate(en, commonEn) as never

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId

/** The row lists and child seats a Session row renders. */
type RowSlotName =
  | 'sidebar.workspaces.session.menu.item'
  | 'sidebar.workspaces.session.row.action'
  | 'sidebar.session.row.trailing'
  | 'sidebar.session.row.leading'
  | 'sidebar.session.row.hover'
type RowRenderSlot = PropsRenderSlots<RowSlotName>['renderSlot']
type SessionNodeItemProps = ComponentProps<typeof SessionNodeItemComponent>
type ProjectRowItemProps = ComponentProps<typeof ProjectRowItemComponent>

const renderNoRowEntries: RowRenderSlot = () => null

// Direct row specs use the real required Slot share, empty unless the case supplies entries.
/**
 * Browser double-click: the second press carries detail 2 and must not disarm.
 * @param el - the double-clicked element.
 */
function realDoubleClick(el: Element): void {
  fireEvent.mouseDown(el, { detail: 1 }); fireEvent.mouseUp(el, { detail: 1 }); fireEvent.click(el, { detail: 1 })
  fireEvent.mouseDown(el, { detail: 2 }); fireEvent.mouseUp(el, { detail: 2 }); fireEvent.click(el, { detail: 2 })
  fireEvent.doubleClick(el)
}

function SessionNodeItem({ renderSlot = renderNoRowEntries, onRenameRequest = () => {}, renderFactorySlot = renderMenuButton,
  useContextMenuTarget = select => select(null), useSessionAccess = allowAllAccess.useSessionAccess, ...props }: Omit<
    SessionNodeItemProps, 'renderSlot' | 'onRenameRequest' | 'renderFactorySlot' | 'useContextMenuTarget' | 'useSessionAccess' | 'useContextMenu'
  > & Partial<Pick<SessionNodeItemProps, 'renderSlot' | 'onRenameRequest' | 'renderFactorySlot' | 'useContextMenuTarget' | 'useSessionAccess' | 'useContextMenu'>>) {
  return <SessionNodeItemComponent {...props} renderSlot={renderSlot} onRenameRequest={onRenameRequest}
    useContextMenu={props.useContextMenu ?? contextMenuHook()} renderFactorySlot={renderFactorySlot}
    useContextMenuTarget={useContextMenuTarget} useSessionAccess={useSessionAccess} />
}

// Direct header specs hold every access answer unless the case refuses one.
function ProjectRowItem({
  useWorkspaceAccess = allowAllAccess.useWorkspaceAccess,
  renderFactorySlot = renderMenuButton, useContextMenuTarget = select => select(null), ...props
}: Omit<ProjectRowItemProps, 'useWorkspaceAccess' | 'renderFactorySlot' | 'useContextMenuTarget' | 'useContextMenu'>
  & Partial<Pick<ProjectRowItemProps, 'useWorkspaceAccess' | 'renderFactorySlot' | 'useContextMenuTarget' | 'useContextMenu'>>) {
  return <ProjectRowItemComponent {...props} useWorkspaceAccess={useWorkspaceAccess}
    useContextMenu={props.useContextMenu ?? contextMenuHook()} renderFactorySlot={renderFactorySlot}
    useContextMenuTarget={useContextMenuTarget} />
}

/** Half detection reads the row rect; jsdom rects are all-zero by default. */
function stubRect(row: HTMLElement): void {
  row.getBoundingClientRect = () => ({
    top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34,
    x: 0, y: 100, toJSON: () => ({}),
  })
}

function dragProps(overrides: Partial<RowDragProps> = {}): RowDragProps {
  return {
    start: vi.fn(), active: false, marker: null,
    hover: vi.fn(), drop: vi.fn(), end: vi.fn(),
    ...overrides,
  }
}

/** Install the async browser clipboard and restore its prior host shape. */
function installClipboard(writeText: (text: string) => Promise<void>): () => void {
  const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return () => {
    if (prior === undefined) Reflect.deleteProperty(navigator, 'clipboard')
    else Object.defineProperty(navigator, 'clipboard', prior)
  }
}

describe('Workspace and Session hover handoff', () => {
  it.each(['workspace', 'session'] as const)('shares the first %s dwell across mixed rows and resets on list exit', (first) => {
    vi.useFakeTimers()
    try {
      const workspace = (key: string): GroupNode => ({
        key, workspaceId: wid(key), cwd: `/projects/${key}`, createdAt: 0, label: key,
        sessionCount: 0, queuedRed: 0, queuedYellow: 0, expanded: true, containsCurrent: false, sessions: [],
      })
      const session: SessionNode = {
        id: sid('session'), title: 'Session', blank: false, running: false,
        runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
      }
      render(<HoverCardGroup>
        <ProjectRowItem group={workspace('Workspace A')} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />
        <SessionNodeItem node={session} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />
        <ProjectRowItem group={workspace('Workspace B')} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />
      </HoverCardGroup>)
      const a = { anchor: screen.getByText('Workspace A'), copy: '/projects/Workspace A' }
      const b = { anchor: screen.getByText('Workspace B'), copy: '/projects/Workspace B' }
      const s = { anchor: screen.getByText('Session'), copy: 'Session\nsession' }
      // jsdom lacks PointerEvent; MouseEvent carries physical relatedTarget across row wrappers.
      const move = (from: Element, to: Element): void => {
        fireEvent(from, new MouseEvent('pointerout', { bubbles: true, relatedTarget: to }))
        fireEvent(to, new MouseEvent('pointerover', { bubbles: true, relatedTarget: from }))
      }
      const order = first === 'workspace' ? [a, s, b, a] : [s, a, b, s]
      const initial = order[0]!
      move(document.body, initial.anchor)
      act(() => { vi.advanceTimersByTime(799) })
      expect(screen.queryAllByRole('button', { name: /^复制:/ })).toHaveLength(0)
      act(() => { vi.advanceTimersByTime(1) })
      let previous = initial.anchor
      for (const current of order) {
        move(previous, current.anchor)
        expect(screen.getAllByRole('button', { name: /^复制:/ })).toHaveLength(1)
        expect(screen.getByRole('button', { name: `复制: ${current.copy}` })).toBeTruthy()
        previous = current.anchor
      }
      move(previous, document.body)
      act(() => { vi.advanceTimersByTime(300) })
      expect(screen.queryAllByRole('button', { name: /^复制:/ })).toHaveLength(0)
      move(document.body, b.anchor)
      act(() => { vi.advanceTimersByTime(799) })
      expect(screen.queryAllByRole('button', { name: /^复制:/ })).toHaveLength(0)
      act(() => { vi.advanceTimersByTime(1) })
      expect(screen.getByRole('button', { name: `复制: ${b.copy}` })).toBeTruthy()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })
})

/** jsdom lacks DragEvent — fireEvent builds no dataTransfer, which a Session row reads at drag end. */
function dragEnd(row: Element, dropEffect: DataTransfer['dropEffect'] = 'none'): void {
  fireEvent.dragEnd(row, { dataTransfer: { dropEffect } })
}

const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), setDragImage: vi.fn() }

/** jsdom lacks DragEvent — the fireEvent fallback drops clientY, so pin it on the built event. */
function fireDrag(row: HTMLElement, kind: 'dragOver' | 'drop', clientY: number): void {
  const event = kind === 'dragOver' ? createEvent.dragOver(row) : createEvent.drop(row)
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', { value: { ...dataTransfer } })
  fireEvent(row, event)
}

describe('native row drag previews', () => {
  function fixture(kind: 'workspace' | 'session') {
    const drag = dragProps()
    const view = render(kind === 'workspace'
      ? <ProjectRowItem group={{
        key: 'workspace', workspaceId: wid('workspace'), cwd: '/workspace', createdAt: 0,
        label: 'Draggable row', sessionCount: 0, queuedRed: 0, queuedYellow: 0, expanded: true, containsCurrent: false, sessions: [],
      }} onToggle={vi.fn()} onCreate={vi.fn()} drag={{ start: drag.start, end: () => { drag.end(false) } }} t={t} />
      : <SessionNodeItem node={{
        id: sid('session'), title: 'Draggable row', blank: false, running: false,
        runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
      }} currentId={undefined} now={0} onOpen={vi.fn()} drag={drag} t={t} />)
    const row = screen.getByRole('treeitem')
    stubRect(row)
    row.style.paddingInlineStart = '32px'
    const transfer = {
      effectAllowed: '', setData: vi.fn(),
      setDragImage: vi.fn<(image: HTMLElement, x: number, y: number) => void>(),
    }
    const start = () => {
      const event = createEvent.dragStart(row, { dataTransfer: transfer })
      Object.defineProperties(event, { clientX: { value: 65 }, clientY: { value: 112 } })
      fireEvent(row, event)
      return transfer.setDragImage.mock.calls.at(-1)![0]
    }
    return { ...view, row, drag, transfer, start }
  }

  it.each(['workspace', 'session'] as const)('uses an inert offscreen %s copy without changing the source row', (kind) => {
    const { row, drag, transfer, start } = fixture(kind)
    const originalStyle = row.getAttribute('style')
    dragEnd(row)
    expect(drag.end).not.toHaveBeenCalled()
    const image = start()
    expect(transfer.setDragImage).toHaveBeenCalledWith(image, 65, 12)
    expect(transfer.effectAllowed).toBe(kind === 'session' ? 'copyMove' : 'move')
    expect(transfer.setData).toHaveBeenCalledWith('text/plain', kind)
    expect(drag.start).toHaveBeenCalledOnce()
    expect(image.parentElement).toBe(document.body)
    expect(image.inert).toBe(true)
    expect(image.getAttribute('aria-hidden')).toBe('true')
    const controls = image.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')
    expect(controls.length).toBeGreaterThan(0)
    expect([...controls].every(control => control.tabIndex === -1)).toBe(true)
    expect(image.style.left).toBe('-200px')
    expect(image.style.width).toBe('200px')
    expect(image.style.height).toBe('34px')
    expect((image.firstElementChild as HTMLElement).style.paddingInlineStart).toBe('32px')
    expect(image.querySelector('[data-row-key]')).toBeNull()
    expect(image.textContent).toBe(row.textContent)
    expect(image.firstElementChild).not.toBe(row)
    expect(screen.getAllByRole('treeitem')).toEqual([row])
    expect(row.getAttribute('style')).toBe(originalStyle)
    expect(row.getAttribute('draggable')).toBe('true')
  })

  it.each(['workspace', 'session'] as const)('keeps %s dragging active when the browser rejects its preview', (kind) => {
    const { drag, transfer, start } = fixture(kind)
    transfer.setDragImage.mockImplementation(() => { throw new DOMException('Image unavailable') })
    const image = start()
    expect(drag.start).toHaveBeenCalledOnce()
    expect(vi.mocked(drag.start).mock.invocationCallOrder[0])
      .toBeLessThan(transfer.setDragImage.mock.invocationCallOrder[0]!)
    expect(image.isConnected).toBe(false)
    dragEnd(screen.getByRole('treeitem'))
    expect(drag.end).toHaveBeenCalledOnce()
  })

  it('finishes a Session drag when the source becomes archived before drag end', () => {
    const { row, drag, start, rerender } = fixture('session')
    const image = start()
    rerender(<SessionNodeItem node={{
      id: sid('session'), title: 'Draggable row', blank: false, running: false,
      runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: true,
    }} currentId={undefined} now={0} onOpen={vi.fn()} drag={drag} t={t} />)
    expect(row.getAttribute('draggable')).toBe('false')
    dragEnd(row)
    expect(image.isConnected).toBe(false)
    expect(drag.end).toHaveBeenCalledOnce()
  })

  it.each(['workspace', 'session'] as const)('removes %s previews on replacement, drag end, and unmount', (kind) => {
    const { row, drag, start, unmount } = fixture(kind)
    const first = start()
    const second = start()
    expect(first.isConnected).toBe(false)
    expect(second.isConnected).toBe(true)
    dragEnd(row)
    expect(second.isConnected).toBe(false)
    expect(drag.end).toHaveBeenCalledOnce()
    const third = start()
    unmount()
    expect(third.isConnected).toBe(false)
  })
})

describe('workspace browser rows', () => {
  it('keeps the leading status cell in the hierarchy-free flat list', () => {
    const idle: SessionNode = {
      id: sid('flat'), title: 'Flat Session', blank: false, running: false,
      runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
    }
    const view = render(<SessionNodeItem node={idle} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
    // The cell is the row's first element and holds nothing while the row is
    // idle without an occupant; the title, whose text sits in an inner span, follows it.
    const cell = screen.getByText('Flat Session').parentElement?.previousElementSibling
    expect(cell?.className).toMatch(/slot/)
    expect(cell?.children).toHaveLength(0)

    view.rerender(<SessionNodeItem node={{ ...idle, running: true }} currentId={undefined} now={0}
      onOpen={vi.fn()} t={t} />)
    // A row that gains a state dot keeps that dot in the same cell.
    expect(screen.getByText('Flat Session').parentElement?.previousElementSibling?.querySelector('[data-state="ongoing"]')).toBeTruthy()
  })

  it('renders the owning group home label between the title and the resting time (collab step3 三元组)', () => {
    const node: SessionNode = {
      id: sid('home-label'), title: 'Titled', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
      homeLabel: 'm-note',
    }
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
    const title = screen.getByText('Titled')
    const label = screen.getByText('m-note')
    // The 一眼层 order: title, home label, then the resting strip carrying the time.
    expect(title.nextElementSibling).toBe(label)
    expect(label.className).toContain('homeLabel')
    expect(label.nextElementSibling?.className).toContain('rowResting')
    expect(label.nextElementSibling?.querySelector('[class*="time"]')?.textContent).toBe('刚刚')
  })

  it('falls back to the ungrouped bucket label when the row owns no Workspace', () => {
    const node: SessionNode = {
      id: sid('loose'), title: 'Loose', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
    }
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
    expect(screen.getByText('未分组').className).toContain('homeLabel')
  })

  it('renders a selected content-search row and opens only its session', () => {
    const onOpen = vi.fn()
    const result: SearchResultNode = {
      id: sid('result'),
      title: 'Result title',
      workspace: 'Workspace context',
      running: true,
      runningSubagentCount: 0,
      completed: false, failed: false,
      archived: false,
      snippet: 'matching message excerpt',
    }
    render(<SearchResultItem result={result} currentId={result.id} onOpen={onOpen}
      onUnarchive={vi.fn()} useSessionAccess={allowAllAccess.useSessionAccess} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Workspace context')).toBeTruthy()
    expect(screen.getByText('matching message excerpt')).toBeTruthy()
    expect(row.querySelector('[data-state="ongoing"]')).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(row.hasAttribute('draggable')).toBe(false)
    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith(result.id)
  })

  it('withholds the search-result restore control while the Session access excludes unarchiving', () => {
    const result: SearchResultNode = {
      id: sid('archived-result'), title: 'Archived', workspace: 'Project',
      running: false, runningSubagentCount: 0, completed: false, failed: false, archived: true,
    }
    const denied = vi.fn(() => false)
    const view = render(<SearchResultItem result={result} currentId={undefined}
      onOpen={vi.fn()} onUnarchive={vi.fn()} useSessionAccess={denied} t={t} />)
    expect(denied).toHaveBeenCalledWith(result.id, 'workspace/unarchiveSession')
    expect(view.queryByRole('button', { name: zh['menu.unarchiveSession'] })).toBeNull()
    cleanup()
    // The allowed answer renders the same verb.
    const allowed = vi.fn(() => true)
    const restored = render(<SearchResultItem result={result} currentId={undefined}
      onOpen={vi.fn()} onUnarchive={vi.fn()} useSessionAccess={allowed} t={t} />)
    expect(restored.getByRole('button', { name: zh['menu.unarchiveSession'] })).toBeTruthy()
  })

  it.each([
    ['approval', '等待审批'],
    ['plan-review', '计划待审'],
    ['question', '等待回答'],
  ] as const)('shows %s ahead of running in search results', (pendingInteraction, label) => {
    const result: SearchResultNode = {
      id: sid(pendingInteraction), title: 'Needs input', workspace: 'Project',
      pendingInteraction, running: true, runningSubagentCount: 0, completed: false, failed: false, archived: false,
    }
    render(<SearchResultItem result={result} currentId={undefined}
      onOpen={vi.fn()} onUnarchive={vi.fn()} useSessionAccess={allowAllAccess.useSessionAccess} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.querySelector('[data-state="warning"]')).toBeTruthy()
    expect(row.querySelector('[data-state="ongoing"]')).toBeNull()
    expect(screen.getByText(label)).toBeTruthy()
  })

  it('renders an active Workspace and keeps its create action separate from toggling', () => {
    const onToggle = vi.fn()
    const onCreate = vi.fn()
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
      sessionCount: 1, queuedRed: 0, queuedYellow: 0, expanded: true, containsCurrent: true, sessions: [],
    }
    render(<ProjectRowItem group={group} onToggle={onToggle} onCreate={onCreate} t={t}
      newShortcut={{ id: 'session.new' as never, label: 'New', aliases: [], binding: null,
        keys: ['Ctrl', 'N'], aria: 'Control+N', modified: true, conflicts: [], issue: null }} />)

    expect(screen.getByRole('treeitem').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: '在“Project”中新建会话' }).getAttribute('aria-keyshortcuts')).toBe('Control+N')
    expect(screen.getByRole('button', { name: '在“Project”中新建会话' }).querySelector('svg')?.getAttribute('width')).toBe('14')
    fireEvent.click(screen.getByRole('button', { name: '在“Project”中新建会话' }))
    expect(onCreate).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Project'))
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('shows the group attention badge red-first with dot-marked counts, hidden at zero (queue-zone-1113)', () => {
    const group = (queuedRed: number, queuedYellow: number): GroupNode => ({
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
      sessionCount: 5, queuedRed, queuedYellow, expanded: true, containsCurrent: false, sessions: [],
    })
    const view = render(<ProjectRowItem group={group(2, 3)} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
    const badge = screen.getByRole('img', { name: '待裁决 2 · 待回话 3' })
    // Red leads; both counts ride the solid dot in their tier colour, sized
    // with the title, and a space separates the pair — the accessible name
    // spells out the tiers, so colour is not the only channel.
    expect([...badge.querySelectorAll('[data-attention]')].map(part => part.getAttribute('data-attention')))
      .toEqual(['failed', 'pending'])
    expect(badge.querySelector('[data-attention="failed"]')?.textContent).toBe('2')
    expect(badge.querySelector('[data-attention="pending"]')?.textContent).toBe('3')
    expect(badge.querySelector('[data-attention="failed"] [class*="attentionDot"]')).toBeTruthy()
    expect(badge.querySelector('[data-attention="pending"] [class*="attentionDot"]')).toBeTruthy()
    // A zero colour inside a live pair renders no part of its own…
    view.rerender(<ProjectRowItem group={group(0, 1)} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
    expect(screen.getByRole('img', { name: '待裁决 0 · 待回话 1' })).toBeTruthy()
    expect(view.container.querySelector('[data-attention="failed"]')).toBeNull()
    // …and zero overall removes the badge entirely.
    view.rerender(<ProjectRowItem group={group(0, 0)} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
    expect(screen.queryByRole('img', { name: /待裁决/ })).toBeNull()
  })

  it('shows the session total left of the attention counts, dot-marked, zero kept visible (session-count-badge-1122)', () => {
    const group = (sessionCount: number, queuedRed: number, queuedYellow: number): GroupNode => ({
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
      sessionCount, queuedRed, queuedYellow, expanded: true, containsCurrent: false, sessions: [],
    })
    const view = render(<ProjectRowItem group={group(28, 2, 3)} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
    const total = screen.getByRole('img', { name: '28 个会话' })
    const attention = screen.getByRole('img', { name: '待裁决 2 · 待回话 3' })
    // DOM order is visual order: the total rides left of the red/yellow pair,
    // its accessible name spelled from the existing sessions.count keys.
    const siblings = [...(total.parentElement?.children ?? [])]
    expect(siblings.indexOf(total)).toBeGreaterThan(-1)
    expect(siblings.indexOf(total)).toBeLessThan(siblings.indexOf(attention))
    // The dot reuses the attention pair's geometry rather than a second circle.
    expect(total.querySelector('[class*="attentionDot"]')).toBeTruthy()
    // Zero total stays on show — an empty group's zero is information — while
    // the attention pair still hides at zero overall.
    view.rerender(<ProjectRowItem group={group(0, 0, 0)} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
    expect(screen.getByRole('img', { name: '0 个会话' })).toBeTruthy()
    expect(screen.queryByRole('img', { name: /待裁决/ })).toBeNull()
  })

  it('renders and opens a selected running Session row', () => {
    const node: SessionNode = {
      id: sid('session'), title: 'Session', blank: false, running: true,
      runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
    }
    const onOpen = vi.fn()
    render(
      <SessionNodeItem node={node} currentId={node.id} now={0} onOpen={onOpen} t={t} />,
    )

    const row = screen.getByRole('treeitem')
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(row.hasAttribute('aria-expanded')).toBe(false)
    expect(screen.queryByRole('button', { name: /展开|收起/ })).toBeNull()
    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith(node.id)
  })

  it('keeps a row.action entry click in the strip, so a plain button does not open the row', () => {
    const node: SessionNode = {
      id: sid('session'), title: 'Session', blank: false, running: false,
      runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
    }
    const onOpen = vi.fn()
    const pluginAction = vi.fn()
    const renderSlot: RowRenderSlot = (name: RowSlotName) => (name === 'sidebar.workspaces.session.row.action'
      ? <button type="button" onClick={pluginAction}>plugin</button>
      : null)
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={onOpen} renderSlot={renderSlot} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'plugin' }))
    expect(pluginAction).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('treeitem'))
    expect(onOpen).toHaveBeenCalledWith(node.id)
  })

  it('marquees a clipped session title at a constant speed while the row is hovered', () => {
    const node: SessionNode = {
      id: sid('clipped'), title: 'A Session Title Long Enough To Be Clipped (1)', blank: false,
      running: false, runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0,
      pinned: false, archived: false,
    }
    render(
      <SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />,
    )
    const row = screen.getByRole('treeitem')
    // The title text sits in the span that travels; its parent clips it.
    const title = screen.getByText(node.title).parentElement as HTMLElement
    // jsdom lays out nothing: the title's clipped geometry is stated outright.
    const geometry = (scrollWidth: number, clientWidth: number): void => {
      Object.defineProperty(title, 'scrollWidth', { value: scrollWidth, configurable: true })
      Object.defineProperty(title, 'clientWidth', { value: clientWidth, configurable: true })
    }
    const marquee = (): (string | undefined)[] =>
      [title.dataset.marquee, title.style.getPropertyValue('--dsh-marquee-range'), title.style.getPropertyValue('--dsh-marquee-duration')]

    geometry(320, 180)
    const touch = new Event('pointerover', { bubbles: true })
    Object.defineProperty(touch, 'pointerType', { value: 'touch' })
    fireEvent(row, touch)
    expect(marquee()).toEqual([undefined, '', ''])
    // Constant 30px/s: the stylesheet travels the 140px overflow in 4667ms.
    fireEvent.pointerEnter(row)
    expect(marquee()).toEqual(['', '140px', '4667ms'])
    // Leaving returns the title to its start in one step.
    fireEvent.pointerLeave(row)
    expect(marquee()).toEqual([undefined, '', ''])

    // A title that fits has nothing to travel: hovering leaves it at rest.
    geometry(180, 180)
    fireEvent.pointerEnter(row)
    expect(marquee()).toEqual([undefined, '', ''])
    fireEvent.pointerLeave(row)

    // Overflow at the 8px jitter threshold also stays put.
    geometry(188, 180)
    fireEvent.pointerEnter(row)
    expect(marquee()).toEqual([undefined, '', ''])
    fireEvent.pointerLeave(row)

    // One pixel past the threshold travels its 9px extent.
    geometry(189, 180)
    fireEvent.pointerEnter(row)
    expect(marquee()).toEqual(['', '9px', '300ms'])
  })

  it('keeps a title marqueed while its context menu owns the hover highlight', () => {
    const node: SessionNode = { id: sid('context-crawl'), title: 'A long Session title', blank: false,
      running: false, runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false }
    const props = { node, currentId: undefined, now: 0, onOpen: vi.fn(), t }
    const view = render(<SessionNodeItem {...props} />)
    const row = screen.getByRole('treeitem')
    const title = screen.getByText(node.title).parentElement as HTMLElement
    Object.defineProperty(title, 'scrollWidth', { value: 400, configurable: true })
    Object.defineProperty(title, 'clientWidth', { value: 160, configurable: true })
    fireEvent.pointerEnter(row)
    expect(title.style.getPropertyValue('--dsh-marquee-range')).toBe('240px')
    view.rerender(<SessionNodeItem {...props} useContextMenuTarget={select => select({ kind: 'session',
      value: { sessionId: node.id, displayTitle: node.title } })} />)
    fireEvent.pointerLeave(row)
    expect(title.hasAttribute('data-marquee')).toBe(true)
    view.rerender(<SessionNodeItem {...props} />)
    expect(title.hasAttribute('data-marquee')).toBe(false)
  })

  it('shows the green unread dot only on an unread session (live activity wins the slot)', () => {
    const renderRow = (over: Partial<SessionNode>) => render(
      <SessionNodeItem
        node={{
          id: sid('s1'), title: 'One', blank: false, running: false,
          runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false, ...over,
        }}
        currentId={undefined} now={0} onOpen={vi.fn()} t={t}
      />,
    )
    const stateDot = (view: ReturnType<typeof renderRow>) =>
      view.container.querySelector('[data-state]')
    // No completion reminder, not running: no state dot at all.
    const plain = renderRow({})
    expect(stateDot(plain)).toBeNull()
    plain.unmount()
    const done = renderRow({ completed: true })
    expect(done.container.querySelector('[data-state="done"]')).not.toBeNull()
    done.unmount()
    // A failed stop still unviewed: the red error dot, not the done dot.
    const failed = renderRow({ completed: true, completionOutcome: 'failed' })
    expect(failed.container.querySelector('[data-state="error"]')).not.toBeNull()
    expect(failed.container.querySelector('[data-state="done"]')).toBeNull()
    expect(screen.getByText('上轮失败')).toBeTruthy()
    failed.unmount()
    // Running wins the slot: the animated ongoing dot, no done dot.
    const running = renderRow({ completed: true, running: true })
    expect(running.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(running.container.querySelector('[data-state="done"]')).toBeNull()
    running.unmount()
    // Descendant activity also wins until the last running descendant stops.
    const delegated = renderRow({ completed: true, failed: false, runningSubagentCount: 1 })
    expect(delegated.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(delegated.container.querySelector('[data-state="done"]')).toBeNull()
  })

  /** Row constructor for the status-wiring cases; every base field stays explicit. */
  const statusRow = (over: Partial<SessionNode> = {}): SessionNode => ({
    id: sid('s1'), title: 'One', blank: false, running: false,
    runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false, ...over,
  })
  const renderStatusRow = (over: Partial<SessionNode>, translate = t) => render(
    <SessionNodeItem node={statusRow(over)} currentId={undefined} now={0} onOpen={vi.fn()} t={translate} />,
  )

  it('wears the gray ring with its numeric badge when live background jobs are the only activity (五态定稿 §二)', () => {
    const view = renderStatusRow({ activeJobCount: 2 })
    const row = screen.getByRole('treeitem')
    const cell = row.firstElementChild
    // The gear + superscript sub-form merged into the ongoing ring's badge:
    // one number = running subagents + live jobs.
    expect(cell?.querySelector('[data-state="ongoing"]')).toBeTruthy()
    expect(cell?.querySelector('[data-busy-count="2"]')?.textContent).toBe('2')
    // The count's full sentence is the row's screen-reader label.
    expect(screen.getByText('2 个后台任务运行中')).toBeTruthy()
    expect(cell?.querySelector('[data-status-glyph]')).toBeNull()
    view.unmount()
  })

  it('sums running subagents and live jobs on one badge, and shows none at zero', () => {
    const both = renderStatusRow({ running: true, runningSubagentCount: 2, activeJobCount: 3 })
    const cell = screen.getByRole('treeitem').firstElementChild
    expect(cell?.querySelector('[data-busy-count="5"]')?.textContent).toBe('5')
    both.unmount()

    // The main turn alone is not a discrete entity: no subagent, no job → no badge.
    const plain = renderStatusRow({ running: true })
    expect(screen.getByRole('treeitem').firstElementChild?.querySelector('[data-busy-count]')).toBeNull()
    plain.unmount()
  })

  it('ranks the wake-up glyph over the unread completion, and rings the last-known state when confirmation drops', () => {
    const wake = renderStatusRow({ completed: true, pendingWakeup: true })
    expect(screen.getByRole('treeitem').querySelector('[data-status-glyph="wakeup"]')).not.toBeNull()
    expect(screen.getByRole('treeitem').querySelector('[data-state="done"]')).toBeNull()
    expect(screen.getByText('待唤醒')).toBeTruthy()
    wake.unmount()

    // 未知不吞已知 (collab step3 §5.1, q5): an unreadable confirmation rings
    // the last-known state instead of replacing it — a confirmed-nothing row
    // keeps its idle dot inside the dashed ring.
    const stale = renderStatusRow({ statusStale: true })
    const staleRow = screen.getByRole('treeitem')
    expect(staleRow.querySelector('[data-state="idle"]')).not.toBeNull()
    expect(staleRow.querySelector('[data-stale-kind="connection"]')).not.toBeNull()
    expect(staleRow.querySelector('[data-state="stale"]')).toBeNull()
    expect(screen.getByText('连接中断：显示为最后已知态（空闲），不可信')).toBeTruthy()
    stale.unmount()

    // A known signal stays painted under the ring.
    const known = renderStatusRow({ completed: true, statusStale: true })
    expect(screen.getByRole('treeitem').querySelector('[data-state="done"]')).not.toBeNull()
    expect(screen.getByRole('treeitem').querySelector('[data-stale-kind="connection"]')).not.toBeNull()
    known.unmount()

    // The heartbeat variant names the interruption's age (第三通道, 件C4).
    const beat = renderStatusRow({ running: true, heartbeatStale: true, heartbeatStaleSeconds: 45 })
    expect(screen.getByRole('treeitem').querySelector('[data-stale-kind="heartbeat"]')).not.toBeNull()
    expect(screen.getByText('心跳中断 45s：显示为最后已知态（进行中），不可信')).toBeTruthy()
    beat.unmount()
  })

  it('embeds the glyph in the enlarged dot: ✓ for the pass, ✕ for the failed stop, and no top-right badge (五态定稿 §二)', () => {
    const pass = renderStatusRow({ completed: true })
    let row = screen.getByRole('treeitem')
    const doneDot = row.querySelector('[data-state="done"]')
    expect(doneDot).not.toBeNull()
    expect(doneDot?.textContent).toBe('✓')
    // The retired statusMark mini-badge channel renders nothing at all.
    expect(row.querySelector('[data-status-mark]')).toBeNull()
    pass.unmount()

    const failed = renderStatusRow({ completed: true, completionOutcome: 'failed' })
    row = screen.getByRole('treeitem')
    const errorDot = row.querySelector('[data-state="error"]')
    expect(errorDot).not.toBeNull()
    // Red uses ✕, not the bang: the bang belongs to the yellow awaiting dot.
    expect(errorDot?.textContent).toBe('✕')
    expect(row.querySelector('[data-status-mark]')).toBeNull()
    expect(screen.getByText('上轮失败')).toBeTruthy()
    failed.unmount()

    // The yellow awaiting dot carries the bang inside the dot.
    const pending = renderStatusRow({ pendingInteraction: 'approval' })
    row = screen.getByRole('treeitem')
    const warnDot = row.querySelector('[data-state="warning"]')
    expect(warnDot).not.toBeNull()
    expect(warnDot?.textContent).toBe('!')
    expect(row.querySelector('[data-status-mark]')).toBeNull()
    pending.unmount()

    // A queued wake-up rides secondary; the glyph stays on the primary cell.
    const wakeup = renderStatusRow({ completed: true, completionOutcome: 'failed', pendingWakeup: true })
    row = screen.getByRole('treeitem')
    expect(row.querySelector('[data-state="error"]')?.textContent).toBe('✕')
    expect(screen.getByText('待唤醒')).toBeTruthy()
    wakeup.unmount()
  })

  it('names a shutdown-cut stop 停机打断 instead of 上轮失败 (聚合红·子原因入详情)', () => {
    const cut = renderStatusRow({ completed: true, completionOutcome: 'failed', completionInterrupted: true })
    expect(screen.getByText('停机打断')).toBeTruthy()
    expect(screen.queryByText('上轮失败')).toBeNull()
    cut.unmount()

    // An ordinary turn failure keeps its own wording.
    const failed = renderStatusRow({ completed: true, completionOutcome: 'failed' })
    expect(screen.getByText('上轮失败')).toBeTruthy()
    failed.unmount()
  })

  it('shows the row-end 已阅 check while the mark stands (点名不改态, q4-readmark)', () => {
    const marked = renderStatusRow({ completed: true, readMarked: true })
    let row = screen.getByRole('treeitem')
    // The signal dot keeps its cell; the check rides the row end.
    expect(row.querySelector('[data-state="done"]')).not.toBeNull()
    expect(screen.getByLabelText('已读')).toBeTruthy()
    marked.unmount()

    const fresh = renderStatusRow({ completed: true })
    row = screen.getByRole('treeitem')
    expect(screen.queryByLabelText('已读')).toBeNull()
    fresh.unmount()
  })

  it('carries the done receipt’s 判据自证 on the hover card (件A, step2 §二)', () => {
    vi.useFakeTimers()
    try {
      const receipt = renderStatusRow({
        completed: true,
        deliverableReceipt: { verdict: 'pass', summary: 'commit 1a2b3c4; gates green', evidence: ['1a2b3c4', 'build:lib'] },
      })
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getByText('commit 1a2b3c4; gates green')).toBeTruthy()
      expect(screen.getByText('1a2b3c4 · build:lib')).toBeTruthy()
      receipt.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps background jobs behind live activity and descendant activity', () => {
    const runningFirst = renderStatusRow({ running: true, activeJobCount: 3 })
    const row = screen.getByRole('treeitem')
    expect(row.firstElementChild?.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(row.firstElementChild?.querySelector('[data-status-glyph]')).toBeNull()
    expect(screen.getByText('3 个后台任务运行中')).toBeTruthy()
    runningFirst.unmount()

    const subagentsFirst = renderStatusRow({ runningSubagentCount: 1, activeJobCount: 3 })
    expect(screen.getByRole('treeitem').firstElementChild?.querySelector('[data-status-glyph]')).toBeNull()
    expect(screen.getByText('3 个后台任务运行中')).toBeTruthy()
    subagentsFirst.unmount()
  })

  it('ranks the wake-up mark over the busy arrangements, and both ahead of the unread completion (statusdot-chain-order-1123)', () => {
    // 2026-11-23 改序: 💤 > 子代理 > 后台. The sleep mark takes the seat while
    // the losing job roster stays visible as a secondary line.
    const all = renderStatusRow({ completed: true, activeJobCount: 1, pendingWakeup: true })
    const cell = screen.getByRole('treeitem').firstElementChild
    expect(cell?.querySelector('[data-status-glyph="wakeup"]')).not.toBeNull()
    expect(cell?.querySelector('[data-state="ongoing"]')).toBeNull()
    expect(cell?.querySelector('[data-state="done"]')).toBeNull()
    expect(screen.getByText('待唤醒')).toBeTruthy()
    expect(screen.getByText('1 个后台任务运行中')).toBeTruthy()
    all.unmount()

    // 后台任务仍压过未查看完成（§3.8 绿点被旁路压制语义零改）。
    const jobsOverGreen = renderStatusRow({ completed: true, activeJobCount: 1 })
    const jobsCell = screen.getByRole('treeitem').firstElementChild
    expect(jobsCell?.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(jobsCell?.querySelector('[data-busy-count="1"]')).not.toBeNull()
    expect(jobsCell?.querySelector('[data-state="done"]')).toBeNull()
    jobsOverGreen.unmount()

    const wakeOverGreen = renderStatusRow({ completed: true, pendingWakeup: true })
    expect(screen.getByRole('treeitem').firstElementChild?.querySelector('[data-status-glyph="wakeup"]')).not.toBeNull()
    wakeOverGreen.unmount()
  })

  it('puts a stopped failed turn over the busy arrangements, and 待裁 over the failure (statusdot-chain-order-1123)', () => {
    // 失败×子代理共现显红：旁路在跑绝不盖住红点。
    const failedSub = renderStatusRow({ completed: true, completionOutcome: 'failed', runningSubagentCount: 2 })
    let cell = screen.getByRole('treeitem').firstElementChild
    expect(cell?.querySelector('[data-state="error"]')).not.toBeNull()
    expect(cell?.querySelector('[data-state="ongoing"]')).toBeNull()
    // 副态半边 (#statusdot-gap-A-1029)：输家副态在悬停/朗读面仍可见。
    expect(screen.getByText('2 个子智能体运行中')).toBeTruthy()
    failedSub.unmount()

    // 失败×后台共现显红。
    const failedJob = renderStatusRow({ completed: true, completionOutcome: 'failed', activeJobCount: 1 })
    cell = screen.getByRole('treeitem').firstElementChild
    expect(cell?.querySelector('[data-state="error"]')).not.toBeNull()
    expect(cell?.querySelector('[data-state="ongoing"]')).toBeNull()
    expect(screen.getByText('1 个后台任务运行中')).toBeTruthy()
    failedJob.unmount()

    // 💤×旁路共现显 💤，旁路计数降为副态。
    const wakeBusy = renderStatusRow({ pendingWakeup: true, runningSubagentCount: 1, activeJobCount: 2 })
    cell = screen.getByRole('treeitem').firstElementChild
    expect(cell?.querySelector('[data-status-glyph="wakeup"]')).not.toBeNull()
    expect(cell?.querySelector('[data-state="ongoing"]')).toBeNull()
    expect(screen.getByText('待唤醒')).toBeTruthy()
    expect(screen.getByText('1 个子智能体运行中')).toBeTruthy()
    expect(screen.getByText('2 个后台任务运行中')).toBeTruthy()
    wakeBusy.unmount()

    // 在跑显转圈：失败分支带 `!running` 闸，自身在跑的重跑仍戴灰环。
    const reRun = renderStatusRow({ completed: true, completionOutcome: 'failed', running: true })
    cell = screen.getByRole('treeitem').firstElementChild
    expect(cell?.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(cell?.querySelector('[data-state="error"]')).toBeNull()
    reRun.unmount()

    // 待裁压失败：待裁 ⟹ 开轮，黄点当仁不让，红点与旁路全降副态/缺席。
    const pendingFailed = renderStatusRow({
      pendingInteraction: 'question', completed: true, completionOutcome: 'failed', runningSubagentCount: 1,
    })
    cell = screen.getByRole('treeitem').firstElementChild
    expect(cell?.querySelector('[data-state="warning"]')).not.toBeNull()
    expect(cell?.querySelector('[data-state="error"]')).toBeNull()
    expect(cell?.querySelector('[data-state="ongoing"]')).toBeNull()
    expect(screen.getByText('等待回答')).toBeTruthy()
    expect(screen.getByText('1 个子智能体运行中')).toBeTruthy()
    pendingFailed.unmount()
  })

  it('labels the completed reminder New completion in English', () => {
    const view = renderStatusRow({ completed: true }, tEn)
    expect(screen.getByText('New completion')).toBeTruthy()
    view.unmount()
  })

  it('shows descendant activity without describing an idle parent as running', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('owner'), title: 'Delegating', blank: false, running: false,
        runningSubagentCount: 2, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
      }
      render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      expect(row.querySelector('[data-state="ongoing"]')).not.toBeNull()
      expect(screen.getByText('2 个子智能体运行中')).toBeTruthy()
      expect(screen.queryByText('进行中')).toBeNull()

      fireEvent.pointerEnter(row.parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getAllByText('2 个子智能体运行中')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps descendant activity secondary while the parent is running', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('owner'), title: 'Delegating', blank: false, running: true,
        runningSubagentCount: 1, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
      }
      render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      expect(row.querySelectorAll('[data-state="ongoing"]')).toHaveLength(1)
      expect(screen.getByText('进行中')).toBeTruthy()
      expect(screen.getByText('1 个子智能体运行中')).toBeTruthy()

      fireEvent.pointerEnter(row.parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getAllByText('进行中')).toHaveLength(2)
      expect(screen.getAllByText('1 个子智能体运行中')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps child activity as a secondary status while user attention is primary', () => {
    const node: SessionNode = {
      id: sid('owner'), title: 'Needs input', blank: false, pendingInteraction: 'question',
      running: false, runningSubagentCount: 1, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
    }
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.querySelector('[data-state="warning"]')).not.toBeNull()
    expect(row.querySelector('[data-state="ongoing"]')).toBeNull()
    expect(screen.getByText('等待回答')).toBeTruthy()
    expect(screen.getByText('1 个子智能体运行中')).toBeTruthy()
  })

  it('shows the green unread dot on an unread search result row', () => {
    render(<SearchResultItem
      result={{
        id: sid('result'), title: 'Done', workspace: 'Workspace', running: false,
        runningSubagentCount: 0, completed: true, failed: false, archived: false,
      }}
      currentId={undefined} onOpen={vi.fn()} onUnarchive={vi.fn()}
      useSessionAccess={allowAllAccess.useSessionAccess} t={t}
    />)
    expect(screen.getByRole('treeitem').querySelector('[data-state="done"]')).not.toBeNull()
  })

  it('shows the jobs badge on a search result row and keeps its roster while shown', () => {
    const release = vi.fn()
    const watchSessionJobs = vi.fn(() => release)
    const view = render(<SearchResultItem
      result={{
        id: sid('result-jobs'), title: 'Busy', workspace: 'Workspace', running: false,
        runningSubagentCount: 0, completed: false, archived: false, activeJobCount: 1,
      }}
      currentId={undefined} onOpen={vi.fn()} onUnarchive={vi.fn()}
      useSessionAccess={allowAllAccess.useSessionAccess}
      watchSessionJobs={watchSessionJobs} t={t}
    />)
    expect(screen.getByRole('treeitem').querySelector('[data-busy-count="1"]')).not.toBeNull()
    expect(screen.getByText('1 个后台任务运行中')).toBeTruthy()
    expect(watchSessionJobs).toHaveBeenCalledWith(sid('result-jobs'))
    view.unmount()
    expect(release).toHaveBeenCalledOnce()
  })

  it('workspace row menu opens on the ellipsis, renames, and shows the danger delete row', () => {
    const openMenu = vi.fn()
    const renderFactorySlot = vi.fn(renderMenuButton)
    const onToggle = vi.fn()
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
      sessionCount: 0, queuedRed: 0, queuedYellow: 0, expanded: false, containsCurrent: false, sessions: [],
    }
    const target = { kind: 'workspace', value: { workspaceId: wid('project'), path: '/projects/project', displayTitle: 'Project' } } as const
    const view = render(<ProjectRowItem group={group} onToggle={onToggle} onCreate={vi.fn()}
      useContextMenu={contextMenuHook(openMenu)} renderFactorySlot={renderFactorySlot} t={t} />)
    fireEvent.contextMenu(screen.getByRole('treeitem'), { clientX: 36, clientY: 48 })
    expect(openMenu).toHaveBeenLastCalledWith(target, { x: 36, y: 48 })
    expect(renderFactorySlot).toHaveBeenLastCalledWith('contextMenu.button', {
      target, label: '工作区“Project”的操作', className: rowCss.iconButton,
    })
    expect(onToggle).not.toHaveBeenCalled()
    view.rerender(<ProjectRowItem group={group} onToggle={onToggle} onCreate={vi.fn()} t={t}
      useContextMenuTarget={select => select(target)} />)
    expect(screen.getByRole('treeitem').className).toContain(rowCss.menuOpen)
  })

  it('workspace row offers only the actions its Workspace access snapshot allows', () => {
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
      sessionCount: 0, queuedRed: 0, queuedYellow: 0, expanded: false, containsCurrent: false, sessions: [],
    }
    const allowed = new Set<string>(['workspace/rename'])
    const useWorkspaceAccess = vi.fn((_workspaceId: WorkspaceId, endpoint: string) => allowed.has(endpoint))
    const drag = { start: vi.fn(), end: vi.fn() }
    const props = {
      group, onToggle: vi.fn(), onCreate: vi.fn(), drag, t,
    }
    const view = render(<ProjectRowItem {...props} useWorkspaceAccess={useWorkspaceAccess} />)
    expect(useWorkspaceAccess).toHaveBeenCalledWith(wid('project'), 'session/create')
    // Mutations stay gated while the menu remains available for file-manager and plugin actions.
    expect(screen.queryByRole('button', { name: '在“Project”中新建会话' })).toBeNull()
    expect(screen.getByRole('treeitem').getAttribute('draggable')).toBe('false')
    expect(screen.getByRole('button', { name: '工作区“Project”的操作' })).toBeTruthy()
    allowed.clear()
    view.rerender(<ProjectRowItem {...props} useWorkspaceAccess={useWorkspaceAccess} />)
    expect(screen.getByRole('button', { name: '工作区“Project”的操作' })).toBeTruthy()

    // Every answer allowed restores the button, the full menu, and the drag handle.
    for (const endpoint of ['session/create', 'workspace/rename', 'workspace/delete', 'workspace/insertBefore']) {
      allowed.add(endpoint)
    }
    view.rerender(<ProjectRowItem {...props} useWorkspaceAccess={useWorkspaceAccess} />)
    expect(screen.getByRole('treeitem').getAttribute('draggable')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '在“Project”中新建会话' }))
    expect(props.onCreate).toHaveBeenCalledExactlyOnceWith(props.group.workspaceId)
  })

  it('ungrouped bucket offers no New Session and asks no access', () => {
    const group: GroupNode = {
      key: 'ungrouped', workspaceId: undefined, cwd: undefined, createdAt: undefined, label: '',
      sessionCount: 0, queuedRed: 0, queuedYellow: 0, expanded: false, containsCurrent: false, sessions: [],
    }
    const useWorkspaceAccess = vi.fn(() => true)
    render(<ProjectRowItem group={group} onToggle={vi.fn()} onCreate={vi.fn()} t={t}
      useWorkspaceAccess={useWorkspaceAccess} />)
    expect(useWorkspaceAccess).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /新建会话/ })).toBeNull()
    expect(fireEvent.contextMenu(screen.getByRole('treeitem'))).toBe(true)
  })

  it('session row drags and renames from its title only while its access snapshot allows each', () => {
    const node: SessionNode = {
      id: sid('s1'), title: 'One', blank: false, running: false,
      runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
    }
    const drag: RowDragProps = {
      active: false, marker: null, start: vi.fn(), end: vi.fn(), hover: vi.fn(), drop: vi.fn(),
    }
    const onRenameRequest = vi.fn()
    const useSessionAccess = vi.fn((_sessionId: SessionId, _endpoint: string) => false)
    const view = render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} drag={drag}
      onRenameRequest={onRenameRequest} useSessionAccess={useSessionAccess} t={t} />)
    expect(useSessionAccess).toHaveBeenCalledWith(sid('s1'), 'session/rename')
    expect(useSessionAccess).toHaveBeenCalledWith(sid('s1'), 'workspace/insertSessionBefore')
    // Without reorder access the row still drags its Session to other drop targets, as a copy only.
    expect(screen.getByRole('treeitem').getAttribute('draggable')).toBe('true')
    const transfer = { effectAllowed: '', setData: vi.fn(), setDragImage: vi.fn() }
    fireEvent.dragStart(screen.getByRole('treeitem'), { dataTransfer: transfer })
    expect(transfer.effectAllowed).toBe('copy')
    expect(transfer.setData.mock.calls).toEqual([['application/x-dsh-session', 's1']])
    expect(drag.start).not.toHaveBeenCalled()
    dragEnd(screen.getByRole('treeitem'))
    fireEvent.doubleClick(screen.getByText('One'))
    expect(onRenameRequest).not.toHaveBeenCalled()

    view.rerender(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} drag={drag}
      onRenameRequest={onRenameRequest} useSessionAccess={() => true} t={t} />)
    expect(screen.getByRole('treeitem').getAttribute('draggable')).toBe('true')
    // A browser rename arms on the first press and fires on the double-click; the helper states both.
    realDoubleClick(screen.getByText('One'))
    expect(onRenameRequest).toHaveBeenCalledWith(sid('s1'), 'One')
  })

  it('workspace hover card shows its details and copies the full directory path', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    const restoreClipboard = installClipboard(writeText)
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
        sessionCount: 0, queuedRed: 0, queuedYellow: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      // Card body: full title + cwd + absolute creation time.
      expect(screen.getAllByText('Project')).toHaveLength(2)
      expect(screen.getByText('/projects/project')).toBeTruthy()
      expect(screen.getByText(/^创建于 \d+年\d+月\d+日 /)).toBeTruthy()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制: /projects/project' })) })
      expect(writeText).toHaveBeenCalledWith('/projects/project')
      expect(screen.getByRole('status').textContent).toBe('已复制')
    } finally {
      restoreClipboard()
      vi.useRealTimers()
    }
  })

  it.each(['hover', 'focus'] as const)('keeps workspace details alongside the new Session tooltip on %s', (trigger) => {
    vi.useFakeTimers()
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
        sessionCount: 0, queuedRed: 0, queuedYellow: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      const create = screen.getByRole('button', { name: '在“Project”中新建会话' })
      fireEvent.pointerEnter(row.parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getByText('/projects/project')).toBeTruthy()

      if (trigger === 'hover') {
        fireEvent.pointerEnter(create)
        act(() => { vi.advanceTimersByTime(500) })
      } else {
        fireEvent.keyDown(document, { key: 'Tab' })
        fireEvent.focus(create)
      }
      expect(screen.getByRole('tooltip').textContent).toBe('新会话')
      expect(screen.getByText('/projects/project')).toBeTruthy()

      if (trigger === 'hover') fireEvent.pointerLeave(create, { relatedTarget: row })
      else fireEvent.blur(create, { relatedTarget: row })
      expect(screen.queryByRole('tooltip')).toBeNull()
      expect(screen.getByText('/projects/project')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows workspace details and the tooltip when the pointer first enters its new Session action', () => {
    vi.useFakeTimers()
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
        sessionCount: 0, queuedRed: 0, queuedYellow: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      const create = screen.getByRole('button', { name: '在“Project”中新建会话' })
      fireEvent.pointerEnter(row.parentElement as HTMLElement)
      fireEvent.pointerEnter(create)
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.getByRole('tooltip').textContent).toBe('新会话')
      expect(screen.getByText('/projects/project')).toBeTruthy()

      fireEvent.pointerLeave(create, { relatedTarget: row })
      expect(screen.queryByRole('tooltip')).toBeNull()
      expect(screen.getByText('/projects/project')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('workspace hover card shows a POSIX home descendant as ~ and still copies the full path', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    const restoreClipboard = installClipboard(writeText)
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: '/home/u/Documents/project', createdAt: 0, label: 'Project',
        sessionCount: 0, queuedRed: 0, queuedYellow: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} home="/home/u" onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getByText('~/Documents/project')).toBeTruthy()
      expect(screen.queryByText('/home/u/Documents/project')).toBeNull()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制: /home/u/Documents/project' })) })
      expect(writeText).toHaveBeenCalledWith('/home/u/Documents/project')
    } finally {
      restoreClipboard()
      vi.useRealTimers()
    }
  })

  it('workspace hover card without a directory omits the path and copy action', async () => {
    vi.useFakeTimers()
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: undefined, createdAt: 0, label: 'Project',
        sessionCount: 0, queuedRed: 0, queuedYellow: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} home="/home/u" onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getAllByText('Project')).toHaveLength(2)
      expect(screen.getByText(/^创建于 \d+年\d+月\d+日 /)).toBeTruthy()
      expect(screen.queryByRole('button', { name: /^复制:/ })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('workspace hover card leaves a Windows path verbatim', async () => {
    vi.useFakeTimers()
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: 'C:\\Users\\u\\project', createdAt: 0, label: 'Project',
        sessionCount: 0, queuedRed: 0, queuedYellow: 0, expanded: false, containsCurrent: false, sessions: [],
      }
      render(<ProjectRowItem group={group} home="C:\\Users\\u" onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getByText('C:\\Users\\u\\project')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ungrouped bucket renders no workspace menu', () => {
    const group: GroupNode = {
      key: '', workspaceId: undefined, cwd: undefined, createdAt: undefined, label: 'Ungrouped',
      sessionCount: 0, queuedRed: 0, queuedYellow: 0, expanded: false, containsCurrent: false, sessions: [],
    }
    render(<ProjectRowItem group={group} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
    expect(screen.queryByRole('button', { name: /工作区/ })).toBeNull()
  })

  it('blank New Session rows carry no menu, no time label, and no hover-card time', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s-blank'), title: 'ignored', blank: true, running: false,
        runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
      }
      const rendered = vi.fn()
      const renderSlot: RowRenderSlot = (name: RowSlotName, owner: object, opts?: object) => {
        rendered(name, owner, opts)
        return null
      }
      render(<SessionNodeItem node={node} currentId={node.id} now={0} onOpen={vi.fn()} renderSlot={renderSlot} t={t} />)
      // The placeholder has no content yet: no "..." menu (the menu list is
      // never asked), no "now" stamp. FORK dsh-local (blank-row-archive-1026):
      // the hover strip still renders so archive can dismiss the placeholder,
      // and its owner share flags the row blank.
      expect(screen.queryByRole('button', { name: /会话.*的操作/ })).toBeNull()
      expect(rendered).toHaveBeenCalledExactlyOnceWith(
        'sidebar.workspaces.session.row.action',
        { sessionId: node.id, displayTitle: 'ignored', blank: true }, undefined,
      )
      expect(screen.queryByText('刚刚')).toBeNull()
      // The hover card keeps title + status but drops the timestamp line.
      const wrapper = screen.getByRole('treeitem').parentElement as HTMLElement
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getAllByText('新会话').length).toBeGreaterThanOrEqual(2)
      expect(screen.getByText('空闲')).toBeTruthy()
      expect(screen.queryByText('刚刚')).toBeNull()
      expect(screen.getByText('空闲').closest('[role="button"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  describe('Session hover-card working directory', () => {
    const located: SessionNode = {
      id: sid('s-cwd'), title: 'Located', blank: false, running: false,
      runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
      cwd: '/home/u/project',
    }
    function hoverCard(node: SessionNode): void {
      render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} home="/home/u" t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
    }
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('shows a home-rooted directory as ~', () => {
      hoverCard(located)
      expect(screen.getByText('~/project')).toBeTruthy()
    })

    it('omits the line when the Host reports no directory', () => {
      const { cwd: _cwd, ...withoutCwd } = located
      hoverCard(withoutCwd)
      expect(screen.getAllByText('Located')).toHaveLength(2)
      expect(screen.queryByText(/project/)).toBeNull()
    })

    it('shows the directory on a blank New Session card', () => {
      hoverCard({ ...located, blank: true })
      expect(screen.getAllByText('新会话')).toHaveLength(2)
      expect(screen.getByText('~/project')).toBeTruthy()
    })
  })

  it('session hover card shows the session id under the title and copies title with id', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    const restoreClipboard = installClipboard(writeText)
    try {
      const node: SessionNode = {
        id: sid('s-idline'), title: 'With id', blank: false, running: false,
        runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
      }
      render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      // The id line hangs directly off the card title, above every other line.
      const id = screen.getByText('s-idline')
      expect(id.previousElementSibling?.textContent).toBe('With id')
      // Clicking the card copies title and id together, one per line.
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制: With id\ns-idline' })) })
      expect(writeText).toHaveBeenCalledWith('With id\ns-idline')
    } finally {
      restoreClipboard()
      vi.useRealTimers()
    }
  })

  it('session row menu opens without opening the session and Escape closes it', () => {
    const onOpen = vi.fn()
    const node: SessionNode = {
      id: sid('s1'), title: 'One', blank: false, running: false,
      runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
    }
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={onOpen} t={t} />)
    const trigger = screen.getByRole('button', { name: '会话“One”的操作' })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
    // Escape closes without selecting (Menu onClose path).
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    // The trigger toggles: a second click closes the menu it opened.
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('renders the menu list with the row identity and open state, and returns focus to the trigger after an entry closes it', async () => {
    const onOpen = vi.fn()
    const openMenu = vi.fn()
    const renderFactorySlot = vi.fn(renderMenuButton)
    const onEntry = vi.fn()
    const rendered = vi.fn()
    // A stub satisfies the generic render signature only with erased parameter
    // types; it narrows the owner and the occurrence options itself.
    const renderSlot: RowRenderSlot = (name: RowSlotName, owner: object, opts?: object) => {
      const { sessionId, displayTitle } = owner as SessionRowOwnerProps
      const hookContext = opts !== undefined && 'hookContext' in opts ? opts.hookContext : undefined
      rendered(name, owner, hookContext)
      if (name !== 'sidebar.workspaces.session.menu.item') return null
      // The stub stands in for the renderer, which binds this occurrence's
      // hookContext into the entries' useMenuOpenState hook.
      const [open, setMenuOpen] = hookContext as MenuOpenState
      return (
        <MenuItemButton onSelect={() => {
          setMenuOpen(false)
          onEntry(sessionId, displayTitle, open)
        }}>
          Export
        </MenuItemButton>
      )
    }
    const node: SessionNode = {
      id: sid('s1'), title: 'One', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0, pinned: false, archived: false,
    }
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={onOpen} renderSlot={renderSlot} t={t} />)

    // Both lists receive the row identity; only the menu list carries the open state.
    expect(rendered).toHaveBeenCalledWith(
      'sidebar.workspaces.session.menu.item', { sessionId: node.id, displayTitle: 'One', blank: false }, [false, expect.any(Function)],
    )
    expect(rendered).toHaveBeenCalledWith(
      'sidebar.workspaces.session.row.action', { sessionId: node.id, displayTitle: 'One', blank: false }, undefined,
    )
    expect(screen.queryByRole('menuitem')).toBeNull()
    const trigger = screen.getByRole('button', { name: '会话“One”的操作' })
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Export'])
    expect(rendered).toHaveBeenCalledWith(
      'sidebar.workspaces.session.menu.item', { sessionId: node.id, displayTitle: 'One', blank: false }, [true, expect.any(Function)],
    )
    const entry = screen.getByRole('menuitem', { name: 'Export' })
    expect(screen.getByRole('treeitem').contains(entry)).toBe(false)
    entry.focus()
    expect(fireEvent.keyDown(entry, { key: 'Enter', code: 'Enter' })).toBe(true)
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(entry)
    expect(onEntry).toHaveBeenCalledWith(node.id, 'One', true)
    // The entry dismissed the menu through the state pair; the list returns focus.
    expect(screen.queryByRole('menu')).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(trigger)
    expect(onOpen).not.toHaveBeenCalled()
    cleanup()
    openMenu.mockClear()
    renderFactorySlot.mockClear()
    render(<SessionNodeItem node={{ ...node, blank: true }} currentId={sid('other')} now={0} onOpen={onOpen}
      useContextMenu={contextMenuHook(openMenu)} renderFactorySlot={renderFactorySlot} t={t} />)
    fireEvent.contextMenu(screen.getByRole('treeitem'))
    expect(openMenu).not.toHaveBeenCalled()
    expect(renderFactorySlot).not.toHaveBeenCalled()
  })

  it('renders the row action list inside the actions area after the menu trigger', () => {
    const onOpen = vi.fn()
    const onQuick = vi.fn()
    const renderSlot: RowRenderSlot = (name: RowSlotName) => name === 'sidebar.workspaces.session.row.action'
      ? (
        <button type="button" aria-label="Quick action" onClick={(e) => { e.stopPropagation(); onQuick() }} />
      )
      : null
    const node: SessionNode = {
      id: sid('s1'), title: 'One', blank: false, running: false,
      runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
    }
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={onOpen} renderSlot={renderSlot} t={t} />)
    const trigger = screen.getByRole('button', { name: '会话“One”的操作' })
    const quick = screen.getByRole('button', { name: 'Quick action' })
    const actionsArea = trigger.closest('[class*="rowActions"]')
    expect(actionsArea).not.toBeNull()
    expect(actionsArea?.contains(quick)).toBe(true)
    expect(trigger.compareDocumentPosition(quick) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(quick)
    expect(onQuick).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it.each([400, 800])('keeps the preview available when hovering More at %dms', (dwell) => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('more-hover'), title: 'More hover', blank: false, running: false,
        runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
      }
      render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      const title = screen.getByText('More hover')
      const more = screen.getByRole('button', { name: '会话“More hover”的操作' })
      fireEvent.pointerEnter(row)
      act(() => { vi.advanceTimersByTime(dwell) })
      fireEvent(title, new MouseEvent('pointerout', { bubbles: true, relatedTarget: more }))
      fireEvent(more, new MouseEvent('pointerover', { bubbles: true, relatedTarget: title }))
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getByRole('button', { name: '复制: More hover\nmore-hover' })).toBeTruthy()
      fireEvent.click(more)
      expect(screen.queryByRole('button', { name: '复制: More hover\nmore-hover' })).toBeNull()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it.each([0, 400, 800])('keeps card dwell independent of the action tooltip (%dms)', (dwell) => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('action-hover'), title: 'Action hover', blank: false, running: false,
        runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
      }
      const renderSlot: RowRenderSlot = (name: RowSlotName) => name === 'sidebar.workspaces.session.row.action'
        ? <Tooltip label="Archive" delayMs={500}><button type="button" aria-label="Archive" /></Tooltip>
        : null
      const { rerender } = render(<SessionNodeItem node={node} currentId={undefined} now={0}
        onOpen={vi.fn()} renderSlot={renderSlot} t={t} />)
      const row = screen.getByRole('treeitem')
      const title = screen.getByText('Action hover')
      const archive = screen.getByRole('button', { name: 'Archive' })
      const card = () => screen.queryByRole('button', { name: '复制: Action hover\naction-hover' })
      fireEvent.pointerEnter(row)
      act(() => { vi.advanceTimersByTime(dwell) })
      if (dwell === 800) expect(card()).not.toBeNull()

      fireEvent(title, new MouseEvent('pointerout', { bubbles: true, relatedTarget: archive }))
      fireEvent(archive, new MouseEvent('pointerover', { bubbles: true, relatedTarget: title }))
      if (dwell === 800) expect(card()).not.toBeNull()
      act(() => { vi.advanceTimersByTime(499) })
      expect(screen.queryByRole('tooltip')).toBeNull()
      if (dwell === 0) expect(card()).toBeNull()
      else expect(card()).not.toBeNull()
      act(() => { vi.advanceTimersByTime(1) })
      expect(screen.getByRole('tooltip').textContent).toBe('Archive')
      if (dwell === 0) expect(card()).toBeNull()
      else expect(card()).not.toBeNull()
      act(() => { vi.advanceTimersByTime(300) })
      expect(card()).not.toBeNull()

      fireEvent(archive, new MouseEvent('pointerout', { bubbles: true, relatedTarget: title }))
      fireEvent(title, new MouseEvent('pointerover', { bubbles: true, relatedTarget: archive }))
      rerender(<SessionNodeItem node={{ ...node, running: true }} currentId={undefined} now={0}
        onOpen={vi.fn()} renderSlot={renderSlot} t={t} />)
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.queryByRole('tooltip')).toBeNull()
      expect(card()).not.toBeNull()

      fireEvent.pointerLeave(row, { relatedTarget: document.body })
      act(() => { vi.advanceTimersByTime(300) })
      fireEvent.pointerEnter(row, { relatedTarget: document.body })
      act(() => { vi.advanceTimersByTime(799) })
      expect(card()).toBeNull()
      act(() => { vi.advanceTimersByTime(1) })
      expect(card()).not.toBeNull()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('shows the hover card after the dwell and suppresses it while the row menu is open', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Hovered', blank: false, running: true,
        runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
      }
      const view = render(<SessionNodeItem node={node} currentId={undefined} now={60_000} onOpen={vi.fn()} t={t} />)
      const wrapper = screen.getByRole('treeitem').parentElement as HTMLElement
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(800) })
      // Card body: full title + relative time + running status.
      expect(screen.getAllByText('Hovered')).toHaveLength(2)
      expect(screen.getByText('1分钟前')).toBeTruthy()
      expect(screen.getAllByText('进行中')).toHaveLength(2)
      fireEvent.pointerLeave(wrapper)
      // Menu open (disabled=true) suppresses the card for the same hover.
      view.rerender(<SessionNodeItem node={node} currentId={undefined} now={60_000} onOpen={vi.fn()} t={t}
        useContextMenuTarget={select => select({ kind: 'session', value: { sessionId: node.id, displayTitle: node.title } })} />)
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.queryByText('1分钟前')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['approval', '等待审批', '待审批'],
    ['plan-review', '计划待审', '计划待审'],
    ['question', '等待回答', '待回答'],
  ] as const)('shows %s as warning and replaces the row time', (pendingInteraction, label, compactLabel) => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid(pendingInteraction), title: 'Needs input', blank: false,
        pendingInteraction, running: true, runningSubagentCount: 0, completed: false, failed: false,
        updatedAt: 0, pinned: false, archived: false,
      }
      const view = render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      const title = screen.getByText('Needs input').parentElement as HTMLElement
      expect(row.querySelector('[data-state="warning"]')).toBeTruthy()
      expect(row.querySelector('[data-state="ongoing"]')).toBeNull()
      expect(row.textContent).toContain(label)
      // The compact label replaces the time inside the resting strip, which now
      // follows the row's home label (title → home label → time).
      expect(title.nextElementSibling?.nextElementSibling?.querySelector('[class*="time"]')?.textContent)
        .toBe(compactLabel)
      expect(row.querySelector('[class*="time"]')?.getAttribute('aria-hidden')).toBe('true')
      expect(row.textContent).not.toContain('刚刚')

      view.rerender(<SessionNodeItem node={{ ...node, running: false }} currentId={undefined} now={0}
        onOpen={vi.fn()} t={t} />)
      expect(screen.getByRole('treeitem').querySelector('[data-state="warning"]')).toBeTruthy()

      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(2)
      expect(screen.getByText('刚刚')).toBeTruthy()
      expect(document.querySelectorAll('[data-state="warning"]')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['approval', 'Approval'],
    ['plan-review', 'Plan review'],
    ['question', 'Answer'],
  ] as const)('uses the compact English %s row label', (pendingInteraction, compactLabel) => {
    const node: SessionNode = {
      id: sid(pendingInteraction), title: 'Needs input', blank: false,
      pendingInteraction, running: false, runningSubagentCount: 0, completed: false, failed: false,
      updatedAt: 0, pinned: false, archived: false,
    }
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={tEn} />)
    const row = screen.getByRole('treeitem')
    expect(row.querySelector('[class*="time"]')?.textContent).toBe(compactLabel)
    expect(screen.getByText(compactLabel).getAttribute('aria-hidden')).toBe('true')
    expect(row.textContent).not.toContain('now')
  })

  it('idle hover card shows the Idle status line', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Quiet', blank: false, running: false,
        runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
      }
      render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getByText('空闲').parentElement?.querySelector('[data-state="idle"]')).not.toBeNull()
      expect(screen.getAllByText('刚刚')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('completed hover card shows the New completion status line', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Done', blank: false, running: false,
        runningSubagentCount: 0, completed: true, failed: false, updatedAt: 0, pinned: false, archived: false,
      }
      render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      // Row's visually-hidden reminder label plus the hover card's status line.
      expect(screen.getAllByText('有新完成')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('archived hover card replaces the resting status with the archived line but keeps live activity', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Stored', blank: false, running: false,
        runningSubagentCount: 0, completed: true, failed: false, updatedAt: 0, pinned: false, archived: true,
      }
      const { rerender } = render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      // Row indicator label plus the hover card's archived line; the idle
      // resting status would restate the same inactivity and stays out.
      expect(screen.getAllByText('已归档')).toHaveLength(1)
      expect(screen.queryByText('空闲')).toBeNull()
      expect(screen.queryByText('未读')).toBeNull()

      // Live activity on an archived session still shows beside the line.
      rerender(<SessionNodeItem node={{ ...node, running: true }} currentId={undefined} now={0} onOpen={vi.fn()} t={t} />)
      expect(screen.getAllByText('进行中').length).toBeGreaterThan(0)
      expect(screen.getAllByText('已归档')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('draggable row wires start/end and gates hover/drop on an active same-group drag', () => {
    const node: SessionNode = {
      id: sid('s1'), title: 'Drag me', blank: false, running: false,
      runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
    }
    const inactive = dragProps()
    const { rerender } = render(
      <SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} drag={inactive} t={t} />,
    )
    const row = screen.getByRole('treeitem')
    stubRect(row)
    expect(row.getAttribute('draggable')).toBe('true')
    fireEvent.dragStart(row, { dataTransfer })
    expect(inactive.start).toHaveBeenCalledOnce()
    // Inactive drag: hover and drop are rejected.
    fireEvent.dragOver(row, { dataTransfer })
    fireEvent.drop(row, { dataTransfer })
    expect(inactive.hover).not.toHaveBeenCalled()
    expect(inactive.drop).not.toHaveBeenCalled()
    dragEnd(row)
    expect(inactive.end).toHaveBeenCalledExactlyOnceWith(false)
    // A copy accepted by another drop target tells the owner to discard the marker.
    fireEvent.dragStart(row, { dataTransfer })
    dragEnd(row, 'copy')
    expect(inactive.end).toHaveBeenLastCalledWith(true)

    const active = dragProps({ active: true, marker: 'before' })
    rerender(
      <SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} drag={active} t={t} />,
    )
    stubRect(screen.getByRole('treeitem'))
    // Top half hovers/drops 'before'; bottom half 'after' (row mid = 117).
    fireDrag(screen.getByRole('treeitem'), 'dragOver', 105)
    expect(active.hover).toHaveBeenCalledWith('before')
    fireDrag(screen.getByRole('treeitem'), 'dragOver', 130)
    expect(active.hover).toHaveBeenCalledWith('after')
    fireDrag(screen.getByRole('treeitem'), 'drop', 130)
    expect(active.drop).toHaveBeenCalledWith('after')

    const after = dragProps({ active: true, marker: 'after' })
    rerender(
      <SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()} drag={after} t={t} />,
    )
    expect(screen.getByRole('treeitem').className).toMatch(/dropAfter/)
  })

  it('marks a pinned row and keeps it draggable', () => {
    const node: SessionNode = {
      id: sid('s1'), title: 'Pinned', blank: false, running: false,
      runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: true, archived: false,
    }
    const view = render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()}
      drag={dragProps()} t={t} />)
    const row = screen.getByRole('treeitem')
    // Reorderable within the pinned block; the browser gates the targets.
    expect(row.getAttribute('draggable')).toBe('true')
    expect(screen.getByRole('img', { name: '已置顶' })).toBeTruthy()

    view.rerender(<SessionNodeItem node={{ ...node, pinned: false }} currentId={undefined} now={0} onOpen={vi.fn()}
      drag={dragProps()} t={t} />)
    expect(screen.queryByRole('img', { name: '已置顶' })).toBeNull()
  })

  it.each(['blank', 'archived'] as const)('ignores child drag end on a %s Session row', (state) => {
    const drag = dragProps({ active: true, marker: 'before' })
    render(<SessionNodeItem node={{
      id: sid('not-draggable'), title: 'Not draggable', blank: state === 'blank', running: false,
      runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: state === 'archived',
    }} currentId={undefined} now={0} onOpen={vi.fn()} drag={drag} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.getAttribute('draggable')).toBe('false')
    dragEnd(row.firstElementChild!)
    dragEnd(row)
    expect(drag.end).not.toHaveBeenCalled()
  })

  it('marks an archived row and blocks dragging it', () => {
    const node: SessionNode = {
      id: sid('s1'), title: 'Stored', blank: false, running: false,
      runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: true, archived: true,
    }
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()}
      drag={dragProps()} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.className).toMatch(/archived/)
    expect(row.getAttribute('draggable')).toBe('false')
    // No leading marker: the grayed row alone carries the archived look, and
    // the pin marker stays off an archived row.
    expect(screen.queryByRole('img', { name: '已归档' })).toBeNull()
    expect(screen.queryByRole('img', { name: '已置顶' })).toBeNull()
    expect(row.getAttribute('aria-description')).toBe('已归档对话暂时无法查看，请取消归档后查看')
  })

  it('double-clicking the title asks for the rename dialog with the current title, but not on a blank row', () => {
    const onRenameRequest = vi.fn()
    const onOpen = vi.fn()
    const node: SessionNode = {
      id: sid('s1'), title: 'Named', blank: false, running: false,
      runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
    }
    const view = render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={onOpen}
      onRenameRequest={onRenameRequest} t={t} />)
    realDoubleClick(screen.getByText('Named'))
    expect(onRenameRequest).toHaveBeenCalledWith(node.id, 'Named')
    expect(onOpen).toHaveBeenCalledWith(node.id)

    // A blank placeholder has no content to rename: double-click is inert.
    view.rerender(<SessionNodeItem node={{ ...node, blank: true }} currentId={undefined} now={0}
      onOpen={onOpen} onRenameRequest={onRenameRequest} t={t} />)
    realDoubleClick(screen.getByText('新会话'))
    expect(onRenameRequest).toHaveBeenCalledOnce()
  })

  it('does not rename when the first click of the pair only activated the window', () => {
    const onRenameRequest = vi.fn()
    const onOpen = vi.fn()
    const node: SessionNode = {
      id: sid('s1'), title: 'Named', blank: false, running: false,
      runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
    }
    render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={onOpen}
      onRenameRequest={onRenameRequest} t={t} />)
    const title = screen.getByText('Named')
    // macOS delivers only the second press of a window-activating pair.
    fireEvent.mouseDown(title, { detail: 2 })
    fireEvent.click(title, { detail: 2 })
    fireEvent.doubleClick(title)
    expect(onOpen).toHaveBeenCalledWith(node.id)
    expect(onRenameRequest).not.toHaveBeenCalled()

    // A press seen before the window lost focus does not arm the next pair.
    fireEvent.mouseDown(title, { detail: 1 })
    fireEvent.blur(window)
    fireEvent.mouseDown(title, { detail: 2 })
    fireEvent.doubleClick(title)
    expect(onRenameRequest).not.toHaveBeenCalled()

    // One armed press renames once.
    realDoubleClick(title)
    fireEvent.mouseDown(title, { detail: 2 })
    fireEvent.doubleClick(title)
    expect(onRenameRequest).toHaveBeenCalledOnce()
  })

  it('flags an archived content-search result', () => {
    const result: SearchResultNode = {
      id: sid('result'), title: 'Old result', workspace: 'Workspace context',
      running: false, runningSubagentCount: 0, completed: false, failed: false, archived: true,
    }
    render(<SearchResultItem result={result} currentId={undefined}
      onOpen={vi.fn()} onUnarchive={vi.fn()} useSessionAccess={allowAllAccess.useSessionAccess} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.className).toMatch(/archived/)
    // No leading marker: the grayed row alone carries the archived look.
    expect(screen.queryByRole('img', { name: '已归档' })).toBeNull()
  })
})

describe('session row decoration seats', () => {
  /**
   * Stand-in occupant: the real one lives in ui-schedule, which this package
   * must not import. The share's owner type covers every key it declares, so
   * the spy takes a bare object and reads the row seats' Session identity from
   * it; a key without one renders nothing.
   */
  function seatSpy(): RowRenderSlot {
    return vi.fn((key: RowSlotName, owner: object) => {
      if (!('sessionId' in owner) || typeof owner.sessionId !== 'string') return null
      return <span key={key} data-seat={key} data-owner={owner.sessionId} />
    })
  }

  const idle: SessionNode = {
    id: sid('idle'), title: 'Idle Session', blank: false, running: false,
    runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false,
  }

  function renderRow(node: SessionNode, renderSlot: RowRenderSlot) {
    return render(<SessionNodeItem node={node} currentId={undefined} now={0} onOpen={vi.fn()}
      renderSlot={renderSlot} t={t} />)
  }

  it.each([false, true])('offers trailing icons after the time label on archived=%s rows', (archived) => {
    const renderSlot = seatSpy()
    const view = renderRow({ ...idle, archived, pinned: !archived }, renderSlot)
    const icon = view.container.querySelector('[data-seat="sidebar.session.row.trailing"]')!
    expect(renderSlot).toHaveBeenCalledWith('sidebar.session.row.trailing', { sessionId: idle.id })
    expect(icon.previousElementSibling?.textContent).toBe('刚刚')
    expect(icon.parentElement?.className).toContain('rowResting')
    expect(icon.nextElementSibling?.getAttribute('aria-label') ?? null).toBe(archived ? null : '已置顶')
    view.rerender(<SessionNodeItem node={{ ...idle, blank: true }} currentId={undefined} now={0}
      onOpen={vi.fn()} renderSlot={renderSlot} t={t} />)
    expect(view.container.querySelector('[data-seat="sidebar.session.row.trailing"]')).toBeNull()
  })

  it('opens a focused row with Enter or Space without handling its action buttons', () => {
    const onOpen = vi.fn()
    render(<SessionNodeItem node={idle} currentId={undefined} now={0} onOpen={onOpen} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.tabIndex).toBe(0)
    fireEvent.keyDown(row, { key: 'ArrowDown' })
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })
    expect(onOpen.mock.calls).toEqual([[idle.id], [idle.id]])
    fireEvent.keyDown(screen.getByRole('button', { name: '会话“Idle Session”的操作' }), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it.each(['Enter', ' '])('leaves modified %j available to global shortcuts', (key) => {
    const onOpen = vi.fn()
    render(<SessionNodeItem node={idle} currentId={undefined} now={0} onOpen={onOpen} t={t} />)
    const row = screen.getByRole('treeitem')
    for (const modifiers of [
      { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true },
      { ctrlKey: true, altKey: true, shiftKey: true },
    ]) {
      expect(fireEvent.keyDown(row, { key, ...modifiers })).toBe(true)
    }
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('walks focus along the rows with ArrowUp/ArrowDown without opening or selecting', () => {
    const onOpen = vi.fn()
    const nodes = (['a', 'b', 'c'] as const).map((key): SessionNode => (
      { ...idle, id: sid(key), title: `Row ${key}` }
    ))
    render(
      <div role="tree" aria-label="sessions">
        {nodes.map(node => (
          <SessionNodeItem key={node.id} node={node} currentId={undefined} now={0} onOpen={onOpen} t={t} />
        ))}
      </div>,
    )
    const rows = screen.getAllByRole('treeitem')
    const [first, second, third] = [rows[0]!, rows[1]!, rows[2]!]
    first.focus()
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(second)
    fireEvent.keyDown(second, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(third)
    // The ends hold: focus neither wraps nor escapes the list. Key events land
    // on the focused row, the way a real keyboard delivers them.
    fireEvent.keyDown(third, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(third)
    fireEvent.keyDown(third, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(second)
    fireEvent.keyDown(second, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(first)
    // A 案: focus walked, the session never opened, selection never followed.
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.getAllByRole('treeitem').map(row => row.getAttribute('aria-selected')))
      .toEqual(['false', 'false', 'false'])
    // Arrows with a modifier stay available to the global shortcuts registry.
    expect(fireEvent.keyDown(first, { key: 'ArrowDown', ctrlKey: true })).toBe(true)
    expect(document.activeElement).toBe(first)
  })

  it('jumps focus to the ends of the row list with Home/End without opening or selecting', () => {
    const onOpen = vi.fn()
    const nodes = (['a', 'b', 'c'] as const).map((key): SessionNode => (
      { ...idle, id: sid(key), title: `Row ${key}` }
    ))
    render(
      <div role="tree" aria-label="sessions">
        {nodes.map(node => (
          <SessionNodeItem key={node.id} node={node} currentId={undefined} now={0} onOpen={onOpen} t={t} />
        ))}
      </div>,
    )
    const rows = screen.getAllByRole('treeitem')
    const [first, , third] = [rows[0]!, rows[1]!, rows[2]!]
    rows[1]!.focus()
    fireEvent.keyDown(rows[1]!, { key: 'Home' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'End' })
    expect(document.activeElement).toBe(third)
    // The ends hold: focus neither wraps nor escapes the list.
    fireEvent.keyDown(third, { key: 'End' })
    expect(document.activeElement).toBe(third)
    fireEvent.keyDown(first, { key: 'Home' })
    expect(document.activeElement).toBe(first)
    // The jump moves focus only: nothing opened, selection never followed.
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.getAllByRole('treeitem').map(row => row.getAttribute('aria-selected')))
      .toEqual(['false', 'false', 'false'])
    // Home/End with a modifier stay available to the global shortcuts registry.
    expect(fireEvent.keyDown(first, { key: 'Home', ctrlKey: true })).toBe(true)
    expect(document.activeElement).toBe(first)
  })

  it('offers the leading seat only while the row is idle, and no state dot beside it', () => {
    const renderSlot = seatSpy()
    const view = renderRow(idle, renderSlot)
    const row = screen.getByRole('treeitem')
    expect(row.querySelector('[data-seat="sidebar.session.row.leading"]')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledWith('sidebar.session.row.leading', { sessionId: idle.id })
    // Priority replacement: the idle row shows the clock seat INSTEAD of a dot.
    expect(row.querySelector('[data-state]')).toBeNull()
    // The seat sits in the leading 16px cell, before the clipped title: the
    // cell is the row's first element, the title follows the cell, then the
    // home label (collab step3 三元组) and the resting strip carrying the time.
    const assertPlacement = (): void => {
      const cell = screen.getByRole('treeitem')
        .querySelector('[data-seat="sidebar.session.row.leading"]')?.parentElement
      expect(cell?.previousElementSibling ?? null).toBeNull()
      expect(cell?.nextElementSibling?.textContent).toBe('Idle Session')
      expect(cell?.nextElementSibling?.nextElementSibling?.className).toContain('homeLabel')
      expect(cell?.nextElementSibling?.nextElementSibling?.nextElementSibling
        ?.querySelector('[class*="time"]')?.textContent).toBe('刚刚')
    }
    assertPlacement()
    // Rerender through the same row: the seat stays leading without the flat
    // list's own props, because the component has no view-specific branch.
    view.rerender(<SessionNodeItem node={idle} currentId={undefined} now={0} onOpen={vi.fn()}
      renderSlot={renderSlot} t={t} />)
    assertPlacement()
  })

  it.each<[string, SessionNode, string]>([
    ['an unviewed completion (new message)', { ...idle, completed: true }, 'done'],
    ['an unviewed failed stop', { ...idle, completed: true, completionOutcome: 'failed' as const }, 'error'],
    ['live activity', { ...idle, running: true }, 'ongoing'],
    ['a pending approval', { ...idle, pendingInteraction: 'approval' as const }, 'warning'],
    ['a running subagent', { ...idle, runningSubagentCount: 2 }, 'ongoing'],
  ])('replaces the leading seat with the %s dot', (_label, node, state) => {
    const renderSlot = seatSpy()
    renderRow(node, renderSlot)
    const row = screen.getByRole('treeitem')
    // The dot occupies the same leading cell the idle row gave the seat.
    const dotCell = row.firstElementChild
    expect(dotCell?.querySelector(`[data-state="${state}"]`)).toBeTruthy()
    expect(row.querySelector('[data-seat="sidebar.session.row.leading"]')).toBeNull()
    expect(renderSlot).not.toHaveBeenCalledWith('sidebar.session.row.leading', expect.anything())
  })

  it('replaces the seat with the wake-up glyph even though the row itself is idle', () => {
    const renderSlot = seatSpy()
    renderRow({ ...idle, pendingWakeup: true }, renderSlot)
    const row = screen.getByRole('treeitem')
    expect(row.firstElementChild?.querySelector('[data-status-glyph="wakeup"]')).toBeTruthy()
    expect(row.querySelector('[data-state]')).toBeNull()
    expect(row.querySelector('[data-seat="sidebar.session.row.leading"]')).toBeNull()
    expect(renderSlot).not.toHaveBeenCalledWith('sidebar.session.row.leading', expect.anything())
  })

  it('keeps the ringed last-known dot in the leading cell instead of offering the seat', () => {
    const renderSlot = seatSpy()
    renderRow({ ...idle, statusStale: true }, renderSlot)
    const row = screen.getByRole('treeitem')
    // 未知不吞已知 (q5): even the confirmed-nothing dot holds the cell while
    // ringed — the unreadable overlays, never vacates, the known.
    expect(row.firstElementChild?.querySelector('[data-state="idle"]')).toBeTruthy()
    expect(row.firstElementChild?.querySelector('[data-stale-kind="connection"]')).toBeTruthy()
    expect(row.querySelector('[data-seat="sidebar.session.row.leading"]')).toBeNull()
    expect(renderSlot).not.toHaveBeenCalledWith('sidebar.session.row.leading', expect.anything())
  })

  it('keeps the row job roster current while mounted and releases it on unmount', () => {
    const release = vi.fn()
    const watchSessionJobs = vi.fn(() => release)
    const view = render(<SessionNodeItem
      node={idle} currentId={undefined} now={0} onOpen={vi.fn()}
      renderSlot={renderNoRowEntries} watchSessionJobs={watchSessionJobs} t={t}
    />)
    expect(watchSessionJobs).toHaveBeenCalledWith(idle.id)
    view.unmount()
    expect(release).toHaveBeenCalledOnce()
  })

  it.each<[string, SessionNode]>([
    ['an idle archived row', { ...idle, archived: true }],
    ['an archived row with live activity', { ...idle, archived: true, running: true }],
    ['an archived row with a pending approval', { ...idle, archived: true, pendingInteraction: 'approval' as const }],
  ])('keeps the leading cell blank on %s: no status dot and no seat', (_label, node) => {
    const renderSlot = seatSpy()
    renderRow(node, renderSlot)
    const row = screen.getByRole('treeitem')
    // The archived rule: the grayed row carries the archived look and its live
    // status stays on the hover card alone, so the cell holds neither marker.
    expect(row.querySelector('[data-state]')).toBeNull()
    expect(row.querySelector('[data-seat="sidebar.session.row.leading"]')).toBeNull()
    expect(renderSlot).not.toHaveBeenCalledWith('sidebar.session.row.leading', expect.anything())
  })

  it('never offers the seat for a provisional blank row', () => {
    const renderSlot = seatSpy()
    renderRow({ ...idle, blank: true }, renderSlot)
    expect(renderSlot).not.toHaveBeenCalledWith('sidebar.session.row.leading', expect.anything())
  })

  it('renders the schedule section between the relative time and the trailing status line', () => {
    vi.useFakeTimers()
    try {
      const renderSlot = seatSpy()
      renderRow(idle, renderSlot)
      // The row's leading seat draws first; the hover seat joins it when the
      // card opens, so the card section is selected by its data attribute.
      expect(renderSlot).toHaveBeenCalledWith('sidebar.session.row.leading', { sessionId: idle.id })
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(800) })
      expect(renderSlot).toHaveBeenCalledWith('sidebar.session.row.hover', { sessionId: idle.id })
      const section = document.querySelector('[data-seat="sidebar.session.row.hover"]')
      expect(section).toBeTruthy()
      // hover-sessionclass-1121: the priority/attributes placeholder block is
      // gone — the hover seat follows the relative time directly, ahead of the
      // trailing status line, and neither placeholder class renders anywhere.
      expect(section?.previousElementSibling?.textContent).toBe('刚刚')
      expect(section?.nextElementSibling?.textContent).toBe('空闲')
      expect(document.querySelector('[class*="hoverAttributes"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

it.each([['未命名', t], ['Untitled', tEn]])('labels unnamed history as %s', (label, translate) => {
  const node: SessionNode = { id: sid('unnamed'), title: '', blank: false, running: false,
    runningSubagentCount: 0, completed: false, failed: false, updatedAt: 0, pinned: false, archived: false }
  const onRenameRequest = vi.fn()
  render(<SessionNodeItem node={node} currentId={node.id} now={0} onOpen={vi.fn()}
    renderSlot={() => null} onRenameRequest={onRenameRequest} t={translate} />)
  expect(screen.getByText(label)).toBeTruthy()
  realDoubleClick(screen.getByText(label))
  expect(onRenameRequest).toHaveBeenCalledWith(node.id, '')
})

it.each([['未命名', t], ['Untitled', tEn]])('labels unnamed search results as %s', (label, translate) => {
  const result: SearchResultNode = { id: sid('unnamed-search'), title: '', workspace: 'Project',
    running: false, runningSubagentCount: 0, completed: false, failed: false, archived: false }
  const onOpen = vi.fn()
  render(<SearchResultItem result={result} currentId={undefined} onOpen={onOpen}
    onUnarchive={vi.fn()} useSessionAccess={allowAllAccess.useSessionAccess} t={translate} />)
  fireEvent.click(screen.getByText(label))
  expect(onOpen).toHaveBeenCalledWith(result.id)
})
