// @vitest-environment jsdom
/**
 * The 安康位 shield badge (FORK dsh-local, collab-step4-c5, marker:
 * healthShield): three states from the ui-session health snapshot — faint
 * green while the books balance, steady red with the click-expanded
 * difference detail when they don't, and the shared dashed-ring vocabulary
 * (asserted against the CSS text in health-shield-styles.client.spec.ts)
 * when the health chain itself goes silent (collab step3 §3.3/§5.2, step4b
 * 接力批2 件C5).
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

afterEach(cleanup)

describe('HealthShield', () => {
  it('paints faint green while the books balance, with nothing to expand', () => {
    render(<HealthShield useSessionHealth={selector => selector(balanced)} t={t} />)
    const shield = screen.getByLabelText('安康位：对账平').closest('[data-health-state]') as HTMLElement
    expect(shield.getAttribute('data-health-state')).toBe('ok')
    expect(shield.hasAttribute('data-health-stale')).toBe(false)
    // 对账平 is click-quiet: the shield offers no detail surface.
    fireEvent.click(screen.getByLabelText('安康位：对账平'))
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
})
