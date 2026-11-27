---
description: "Sidebar shell plugin for the dsh web client: brand row, New Session action, collapse control, scroll-aware region seat, and bottom-pinned Settings seat."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar

English | [中文](README.zh.md)

Desktop product events use the optional [product analytics service](../product-analytics/README.md); ordinary Web interactions are excluded.

## Summary

The dsh web client sidebar lets users recognize the active build, start a new session, collapse navigation to a 56px rail, browse Workspaces and Sessions, and open Settings. It preserves a bottom-pinned Settings entry and hides idle scrollbars without moving browser rows. New Session uses an explicitly selected Workspace, then the current Session's Workspace, then the most recently active Workspace; if none exists, it opens a blank New Session page. Deployments can replace the brand mark or name while retaining the navigation controls and rail geometry.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The sidebar is the navigation shell: users see the brand, start new sessions, collapse the rail, and reach Settings. Feature plugins fill its seats — ui-workspace fills `sidebar.workspaces`, ui-settings registers the trigger row and settings panel at `sidebar.settings`.

Below 768px, without a native Windows caption, the sidebar keeps its expanded content mounted inside the frame's drawer. The drawer initially focuses its collapse toggle, traps keyboard focus, closes with Escape or a mask press, and restores the invoking control unless a foreground dialog remains open. When an open drawer becomes a collapsed rail, focus remaining in its wide content transfers to the rail toggle before that content unmounts. When a collapsed rail becomes a hidden drawer, the sidebar transfers its own focus to its header opener, preserving focus elsewhere and in foreground dialogs. This includes focus in a global menu identified by the original sidebar control's `aria-controls`. Returning from a closed drawer renders the compact rail immediately, without a crossfade. Its toggle tooltip renders outside the drawer. Opening it does not resize the conversation.

### Brand and New Session

When the sidebar is fully hidden, Web shows only the header's sidebar opener. Desktop hosts that mount this header seat also keep New Session; Windows with a native caption keeps its New Session control in that caption instead.

