// @vitest-environment jsdom
/**
 * The 安康位 shield badge (FORK dsh-local, collab-step4-c5, marker:
 * healthShield): three states from the ui-session health snapshot — faint
 * green while the books balance, steady red with the click-expanded
 * two-section detail when they don't, and the shared dashed-ring vocabulary
 * (asserted against the CSS text in health-shield-styles.client.spec.ts)
 * when the health chain itself goes silent (collab step3 §3.3/§5.2, step4b
 * 接力批2 件C5).
 *
 * 批2 duty-shield-b2-1103 (ruling `shield-entry-ruling` A案): the faint-green
 * 平态 is clickable (the old click-quiet contract is replaced), the detail
 * carries BOTH sections (会话对账 + 值守清单), and the duty fold's verdict
 * paints the shield red — with healthy items hidden, 有意停用 grey, failed red
 * with the collector's reasons (三态纪律, 清单档 §6.3).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionHealthState } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import { HealthShield } from '../src/client/rows/HealthShield.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as WorkspaceBrowserProps['t']

const balanced: SessionHealthState = {
  report: { ok: true, total: 1, counts: { running: 1, awaiting: 0, failed: 0, rest: 0 }, issues: [] },
}

const broken: SessionHealthState = {
  report: {
    ok: false,
    total: 2,
    counts: { running: 1, awaiting: 0, failed: 0, rest: 0 },
    issues: [{ invariant: 'unreadable', sessionIds: ['ghost' as never] }],
  },
}

/** A balanced Session plane over a duty ledger holding one failure + one intentional stop. */
const dutyBroken: SessionHealthState = {
  report: {
    ok: true,
    total: 1,
    counts: { running: 1, awaiting: 0, failed: 0, rest: 0 },
    issues: [],
    duty: {
      ok: false,
      fresh: true,
      ageSec: 60,
      counts: { total: 3, healthy: 1, disabled: 1, failed: 1 },
      items: [
        { id: 'DSH-Build-Watchdog', status: 'healthy', intentional: false, reasons: [] },
        { id: 'taskbot-guard-check', status: 'disabled', intentional: true, reasons: [] },
        {
          id: 'DSH-Host-Revive',
          status: 'failed',
          intentional: false,
          cadenceLabel: '每 5 分钟',
          reasons: ['该跑没跑：LastRunTime 距今 900s > 阈 900s'],
        },
      ],
    },
  },
}

/** A balanced Session plane with NO autoRoute plane attached (plugin absent) — quiet by design. */
const noAutoRoute: SessionHealthState = {
  report: { ok: true, total: 1, counts: { running: 1, awaiting: 0, failed: 0, rest: 0 }, issues: [] },
}

/** Balanced books + a SUSTAINED controller poll failure (2026-11-04 ruling: the shield's third alarm). */
const autoRouteSustained: SessionHealthState = {
  report: {
    ok: true,
    total: 1,
    counts: { running: 1, awaiting: 0, failed: 0, rest: 0 },
    issues: [],
    autoRoute: {
      ok: false,
      failingSince: 1_700_000_000_000,
      failingForSec: 312,
      sustained: true,
      error: 'meter source unreachable: fetch failed (cause: connect ECONNREFUSED 127.0.0.1:7897)',
      ageSec: 4,
    },
  },
}

/** Balanced books + a TRANSIENT poll miss — nothing ambient may light (狼来了). */
const autoRouteTransient: SessionHealthState = {
  report: {
    ok: true,
    total: 1,
    counts: { running: 1, awaiting: 0, failed: 0, rest: 0 },
    issues: [],
    autoRoute: { ok: false, failingForSec: 47, sustained: false, error: 'fetch failed', ageSec: 3 },
  },
}

afterEach(cleanup)

