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
 * and the foot holds `sidebar.settings` plus `sidebar.footer.action`; the shell
 * hands them the wide flag (plus an expand request callback for the browser).
 * Low-frequency actions fold into the footer ⋯ menu through
 * `sidebar.more.action` (user ruling sidebar-footer-ui-1026). FORK
 * rail-more-sync-1030 (2026-10-30 用户裁定): the collapsed rail hosts the
 * SAME ⋯ menu as the wide foot — its per-panel icon column and its foot's
 * action rows are gone, so the rail mirrors the wide layout's folded entries
 * instead of outlisting them (the rail keeps only its New Session icon on top
 * of the menu anchor).
 *
 * The column also owns whether the scroll regions nested in it draw a
 * scrollbar at all: the shell tracks the pointer and rebinds ui-theme's
 * scrollbar indirection away while it is elsewhere, so a list the user is not
 * pointing at carries no bar.
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  FishLogo, IconEllipsisOutlineRegular, IconNewChatOutlineMedium, IconNewChatOutlineRegular,
  IconPanelLeftOutlineRegular, IconUserOutlineMedium, isDarwinDesktop, Menu, ShortcutKeys, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  SidebarPanelMetadata, SidebarRootComponentProps, SidebarRootInjected,
} from './contract/slots.ts'
import { UsageGlance } from './UsageGlance.tsx'
import { FIXED_PANEL_ID } from './panel-pins.ts'
import css from './SidebarRoot.module.css'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/**
 * How long the column's scrollbars stay drawn after the pointer leaves it.
 * The bar is a pointer affordance here, and hiding it on the leave event
 * itself makes it blink out while the pointer is only crossing the column's
 * edge — on the way to the conversation, or around a portalled menu.
 */
const SCROLLBAR_LINGER_MS = 2000

/** Analytics category of an official panel; other panels are never reported. */
function officialEntry(id: string): 'plugin' | 'cron' | undefined {
  if (id === 'plugins') return 'plugin'
  return id === 'schedules' ? 'cron' : undefined
}

