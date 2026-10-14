// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
/** Global panel entries (footer ⋯ menu wide, rail icon column collapsed) and DOM focus through the production slot renderer. */
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ILayout, MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsRenderSlots, PropsRuntime, SlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'sidebar-panel-test': 'alpha'
  }
}

const ALPHA = 'sidebar-test-alpha' as MainPanelId
const BETA = 'sidebar-test-beta' as MainPanelId
const runtimes = new Set<SlotTestRuntime>()

afterEach(async () => {
  try {
    for (const runtime of runtimes) await runtime.dispose()
  } finally {
    runtimes.clear()
    cleanup()
  }
})

async function bench(collapsed = false) {
  const runtime = await SlotTestRuntime.create()
  runtimes.add(runtime)
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  const startSession = vi.fn()
  const layout = {
    panelInfo: runtime.panelInfo,
    beginNavigation: vi.fn(() => new AbortController().signal),
    toggleSidebar: vi.fn(),
    selectPanel: vi.fn((activePanelId: MainPanelId | null) => { runtime.panelInfo.set({ activePanelId }) }),
    openRightbar: vi.fn(),
    closeRightbar: vi.fn(),
  } satisfies ILayout
  await runtime.mount({
    inject: ['slots'],
    apply(ctx: Context) {
      ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
      ctx.provide('layout', layout)
      ctx.provide('uiWorkspace', { startSession } as never)
      ctx.provide('locale', locale)
      ctx.effect(() => locale.register('common', { zh: commonZh, en: commonEn }), 'panel test: common locale')
      ctx.effect(() => locale.register('sidebar-panel-test', {
        zh: { alpha: '甲面板' }, en: { alpha: 'Alpha panel' },
      }), 'panel test: panel locale')
      ctx.slots.installLocale(locale)
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'conversation' }, () => (
        <p>Conversation content</p>
      )))
    },
  })
  function Frame({ usePanelInfo, renderSlot }: PropsRuntime<'root'> & PropsRenderSlots<'sidebar' | 'main'>) {
    const activePanelId = usePanelInfo(info => info.activePanelId)
    return (
      <>
        <aside>{renderSlot('sidebar', { collapsed, width: collapsed ? 56 : 300 })}</aside>
        <main>{renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })}</main>
      </>
    )
  }
  await runtime.root.declare({
    sidebar: { kind: 'single', scope: 'root' },
    main: { kind: 'keyed', scope: 'root' },
  }, Frame)
  const sidebar = await runtime.mount({ inject: [...inject], apply })
  const view = runtime.renderRoot()
  return { runtime, locale, layout, startSession, sidebar, view }
}

interface TestPanel {
  id: MainPanelId
  heading: string
  order?: number
  label?: SlotLabel
}

async function mountPanel(runtime: SlotTestRuntime, { heading, ...metadata }: TestPanel) {
  function Icon({ size, active }: PropsRuntime<'sidebar.panellist'>) {
    return (
      <span data-testid={`${metadata.id}-icon`} data-active={active}>
        <IconGlobeOutlineRegular size={size} />
      </span>
    )
  }
  function Body() {
    return (
      <section>
        <h1>{heading}</h1>
        <input aria-label={`${heading} input`} />
        <button type="button">{heading} action</button>
      </section>
    )
  }
  return runtime.mount({
    inject: ['slots'],
    apply(ctx: Context) {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: metadata.id }, Body))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', ...metadata }, Icon))
    },
  })
}

async function mountPanels(runtime: SlotTestRuntime, locale: LocaleRuntime, betaOrder = 10) {
  const t = locale.bind('sidebar-panel-test')
  const alpha = await mountPanel(runtime, { id: ALPHA, heading: 'Alpha content', label: () => t('alpha'), order: 20 })
  const beta = await mountPanel(runtime, { id: BETA, heading: 'Beta content', label: 'Beta panel', order: betaOrder })
  return { alpha, beta }
}

/** The wide sidebar's ⋯ menu: trigger by its en label (locale benches set en). */
async function openPanelsMenu(view: Awaited<ReturnType<typeof bench>>['view'], triggerName = 'More') {
  const trigger = await view.findByRole('button', { name: triggerName })
  fireEvent.click(trigger)
  const menu = await view.findByRole('menu')
  return { trigger, menu }
}

