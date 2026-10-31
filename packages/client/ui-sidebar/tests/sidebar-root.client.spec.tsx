// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShortcutCatalogEntry, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ReactNode } from 'react'
import type {
  SidebarFooterActionOwnerProps, SidebarRootComponentProps, SidebarSectionOwnerProps,
  SidebarSettingsOwnerProps,
} from '../src/client/contract/slots.ts'
import { HeaderLeadingControls, type HeaderLeadingControlsProps } from '../src/client/HeaderLeadingControls.tsx'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'
import { en } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

const t: SidebarRootComponentProps['t'] = makeTranslate({ ...commonEn, ...en })

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.platform
  vi.unstubAllEnvs()
  vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'clipboard')
})

// The shell never reads the global hooks itself, but they ride the standard
// props share; stub them as never-called functions.
const neverHook = (() => { throw new Error('shell must not read global hooks') }) as never
type AttentionSnapshot = Parameters<Parameters<SidebarRootComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: SidebarRootComponentProps['useSessionStatus'] = selector => selector(noAttention)

function mountShell({ collapsed = false, width = 300, shortcuts = [], footerActions = ['update'] }: {
  collapsed?: boolean
  width?: number
  shortcuts?: readonly ShortcutCatalogEntry[]
  /** Registration ids of the folded footer-action seat (empty = no occupant). */
  footerActions?: readonly string[]
} = {}) {
  const startSession = vi.fn()
  const toggleSidebar = vi.fn()
  const trackEntryClick = vi.fn<SidebarRootComponentProps['trackEntryClick']>()
  let regionOwner: SidebarSectionOwnerProps | undefined
  let settingsOwner: SidebarSettingsOwnerProps | undefined
  let footerActionOwner: SidebarFooterActionOwnerProps | undefined
  const brandMark = <span data-testid="custom-brand-mark">M</span>
  const brandName = <span data-testid="custom-brand-name">Custom Brand</span>
  let current = { collapsed, width }
  const root = () => (
    <SidebarRoot
      collapsed={current.collapsed} width={current.width}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useShortcuts={selector => selector(shortcuts)}
      useMoreActions={selector => selector([])}
      useFooterActions={selector => selector(footerActions)}
      useEntryPins={selector => selector([])} useEntryActions={selector => selector(false)} setPinned={() => {}}
      useResource={useResource} useWorkspaces={neverHook}
      {...allowAllAccess}
      startSession={startSession} toggleSidebar={toggleSidebar} trackEntryClick={trackEntryClick} t={t}
      renderSlot={((
        key: string,
        owner: SidebarFooterActionOwnerProps | SidebarSectionOwnerProps | SidebarSettingsOwnerProps,
      ) => {
        if (key === 'sidebar.brand.mark') return brandMark
        if (key === 'sidebar.brand.name') return brandName
        if (key === 'sidebar.toggle.badge') return null
        if (key === 'sidebar.settings') {
          settingsOwner = owner
          return <div data-testid="settings-seat" data-wide={owner.wide} />
        }
        if (key === 'sidebar.footer.action') {
          footerActionOwner = owner
          return <div data-testid="footer-action-seat" data-wide={owner.wide} />
        }
        if (key === 'sidebar.more.action') {
          return <div data-testid="more-action-seat" data-wide={owner.wide} />
        }
        regionOwner = owner as SidebarSectionOwnerProps
        return <div data-testid="region" data-wide={owner.wide} />
      }) as SidebarRootComponentProps['renderSlot']}
    />
  )
  const view = render(root())
  return {
    startSession,
    toggleSidebar,
    trackEntryClick,
    regionOwner: () => {
      if (regionOwner === undefined) throw new Error('region owner not rendered')
      return regionOwner
    },
    settingsOwner: () => {
      if (settingsOwner === undefined) throw new Error('settings owner not rendered')
      return settingsOwner
    },
    footerActionOwner: () => {
      if (footerActionOwner === undefined) throw new Error('footer action owner not rendered')
      return footerActionOwner
    },
    rerender(next: Partial<typeof current>) {
      current = { ...current, ...next }
      view.rerender(root())
    },
  }
}

