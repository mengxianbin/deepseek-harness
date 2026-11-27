/**
 * Sidebar shell: column geometry and global panel navigation.
 * Collapse is a slide plus crossfade:
 * content freezes at its expanded width (inline style) and fades out in place
 * while the sliding column (AppFrame grid tracks) clips it — nothing reflows
 * mid-slide. At settle the wide-only content unmounts and the upper
 * controls enter the 56px rail from the same horizontal offset (one icon each,
 * same top-down order) on one fade that ends with the slide. The bottom-pinned
 * settings control only fades. The workspace/session browsing region between
 * global panel rows and the foot is the `sidebar.workspaces` registrant's,
 * and the foot holds `sidebar.settings` plus the ⋯ menu; the shell hands them
 * the wide flag (plus an expand request callback for the browser).
 * Low-frequency actions fold into the footer ⋯ menu through
 * `sidebar.more.action` (user ruling sidebar-footer-ui-1026), and the
 * `sidebar.footer.action` seat joins them in the SAME menu (FORK
 * footer-into-more-1031: the update trigger left the foot row). FORK
 * rail-more-sync-1030 (2026-10-30 用户裁定): the collapsed rail hosts the
 * SAME ⋯ menu as the wide foot — its per-panel icon column is gone, and the
 * rail keeps only its New Session icon on top while the ⋯ anchor sits in the
 * rail foot below Settings/Restart (FORK footer-into-more-1031: the anchor
 * moved out of the rail's upper group).
 * Through the browser's hookContext, the shell also hands it the scroller hook
 * that continues wheel scrolling over the sidebar viewport into its list.
 *
 * The column also owns whether the scroll regions nested in it draw a
 * scrollbar at all: the shell tracks the pointer and rebinds ui-theme's
 * scrollbar indirection away while it is elsewhere, so a list the user is not
 * pointing at carries no bar.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import clsx from 'clsx'
import {
  IconAppsAddOutlineRegular, IconEllipsisOutlineRegular, IconNewChatOutlineMedium,
  IconNewChatOutlineRegular, IconPanelLeftOutlineRegular, IconPinFillRegular, IconUserOutlineMedium,
  focusWithoutRing, isBehindModal, isDarwinDesktop, Menu, ShortcutKeys, Tooltip,
  useModalLayer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  SidebarPanelActionsOwnerProps, SidebarPanelMetadata, SidebarRootComponentProps, SidebarRootInjected,
  SidebarSectionHookContext, SidebarSectionOwnerProps,
} from './contract/slots.ts'
import { UsageGlance } from './UsageGlance.tsx'
import { FIXED_PANEL_ID } from './panel-pins.ts'
import { createScrollHandoff } from './scroll-handoff.ts'
import css from './SidebarRoot.module.css'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

type PanelRowProps =
  Pick<SidebarPanelMetadata, 'id' | 'label'>
  & Pick<SidebarSectionOwnerProps, 'wide'>
  & Pick<PropsRuntime<'sidebar'>, 'usePanelInfo'>
  & Pick<InjectFace<SidebarRootInjected>, 'selectPanel' | 'trackEntryClick' | 'setPinned'>
  & { readonly unpinLabel: string; readonly unpinTooltip: string; readonly canUnpin: boolean }
  & PropsRenderFactories

/** Analytics category of an official panel; other panels are never reported. */
function officialEntry(id: string): 'plugin' | 'cron' | undefined {
  if (id === 'plugins') return 'plugin'
  return id === 'schedules' ? 'cron' : undefined
}

type PanelMoreProps =
  Pick<SidebarRootComponentProps, 'usePanelInfo' | 't'>
  & Pick<InjectFace<SidebarRootInjected>, 'selectPanel' | 'startSession' | 'trackEntryClick' | 'setPinned'>
  & Pick<PropsRenderSlots<'sidebar.panellist.actions' | 'sidebar.more.action' | 'sidebar.footer.action'>, 'renderSlot'>
  // The panel glyphs ride the `sidebar.panel.icon` factory (upstream seat):
  // `sidebar.panellist` is no longer a child of the `sidebar` entry, so the
  // menu renders the factory exactly as the rail rows do.
  & PropsRenderFactories
  & { readonly panels: readonly SidebarPanelMetadata[] }
  & { readonly unpinned: readonly string[] }
  & { readonly hasEntryActions: boolean }
  & {
    /** Whether the ⋯-menu action seat has registrants (draws the group separator). */
    readonly hasMoreActions: boolean
  }
  & {
    /**
     * Whether the folded footer-action seat (FORK footer-into-more-1031: it
     * renders here now, not beside Settings) has registrants — it shares the
     * group separator with the more-action seat.
     */
    readonly hasFooterActions: boolean
  }
  & {
    /**
     * Anchor placement: the wide foot row, or the collapsed rail's foot
     * below Settings/Restart (FORK footer-into-more-1031: the anchor left the
     * rail's upper group) — the menu body is identical, only the anchor's
     * row geometry and tooltip side differ.
     */
    readonly rail: boolean
  }

