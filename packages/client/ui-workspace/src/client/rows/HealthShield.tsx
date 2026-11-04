/**
 * The 安康位 shield badge (FORK dsh-local, collab-step4-c5, marker:
 * healthShield): the 工作区 section header's right-end seat — a sibling AFTER
 * the 🔍 / view-options / add cluster, never inside it (the cluster's fixed
 * 60px overflow-hidden clip window swallows a third child whole, 1101 裁切
 * 复修), reading the ui-session health hook.
 * Placement = user ruling 2026-11-01 (ask 回执 id=`shield-placement`, A 案
 * 工作区行右端): the first seat — the wide top strip beside UsageGlance —
 * squeezed the usage text out of the clipped row, and this badge audits the
 * very list the header heads, so the reading and the audited face share one
 * glance (step3 §3.3 措辞随该裁定修订). Collab step3 §3.3/§5.2 (step4b 接力批2
 * 件C5): an even reconciliation paints the shield faint green — the
 * quiet-trust 本体 ("no badge reading = nothing to do"); a broken one burns
 * red steady and expands the per-invariant difference detail on click (哪条
 * 不变量、哪些会话); and a chain the client stops hearing overlays the SAME
 * amber dashed stale ring the session rows use (step3 §5.1 vocabulary, 自指
 * fail-closed) — the last known verdict stays painted under it (未知不吞已知)
 * while the tooltip counts the interruption up. The 安康位 alarm additionally
 * cuts into the 「要我拿主意」 queue segment at P0/P1 level (the queue health
 * alert below); this badge is the always-on global seat.
 *
 * 批2 duty-shield-b2-1103 (ruling `shield-entry-ruling` A案 淡绿常驻可点,
 * 2026-11-03): the faint-green平态 is now CLICKABLE — one badge, one detail
 * surface, TWO sections (会话对账 + 值守清单, rendered by the shared
 * HealthDetail) — so the duty inventory stays reachable even when everything
 * is green, without a second badge (一个入口两段内容). `broken` widens to the
 * duty fold: a failed or untrusted 值守总账 paints the shield red exactly like
 * a broken Session reconciliation (三态纪律: healthy quiet / 有意停用 grey /
 * failed red + 逐项明细 + 插队 P0/P1).
 *
 * 2026-11-04 ruling (controller-poll availability): `broken` widens once more
 * to the auto-route plane's SUSTAINED verdict — a meter-poll failure streak
 * ≥ ~5 min burns the shield red with its own label (never "对账对不上": the
 * books balance, the controller is blind). Transient misses set nothing here;
 * they live in the glance button tooltip and the detail's third section
 * (三态纪律 + 警报经济学: one fact, one alarm surface, no double meanings).
 */
import { useState } from 'react'
import clsx from 'clsx'
import { IconShieldOutlineMedium, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseSessionHealth } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import { HealthDetail } from './HealthDetail.tsx'
import css from './HealthShield.module.css'

type HealthShieldProps = {
  /**
   * The ui-session health hook (global standard prop), threaded as a slot
   * with `undefined` in it (exactOptionalPropertyTypes rejects an explicitly
   * undefined optional): absent in compositions without ui-session's root
   * props — the seat renders nothing.
   */
  useSessionHealth: UseSessionHealth | undefined
  t: WorkspaceBrowserProps['t']
}

/**
 * Render the shield with its two-section detail popover.
 * @param props - the health hook plus the sidebar locale seat.
 * @returns the shield element tree, or null without a health source.
 */
export function HealthShield({ useSessionHealth, t }: HealthShieldProps) {
  const health = useSessionHealth?.(value => value)
  const [detailAnchor, setDetailAnchor] = useState<{ left: number; top: number } | undefined>(undefined)
  if (health === undefined) return null
  const report = health.report
  // Three planes can break the shield: Session invariants, the duty fold (批2),
  // and — 2026-11-04 ruling — a SUSTAINED auto-route meter-poll failure.
  // Transient misses never set it (狼来了: the glance tooltip owns those).
  const sessionDutyBroken = report?.ok === false || report?.duty?.ok === false
  const sustained = report?.autoRoute?.sustained === true
  const broken = sessionDutyBroken || sustained
  const stale = health.stale === true
  const label = stale
    ? t('health.stale.label')
    // An autoRoute-only break must not claim "对账对不上" — the books balance;
    // it's the controller that can't read its meters (three distinct alarms).
    : sessionDutyBroken
      ? t('health.broken.label')
      : sustained
        ? t('health.autoRoute.label')
        : t('health.ok.label')
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
          aria-expanded={detailAnchor !== undefined}
          onClick={(event) => {
            // 批2 ruling A案: the faint-green平态 is clickable too — the detail
            // opens for both verdicts (one entrance, two sections); only the
            // self-stale ring changes the tooltip, never the disclosure.
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
      {detailAnchor !== undefined && (
        <div
          className={css.detail}
          data-health-detail=""
          style={{ left: detailAnchor.left, top: detailAnchor.top }}
        >
          <HealthDetail report={report} t={t} />
        </div>
      )}
    </span>
  )
}
