/**
 * The 安康位 detail body — TWO sections in ONE surface (批2
 * duty-shield-b2-1103, ruling `shield-entry-ruling` A案 淡绿常驻可点:
 * 一个入口两段内容): 会话对账 (the three-invariant difference detail) above
 * 值守清单 (the duty ledger's rows) below. Shared verbatim by the header
 * shield popover and the queue alarm row, so both entrances expand the same
 * two segments (step3 §3.3/§5.2 duty extension).
 *
 * 三态纪律 (清单档 §6.3, 警报经济学 archive-seal-light 2026-11-02): healthy
 * items are HIDDEN behind the summary counts (健康隐藏 — nothing to act on),
 * 有意停用 renders grey with its tag and never lights, failed renders red
 * with the collector's per-item reasons (逐项明细).
 */
import type { SessionHealthState } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import type { WorkspaceKey } from '../locales.ts'
import css from './HealthDetail.module.css'

type DetailTranslate = WorkspaceBrowserProps['t']
type HealthReport = SessionHealthState['report']

/** One broken invariant as the detail names it (derived from the wire report). */
type HealthInvariant = NonNullable<HealthReport>['issues'][number]['invariant']

/** The invariant labels this surface's language table carries. */
const INVARIANT_KEYS = {
  'total-partition': 'health.invariant.totalPartition',
  unclassified: 'health.invariant.unclassified',
  unreadable: 'health.invariant.unreadable',
} as const satisfies Record<HealthInvariant, WorkspaceKey>

/**
 * Render the two-section detail over one wire report.
 * @param report - the sweep's audit (with its duty fold); `undefined` until the first frame lands.
 * @param t - the workspace namespace translator.
 * @returns the sessions + duty sections as one fragment.
 */
export function HealthDetail({ report, t }: { report: HealthReport; t: DetailTranslate }) {
  const duty = report?.duty
  const failed = duty?.items.filter(item => item.status === 'failed') ?? []
  const disabled = duty?.items.filter(item => item.status === 'disabled') ?? []
  return (
    <>
      <section className={css.section} data-health-section="sessions">
        <div className={css.sectionTitle}>{t('health.section.sessions')}</div>
        {report === undefined
          ? <div className={css.quiet}>{t('health.detail.awaiting')}</div>
          : report.issues.length === 0
            ? <div className={css.quiet}>{t('health.detail.balanced')}</div>
            : report.issues.map(issue => (
              <div key={issue.invariant} className={css.issue} data-health-invariant={issue.invariant}>
                <span className={css.issueLabel}>{t(INVARIANT_KEYS[issue.invariant])}</span>
                <span className={css.issueSessions}>
                  {issue.sessionIds.length === 0 ? '—' : issue.sessionIds.join(', ')}
                </span>
              </div>
            ))}
      </section>
      <section className={css.section} data-health-section="duty">
        <div className={css.sectionTitle}>{t('health.section.duty')}</div>
        {duty === undefined
          ? <div className={css.quiet}>{t('health.duty.unwired')}</div>
          : (
            <>
              <div className={css.dutySummary} data-duty-summary="">
                {t('health.duty.summary', {
                  total: duty.counts.total,
                  healthy: duty.counts.healthy,
                  disabled: duty.counts.disabled,
                  failed: duty.counts.failed,
                })}
              </div>
              {!duty.fresh && (
                <div className={css.dutyUntrusted} data-duty-untrusted="">
                  {t('health.duty.untrusted', { s: duty.ageSec ?? 0 })}
                </div>
              )}
              {/* failed = 红 + 逐项明细 (collector reasons, untranslated by policy). */}
              {failed.map(item => (
                <div key={item.id} className={css.dutyFailed} data-duty-item="failed">
                  <span className={css.dutyItemName}>{item.id}</span>
                  {item.cadenceLabel !== undefined && (
                    <span className={css.dutyItemCadence}>{item.cadenceLabel}</span>
                  )}
                  <span className={css.dutyItemReasons}>
                    {item.reasons.length === 0 ? '—' : item.reasons.join('；')}
                  </span>
                </div>
              ))}
              {/* 有意停用 = 灰不亮: rendered for completeness, never a lamp. */}
              {disabled.map(item => (
                <div key={item.id} className={css.dutyDisabled} data-duty-item="disabled">
                  <span className={css.dutyItemName}>{item.id}</span>
                  {item.cadenceLabel !== undefined && (
                    <span className={css.dutyItemCadence}>{item.cadenceLabel}</span>
                  )}
                  <span className={css.dutyItemTag}>{t('health.duty.disabledTag')}</span>
                </div>
              ))}
              {/* healthy items stay HIDDEN behind the summary counts (健康隐藏). */}
            </>
          )}
      </section>
    </>
  )
}
