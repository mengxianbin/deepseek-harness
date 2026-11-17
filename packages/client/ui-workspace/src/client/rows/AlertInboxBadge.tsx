/**
 * The alert-inbox envelope badge (设计档 `session-revival-v2-alert-inbox-1116.md`
 * §七 盾旁信封徽标, alert-inbox-signal-face-1116): the 工作区 section header's
 * sibling seat AFTER the 安康盾 — two dimensions, two seats (盾灯 = mechanism
 * health, 信封 = pending alert entries), never competing for one slot.
 *
 * Signal face ONLY (§七 分工: 盾灯解决信号问题，不负责行动面 — same for the
 * envelope): it renders the counts the session-controller fold published on
 * the health frame (`report.alertInbox` — 徽标数 = unread 计数 = 未处理数, the
 * 机检 对账基准) and does nothing else — no click action, no popover, and ⛔
 * never the `question` attention kind (it feeds health's `awaiting` count:
 * lighting it would collide semantically AND inflate the metric).
 *
 * State rides `data-alert-inbox-state` and only changes color when abnormal
 * (同构 with the shield): plane not attached (neither document exists) → no
 * seat at all (面消失 ≠ 面变坏, optional plane); attached with zero pending →
 * the quiet white envelope; unread > 0 → red with the count; escalated
 * entries keep it red and add the 超时 wording (不消失反升红).
 */
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseSessionHealth } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import css from './AlertInboxBadge.module.css'

type AlertInboxBadgeProps = {
  /**
   * The ui-session health hook (global standard prop), threaded as a slot
   * with `undefined` in it (exactOptionalPropertyTypes rejects an explicitly
   * undefined optional): absent in compositions without ui-session's root
   * props — the seat renders nothing, like HealthShield.
   */
  useSessionHealth: UseSessionHealth | undefined
  t: WorkspaceBrowserProps['t']
}

/**
 * Render the envelope badge beside the shield.
 * @param props - the health hook plus the sidebar locale seat.
 * @returns the badge element tree, or null without a health source or an
 *   attached inbox plane (quiet absence, never a broken render).
 */
export function AlertInboxBadge({ useSessionHealth, t }: AlertInboxBadgeProps) {
  const health = useSessionHealth?.(value => value)
  if (health === undefined) return null
  const inbox = health.report?.alertInbox
  if (inbox === undefined) return null
  const unread = inbox.unread
  const escalated = inbox.escalated
  const pending = unread > 0
  const label = !pending
    ? t('alertInbox.clear')
    : escalated > 0
      ? t('alertInbox.escalated').replace('{n}', String(unread)).replace('{m}', String(escalated))
      : t('alertInbox.unread').replace('{n}', String(unread))
  return (
    <span
      className={clsx(css.badge, pending ? css.pending : css.quiet)}
      data-alert-inbox-state={pending ? (escalated > 0 ? 'escalated' : 'unread') : 'clear'}
    >
      <Tooltip label={label} delayMs={500}>
        {/* Signal-only seat: a span with an accessible name, never a button —
            there is no action here to invite (行动面 = 追查会话, not this). */}
        <span className={css.glyph} role="img" aria-label={label}>
          <svg
            className={css.envelope}
            viewBox="0 0 16 16"
            width="16"
            height="16"
            aria-hidden="true"
            focusable="false"
          >
            <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" />
            <path d="M2.5 4.5 8 8.75 13.5 4.5" />
          </svg>
          {pending && (
            <span className={css.count} data-alert-inbox-count="">{unread}</span>
          )}
        </span>
      </Tooltip>
    </span>
  )
}
