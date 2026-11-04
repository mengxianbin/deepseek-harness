/**
 * The 安康位 detail body — THREE sections in ONE surface (批2
 * duty-shield-b2-1103, ruling `shield-entry-ruling` A案 淡绿常驻可点:
 * 一个入口多段内容): 会话对账 (the three-invariant difference detail) above
 * 值守清单 (the duty ledger's rows) above 自动路由 (the controller's meter-
 * poll verdict, 2026-11-04 ruling). Shared verbatim by the header
 * shield popover and the queue alarm row, so both entrances expand the same
 * segments (step3 §3.3/§5.2 duty extension).
 *
 * 三态纪律 (清单档 §6.3, 警报经济学 archive-seal-light 2026-11-02): healthy
 * items are HIDDEN behind the summary counts (健康隐藏 — nothing to act on),
 * 有意停用 renders grey with its tag and never lights, failed renders red
 * with the collector's per-item reasons (逐项明细). The autoRoute plane is
 * optional (absent = plugin not wired → quiet line, never broken); a failing
 * poll renders red WITH its raw error and streak age — the detail is the
 * on-demand investigation surface, so even a transient miss shows here even
 * though it never sets any ambient alarm.
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
 * Render the three-section detail over one wire report.
 * @param report - the sweep's audit (with its duty and autoRoute folds); `undefined` until the first frame lands.
 * @param t - the workspace namespace translator.
 * @returns the sessions + duty + autoRoute sections as one fragment.
 */
export function HealthDetail({ report, t }: { report: HealthReport; t: DetailTranslate }) {
  const duty = report?.duty
  const autoRoute = report?.autoRoute
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
      {/* 2026-11-04 ruling: the controller's meter-poll verdict. Optional
          plane — absent reads "not wired" (quiet, never broken); a miss
          renders red with its raw error and streak age, sustained or not,
          because THIS surface is the on-demand investigation, not an alarm. */}
      <section className={css.section} data-health-section="autoRoute">
        <div className={css.sectionTitle}>{t('health.section.autoRoute')}</div>
        {autoRoute === undefined
          ? <div className={css.quiet}>{t('health.autoRoute.unwired')}</div>
          : autoRoute.ok
            ? <div className={css.quiet}>{t('health.autoRoute.ok')}</div>
            : (
              <div className={css.dutyFailed} data-auto-route="failing">
                <span className={css.dutyItemName}>
                  {t('health.autoRoute.failing', { s: autoRoute.failingForSec ?? 0 })}
                </span>
                {autoRoute.sustained && (
                  <span className={css.dutyItemTag}>{t('health.autoRoute.sustainedTag')}</span>
                )}
                {/* Controller error text, untranslated by policy (collector language, like duty reasons). */}
                <span className={css.dutyItemReasons}>{autoRoute.error ?? '—'}</span>
              </div>
            )}
      </section>
    </>
  )
}