/** Each panel row subscribes only to its own selection state. */
function PanelRow({
  id, label, wide, unpinLabel, unpinTooltip, canUnpin, usePanelInfo, selectPanel, setPinned, trackEntryClick, renderFactorySlot,
}: PanelRowProps) {
  const active = usePanelInfo(info => info.activePanelId === id)
  const trailing = useId()
  return (
    <div className={clsx(css.panelEntry, wide && css.panelEntryWide, active && css.panelEntryActive)}>
      <Tooltip label={label} delayMs={500} disabled={wide}>
        <button
          type="button"
          className={css.panelRow}
          aria-label={label}
          aria-describedby={trailing}
          aria-current={active ? 'page' : undefined}
          onClick={() => {
            const entry = officialEntry(id)
            if (entry !== undefined) trackEntryClick({ menu_name: entry, position: 'sidebar' })
            selectPanel(id)
          }}
        >
          <span className={css.panelGlyph} aria-hidden="true">
            {renderFactorySlot('sidebar.panel.icon', { id, size: wide ? 16 : 18, active })}
          </span>
          {wide && (
            <span className={clsx(css.panelTitle, css.wide)}>
              {label}
            </span>
          )}
          <span id={trailing} className={css.panelTrailing}>{renderFactorySlot('sidebar.panel.trailing', { id, wide, active })}</span>
        </button>
      </Tooltip>
      {wide && canUnpin && <Tooltip label={unpinTooltip} side="bottom" align="end" delayMs={500} portal>
        <button type="button" className={css.panelUnpin} aria-label={unpinLabel} onClick={(event) => {
          // Unpin is rendered only while this navigation also renders More.
          const navigation = event.currentTarget.closest('nav') as HTMLElement
          const more = navigation.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement
          focusWithoutRing(more)
          setPinned(id, false)
        }}>
          <IconPinFillRegular size={14} />
        </button>
      </Tooltip>}
    </div>
  )
}

/** The New Session row's menu id (an action, not a registered main panel). */
const NEW_SESSION_ITEM = 'new-session'

/** The MiMo sign-in row's menu id (an action, not a registered main panel). */
const MIMO_LOGIN_ITEM = 'mimo-login'

/**
 * The re-login kit's page the MiMo sign-in row opens (FORK mimo-login-cta
 * moved here 2026-10-30 用户指示): same-origin relative, mirroring the glance
 * overview route — the kit is served by the same origin that serves this
 * shell.
 */
const MIMO_RELOGIN_PAGE = '/api/mimo-relogin/page'

