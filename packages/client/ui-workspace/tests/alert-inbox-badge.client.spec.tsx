// @vitest-environment jsdom
/**
 * The alert-inbox envelope badge (设计档 `session-revival-v2-alert-inbox-1116.md`
 * §七 盾旁信封徽标, alert-inbox-signal-face-1116): 机检1 badge side — 徽标数 =
 * unread 计数 fixture 对照 (the count rendered IS the fold's published `unread`,
 * the same number duty reads off the same document). Four states from the
 * health snapshot: attached+pending red with the count, attached+clear quiet
 * white, escalated keeps the red with the 超时 wording (不消失反升红), and an
 * unattached plane renders NOTHING (面消失 ≠ 面变坏, optional plane).
 *
 * Structure check: the seat is a signal-only `span[role=img]` — no button, no
 * popover, no attention wiring (⛔ never the `question` kind: it feeds health's
 * `awaiting` count, so lighting it would collide semantically and inflate the
 * metric; the 反例判据 asserts the seat has no interactive/attention surface).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionHealthState } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import { AlertInboxBadge } from '../src/client/rows/AlertInboxBadge.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as WorkspaceBrowserProps['t']

const base = {
  ok: true,
  total: 1,
  counts: { running: 1, awaiting: 0, failed: 0, rest: 0 },
  issues: [],
} as const

/** Balanced books + three unread entries — the badge must show exactly 3 (机检1). */
const pending3: SessionHealthState = {
  report: { ...base, alertInbox: { at: 1_700_000_000_000, unread: 3, escalated: 0, total: 4, entries: [] } },
}

/** Attached with nothing pending — the quiet white envelope (无件白). */
const clear: SessionHealthState = {
  report: { ...base, alertInbox: { at: 1_700_000_000_000, unread: 0, escalated: 0, total: 4, entries: [] } },
}

/** Two unread, one past the escalation window — red stays, wording escalates (超时升级). */
const escalated: SessionHealthState = {
  report: { ...base, alertInbox: { at: 1_700_000_000_000, unread: 2, escalated: 1, total: 4, entries: [] } },
}

/** Balanced books with NO alertInbox plane attached (neither document exists) — quiet by design. */
const unattached: SessionHealthState = { report: { ...base } }

function badgeOf(): HTMLElement {
  const badge = document.querySelector('[data-alert-inbox-state]') as HTMLElement | null
  expect(badge).not.toBeNull()
  return badge as HTMLElement
}

afterEach(cleanup)

describe('AlertInboxBadge', () => {
  it('机检1 徽标侧: 徽标数 = unread 计数 fixture 对照 (rendered count IS the published count)', () => {
    render(<AlertInboxBadge useSessionHealth={selector => selector(pending3)} t={t} />)
    const badge = badgeOf()
    expect(badge.getAttribute('data-alert-inbox-state')).toBe('unread')
    expect(badge.querySelector('[data-alert-inbox-count]')?.textContent).toBe('3')
    // The accessible name carries the same number (label and count cannot drift).
    expect(screen.getByLabelText('告警信箱：3 条未处理')).not.toBeNull()
  })

  it('无件白: attached with zero pending → quiet clear state, no count, no red', () => {
    render(<AlertInboxBadge useSessionHealth={selector => selector(clear)} t={t} />)
    const badge = badgeOf()
    expect(badge.getAttribute('data-alert-inbox-state')).toBe('clear')
    expect(badge.querySelector('[data-alert-inbox-count]')).toBeNull()
    expect(screen.getByLabelText('告警信箱：无未处理')).not.toBeNull()
  })

  it('超时升级: escalated > 0 keeps the red state and adds the 超时 wording (不消失反升红)', () => {
    render(<AlertInboxBadge useSessionHealth={selector => selector(escalated)} t={t} />)
    const badge = badgeOf()
    expect(badge.getAttribute('data-alert-inbox-state')).toBe('escalated')
    expect(badge.querySelector('[data-alert-inbox-count]')?.textContent).toBe('2')
    expect(screen.getByLabelText('告警信箱：2 条未处理（1 条超时未确认）')).not.toBeNull()
  })

  it('面未接线: no alertInbox plane → renders nothing (面消失 ≠ 面变坏, never a break)', () => {
    const view = render(<AlertInboxBadge useSessionHealth={selector => selector(unattached)} t={t} />)
    expect(view.container.textContent).toBe('')
    expect(document.querySelector('[data-alert-inbox-state]')).toBeNull()
  })

  it('renders nothing without a health source (minimal assemblies)', () => {
    const view = render(<AlertInboxBadge useSessionHealth={undefined} t={t} />)
    expect(view.container.textContent).toBe('')
  })

  it('反例判据: signal-only seat — no button, no popover, no attention surface (⛔ 不占 question kind)', () => {
    render(<AlertInboxBadge useSessionHealth={selector => selector(pending3)} t={t} />)
    const badge = badgeOf()
    // A span with an accessible name: nothing to click, nothing that could be
    // mistaken for an attention/question affordance.
    expect(badge.querySelector('button')).toBeNull()
    expect(badge.querySelector('[data-health-detail]')).toBeNull()
    expect(badge.querySelector('[role="img"]')).not.toBeNull()
  })
})
