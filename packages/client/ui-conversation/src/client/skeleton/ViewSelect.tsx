/** The session-header view dropdown: the retired tab row's replacement in the actions seat. */

import { useState } from 'react'
import {
  Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, Menu, MenuItemButton,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationStore } from '../contract/slots.ts'
import type { ViewTab } from '../contract/views.ts'
import { resolveActiveView } from '../view-selection.ts'
import { FIXED_VIEW_ID } from '../view-pins.ts'
import css from './ConversationRoot.module.css'

/** Registration-side business face of the view dropdown. */
export interface ViewSelectInjected {
  hooks: {
    /** Package-owned View roster, bound by the renderer as useConversationViews. */
    readonly conversationViews: ObservableSnapshot<readonly ViewTab[]>
  }
  /** Select a Session View and persist it as this Session's preference. */
  selectView: (view: string) => void
}

/** Full props for the session-header view-select action. */
export type ViewSelectProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsStore<ConversationStore>
  & InjectFace<ViewSelectInjected>

/** Chat leads the menu; every other View keeps its registration order. */
function menuOrder(views: readonly ViewTab[]): readonly ViewTab[] {
  return [
    ...views.filter(view => view.id === FIXED_VIEW_ID),
    ...views.filter(view => view.id !== FIXED_VIEW_ID),
  ]
}

/**
 * Render the labeled view-switcher trigger and its menu. The trigger names the
 * current View; the menu lists every registered View with the current one
 * marked, then the header-owned view-actions rows when any are registered.
 * @param props - Standard Session props, the store share, the owner rows, and the injected view services.
 * @returns the trigger, or nothing while no View is registered.
 */
export function ViewSelect({
  useConversationViews, useStore, selectView, renderViewsActions,
}: ViewSelectProps) {
  const views = useConversationViews(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(views, selectedId)
  const [open, setOpen] = useState(false)
  const close = (): void => { setOpen(false) }
  if (views.length === 0) return null
  return (
    <Menu open={open} onClose={close} portal autoFocus
      className={css.viewSelectAnchor} listClassName={css.viewSelectMenu}
      anchor={(
        <Button size="sm" className={css.viewSelect} data-conversation-view-select=""
          aria-haspopup="menu" aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}>
          <span className={css.viewSelectLabel}>{active?.label ?? ''}</span>
          <IconChevronDownOutlineRegular size={12} className={css.viewSelectCaret} />
        </Button>
      )}>
      {menuOrder(views).map((view) => {
        const current = view.id === active?.id
        return (
          <MenuItemButton key={view.id} current={current}
            onSelect={() => { close(); selectView(view.id) }}>
            <span className={css.viewSelectRow}>
              <span>{view.label}</span>
              {current && <IconCheckOutlineRegular size={16} className={css.viewSelectCheck} />}
            </span>
          </MenuItemButton>
        )
      })}
      {renderViewsActions?.(close)}
    </Menu>
  )
}