/**
 * The expanded sidebar's one footer ⋯ menu.
 * FORK dsh-local (sidebar-layout, 2026-10-14): the top rows are reserved for
 * the session list — New Session (round 2: the wide capsule is folded in
 * here as the head row, sessions are opened from a workspace anyway) and the
 * low-frequency global panels (plugins, schedules, task board) live behind
 * this control instead of owning rows above the browsing region. FORK
 * rail-more-sync-1030: the collapsed rail anchors this same menu (its old
 * per-panel icon column is retired), so both states list identical entries;
 * the rail keeps only its New Session icon above the anchor. Panel glyphs
 * still come from each entry's own `sidebar.panellist` registration.
 *
 * rc.3 merge (2026-10-24): upstream's navigation-entry customization lands
 * here instead of a nav-row More launcher — the menu keeps FULL panel
 * reachability (pins filter the rail launchers, never the overflow menu:
 * hiding a panel from the only wide entry point would remove access
 * entirely), reports official-entry clicks as `sidebar_more`, and renders
 * the `sidebar.panellist.actions` registrations (entry-customization's
 * Install/Create plugin rows) after the data rows when any exist.
 *
 * FORK rail-more-sync-1030 (2026-10-30 用户裁定): the collapsed rail renders
 * this SAME menu from its own anchor — the rail's per-panel icon column and
 * foot action rows are retired so both states list identical entries through
 * one component. The menu body is state-independent; only the anchor's
 * placement differs.
 *
 * FORK footer-into-more-1031 (2026-10-31 用户指示): the `sidebar.footer.action`
 * seat (the update trigger) renders its registrants as full-width rows in
 * this menu's action group, ahead of the `sidebar.more.action` rows — it no
 * longer owns a button beside Settings in either column state. The rail
 * anchor also moved out of the rail's upper group into the foot, so the rail
 * reads New Session on top, Settings/Restart/⋯ at the bottom.
 *
 * FORK mimo-login-cta moved (2026-10-30 用户指示): the standing MiMo
 * re-login entry — formerly the balance row's inline `重新登录` link — leads
 * this menu as its first item, renamed `登录MiMo` (`panels.mimoLogin`), and
 * opens `/api/mimo-relogin/page` in a new tab. Always-on survives the move:
 * the item renders in every balance state and before the first load. It
 * reports no analytics (same as the inline link it replaces;
 * `SidebarAnalyticsEntry` carries no login dimension).
 * @param props - panel metadata plus the shell's action/render shares.
 * @returns the ⋯ anchor with its menu.
 */
function PanelMore({
  panels, unpinned, hasEntryActions, hasMoreActions, hasFooterActions, rail,
  usePanelInfo, selectPanel, startSession, setPinned, trackEntryClick, renderSlot, renderFactorySlot, t,
}: PanelMoreProps) {
  const [open, setOpen] = useState(false)
  const activePanelId = usePanelInfo(info => info.activePanelId)
  const onDismiss = (): void => { setOpen(false) }
  return (
    <Menu
      open={open}
      onClose={onDismiss}
      items={[
        // FORK mimo-login-cta moved (2026-10-30): the MiMo sign-in row leads
        // the menu — always-on, no render gate, same-origin page in a new tab.
        { id: MIMO_LOGIN_ITEM, label: t('panels.mimoLogin'), icon: <IconUserOutlineMedium size={16} /> },
        { id: NEW_SESSION_ITEM, label: t('session.new'), icon: <IconNewChatOutlineMedium size={16} /> },
        ...(panels.length > 0
          ? [
            { type: 'separator' as const, id: 'panel-separator' },
            ...panels.map(({ id, label }) => ({
              id,
              label,
              icon: renderFactorySlot('sidebar.panel.icon', { id, size: 16, active: id === activePanelId }),
            })),
          ]
          : []),
        // FORK dsh-local (sidebar-footer-ui-1026): low-frequency foot actions
        // (phone pairing, remote access) fold into this menu as component
        // rows after the data items. FORK footer-into-more-1031: the
        // footer-action seat (the update trigger) joins them in the same
        // group — the separator draws while EITHER action seat has rows.
        ...(hasMoreActions || hasFooterActions
          ? [{ type: 'separator' as const, id: 'more-action-separator' }]
          : []),
      ]}
      selectedIds={activePanelId === null ? [] : [activePanelId]}
      // Icon-labelled rows: the active marker rides the hover fill, a trailing
      // check would crowd the cell beside the glyph.
      selection="fill"
      onSelect={(id) => {
        if (id === MIMO_LOGIN_ITEM) {
          // The re-login kit's page opens externally; no navigation and no
          // analytics (the inline link it replaces reported nothing either).
          window.open(MIMO_RELOGIN_PAGE, '_blank', 'noopener,noreferrer')
        } else if (id === NEW_SESSION_ITEM) {
          trackEntryClick({ menu_name: 'new_session', position: 'sidebar' })
          startSession()
        } else {
          const entry = officialEntry(id)
          if (entry !== undefined) trackEntryClick({ menu_name: entry, position: 'sidebar_more' })
          selectPanel(id as MainPanelId)
        }
        setOpen(false)
      }}
      align="start"
      portal
      dense
      // FORK (sidebar-layout round 3c): the flex item is this anchor WRAPPER
      // span, not the trigger button — the row order must ride it. The rail
      // anchor (rail-more-sync-1030) swaps the foot-row order pin for the
      // rail stack's own geometry (SidebarRoot.module.css .panelMoreSlot).
      className={clsx(css.panelMoreSlot, rail && css.panelMoreRail)}
      anchor={(
        <Tooltip label={t('panels.more')} delayMs={500} {...(rail ? { side: 'right' as const } : {})}>
          <button
            type="button"
            className={clsx(css.iconButton, css.panelMore)}
            aria-label={t('panels.more')}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => {
              trackEntryClick({ menu_name: 'more', position: 'sidebar' })
              setOpen(v => !v)
            }}
          >
            <IconEllipsisOutlineRegular />
          </button>
        </Tooltip>
      )}
    >
      {hasEntryActions && renderSlot('sidebar.panellist.actions', {
        entries: panels.filter(({ id }) => id !== FIXED_PANEL_ID)
          .map(({ id, label }) => ({ id, label, pinned: !unpinned.includes(id), active: id === activePanelId })),
        onOpen: (id) => {
          const entry = officialEntry(id)
          if (entry !== undefined) trackEntryClick({ menu_name: entry, position: 'sidebar_more' })
          const panel = panels.find(candidate => candidate.id === id)
          if (panel !== undefined) selectPanel(panel.id)
          setOpen(false)
        },
        onPinnedChange: setPinned,
        onDismiss,
      })}
      {(hasMoreActions || hasFooterActions) && (
        <div className={css.moreActions}>
          {/* FORK footer-into-more-1031: the footer-action seat (the update
              trigger) renders as menu rows here, ahead of the more-action
              rows — both share the full-width row styling. */}
          {hasFooterActions && renderSlot('sidebar.footer.action', { wide: true })}
          {renderSlot('sidebar.more.action', { wide: true })}
        </div>
      )}
    </Menu>
  )
}