describe('HealthShield', () => {
  it('paints faint green in the 平态 and opens the two-section detail on click (批2 ruling A案)', () => {
    render(<HealthShield useSessionHealth={selector => selector(balanced)} t={t} />)
    const shield = screen.getByLabelText('安康位：对账平，点击展开明细').closest('[data-health-state]') as HTMLElement
    expect(shield.getAttribute('data-health-state')).toBe('ok')
    expect(shield.hasAttribute('data-health-stale')).toBe(false)
    expect(document.querySelector('[data-health-detail=""]')).toBeNull()

    // 一个入口两段内容: the green平态 now expands 会话对账 + 值守清单.
    fireEvent.click(screen.getByLabelText('安康位：对账平，点击展开明细'))
    const detail = document.querySelector('[data-health-detail=""]') as HTMLElement
    expect(detail.querySelector('[data-health-section="sessions"]')?.textContent).toContain('会话对账')
    expect(detail.querySelector('[data-health-section="duty"]')?.textContent).toContain('值守清单')
    expect(detail.textContent).toContain('对账平')

    // The same click closes it again.
    fireEvent.click(screen.getByLabelText('安康位：对账平，点击展开明细'))
    expect(document.querySelector('[data-health-detail=""]')).toBeNull()
  })

  it('burns red steady when the reconciliation breaks and expands the difference detail on click (件C5)', () => {
    render(<HealthShield useSessionHealth={selector => selector(broken)} t={t} />)
    const shield = screen.getByLabelText('安康位：对账对不上，点击展开差异明细').closest('[data-health-state]') as HTMLElement
    expect(shield.getAttribute('data-health-state')).toBe('broken')
    expect(document.querySelector('[data-health-detail=""]')).toBeNull()

    fireEvent.click(screen.getByLabelText('安康位：对账对不上，点击展开差异明细'))
    const detail = document.querySelector('[data-health-detail=""]') as HTMLElement
    expect(detail.textContent).toContain('有读不到的会话')
    expect(detail.textContent).toContain('ghost')

    // The same click closes it again.
    fireEvent.click(screen.getByLabelText('安康位：对账对不上，点击展开差异明细'))
    expect(document.querySelector('[data-health-detail=""]')).toBeNull()
  })

  it('burns red on a failed duty fold and lists the three states per item (批2 三态纪律)', () => {
    render(<HealthShield useSessionHealth={selector => selector(dutyBroken)} t={t} />)
    // Sessions balance, yet the duty plane failed → the shield is red anyway.
    const shield = screen.getByLabelText('安康位：对账对不上，点击展开差异明细').closest('[data-health-state]') as HTMLElement
    expect(shield.getAttribute('data-health-state')).toBe('broken')

    fireEvent.click(screen.getByLabelText('安康位：对账对不上，点击展开差异明细'))
    const detail = document.querySelector('[data-health-detail=""]') as HTMLElement
    const duty = detail.querySelector('[data-health-section="duty"]') as HTMLElement
    // Summary counts + failed row (red, with the collector's reasons).
    expect(duty.textContent).toContain('共 3 件')
    expect(duty.textContent).toContain('失效 1')
    expect(duty.querySelector('[data-duty-item="failed"]')?.textContent).toContain('DSH-Host-Revive')
    expect(duty.querySelector('[data-duty-item="failed"]')?.textContent).toContain('该跑没跑')
    // 有意停用 renders grey with its tag — never a lamp, never hidden.
    expect(duty.querySelector('[data-duty-item="disabled"]')?.textContent).toContain('taskbot-guard-check')
    expect(duty.querySelector('[data-duty-item="disabled"]')?.textContent).toContain('有意停用')
    // 健康隐藏: the healthy item is counted, never listed as a row.
    expect(duty.querySelector('[data-duty-item="healthy"]')).toBeNull()
    expect(duty.textContent).not.toContain('DSH-Build-Watchdog')
  })

  it('keeps the last verdict under the self stale ring and names the interruption (件C5 自指 fail-closed)', () => {
    render(<HealthShield useSessionHealth={selector => selector({ ...broken, stale: true, staleSeconds: 45 })} t={t} />)
    const shield = screen.getByLabelText('安康位：对账读数中断').closest('[data-health-state]') as HTMLElement
    // 未知不吞已知: the last known verdict's state still shows under the ring.
    expect(shield.getAttribute('data-health-state')).toBe('broken')
    expect(shield.hasAttribute('data-health-stale')).toBe(true)
  })

  it('renders nothing without a health source (minimal assemblies)', () => {
    const view = render(<HealthShield useSessionHealth={undefined} t={t} />)
    expect(view.container.textContent).toBe('')
  })

  // 2026-11-04 ruling: sustained controller poll failure = the shield's third alarm.
  it('burns red on a SUSTAINED auto-route poll failure — with its own label, never 对账对不上', () => {
    render(<HealthShield useSessionHealth={selector => selector(autoRouteSustained)} t={t} />)
    const label = '安康位：控制器读数持续中断，点击展开明细'
    const shield = screen.getByLabelText(label).closest('[data-health-state]') as HTMLElement
    expect(shield.getAttribute('data-health-state')).toBe('broken')
    // The books balance — the label must not claim a reconciliation break.
    expect(shield.textContent).not.toContain('对账对不上')

    // The third detail section explains the red: raw error + streak age + sustained tag.
    fireEvent.click(screen.getByLabelText(label))
    const detail = document.querySelector('[data-health-detail=""]') as HTMLElement
    expect(detail.querySelector('[data-health-section="autoRoute"]')?.textContent).toContain('控制器读数中断 312s')
    expect(detail.textContent).toContain('持续 ≥5 分钟')
    expect(detail.textContent).toContain('connect ECONNREFUSED')
    // The other two sections keep their own verdicts (books balance).
    expect(detail.querySelector('[data-health-section="sessions"]')?.textContent).toContain('对账平')
  })

  it('stays faint green on a TRANSIENT poll miss — only the detail carries the fact', () => {
    render(<HealthShield useSessionHealth={selector => selector(autoRouteTransient)} t={t} />)
    const shield = screen.getByLabelText('安康位：对账平，点击展开明细').closest('[data-health-state]') as HTMLElement
    expect(shield.getAttribute('data-health-state')).toBe('ok')
    expect(shield.hasAttribute('data-health-stale')).toBe(false)
    // Drill-down still shows the raw miss (on-demand investigation, not an alarm).
    fireEvent.click(screen.getByLabelText('安康位：对账平，点击展开明细'))
    const detail = document.querySelector('[data-health-detail=""]') as HTMLElement
    expect(detail.querySelector('[data-health-section="autoRoute"]')?.textContent).toContain('控制器读数中断 47s')
    expect(detail.textContent).not.toContain('持续 ≥5 分钟')
  })

  it('shows a quiet not-wired line when the autoRoute plane is absent (optional plugin)', () => {
    render(<HealthShield useSessionHealth={selector => selector(noAutoRoute)} t={t} />)
    fireEvent.click(screen.getByLabelText('安康位：对账平，点击展开明细'))
    const detail = document.querySelector('[data-health-detail=""]') as HTMLElement
    expect(detail.querySelector('[data-health-section="autoRoute"]')?.textContent).toContain('控制器轮询未接入')
    // Absent = not attached, NEVER broken.
    const shield = screen.getByLabelText('安康位：对账平，点击展开明细').closest('[data-health-state]') as HTMLElement
    expect(shield.getAttribute('data-health-state')).toBe('ok')
  })
})