The expanded brand row renders `sidebar.brand.name` as a single slot, and no state seats `sidebar.brand.mark` anymore (FORK rail-icon-only-1124, 2026-11-24 用户指示: the collapsed rail's toggle rests as the Open sidebar panel icon in both states — no whale mark and no hover swap — so the shell never falls back to the fish mark). On Web and Windows desktop, clicking the expanded brand starts a new session; hovering or focusing it shows no tooltip. The brand row's localized local-build label stays dropped (FORK dsh-local). FORK dsh-local (usage glance v2, 2026-10-15): the expanded logo row carries no brand / New Session button — New Session lives in the ⋯ menu (and the rail icon) behind the standing MiMo sign-in row that leads it (FORK mimo-login-cta moved, 2026-10-30 用户指示: the menu's first item is `panels.mimoLogin` — `Sign in to MiMo` / `登录MiMo` — opening the re-login kit's page `/api/mimo-relogin/page` in a new tab, always-on in every balance state), a `sidebar.brand.name` occupant renders ahead of the glance only when it carries content, and `UsageGlance` owns the row: one row PER quota window the host reports among month / week / 5h (FORK usage glance v2.4, 2026-10-22; display order month → week → 5h) — each row is a short window label (`glance.window.*.label`: M / W / 5h; FORK 2026-11-15: zh shows the same English copy), a same-width left-aligned track, and two right-aligned read-out columns (FORK usage glance v2.4.1, 2026-10-22, split on the user's call: the usage percent `33%` beside the day/hour pair `5/31d`, an em dash without a span, fixed column widths on a common right edge): the fill is that window's usage share, a 1px vertical tick marks its continuous time progress (the span is back-derived from `resetsAt` — one month / seven days / five hours before the reset), and the fill segment past the tick paints in the warn color (usage running ahead of the clock, i.e. ahead of pace); month and week read day pairs, the 5-hour window hours; a window the provider does not report (or reports without a percent) drops its whole row and rolling windows never render (no day structure); the three 12px rows stack gapless so the rows plus the button padding land at exactly 40px (the Windows titlebar logo row's height), plus today's and the plan cycle's token usage in their own column to the right — two labeled rows (FORK usage glance v2.3, 2026-10-22), `Today 321.7M` above `Cycle 4.21B`, each a fixed English label (`glance.today.label` / `glance.cycle.label`; FORK 2026-11-15: zh shows the same English copy) beside its compact total summed from the overview's four disjoint buckets; the cycle value sums the trend series over pickWindow's main window (month preferred — the month row's window, re-affirmed when v2.4 split the bars per window; 2026-10-22 ruling: plan cycle, never the calendar month; the cycle start day counts whole, so the reset day carries the previous cycle's pre-reset slice), rendered `≥…` as a floor when `availableDays` proves in-cycle keys fell outside the 30-entry series, with the data-refresh stamp (`26.10.15 21:30`, local time, the instant the overview last loaded successfully) moved into that column's tooltip (the figure column is right-aligned so the unit letters M / B / R sit flush right; a CNY balance figure carries the `R` suffix, 2026-11-15), fed by the dsh-usage host overview (`/api/dsh-usage/overview`, refreshed every 60s while the tab is visible, hidden entirely when the host half serves 404); the control is READ-ONLY (2026-11-26 用户裁定纯只读): it no longer opens Settings — the dsh-usage section moved into Web Extensions, so the old click replay could never land on it, and the footer gear owns opening Settings. FORK usage glance v3 (2026-10-24): a window that also carries the absolute water-line pair (`used`/`limit`; the host now sources OpenCode Go from console `go/status`) fires the switch trigger at `used / limit >= 0.85` — every fired row paints its percent figure in the state-error red, the week/month rows (the A-plan switch windows) additionally paint the fill solid red and append the `glance.trigger.hint` tooltip, the 5-hour row reddens its figure only, and windows without the pair (another provider, or a host before the activating restart) never trigger; the read-out columns stay percent-only per the 2026-10-24 ruling. FORK usage-glance v3 / auto-routing, both source dots fully retired (2026-11-04 用户裁定, superseding the 2026-10-30 "exception-only v2" badge wording and the original 2026-10-25 badge `66b78fb3aa`): the control still reads the auto-routing controller's policy state at `GET /api/auto-route/status` (same origin, same 60s cadence; a 404 — controller not installed — reads as nothing), but the error-red poll dot and the 95–99 dead-zone warn dot are both GONE — usage warnings already speak through the bar colors, the source state speaks through the dimmed Go window rows (triggered phase; the rows stop describing dsh's live spend) plus the button tooltip spelling the switch, and the fork state needs no chrome at all (bar colors suffice); a standing dot is redundant signaling that would dilute real alarms. The ONE surviving exception is a TRANSIENT poll-failure line on the button title (`glance.source.pollError`, hover-revealed, never standing) — a SUSTAINED failure (≥ ~5 min) is taken over by the 安康盾 burning red plus the detail's third section (2026-11-04 ruling: one fact, one alarm surface; blips never flash the shield — 狼来了 discipline); baseline renders the pre-badge layout untouched; the trigger hint carries the double-layer ruling wording (85% warning, 95%/99% auto lines). A complete build stacks a code badge as `version[-commit][-dirty]`, using `DSH_CLIENT_VERSION`, the optional 7-character `DSH_CLIENT_COMMIT_HASH`, and `DSH_CLIENT_GIT_DIRTY=true`; missing version metadata omits the badge. FORK dsh-local (usage glance v2): neither the badge nor its version-reading path survives in the row — build metadata lives in the fork ledger, not the logo row. New Session targets the explicit Workspace used by a scoped action, otherwise the current Session's Workspace, otherwise the most recently active Workspace; when none exists it clears into the blank New Session page. The expanded New Session button displays the effective binding as trailing grey text on hover or keyboard focus. While the shortcut is visible, the centered icon and label fade before it when space is narrow; CSS reserves the shortcut’s width without measuring the button. Icon-only controls retain tooltips with platform-formatted keycaps, including the resident macOS header control when the sidebar is hidden. All controls expose `aria-keyshortcuts`. While the global access snapshot excludes `session/create`, no New Session affordance renders in any state — neither the rail icon, the macOS capsule, nor the window-chrome New Session control — and the Host still decides every create request.

### Global panel entries

Plugins add an icon component to the root-scoped `sidebar.panellist` list with an `id`, optional `order`, and a string or locale-aware `label`. The same id addresses the component registered in the layout's root-scoped `main` keyed slot; selecting a missing main entry throws without changing the current selection. The label supplies plain visible text, the accessible name, and the collapsed tooltip. Expanded navigation rows are 32px high with a 2px gap; collapsed rail controls remain 36px high with a 12px gap. Expanded navigation keeps an 8px bottom margin before the Workspace header. Each row reads its own selected state through `usePanelInfo`; moving DOM focus to search or a directory picker does not change the displayed panel or its selected row. With no panel registrations, neither the list nor spacing for it is rendered. The shipped composition registers no example panel.

A panel may also register non-interactive inline content in the root-scoped `sidebar.panellist.trailing` list with the same `id`, such as a count. It receives `wide` and `active`. The expanded row lays it out after the title, so a row without content keeps its full title width. Where the pointer hovers, the content rests at the row's end, in the place of the unpin action, and gives way to that action while the row is hovered or holds keyboard focus, as a Session row's time gives way to its actions; on a touch device, where the unpin action always shows, the content stays before it. The collapsed rail shows it over the icon's top trailing corner. It renders inside the row button, so it holds no interactive elements; its text becomes the button's accessible description, so decorative parts must be `aria-hidden`.

While the root-scoped `sidebar.panellist.actions` list has registrations, a **More** button styled as a panel row follows the rows inside the navigation landmark; the collapsed rail shows its label as a tooltip. It opens a menu whose rows are that list's registrations. Each receives `entries` (customizable panels in registration order with `id`, `label`, `pinned`, and `active`; Plugins is never listed), `onOpen(id)`, which selects the panel, `onPinnedChange(id, pinned)`, and `onDismiss()`, which closes the menu. The sidebar keeps one in-memory list of unpinned panel ids shared by every Session; Plugins always shows. While More shows, expanded rows other than Plugins show an unpin action on hover or keyboard focus; devices without hover show it continuously. Its resting color matches the Session pin marker, and its tooltip says “Unpin from left sidebar”. Both sidebar and More entries follow the same registration order rather than pin timing. The default More menu lists only unpinned panels before plugin browsing and creation; opening a panel does not pin it, while its separate pin icon returns the row to the sidebar and dismisses the menu. Choices reset when the plugin reloads and legacy localStorage values are ignored. Unpinning hides only the row, and only while More shows; without `sidebar.panellist.actions` registrations every registered row shows again. The main panel, its registration, and the current selection stay unchanged. Unregistered panel ids remain in the in-memory list until the plugin reloads. FORK rail-more-sync-1030 (2026-10-30 用户裁定): the collapsed rail renders no navigation landmark and no per-panel icon column — it anchors the SAME ⋯ menu under its New Session icon, so both states list identical entries (MiMo sign-in, New Session, panel rows, the action rows) through one component; the rail foot no longer renders the `sidebar.more.action` seat either.

### Collapse behavior

The sidebar and conversation-header toggles show the effective shortcut from the command catalog in their hover and keyboard-focus tooltips and `aria-keyshortcuts`. An unbound command shows only the action label.

The top expand button hosts the optional, non-interactive `sidebar.toggle.badge` slot while collapsed. Its occupant supplies status and tooltip content without adding another action or changing the button's navigation behavior.

The root-scoped `sidebar.session.action` HOC layer wraps the New Session row's content: an occupant receives the row's Tooltip and button as `children` and returns them, possibly wrapped, together with its own controls, so it decorates the row without adding a wrapper element. It receives only `wide`, and an occupant that adds nothing must return `children`. Expanded, the controls share the New Session row and the button takes the remaining width; in the rail they stack below its icon. The row renders only while New Session renders, and each occupant still checks its own access.

Expanded content follows the frame's column width, including its transitions. During a live collapse, the content fades out at its frozen expanded width, the upper controls share one fade and leftward translation into the 56px rail, and the layout's column slide ends the motion. A page that starts collapsed renders the rail statically, and reduced-motion mode disables both transitions. The bottom-pinned `sidebar.settings` control shares the fade timing but has no horizontal translation.

On Windows Electron, `html[data-windows-titlebar]` fixes the sidebar toggle in the caption's top-left corner in both states, aligned with New Session's left edge only when expanded. The expanded brand sits below the caption and above New Session, with 8px of extra space above that button. Collapsing hides the brand and sidebar content and places New Session between the sidebar toggle and the Desktop-owned menus. The sidebar sets the root `--dsh-windows-menu-start` to 84px when collapsed; the Desktop preload uses it to position its menu after New Session and defaults to 48px when expanded. Caption icon buttons use centered 16px glyphs in 28px controls with the compact control radius and exclude themselves from the window drag region. The sidebar toggle and New Session bubbles open below the caption, where the Desktop-owned menu text cannot cover them; an occupying `sidebar.toggle.badge` chooses its own bubble side.

### macOS desktop

Under `html[data-platform='darwin']` (set only by the desktop preload) the expanded column opens with a 52px top strip that clears the hiddenInset traffic lights and carries the collapse toggle; the strip and the logo row below each mark themselves `data-window-drag`, so each row's own box is the window's drag region (ui-web base.css declares the one darwin drag rule), and the brand wordmark is not a New Session shortcut there — the dedicated New Session button keeps the action — and collapsing hides the column entirely instead of leaving the rail. The package registers `HeaderLeadingControls` into the frame's `shell.leading` window-chrome seat (ui-layout), which mounts it — the open-sidebar and New Session controls beside the traffic lights — only while the column is hidden, over every main panel. The [Desktop reference](../../../apps/desktop/README.md) owns window integration.

### Scrollbars

Scrollbars in the column are a pointer affordance: the shell rebinds the scrollbar indirection to `transparent` whenever the pointer is outside the column, so a list nobody is pointing at carries no bar. After the pointer leaves, the thumb stays drawn for 500ms and then fades out linearly over 200ms; a pointer that returns before the fade ends redraws it at once, and reduced motion keeps the delay without the fade. Outside is decided by the column's box for every pointer move that reaches the column, so a pointer over the fixed-position Settings panel or a portalled menu outside the box also counts as outside. The reservation that keeps rows from moving belongs to the scrolling region (ui-workspace), so revealing a thumb never reflows.

### Click analytics

On Desktop, the official navigation controls report `sidebar_menu_click` with `menu_name` and `position` before they act. Without the analytics service, the controls only navigate. Selecting a panel by other means reports nothing, and the sidebar reports no exposure events.

- The expanded brand and the New Session button report `menu_name=new_session` with `position=sidebar`. While the Windows caption hosts the collapsed New Session button, that button reports `position=titlebar`; the macOS New Session control beside the traffic lights also reports `position=titlebar`.
- The **Plugins** and **Automation tasks** rows report `menu_name=plugin` and `menu_name=cron` with `position=sidebar`. Other panel rows report nothing.
- Each **More** button click reports `menu_name=more` with `position=sidebar`, whether it opens or closes the menu.
- A More menu row that calls `onOpen(id)` for Plugins or Automation tasks reports `menu_name=plugin` or `menu_name=cron` with `position=sidebar_more`. The shipped More menu calls `onOpen` for unpinned panels, including Automation tasks; pin and unpin actions report no navigation click. The report precedes the registration check, so a request for a panel that has unregistered still counts although nothing is selected.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The shell is pure composition: `SidebarRootComponentProps` composes the layout owner share, the global `useSessions` and `useWorkspaces` hooks, the declared brand, the `sidebar.workspaces` and `sidebar.settings` child slots, and injected navigation callbacks. The sidebar declares the `sidebar.panel.icon` Component Factory, which owns the `sidebar.panellist` list, and the `sidebar.panel.trailing` Component Factory, which owns the `sidebar.panellist.trailing` list; panel rows and the More menu render a panel's registered icon through the first, and panel rows its trailing content through the second. Panel metadata is derived from list registrations and locale changes; selection belongs to the layout store. The injected `trackEntryClick(attributes)` forwards to `ctx.get('productAnalytics')?.track('sidebar_menu_click', attributes)`, and `selectPanel` only selects, so each control supplies its own entry and position.

Expanded navigation uses 8px outer gutters, hover and selected fills inset 3px on each side, and a 16px leading cell with a 6px label gap. New Session centers its content; its row keeps 4px side margins and a 6px bottom margin. Navigation adds a further 4px outside the scrollport and an 8px gap inside it that scrolls away. The logo row has no bottom margin; its content starts 16px from the column's left edge, with 5px between mark and name. Only the macOS non-fullscreen top toggle shifts 4px right while expanded, retaining that offset throughout its fade-out. Collapsed geometry stays independent.

Expanded panel navigation and the `sidebar.workspaces` section share one vertical-only viewport below the fixed brand and New Session controls; footer actions and Settings stay outside it. Horizontal overflow is clipped so toolbar edge offsets do not create a horizontal scrollbar. The viewport hides its own scrollbar and only scrolls the navigation away: the section is at most one viewport tall and scrolls its rows in its own scroller, which draws the only visible scrollbar; a section that fits leaves the viewport nothing to scroll. While expanded, the viewport carries `data-sidebar-scrollport`, a stable marker for tests and integrations. The shell owns the bottom fade.

Scrolling down moves the navigation away before the section scroller moves; scrolling up returns the section scroller to its top before the navigation reappears. A wheel or trackpad gesture whose first event must move the viewport, or starts outside the section scroller, is split between the two in JavaScript until it ends, including its momentum, so one gesture crosses the boundary; wheel events less than 100ms apart count as one gesture. A gesture the section scroller can take alone keeps native scrolling; when an uncancelable native gesture reaches the section scroller's top, the viewport takes the rest. Events another listener already canceled, pinch-zoom (Ctrl), and mostly horizontal wheel events keep native scrolling. Content inside the viewport must not own vertical scrolling unless it cancels its own wheel events. The section receives this capability through `sidebar.workspaces`: each render supplies `hookContext.useSectionScroller`, and the occupant's `useSectionScroller()` returns the same `{ bindScrollerRef }` object for one sidebar. An occupant that binds no scroller keeps native scrolling. The region around the viewport is a size container with the viewport's height, and the viewport is a scroll-state container, so a section scroller can refuse native scrolling until the viewport reaches its end.

Wheel scrolling is unreliable during a native drag, and WebKit and Firefox do not autoscroll the section scroller, so the sidebar scrolls itself during a drag; in Chromium this adds to its native drag autoscroll. While a drag's pointer is within 48px of the top or bottom edge of the section scroller's visible part, or of the viewport without a bound scroller, the two scroll in the same order as wheel scrolling, at up to 1000px per second; the speed rises linearly toward the edge and stays at the maximum past it. Scrolling stops at `drop`, `dragend`, a `dragleave` out of the viewport, or 600ms without `dragover`.

The sidebar root supplies inherited CSS properties to `sidebar.workspaces` and `sidebar.settings`: `--dsh-sidebar-inline-padding: 8px`, `--dsh-sidebar-row-padding: 12px`, `--dsh-sidebar-label-gap: 6px`, and `--dsh-sidebar-paint-inset: 3px`. Occupants consume these values for expanded row alignment; standalone compositions must provide them on an ancestor. The paint inset reduces the fill without moving content: rows subtract it from their inline padding and use it as a transparent border. The expanded viewport hides its own scrollbar; its trailing grid column keeps navigation and the section 8px from the sidebar edge, and the section's scroller places its scrollbar 2px from that edge.

### Slot discipline

Declaration-aware `slots.inject()` lets a replacing package activate before or after the sidebar. The foot is the `sidebar.settings` seat: the sidebar renders only the bottom-pinned layout slot and shares its column state (`wide`). The `/client` exports are the plugin body (`apply`/`inject`) plus the contract types only; SidebarRoot, the row components, and the tree derivation remain package-internal behind the slot registration.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the surfaces that fill the shell's seats and the composition model.

- [ui-workspace](../ui-workspace/README.md) — the Workspace and Session browser rendered into `sidebar.workspaces`.
- [ui-settings](../ui-settings/README.md) — the settings domain base registering the trigger row at `sidebar.settings`.
- [ui-layout](../ui-layout/README.md) — the layout owner whose rail and column state the collapse uses.
- [ui-theme](../ui-theme/README.md) — the scrollbar token indirection the shell rebinds.
- [Slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) — the composition model behind the seats.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the shell owns versus what its occupants own; they are current package constraints.

- **Session state-dot rendering is owned by ui-workspace** — no done/error notification sources are available to this shell.
- **Workspace browser behavior is composition-owned** — grouping, ordering, search, and row state belong to ui-workspace, not this shell.
- **Copying the local-build version is mouse-only** — keyboard activation of the brand starts a session.
- **Only wheel and trackpad input crosses the navigation boundary in one gesture** — touch drags keep native nested scrolling and stop where the viewport reaches its end; browsers without scroll-state container queries scroll the section first. Wheel steps split in JavaScript run on the main thread without smooth-scrolling animation or overscroll bounce.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