type PanelMoreMenuProps =
  Pick<SidebarSectionOwnerProps, 'wide'>
  & Omit<SidebarPanelActionsOwnerProps, 'onDismiss'>
  & PropsRenderSlots<'sidebar.panellist.actions'>
  & Pick<InjectFace<SidebarRootInjected>, 'trackEntryClick'>
  & { readonly label: string }

/** The panel list's More launcher: a panel-row button whose menu rows come from `sidebar.panellist.actions`. */
function PanelMoreMenu({ wide, label, entries, onOpen, onPinnedChange, trackEntryClick, renderSlot }: PanelMoreMenuProps) {
  const [open, setOpen] = useState(false)
  const onDismiss = (): void => { setOpen(false) }
  return (
    <Menu open={open} onClose={onDismiss} portal autoFocus className={css.moreAnchor} listClassName={css.moreMenu}
      anchor={(
        <Tooltip label={label} delayMs={500} disabled={wide}>
          <button type="button" className={css.panelRow} aria-label={label} aria-haspopup="menu" aria-expanded={open}
            onClick={() => {
              trackEntryClick({ menu_name: 'more', position: 'sidebar' })
              setOpen(value => !value)
            }}>
            <span className={css.panelGlyph} aria-hidden="true"><IconAppsAddOutlineRegular size={wide ? 16 : 18} /></span>
            {wide && <span className={clsx(css.panelTitle, css.wide)}>{label}</span>}
          </button>
        </Tooltip>
      )}>
      {renderSlot('sidebar.panellist.actions', { entries, onOpen, onPinnedChange, onDismiss })}
    </Menu>
  )
}

/**
 * Render the sidebar column shell.
 * @param props - composed slot props (runtime share + injected callbacks, contract/slots.ts).
 * @returns the sidebar element tree.
 */
