/**
 * The 安康位 shield badge (FORK dsh-local, collab-step4-c5, marker:
 * healthShield): the wide top strip's right-end occupant, reading the
 * ui-session health hook. Collab step3 §3.3/§5.2 (step4b 接力批2 件C5): an
 * even reconciliation paints the shield faint green — the quiet-trust
 * 本体 ("no badge reading = nothing to do"); a broken one burns red steady
 * and expands the per-invariant difference detail on click (哪条不变量、哪些
 * 会话); and a chain the client stops hearing overlays the SAME amber dashed
 * stale ring the session rows use (step3 §5.1 vocabulary, 自指 fail-closed) —
 * the last known verdict stays painted under it (未知不吞已知) while the
 * tooltip counts the interruption up. The 安康位 alarm additionally cuts into
 * the 「要我拿主意」 queue segment at P0/P1 level (ui-workspace's queue
 * health alert); this badge is the always-on global seat.
 */
import { useState } from 'react'
import clsx from 'clsx'
import { IconShieldOutlineMedium, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionHealthState, UseSessionHealth } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SidebarKey } from './locales.ts'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import css from './HealthShield.module.css'

/** One broken invariant as this seat names it (derived from the wire report). */
type HealthInvariant = NonNullable<SessionHealthState['report']>['issues'][number]['invariant']

/** The invariant labels this seat's language table carries. */
const INVARIANT_KEYS = {
  'total-partition': 'health.invariant.totalPartition',
  unclassified: 'health.invariant.unclassified',
  unreadable: 'health.invariant.unreadable',
} as const satisfies Record<HealthInvariant, SidebarKey>

type HealthShieldProps = {
  /**
   * The ui-session health hook (global standard prop), threaded as a slot
   * with `undefined` in it (exactOptionalPropertyTypes rejects an explicitly
   * undefined optional): absent in compositions without ui-session's root
   * props — the seat renders nothing.
   */
  useSessionHealth: UseSessionHealth | undefined
  t: SidebarRootComponentProps['t']
}

/**
 * Render the shield with its optional detail popover.
 * @param props - the health hook plus the sidebar locale seat.
 * @returns the shield element tree, or null without a health source.
 */
export function HealthShield({ useSessionHealth, t }: HealthShieldProps) {
  const health = useSessionHealth?.(value => value)
  const [detailAnchor, setDetailAnchor] = useState<{ left: number; top: number } | undefined>(undefined)
  if (health === undefined) return null
  const report = health.report
  const broken = report?.ok === false
  const stale = health.stale === true
  const label = stale
    ? t('health.stale.label')
    : broken ? t('health.broken.label') : t('health.ok.label')
  const tooltip = stale && health.staleSeconds !== undefined
    ? t('health.stale.tooltip').replace('{s}', String(health.staleSeconds))
    : label
  return (
    <span
      className={clsx(css.shield, broken ? css.broken : css.ok, stale && css.staleRing)}
      data-health-state={broken ? 'broken' : 'ok'}
      {...(stale ? { 'data-health-stale': '' } : {})}
    >
      <Tooltip label={tooltip} delayMs={500}>
        <button
          type="button"
          className={css.button}
          aria-label={label}
          {...(broken ? { 'aria-expanded': detailAnchor !== undefined } : {})}
          onClick={(event) => {
            if (!broken) return
            if (detailAnchor !== undefined) {
              setDetailAnchor(undefined)
              return
            }
            const rect = event.currentTarget.getBoundingClientRect()
            // Fixed coordinates: the top strip clips its overflow, so the
            // detail floats in the viewport layer instead of inside the row.
            setDetailAnchor({ left: rect.left, top: rect.bottom + 4 })
          }}
        >
          <IconShieldOutlineMedium size={16} />
        </button>
      </Tooltip>
      {/* `broken` (aliased from `report?.ok === false`) already narrows
          `report` to present — the detail only exists with a verdict. */}
      {broken && detailAnchor !== undefined && (
        <div
          className={css.detail}
          data-health-detail=""
          style={{ left: detailAnchor.left, top: detailAnchor.top }}
        >
          {report.issues.map(issue => (
            <div key={issue.invariant} className={css.issue} data-health-invariant={issue.invariant}>
              <span className={css.issueLabel}>{t(INVARIANT_KEYS[issue.invariant])}</span>
              <span className={css.issueSessions}>
                {issue.sessionIds.length === 0 ? '—' : issue.sessionIds.join(', ')}
              </span>
            </div>
          ))}
        </div>
      )}
    </span>
  )
}