describe('SidebarRoot shell', () => {
  it('advertises the effective new-session binding', () => {
    const shortcut: ShortcutCatalogEntry = { id: 'session.new' as ShortcutCommandId, label: 'New', aliases: [],
      binding: null, modified: true, conflicts: [], issue: null, keys: ['Ctrl', 'N'], aria: 'Control+N' }
    mountShell({ shortcuts: [shortcut] })
    // FORK dsh-local (usage glance v2): the wide logo row carries no New
    // Session button — the ⋯ menu head row owns the action, and the resident
    // leading controls (rail / macOS header) keep the ARIA binding.
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull()
    // The ⋯ menu's head row starts a session through the same action.
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Session' }))
    cleanup()
    render(<HeaderLeadingControls toggleSidebar={vi.fn()} startSession={vi.fn()} selectPanel={vi.fn()} t={t}
      trackEntryClick={vi.fn()} setPinned={() => {}} usePanelInfo={neverHook} useSessions={neverHook} useSessionStatus={neverHook}
      useSessionRetainInfo={neverHook} useResource={useResource} useWorkspaces={neverHook}
      {...allowAllAccess}
      usePanels={select => select([])} useEntryPins={select => select([])} useEntryActions={select => select(false)}
      useMoreActions={select => select([])}
      useFooterActions={select => select([])}
      useShortcuts={select => select([shortcut])} />)
    const button = screen.getByRole('button', { name: 'New session' })
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+N')
    fireEvent.focus(button)
    expect(Array.from(screen.getByRole('tooltip').querySelectorAll('kbd'), key => key.textContent)).toEqual(['Ctrl', 'N'])
  })
  it('routes New Session through the ⋯ menu and keeps the column toggle', () => {
    const b = mountShell()
    // FORK dsh-local (usage glance v2): the wordmark seat is gone from the
    // logo row (no mark slot, no New Session button); a brand NAME occupant
    // still renders ahead of the glance.
    expect(screen.queryByTestId('custom-brand-mark')).toBeNull()
    expect(screen.getByTestId('custom-brand-name')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Session' }))
    expect(b.startSession).toHaveBeenCalledExactlyOnceWith()
    // rc.3 merge: opening the ⋯ menu reports 'more'; its head row reports New Session first.
    expect(b.trackEntryClick).toHaveBeenNthCalledWith(1, { menu_name: 'more', position: 'sidebar' })
    expect(b.trackEntryClick).toHaveBeenNthCalledWith(2, { menu_name: 'new_session', position: 'sidebar' })
    expect(b.trackEntryClick).toHaveBeenCalledTimes(2)
    expect(b.trackEntryClick.mock.invocationCallOrder[1]).toBeLessThan(b.startSession.mock.invocationCallOrder[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('reports the collapsed rail New Session as a sidebar click outside the Windows caption', () => {
    const b = mountShell({ collapsed: true, width: 56 })
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(b.startSession).toHaveBeenCalledOnce()
    expect(b.trackEntryClick).toHaveBeenCalledExactlyOnceWith({ menu_name: 'new_session', position: 'sidebar' })
  })

  it('offers no New Session control while the access snapshot excludes session/create', () => {
    const toggleSidebar = vi.fn()
    const startSession = vi.fn()
    const useRemoteAccess = vi.fn((action: string) => action !== 'session/create')
    render(<SidebarRoot
      collapsed={false} width={300}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useEntryPins={selector => selector([])}
      useEntryActions={selector => selector(false)} setPinned={vi.fn()}
      useShortcuts={selector => selector([])}
      useMoreActions={selector => selector([])}
      useFooterActions={selector => selector([])}
      useResource={useResource} useWorkspaces={neverHook}
      {...allowAllAccess}
      useRemoteAccess={useRemoteAccess}
      startSession={startSession} toggleSidebar={toggleSidebar} trackEntryClick={vi.fn()} t={t}
      renderSlot={((key: string) => {
        if (key === 'sidebar.brand.mark') return <span data-testid="brand-mark">M</span>
        if (key === 'sidebar.brand.name') return <span data-testid="brand-name">Brand</span>
        return null
      }) as SidebarRootComponentProps['renderSlot']}
    />)

    // Neither the brand-name seat nor any dedicated button starts a Session.
    // FORK (usage glance v2): the wide row keeps the brand NAME occupant and
    // never seats the mark, so the mark slot stays empty here.
    expect(useRemoteAccess).toHaveBeenCalledWith('session/create')
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull()
    expect(screen.queryByTestId('brand-mark')).toBeNull()
    expect(screen.getByTestId('brand-name')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(toggleSidebar).toHaveBeenCalledOnce()
    expect(startSession).not.toHaveBeenCalled()
  })

  it('renders no brand surfaces when no package fills the slots', () => {
    vi.stubEnv('DSH_CLIENT_COMMIT_HASH', '0123456')
    vi.stubEnv('DSH_CLIENT_GIT_DIRTY', 'true')
    vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3-rc.4')
    const { container } = render(<SidebarRoot
      collapsed={false} width={300}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useShortcuts={selector => selector([])}
      useMoreActions={selector => selector([])}
      useFooterActions={selector => selector([])}
      useEntryPins={selector => selector([])} useEntryActions={selector => selector(false)} setPinned={() => {}}
      useResource={useResource} useWorkspaces={neverHook}
      {...allowAllAccess}
      startSession={vi.fn()} toggleSidebar={vi.fn()} trackEntryClick={vi.fn()} t={t}
      renderSlot={((_key: string, _owner: unknown, options?: { fallback?: ReactNode }) =>
        options?.fallback ?? null) as SidebarRootComponentProps['renderSlot']}
    />)

    // FORK dsh-local (usage glance v2): the wide logo row carries no brand
    // button, label, badge, or version title — the row is the usage glance
    // plus the panel toggle.
    expect(screen.queryByText('DSH Local Build')).toBeNull()
    expect(screen.queryByText('1.2.3-rc.4-0123456-dirty')).toBeNull()
    expect(container.querySelector('[title="1.2.3-rc.4-0123456-dirty"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull()
    expect(screen.getByRole('button', { name: t('glance.open') })).toBeTruthy()
  })

  it.each([
    [{ DSH_CLIENT_VERSION: '1.2.3' }, '1.2.3'],
    [{ DSH_CLIENT_COMMIT_HASH: 'abcdef0', DSH_CLIENT_VERSION: '1.2.3' }, '1.2.3-abcdef0'],
  ])('keeps build-version metadata out of the logo row from %j', (environment, expected) => {
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value)
    render(<SidebarRoot
      collapsed={false} width={300}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useShortcuts={selector => selector([])}
      useMoreActions={selector => selector([])}
      useFooterActions={selector => selector([])}
      useEntryPins={selector => selector([])} useEntryActions={selector => selector(false)} setPinned={() => {}}
      useResource={useResource} useWorkspaces={neverHook}
      {...allowAllAccess}
      startSession={vi.fn()} toggleSidebar={vi.fn()} trackEntryClick={vi.fn()} t={t}
      renderSlot={((_key: string, _owner: unknown, options?: { fallback?: ReactNode }) =>
        options?.fallback ?? null) as SidebarRootComponentProps['renderSlot']}
    />)

    // FORK dsh-local (usage glance v2): build metadata never surfaces in the
    // logo row — the version-reading code path is gone with the brand button.
    expect(document.querySelector(`[title="${expected}"]`)).toBeNull()
    expect(screen.queryByText(expected)).toBeNull()
  })

  it('renders no local-build label without complete build metadata', () => {
    const { container } = render(<SidebarRoot
      collapsed={false} width={300}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useShortcuts={selector => selector([])}
      useMoreActions={selector => selector([])}
      useFooterActions={selector => selector([])}
      useEntryPins={selector => selector([])} useEntryActions={selector => selector(false)} setPinned={() => {}}
      useResource={useResource} useWorkspaces={neverHook}
      {...allowAllAccess}
      startSession={vi.fn()} toggleSidebar={vi.fn()} trackEntryClick={vi.fn()} t={t}
      renderSlot={((_key: string, _owner: unknown, options?: { fallback?: ReactNode }) =>
        options?.fallback ?? null) as SidebarRootComponentProps['renderSlot']}
    />)

    // FORK dsh-local (usage glance v2): no version metadata and no brand
    // surfaces at all — the row is the usage glance plus the toggle.
    expect(screen.queryByText('DSH Local Build')).toBeNull()
    expect(container.querySelector('[class*="logoRow"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: t('glance.open') })).toBeTruthy()
  })

  it('hands the region its wide flag and clamps expandSidebar to the collapsed state', () => {
    const b = mountShell()
    expect(b.regionOwner().wide).toBe(true)
    // The settings seat rides the same wide flag (ui-settings renders the row).
    expect(b.settingsOwner().wide).toBe(true)
    // Expanded: the request is a no-op (no accidental collapse).
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).not.toHaveBeenCalled()
  })

  it('folds the footer-action seat into the ⋯ menu instead of the foot row', () => {
    const b = mountShell()
    // FORK footer-into-more-1031: no occupant renders beside Settings — the
    // seat only exists inside the open menu, always in wide row form.
    expect(screen.queryByTestId('footer-action-seat')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(b.footerActionOwner().wide).toBe(true)
    expect(screen.getByTestId('footer-action-seat')).toBeTruthy()
    // Both action seats share the group; the separator renders above them.
    expect(screen.getByTestId('more-action-seat')).toBeTruthy()
    expect(screen.getAllByRole('separator').length).toBeGreaterThan(0)
  })

  it('draws the action-group separator while either action seat has registrations', () => {
    cleanup()
    const withFooterOnly = mountShell({ footerActions: ['update'] })
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(withFooterOnly.footerActionOwner().wide).toBe(true)
    cleanup()
    // No registrants in either seat: the group (and its separator) is gone.
    mountShell({ footerActions: [] })
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.queryByTestId('footer-action-seat')).toBeNull()
    expect(screen.queryByTestId('more-action-seat')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('keeps the region mounted through collapse and expands on its request', () => {
    vi.useFakeTimers()
    const b = mountShell()
    b.rerender({ collapsed: true })
    // Wide content survives the crossfade window, then settles into the rail.
    expect(b.regionOwner().wide).toBe(true)
    vi.advanceTimersByTime(200)
    b.rerender({})
    expect(b.regionOwner().wide).toBe(false)
    expect(screen.getByTestId('region')).toBeTruthy()
    // FORK footer-into-more-1031: in the rail the folded seat renders from
    // the foot's ⋯ menu — still wide row form (the menu body is state-independent).
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(b.footerActionOwner().wide).toBe(true)
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('renders statically collapsed on a cold start (no crossfade classes)', () => {
    const b = mountShell({ collapsed: true })
    expect(b.regionOwner().wide).toBe(false)
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeTruthy()
  })

  it('shows only the badge bubble while the rail badge is hovered inside the toggle', () => {
    vi.useFakeTimers()
    render(<SidebarRoot
      collapsed width={56}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useShortcuts={selector => selector([])}
      useMoreActions={selector => selector([])}
      useFooterActions={selector => selector([])}
      useEntryPins={selector => selector([])} useEntryActions={selector => selector(false)} setPinned={() => {}}
      useResource={useResource} useWorkspaces={neverHook}
      {...allowAllAccess}
      startSession={vi.fn()} toggleSidebar={vi.fn()} trackEntryClick={vi.fn()} t={t}
      renderSlot={((key: string) => key === 'sidebar.toggle.badge'
        ? <Tooltip label="Update — V1.2.3"><span data-testid="badge" /></Tooltip>
        : null) as SidebarRootComponentProps['renderSlot']}
    />)
    const toggle = screen.getByRole('button', { name: 'Open sidebar' })
    fireEvent.pointerEnter(toggle)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByRole('tooltip').textContent).toBe('Open sidebar')
    // The badge's own bubble replaces the toggle's rather than stacking on it,
    // even after the toggle's longer hover delay has elapsed.
    fireEvent.pointerEnter(screen.getByTestId('badge'))
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getAllByRole('tooltip').map(bubble => bubble.textContent)).toEqual(['Update — V1.2.3'])
    fireEvent.pointerLeave(screen.getByTestId('badge'), { relatedTarget: toggle })
    expect(screen.getByRole('tooltip').textContent).toBe('Open sidebar')
    fireEvent.pointerLeave(toggle)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

it('keeps the macOS sidebar toggle in its top strip', () => {
  document.documentElement.dataset.platform = 'darwin'
  const shell = mountShell()
  fireEvent.click(screen.getByRole('button', { name: en['toggle.collapse'] }))
  expect(shell.toggleSidebar).toHaveBeenCalledOnce()
  // FORK (usage glance v2): the brand surface is gone from the logo row; the
  // dedicated macOS New Session capsule is the only top starter.
  expect(screen.getAllByRole('button', { name: 'New session' })).toHaveLength(1)
  expect(screen.queryByTestId('custom-brand-mark')).toBeNull()
})

it('wires the shell.leading controls to the shared sidebar actions', () => {
  const toggleSidebar = vi.fn()
  const startSession = vi.fn()
  const trackEntryClick = vi.fn<HeaderLeadingControlsProps['trackEntryClick']>()
  // This occupant only consumes its actions, the global access Hook, and locale, not Session hooks.
  const props = { toggleSidebar, startSession, trackEntryClick, t, useRemoteAccess: allowAllAccess.useRemoteAccess, useShortcuts: select => select([{ id: 'sidebar.left.toggle' as ShortcutCommandId, label: 'Toggle sidebar', aliases: [], binding: null, modified: false, conflicts: [], issue: null, keys: ['⌘', 'B'], aria: 'Meta+B' }]) } as HeaderLeadingControlsProps
  render(<HeaderLeadingControls {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en['toggle.open'] }))
  fireEvent.click(screen.getByRole('button', { name: en['session.new.label'] }))
  expect(toggleSidebar).toHaveBeenCalledOnce()
  expect(startSession).toHaveBeenCalledOnce()
  // rc.3 merge: the titlebar starter reports its own position.
  expect(trackEntryClick).toHaveBeenCalledExactlyOnceWith({ menu_name: 'new_session', position: 'titlebar' })
  expect(trackEntryClick.mock.invocationCallOrder[0]).toBeLessThan(startSession.mock.invocationCallOrder[0]!)
  cleanup()

  // A page whose access snapshot excludes starting a Session keeps only the sidebar toggle.
  render(<HeaderLeadingControls {...props} useRemoteAccess={action => action !== 'session/create'} />)
  expect(screen.getByRole('button', { name: en['toggle.open'] })).toBeTruthy()
  expect(screen.queryByRole('button', { name: en['session.new.label'] })).toBeNull()
})

describe('Windows caption tooltips', () => {
  afterEach(() => { document.documentElement.removeAttribute('data-windows-titlebar') })

  const hover = (button: HTMLElement): void => {
    fireEvent.pointerEnter(button)
    act(() => { vi.advanceTimersByTime(500) })
  }

  it.each([false, true])(
    'drops the sidebar toggle bubble below the caption (collapsed=%s)',
    (collapsed) => {
      vi.useFakeTimers()
      document.documentElement.setAttribute('data-windows-titlebar', '')
      mountShell({ collapsed, width: collapsed ? 0 : 300 })
      hover(screen.getByRole('button', { name: collapsed ? 'Open sidebar' : 'Collapse sidebar' }))
      expect(screen.getByRole('tooltip').getAttribute('data-side')).toBe('bottom')
    },
  )

  it('drops the collapsed New Session bubble below the caption as well', () => {
    vi.useFakeTimers()
    document.documentElement.setAttribute('data-windows-titlebar', '')
    mountShell({ collapsed: true, width: 0 })
    hover(screen.getByRole('button', { name: 'New session' }))
    expect(screen.getByRole('tooltip').getAttribute('data-side')).toBe('bottom')
  })

  it('keeps the ordinary Web bubble beside its anchor', () => {
    vi.useFakeTimers()
    mountShell({ collapsed: true, width: 0 })
    hover(screen.getByRole('button', { name: 'Open sidebar' }))
    expect(screen.getByRole('tooltip').getAttribute('data-side')).toBe('right')
  })
})

it('uses the same effective sidebar binding for hover/focus hints and ARIA', () => {
  const shortcut = { id: 'sidebar.left.toggle' as ShortcutCommandId, label: 'Toggle sidebar', aliases: [], binding: null, modified: false, conflicts: [], issue: null, keys: ['⌘', 'B'], aria: 'Meta+B' }
  mountShell({ shortcuts: [shortcut] })
  const toggle = screen.getByRole('button', { name: en['toggle.collapse'] })
  expect(toggle.getAttribute('aria-keyshortcuts')).toBe('Meta+B')
  fireEvent.focus(toggle)
  expect(Array.from(screen.getByRole('tooltip').querySelectorAll('kbd'), key => key.textContent)).toEqual(['⌘', 'B'])
})