export function SidebarRoot({
  collapsed,
  width,
  drawer,
  startSession,
  toggleSidebar,
  selectPanel,
  setPinned,
  trackEntryClick,
  useRemoteAccess,
  usePanels,
  useEntryPins,
  useEntryActions,
  useMoreActions,
  useFooterActions,
  useShortcuts,
  usePanelInfo,
  t,
  renderSlot,
  renderFactorySlot,
}: SidebarRootComponentProps) {
  const panels = usePanels(snapshot => snapshot)
  const unpinned = useEntryPins(ids => ids)
  const hasEntryActions = useEntryActions(registered => registered)
  const activePanelId = usePanelInfo(info => info.activePanelId)
  const moreActions = useMoreActions(snapshot => snapshot)
  const footerActions = useFooterActions(snapshot => snapshot)
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'sidebar.left.toggle'))
  const newShortcut = useShortcuts(rows => rows.find(row => row.id === 'session.new'))
  // A page whose access snapshot excludes starting a Session offers no New Session affordance.
  const canStartSession = useRemoteAccess('session/create')
  const toggleLabel = collapsed ? t('toggle.open') : t('toggle.collapse')
  // Wide content stays mounted while the collapse animates (fading via
  // .collapsed .wide), unmounts at settle, and remounts right away on expand.
  // A closed drawer retains its content with the rail phase already settled.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (drawer || !collapsed) { setSettled(collapsed); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed, drawer])
  const windowsTitlebar = document.documentElement.hasAttribute('data-windows-titlebar')
  const wide = drawer || (windowsTitlebar ? !collapsed : !collapsed || !settled)
  const [scrollHandoff] = useState(createScrollHandoff)
  const sectionHookContext = useMemo<SidebarSectionHookContext>(
    () => ({ useSectionScroller: scrollHandoff.useSectionScroller }), [scrollHandoff],
  )
  // The Windows titlebar hosts the New Session controls while the sidebar is collapsed.
  // New Session reports a sidebar click first; the collapsed rail icon is the
  // only starter outside the Windows caption.
  const openNewSession = (): void => {
    trackEntryClick({ menu_name: 'new_session', position: 'sidebar' })
    startSession()
  }
  // The Windows caption menus occupy the strip to the right of these controls
  // (that is what --dsh-windows-menu-start reserves), so a right-side bubble
  // lands under their text. Below the caption is the only clear side.
  const captionTooltipSide = windowsTitlebar ? 'bottom' : 'right'
  // Freeze the content at its expanded width while it fades out (collapsed
  // && wide): the sliding column then clips it instead of reflowing it. The
  // rail layout (.collapsed styles) only applies once the fade settles.
  const lastWideWidth = useRef(width)
  if (drawer || !collapsed) lastWideWidth.current = width

  // A closed drawer returns to the static rail; only a live collapse fades it in.
  const animateRail = useRef(!collapsed)
  if (drawer || !collapsed) animateRail.current = !collapsed

  // Scrollbars in the column follow the pointer: .quietBars rebinds them away
  // whenever the pointer is outside, and its stylesheet owns the delay and
  // fade, so a pointer that returns before the fade starts sees no change.
  const column = useRef<HTMLDivElement>(null)
  const sidebarFocus = useRef<Element | null>(null)
  useModalLayer(column, drawer && !collapsed, toggleSidebar)
  useLayoutEffect(() => {
    if (!collapsed) return
    const controlled = sidebarFocus.current?.getAttribute('aria-controls')?.split(/\s+/) ?? []
    const ownsMenuFocus = controlled.some(id => document.getElementById(id)?.contains(document.activeElement))
    if (sidebarFocus.current !== document.activeElement && !ownsMenuFocus) return
    const opener = drawer
      ? column.current?.ownerDocument.querySelector<HTMLElement>('[data-sidebar-opener]')
      : column.current?.querySelector<HTMLElement>('[data-sidebar-toggle]')
    if (opener != null && !isBehindModal(opener)) focusWithoutRing(opener, { preventScroll: true })
  }, [drawer, collapsed])
  const [pointerInside, setPointerInside] = useState(false)
  // Inside is decided by the column's BOX, not by DOM containment, for every
  // pointer move that reaches the column. ui-settings renders its
  // full-viewport panel as a fixed-position DESCENDANT of this column, and the
  // column's menus and tooltips are React portals, so a pointer over them
  // fires no `pointerleave` here while their moves still bubble to it. The
  // element's own leave stays as the one signal geometry cannot give: a
  // pointer that leaves the window emits no further moves.
  const trackPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    setPointerInside(event.clientX >= rect.left && event.clientX < rect.right
      && event.clientY >= rect.top && event.clientY < rect.bottom)
  }

  const darwinDesktop = isDarwinDesktop()
  // Both states rest as the plain panel icon (FORK rail-icon-only-1124,
  // 2026-11-24 用户指示): the collapsed rail never rests as the whale mark
  // and no longer swaps it in on hover — the expand affordance is the
  // resting face.
  const toggle = (
    <Tooltip label={toggleLabel} shortcutKeys={shortcut?.keys} delayMs={500} side={captionTooltipSide} portal={drawer}>
      <button
        data-sidebar-toggle
        data-modal-autofocus={drawer || undefined}
        type="button"
        className={clsx(css.iconButton, css.toggle)}
        aria-label={toggleLabel}
        aria-keyshortcuts={shortcut?.aria}
        onClick={() => { toggleSidebar() }}
      >
        {/* Rail icons render at 18 (figma rail spec); expanded keeps the glyph-native sizes. */}
        <IconPanelLeftOutlineRegular className={css.panelIcon} size={wide || windowsTitlebar ? 16 : 18} />
        {!wide && renderSlot('sidebar.toggle.badge', {})}
      </button>
    </Tooltip>
  )

  return (
    <div
      ref={column}
      onFocusCapture={(event) => { sidebarFocus.current = event.target }}
      role={drawer ? 'dialog' : undefined}
      data-shortcut-modal={drawer ? 'sidebar' : undefined}
      aria-modal={drawer && !collapsed ? true : undefined}
      aria-label={drawer ? t('navigation.label') : undefined}
      tabIndex={drawer ? -1 : undefined}
      className={clsx(
        css.root, !wide && css.collapsed, !wide && animateRail.current && css.railIn,
        !drawer && collapsed && wide && css.fading, !pointerInside && css.quietBars,
      )}
      style={wide ? { width: !drawer && collapsed ? lastWideWidth.current : width } : undefined}
      onPointerEnter={trackPointer}
      onPointerMove={trackPointer}
      onPointerLeave={() => { setPointerInside(false) }}
    >
      {/* macOS hiddenInset titlebar: the strip shares the row with the
          traffic lights and keeps the toggle at the sidebar's top-right. */}
      {darwinDesktop && <div className={css.topStrip} data-window-drag>{toggle}</div>}
      <div className={css.logoRow} data-window-drag>
        {/* FORK dsh-local (usage glance v2, 2026-10-15): the wide logo row no
            longer carries a brand / New Session button — New Session lives in
            the ⋯ menu head row (and the rail icon), and the row belongs to the
            usage glance plus the panel toggle. v2.1: the glance LEADS the row —
            an occupant that renders an empty `sidebar.brand.name` div must not
            push it right of that dead seat; a real occupant renders after it.
            The collapsed rail keeps its plain panel-icon toggle (FORK
            rail-icon-only-1124: no whale resting face). */}
        {/* Expanded, the brand doubles as a New Session shortcut while the
            access snapshot allows `session/create` — except on
            macOS, where it stays part of the logo row's window-drag surface
            (the drag-row controls rule would subtract a button);
            the collapsed rail's logo is the expand toggle below instead.
            Mouse clicks on the local-build fallbacks copy the version instead. */}
        {wide && (() => {
          const brandName = renderSlot('sidebar.brand.name', {}, { fallback: null })
          return (
            <>
              <UsageGlance t={t} />
              {brandName === null || brandName === undefined
                ? null
                : <span className={css.brandName} aria-hidden="true">{brandName}</span>}
            </>
          )
        })()}
        {!darwinDesktop && toggle}
      </div>

      {/* The label fades before the hover/focus shortcut, including on translucent backgrounds.
          FORK dsh-local (sidebar-layout round 2): the wide non-darwin capsule is folded into
          the footer ⋯ menu (head row) — sessions are opened from a workspace anyway; macOS
          keeps its capsule (its wordmark is window-drag surface, not a button), and the rail
          keeps its icon. Upstream rc: the access snapshot gates the control — no
          `session/create`, no New Session affordance in either state. */}
      {canStartSession && (!wide || darwinDesktop) && (
        <Tooltip label={t('session.new.label')} shortcutKeys={newShortcut?.keys} delayMs={500} side={captionTooltipSide} disabled={wide}>
          <button
            type="button"
            className={css.newSession}
            aria-label={t('session.new.label')}
            aria-keyshortcuts={newShortcut?.aria}
            onClick={openNewSession}
          >
            <span className={css.newSessionLabelMask}><span className={css.newSessionContent}>
              {wide
                ? <IconNewChatOutlineMedium size={14} />
                : <IconNewChatOutlineRegular size={windowsTitlebar ? 16 : 18} />}
              {wide && <span className={clsx(css.newSessionLabel, css.wide)}>{t('session.new')}</span>}
            </span></span>
            {wide && newShortcut !== undefined && newShortcut.keys.length > 0 && <span className={css.newSessionShortcut} aria-hidden="true">
              <ShortcutKeys keys={newShortcut.keys} />
            </span>}
          </button>
        </Tooltip>
      )}
      {/* FORK footer-into-more-1031 (2026-10-31 用户指示): the rail's ⋯
          anchor left the upper group — the rail top now carries only New
          Session, and the anchor sits in the foot below Settings/Restart.
          It hosts the SAME menu the wide foot renders, so both states list
          identical entries through one component. */}

      <div className={css.scrollRegion}>
        <div
          ref={scrollHandoff.bindViewportRef}
          className={css.scrollArea}
          data-sidebar-scrollport={wide ? '' : undefined}
        >
          {panels.length > 0 && (
            <nav className={css.panelList} aria-label={t('panels.label')}>
              {panels.filter(({ id }) => id === FIXED_PANEL_ID || !hasEntryActions || !unpinned.includes(id)).map(({ id, label }) => (
                <PanelRow
                  key={id}
                  id={id}
                  label={label}
                  wide={wide}
                  unpinLabel={t('panels.unpin', { name: label })}
                  unpinTooltip={t('panels.unpinTooltip')}
                  canUnpin={hasEntryActions && id !== FIXED_PANEL_ID}
                  setPinned={setPinned}
                  usePanelInfo={usePanelInfo}
                  selectPanel={selectPanel}
                  trackEntryClick={trackEntryClick}
                  renderFactorySlot={renderFactorySlot}
                />
              ))}
              {hasEntryActions && (
                <PanelMoreMenu
                  wide={wide}
                  label={t('panels.more')}
                  entries={panels.filter(({ id }) => id !== FIXED_PANEL_ID)
                    .map(({ id, label }) => ({ id, label, pinned: !unpinned.includes(id), active: id === activePanelId }))}
                  onOpen={(id) => {
                    const entry = officialEntry(id)
                    if (entry !== undefined) trackEntryClick({ menu_name: entry, position: 'sidebar_more' })
                    const panel = panels.find(candidate => candidate.id === id)
                    if (panel !== undefined) selectPanel(panel.id)
                  }}
                  onPinnedChange={setPinned}
                  trackEntryClick={trackEntryClick}
                  renderSlot={renderSlot}
                />
              )}
            </nav>
          )}
          <div className={css.regionArea}>
            {renderSlot('sidebar.workspaces', {
              wide,
              expandSidebar: () => { if (collapsed) toggleSidebar() },
            }, { hookContext: sectionHookContext })}
          </div>
        </div>
        <span className={css.scrollFade} aria-hidden="true" />
      </div>

      {/* FORK dsh-local (sidebar-layout round 3): the wide foot is ONE row —
          Settings, then the ⋯ menu (user ruling order, sidebar-footer-ui-1026).
          The dsh-usage glance card is removed (usage-glance ruling,
          2026-10-15): the plan cycle pair now lives in the logo row beside the
          whale mark (UsageGlance), so nothing injects above this row.
          FORK footer-into-more-1031 (2026-10-31 用户指示): the
          footer-action seat (the update trigger) left BOTH feet — it renders
          as rows inside the ⋯ menu; the rail foot is Settings/Restart then
          the ⋯ anchor, in that order. */}
      <div className={css.footArea}>
        {wide
          ? (
            <div className={css.footRow}>
              <div className={css.settingsArea}>
                {renderSlot('sidebar.settings', { wide })}
              </div>
              <PanelMore
                panels={panels}
                unpinned={unpinned}
                hasEntryActions={hasEntryActions}
                hasMoreActions={moreActions.length > 0}
                hasFooterActions={footerActions.length > 0}
                rail={false}
                usePanelInfo={usePanelInfo}
                selectPanel={selectPanel}
                startSession={startSession}
                setPinned={setPinned}
                trackEntryClick={trackEntryClick}
                renderSlot={renderSlot}
                renderFactorySlot={renderFactorySlot}
                t={t}
              />
            </div>
          )
          : (
            <>
              <div className={css.settingsArea}>
                {renderSlot('sidebar.settings', { wide })}
              </div>
              <PanelMore
                panels={panels}
                unpinned={unpinned}
                hasEntryActions={hasEntryActions}
                hasMoreActions={moreActions.length > 0}
                hasFooterActions={footerActions.length > 0}
                rail
                usePanelInfo={usePanelInfo}
                selectPanel={selectPanel}
                startSession={startSession}
                setPinned={setPinned}
                trackEntryClick={trackEntryClick}
                renderSlot={renderSlot}
                renderFactorySlot={renderFactorySlot}
                t={t}
              />
            </>
          )}
      </div>
    </div>
  )
}