describe('sidebar global panels', () => {
  it('offers New Session head of the ⋯ menu, follows panel registrations, and drops each contribution', async () => {
    const { runtime, locale, startSession, view } = await bench()
    expect(runtime.slots.entries('sidebar.panellist')).toEqual([])
    expect(view.queryByRole('navigation')).toBeNull()
    // Wide renders the ⋯ even with zero panels: New Session always rides it.
    let trigger = await view.findByRole('button', { name: 'More' })
    let { menu } = await openPanelsMenu(view)
    expect(within(menu).getAllByRole('menuitem').map(row => row.textContent)).toEqual(['New Session'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'New Session' }))
    // The shell's inject wrapper forwards its optional workspace id (absent here → undefined).
    expect(startSession).toHaveBeenCalledExactlyOnceWith(undefined)
    await waitFor(() => { expect(view.queryByRole('menu')).toBeNull() })
    expect(view.getByText('Conversation content')).toBeTruthy()

    const { alpha, beta } = await mountPanels(runtime, locale)
    ;({ menu } = await openPanelsMenu(view))
    expect(within(menu).getAllByRole('menuitem').map(row => row.textContent)).toEqual(['New Session', 'Beta panel', 'Alpha panel'])
    expect(within(menu).getAllByRole('separator')).toHaveLength(1)
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Alpha panel' }))
    expect(view.getByRole('heading', { name: 'Alpha content' })).toBeTruthy()
    await waitFor(() => { expect(view.queryByRole('menu')).toBeNull() })

    await alpha.dispose()
    fireEvent.click(view.getByRole('button', { name: 'More' }))
    menu = await view.findByRole('menu')
    expect(within(menu).queryByRole('menuitem', { name: 'Alpha panel' })).toBeNull()
    expect(view.queryByRole('heading', { name: 'Alpha content' })).toBeNull()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Beta panel' }))
    expect(view.getByRole('heading', { name: 'Beta content' })).toBeTruthy()
    expect(runtime.slots.entries('main').map(entry => entry.options.key)).toEqual(['conversation', BETA])

    await beta.dispose()
    fireEvent.click(view.getByRole('button', { name: 'More' }))
    await waitFor(() => {
      expect(within(view.getByRole('menu')).queryByRole('menuitem', { name: 'Beta panel' })).toBeNull()
    })
    expect(runtime.slots.entries('sidebar.panellist')).toEqual([])
    expect(view.container.querySelector('[data-slot="sidebar.panellist"]')).toBeNull()
    expect(runtime.slots.entries('main').map(entry => entry.options.key)).toEqual(['conversation'])
    // The trigger stays while the shell does: New Session needs no registration.
    trigger = view.getByRole('button', { name: 'More' })
    expect(trigger.isConnected).toBe(true)
  })

  it.each([false, true])('renders ordered panel controls (menu wide / rail icons collapsed) with collapsed=%s', async (collapsed) => {
    const { runtime, locale, view } = await bench(collapsed)
    await mountPanels(runtime, locale)
    if (collapsed) {
      expect(view.queryByRole('button', { name: 'More' })).toBeNull()
      const navigation = await view.findByRole('navigation', { name: 'Global panels' })
      const rows = within(navigation).getAllByRole('button')
      expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(['Beta panel', 'Alpha panel'])
      for (const [id, label] of [[BETA, 'Beta panel'], [ALPHA, 'Alpha panel']] as const) {
        const row = within(navigation).getByRole('button', { name: label })
        expect(row.getAttribute('aria-current')).toBeNull()
        expect(row.textContent).toBe('')
        expect(row.querySelectorAll('svg')).toHaveLength(1)
        const icon = within(row).getByTestId(`${id}-icon`)
        expect(icon.getAttribute('data-active')).toBe('false')
        expect(icon.querySelector('svg')?.getAttribute('width')).toBe('18')
        expect(icon.querySelector('svg')?.getAttribute('height')).toBe('18')
        act(() => { row.focus() })
        expect(document.activeElement).toBe(row)
        expect(view.getByRole('tooltip').textContent).toBe(label)
        act(() => { row.blur() })
        expect(document.activeElement).not.toBe(row)
        expect(view.queryByRole('tooltip')).toBeNull()
      }
      return
    }
    // Wide: the top rows are gone; entries live in the footer ⋯ menu.
    expect(view.queryByRole('navigation')).toBeNull()
    const { trigger, menu } = await openPanelsMenu(view)
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const rows = within(menu).getAllByRole('menuitem')
    expect(rows.map(row => row.textContent)).toEqual(['New Session', 'Beta panel', 'Alpha panel'])
    // New Session leads the menu with its own glyph (not a panellist entry).
    expect(within(within(menu).getByRole('menuitem', { name: 'New Session' })).queryByTestId(/-icon/)).toBeNull()
    for (const [id, label] of [[BETA, 'Beta panel'], [ALPHA, 'Alpha panel']] as const) {
      const row = within(menu).getByRole('menuitem', { name: label })
      expect(row.querySelectorAll('svg')).toHaveLength(1)
      const icon = within(row).getByTestId(`${id}-icon`)
      expect(icon.getAttribute('data-active')).toBe('false')
      expect(icon.querySelector('svg')?.getAttribute('width')).toBe('16')
      expect(icon.querySelector('svg')?.getAttribute('height')).toBe('16')
    }
    fireEvent.click(trigger)
    await waitFor(() => { expect(view.queryByRole('menu')).toBeNull() })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps registration order when panel rows have equal order', async () => {
    const { runtime, locale, view } = await bench()
    await mountPanels(runtime, locale, 20)
    const { menu } = await openPanelsMenu(view)
    expect(within(menu).getAllByRole('menuitem').map(row => row.textContent)).toEqual(['New Session', 'Alpha panel', 'Beta panel'])
  })

  it('selects registered main content and keeps a repeated selection active', async () => {
    const { runtime, locale, layout, view } = await bench()
    await mountPanels(runtime, locale)
    fireEvent.click(await view.findByRole('button', { name: 'More' }))
    let menu = await view.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Alpha panel' }))
    expect(layout.selectPanel).toHaveBeenLastCalledWith(ALPHA)
    expect(runtime.panelInfo.getSnapshot()).toEqual({ activePanelId: ALPHA })
    expect(view.getByRole('heading', { name: 'Alpha content' })).toBeTruthy()
    expect(view.queryByRole('heading', { name: 'Beta content' })).toBeNull()
    // The active flag rides the menu rows' icon owner props.
    fireEvent.click(view.getByRole('button', { name: 'More' }))
    menu = await view.findByRole('menu')
    expect(within(menu).getByTestId(`${ALPHA}-icon`).getAttribute('data-active')).toBe('true')
    expect(within(menu).getByTestId(`${BETA}-icon`).getAttribute('data-active')).toBe('false')

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Alpha panel' }))
    expect(layout.selectPanel).toHaveBeenLastCalledWith(ALPHA)
    expect(runtime.panelInfo.getSnapshot()).toEqual({ activePanelId: ALPHA })
    expect(view.getByRole('heading', { name: 'Alpha content' })).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'More' }))
    menu = await view.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Beta panel' }))
    expect(layout.selectPanel).toHaveBeenLastCalledWith(BETA)
    expect(runtime.panelInfo.getSnapshot()).toEqual({ activePanelId: BETA })
    fireEvent.click(view.getByRole('button', { name: 'More' }))
    menu = await view.findByRole('menu')
    expect(within(menu).getByTestId(`${ALPHA}-icon`).getAttribute('data-active')).toBe('false')
    expect(within(menu).getByTestId(`${BETA}-icon`).getAttribute('data-active')).toBe('true')
    expect(view.queryByRole('heading', { name: 'Alpha content' })).toBeNull()
    expect(view.getByRole('heading', { name: 'Beta content' })).toBeTruthy()
  })

  it('refreshes locale labels without re-registering icons or changing plain labels', async () => {
    const { runtime, locale, view } = await bench()
    await mountPanels(runtime, locale)
    await openPanelsMenu(view)
    const entries = runtime.slots.entries('sidebar.panellist')
    act(() => { locale.setLocale('zh') })
    await waitFor(() => {
      expect(view.getByRole('button', { name: '更多' }).getAttribute('aria-expanded')).toBe('true')
    })
    const menu = await view.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: '新会话' }).textContent).toBe('新会话')
    expect(within(menu).getByRole('menuitem', { name: '甲面板' }).textContent).toBe('甲面板')
    expect(within(menu).getByRole('menuitem', { name: 'Beta panel' }).textContent).toBe('Beta panel')
    expect(runtime.slots.entries('sidebar.panellist')).toBe(entries)
  })

  it('uses an omitted label and order as the panel id and order zero', async () => {
    const { runtime, view } = await bench()
    await mountPanel(runtime, { id: ALPHA, heading: 'Alpha content', label: 'Alpha panel', order: 20 })
    await mountPanel(runtime, { id: BETA, heading: 'Beta content' })
    const { menu } = await openPanelsMenu(view)
    expect(within(menu).getAllByRole('menuitem').map(row => row.textContent)).toEqual(['New Session', BETA, 'Alpha panel'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: BETA }))
    expect(view.getByRole('heading', { name: 'Beta content' })).toBeTruthy()
  })

  it.each([false, true])('keeps main selection while DOM focus moves between controls with collapsed=%s', async (collapsed) => {
    const { runtime, locale, layout, view } = await bench(collapsed)
    await mountPanels(runtime, locale)
    if (collapsed) {
      const navigation = await view.findByRole('navigation', { name: 'Global panels' })
      const alpha = within(navigation).getByRole('button', { name: 'Alpha panel' })
      const beta = within(navigation).getByRole('button', { name: 'Beta panel' })
      act(() => { alpha.focus() })
      expect(document.activeElement).toBe(alpha)
      expect(runtime.panelInfo.getSnapshot()).toEqual({ activePanelId: null })
      expect(alpha.getAttribute('aria-current')).toBeNull()
      expect(layout.selectPanel).not.toHaveBeenCalled()
      fireEvent.click(alpha)
      const selected = runtime.panelInfo.getSnapshot()
      const textbox = view.getByRole('textbox', { name: 'Alpha content input' })
      const action = view.getByRole('button', { name: 'Alpha content action' })
      for (const target of [textbox, action, beta, alpha]) {
        act(() => { target.focus() })
        expect(document.activeElement).toBe(target)
        expect(runtime.panelInfo.getSnapshot()).toBe(selected)
        expect(alpha.getAttribute('aria-current')).toBe('page')
        expect(beta.getAttribute('aria-current')).toBeNull()
        expect(view.getByRole('heading', { name: 'Alpha content' })).toBeTruthy()
        expect(view.queryByRole('heading', { name: 'Beta content' })).toBeNull()
      }
      expect(layout.selectPanel).toHaveBeenCalledExactlyOnceWith(ALPHA)
      return
    }
    fireEvent.click(await view.findByRole('button', { name: 'More' }))
    let menu = await view.findByRole('menu')
    const alpha = within(menu).getByRole('menuitem', { name: 'Alpha panel' })
    act(() => { alpha.focus() })
    expect(document.activeElement).toBe(alpha)
    expect(runtime.panelInfo.getSnapshot()).toEqual({ activePanelId: null })
    expect(layout.selectPanel).not.toHaveBeenCalled()
    fireEvent.click(alpha)
    expect(layout.selectPanel).toHaveBeenCalledExactlyOnceWith(ALPHA)
    const selected = runtime.panelInfo.getSnapshot()
    const textbox = view.getByRole('textbox', { name: 'Alpha content input' })
    const action = view.getByRole('button', { name: 'Alpha content action' })
    fireEvent.click(view.getByRole('button', { name: 'More' }))
    menu = await view.findByRole('menu')
    const beta = within(menu).getByRole('menuitem', { name: 'Beta panel' })
    const alphaAgain = within(menu).getByRole('menuitem', { name: 'Alpha panel' })
    for (const target of [textbox, action, beta, alphaAgain]) {
      act(() => { target.focus() })
      expect(document.activeElement).toBe(target)
      expect(runtime.panelInfo.getSnapshot()).toBe(selected)
      expect(view.getByRole('heading', { name: 'Alpha content' })).toBeTruthy()
      expect(view.queryByRole('heading', { name: 'Beta content' })).toBeNull()
    }
  })

  it('closes the panel menu on Escape without changing the selection', async () => {
    const { runtime, locale, layout, view } = await bench()
    await mountPanels(runtime, locale)
    const { trigger } = await openPanelsMenu(view)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(view.queryByRole('menu')).toBeNull() })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(layout.selectPanel).not.toHaveBeenCalled()
    expect(runtime.panelInfo.getSnapshot()).toEqual({ activePanelId: null })
  })

  it('disposes the sidebar while retaining independently owned main panel bodies', async () => {
    const { runtime, locale, sidebar, view } = await bench()
    await mountPanels(runtime, locale)
    fireEvent.click(await view.findByRole('button', { name: 'More' }))
    fireEvent.click(within(await view.findByRole('menu')).getByRole('menuitem', { name: 'Alpha panel' }))
    await sidebar.dispose()
    expect(view.queryByRole('button', { name: 'More' })).toBeNull()
    expect(view.queryByRole('menu')).toBeNull()
    expect(runtime.slots.spec('sidebar.panellist')).toBeUndefined()
    expect(runtime.slots.entries('sidebar.panellist')).toEqual([])
    expect(view.getByRole('heading', { name: 'Alpha content' })).toBeTruthy()
    act(() => { locale.setLocale('zh') })
    expect(view.queryByRole('button', { name: '更多入口' })).toBeNull()
  })
})