type PanelMoreProps =
  Pick<SidebarRootComponentProps, 'usePanelInfo' | 't'>
  & Pick<InjectFace<SidebarRootInjected>, 'selectPanel' | 'startSession' | 'trackEntryClick' | 'setPinned'>
  & Pick<PropsRenderSlots<'sidebar.panellist' | 'sidebar.panellist.actions' | 'sidebar.more.action'>, 'renderSlot'>
  & { readonly panels: readonly SidebarPanelMetadata[] }
  & { readonly unpinned: readonly string[] }
  & { readonly hasEntryActions: boolean }
  & {
    /** Whether the ⋯-menu action seat has registrants (draws the group separator). */
    readonly hasMoreActions: boolean
  }
  & {
    /**
     * Anchor placement: the wide foot row, or the collapsed rail's top seat
     * (FORK rail-more-sync-1030) — the menu body is identical, only the
     * anchor's row geometry and tooltip side differ.
     */
    readonly rail: boolean
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
 * this SAME menu from its own anchor (rail top, under New Session) — the
 * rail's per-panel icon column and foot action rows are retired so both
 * states list identical entries through one component. The menu body is
 * state-independent; only the anchor's placement differs.
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
  panels, unpinned, hasEntryActions, hasMoreActions, rail,
  usePanelInfo, selectPanel, startSession, setPinned, trackEntryClick, renderSlot, t,
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
              icon: renderSlot('sidebar.panellist', { size: 16, active: id === activePanelId }, { only: id }),
            })),
          ]
          : []),
        // FORK dsh-local (sidebar-footer-ui-1026): low-frequency foot actions
        // (phone pairing, remote access) fold into this menu as component
        // rows after the data items; the separator only draws while the seat
        // actually has registrants.
        ...(hasMoreActions
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
      {hasMoreActions && (
        <div className={css.moreActions}>
          {renderSlot('sidebar.more.action', { wide: true })}
        </div>
      )}
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
  useShortcuts,
  usePanelInfo,
  t,
  renderSlot,
}: SidebarRootComponentProps) {
  const panels = usePanels(snapshot => snapshot)
  const unpinned = useEntryPins(ids => ids)
  const hasEntryActions = useEntryActions(registered => registered)
  const moreActions = useMoreActions(snapshot => snapshot)
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'sidebar.left.toggle'))
  const newShortcut = useShortcuts(rows => rows.find(row => row.id === 'session.new'))
  // A page whose access snapshot excludes starting a Session offers no New Session affordance.
  const canStartSession = useRemoteAccess('session/create')
  const toggleLabel = collapsed ? t('toggle.open') : t('toggle.collapse')
  // Wide content stays mounted while the collapse animates (fading via
  // .collapsed .wide), unmounts at settle, and remounts right away on expand.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const windowsTitlebar = document.documentElement.hasAttribute('data-windows-titlebar')
  const wide = windowsTitlebar ? !collapsed : !collapsed || !settled
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
  if (!collapsed) lastWideWidth.current = width

  // Rail-in only crossfades a live collapse: a refresh straight into the
  // collapsed state renders the rail statically (no delay-hidden icons).
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true

  // Scrollbars in the column follow the pointer (.quietBars rebinds them
  // away): drawn while it is inside, and for SCROLLBAR_LINGER_MS after it
  // leaves. A pointer that returns within that window cancels the pending
  // hide rather than restarting from a hidden bar.
  const column = useRef<HTMLDivElement>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }
  // Leaving is decided by the column's BOX, not by DOM containment, and only
  // while the bars are drawn. ui-settings renders its full-viewport panel as a
  // fixed-position DESCENDANT of this column, so a pointer moved onto that
  // panel — or onto the conversation once it closes — fires no `pointerleave`
  // here, and the bars would stay drawn over a column nobody is pointing at.
  // The element's own leave stays as the one signal geometry cannot give: a
  // pointer that leaves the window emits no further moves.
  useEffect(() => {
    if (!pointerInside) return
    const onMove = (event: PointerEvent): void => {
      const rect = column.current?.getBoundingClientRect()
      /* v8 ignore next -- the listener only exists while the column is mounted and revealed. */
      if (rect === undefined) return
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      if (inside) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside])

  const darwinDesktop = isDarwinDesktop()
  // Rail resting state is the whale mark; hovering swaps in the panel icon
  // (the expand affordance, figma sidebar-hover flow). Expanded it is a plain
  // panel icon.
  const toggle = (
    <Tooltip label={toggleLabel} shortcutKeys={shortcut?.keys} delayMs={500} side={captionTooltipSide}>
      <button
        type="button"
        className={clsx(css.iconButton, css.toggle)}
        aria-label={toggleLabel}
        aria-keyshortcuts={shortcut?.aria}
        onClick={() => { toggleSidebar() }}
      >
        {!wide && !windowsTitlebar && (
          <span className={css.railMark} aria-hidden="true">
            {renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: <FishLogo size={24} /> })}
          </span>
        )}
        {/* Rail icons render at 18 (figma rail spec); expanded keeps the glyph-native sizes. */}
        <IconPanelLeftOutlineRegular className={css.panelIcon} size={wide || windowsTitlebar ? 16 : 18} />
        {!wide && renderSlot('sidebar.toggle.badge', {})}
      </button>
    </Tooltip>
  )

  return (
    <div
      ref={column}
      className={clsx(
        css.root, !wide && css.collapsed, !wide && everWide.current && css.railIn,
        collapsed && wide && css.fading, !pointerInside && css.quietBars,
      )}
      style={wide ? { width: collapsed ? lastWideWidth.current : width } : undefined}
      onPointerEnter={() => {
        cancelLinger()
        setPointerInside(true)
      }}
      onPointerLeave={() => { armLinger() }}
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
            The collapsed rail keeps its whale-mark toggle. */}
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
      {/* FORK rail-more-sync-1030 (2026-10-30 用户裁定): the rail's per-panel
          icon column is RETIRED — the rail anchors the same ⋯ menu the wide
          foot renders, so both states list identical entries through one
          component. rc.3 pins had already stopped filtering this launcher;
          with the column gone the pin list no longer shapes any rail
          surface. */}
      {!wide && (
        <PanelMore
          panels={panels}
          unpinned={unpinned}
          hasEntryActions={hasEntryActions}
          hasMoreActions={moreActions.length > 0}
          rail
          usePanelInfo={usePanelInfo}
          selectPanel={selectPanel}
          startSession={startSession}
          setPinned={setPinned}
          trackEntryClick={trackEntryClick}
          renderSlot={renderSlot}
          t={t}
        />
      )}

      {/* The browsing region fills the column between the controls and the
          foot in both states; its rail icon column rides the same slot. */}
      <div className={css.regionArea}>
        {renderSlot('sidebar.workspaces', {
          wide,
          expandSidebar: () => { if (collapsed) toggleSidebar() },
        })}
      </div>

      {/* FORK dsh-local (sidebar-layout round 3): the wide foot is ONE row —
          Settings, the footer actions, then the ⋯ menu (user ruling order,
          sidebar-footer-ui-1026: ⋯ sits right of the update badge; phone
          pairing + remote access moved INTO the ⋯ menu). The dsh-usage glance
          card is removed (usage-glance ruling, 2026-10-15): the plan cycle
          pair now lives in the logo row beside the whale mark (UsageGlance),
          so nothing injects above this row. FORK rail-more-sync-1030: the
          rail foot no longer renders the ⋯-menu action seat either — the
          rail's ⋯ anchor (top) hosts those rows in its menu, same as wide. */}
      <div className={css.footArea}>
        {wide
          ? (
            <div className={css.footRow}>
              <div className={css.settingsArea}>
                {renderSlot('sidebar.settings', { wide })}
              </div>
              <div className={css.footerActions}>
                {renderSlot('sidebar.footer.action', { wide })}
              </div>
              <PanelMore
                panels={panels}
                unpinned={unpinned}
                hasEntryActions={hasEntryActions}
                hasMoreActions={moreActions.length > 0}
                rail={false}
                usePanelInfo={usePanelInfo}
                selectPanel={selectPanel}
                startSession={startSession}
                setPinned={setPinned}
                trackEntryClick={trackEntryClick}
                renderSlot={renderSlot}
                t={t}
              />
            </div>
          )
          : (
            <>
              <div className={css.footerActions}>
                {renderSlot('sidebar.footer.action', { wide })}
              </div>
              <div className={css.settingsArea}>
                {renderSlot('sidebar.settings', { wide })}
              </div>
            </>
          )}
      </div>
    </div>
  )
}
