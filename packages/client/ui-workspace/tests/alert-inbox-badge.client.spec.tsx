// @vitest-environment jsdom
/**
 * The alert-inbox envelope badge + 双栏面板 (设计档 §七 + 2026-11-18 改版裁定 A/C):
 * 机检1 badge side — 徽标数 = unread 计数 fixture 对照 (the count rendered IS the
 * fold's published `unread`, the same number duty reads off the same document).
 *
 * 改判 A supersedes the old signal-only seat: the envelope is a BUTTON that opens
 * the two-column mailbox (未读 ∪ 最近24h, both `lastAt` descending); 改判 C
 * retires the escalation wording — the red now tracks `unread` ONLY (no entry
 * ever flips on its own, so there is no "timed out" state to render).
 *
 * ⛔ still never the `question` attention kind (it feeds health's `awaiting`
 * count: lighting it would collide semantically AND inflate the metric) — the
 * 反例判据 keeps asserting that absence while allowing the panel button.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionHealthState } from '@deepseek-ai/dsh-client-ui-session/client'
import type { AlertInboxEntryView } from '@deepseek-ai/dsh-api-session-controller/types'
import { ALERT_INBOX_PATH } from '../src/client/rows/alert-inbox-path.ts'
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

const NOW = Date.now()

/** Two-column fodder: one unread source class inside 24h, one read class sliding out. */
const panelEntries: AlertInboxEntryView[] = [
  { id: 'fam-storm', cause: 'restart-storm', lastAt: NOW - 60_000, count: 6, unread: true, archived: false },
  { id: 'fam-death', cause: 'host-death-unknown', lastAt: NOW - 30 * 60 * 60 * 1000, count: 1, unread: true, archived: false },
  { id: 'fam-read', cause: 'zero-token', lastAt: NOW - 120_000, count: 3, unread: false, archived: true },
]

/** Balanced books + three unread entries — the badge must show exactly 3 (机检1). */
const pending3: SessionHealthState = {
  report: { ...base, alertInbox: { at: 1_700_000_000_000, unread: 3, escalated: 0, total: 4, entries: [] } },
}

/** Attached with nothing pending — the quiet white envelope (无件白). */
const clear: SessionHealthState = {
  report: { ...base, alertInbox: { at: 1_700_000_000_000, unread: 0, escalated: 0, total: 4, entries: [] } },
}

/** Two unread with a stale `escalated` count — 改判 C: the wording follows unread only. */
const escalated: SessionHealthState = {
  report: { ...base, alertInbox: { at: 1_700_000_000_000, unread: 2, escalated: 1, total: 4, entries: [] } },
}

/** Pending badge carrying the two columns' union (改判 A 的面板数据面). */
const panel: SessionHealthState = {
  report: { ...base, alertInbox: { at: NOW, unread: 2, escalated: 0, total: 3, entries: panelEntries } },
}

/** Balanced books with NO alertInbox plane attached (neither document exists) — quiet by design. */
const unattached: SessionHealthState = { report: { ...base } }

function badgeOf(): HTMLElement {
  const badge = document.querySelector<HTMLElement>('[data-alert-inbox-state]')
  expect(badge).not.toBeNull()
  return badge as HTMLElement
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('AlertInboxBadge', () => {
  it('wire path 双侧钉死: client 字面 == host 常量（跨插件不许 value import，靠两侧测试互锁）', () => {
    expect(ALERT_INBOX_PATH).toBe('/api/session-controller/alert-inbox')
  })

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

  it('改判 C: escalated 遗留字段不再影响徽标——红只看 unread、无超时措辞', () => {
    render(<AlertInboxBadge useSessionHealth={selector => selector(escalated)} t={t} />)
    const badge = badgeOf()
    expect(badge.getAttribute('data-alert-inbox-state')).toBe('unread')
    expect(badge.querySelector('[data-alert-inbox-count]')?.textContent).toBe('2')
    expect(screen.getByLabelText('告警信箱：2 条未处理')).not.toBeNull()
    expect(screen.queryByText(/超时/)).toBeNull()
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

  it('改判 A: 信封是按钮——点开双栏面板（未读 ∪ 最近24h，均 lastAt 逆序）', () => {
    render(<AlertInboxBadge useSessionHealth={selector => selector(panel)} t={t} />)
    fireEvent.click(document.querySelector('[data-alert-inbox-open]') as HTMLElement)
    const unread = document.querySelector('[data-alert-inbox-column="unread"]')
    const recent = document.querySelector('[data-alert-inbox-column="recent"]')
    expect(unread).not.toBeNull()
    expect(recent).not.toBeNull()
    // 未读栏 = unread && !archived（fam-storm 与 25h 前仍未读的 fam-death 都在）.
    const unreadRows = unread?.querySelectorAll('[data-alert-inbox-entry]') ?? []
    expect(unreadRows.length).toBe(2)
    // 最近24h栏 = lastAt 窗内全部（含已读 fam-read；滑出窗的 fam-death 不在）.
    const recentRows = recent?.querySelectorAll('[data-alert-inbox-entry]') ?? []
    expect(recentRows.length).toBe(2)
    expect(recent?.textContent).toContain('重启风暴')
    expect(recent?.textContent).toContain('zero-token') // 未本地化的类回落类键
    expect(unread?.textContent).toContain('宿主死因不明') // 未读不受 24h 窗约束
    expect(recent?.textContent).not.toContain('宿主死因不明') // 已滑出 24h 视图窗
  })

  it('改判 A: 未读行点【已读】→ POST read，响应 report 让行即刻翻位（不等心跳帧）', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      report: {
        at: NOW,
        unread: 1,
        escalated: 0,
        total: 3,
        entries: panelEntries.map(entry => (entry.id === 'fam-storm'
          ? { ...entry, unread: false, archived: true }
          : entry)),
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    render(<AlertInboxBadge useSessionHealth={selector => selector(panel)} t={t} />)
    fireEvent.click(document.querySelector('[data-alert-inbox-open]') as HTMLElement)
    fireEvent.click(screen.getAllByRole('button', { name: '已读' })[0]!)

    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe(ALERT_INBOX_PATH)
    expect(JSON.parse(init.body as string)).toEqual({ id: 'fam-storm', action: 'read' })
    // 乐观翻位：该行改显示【恢复】，徽标数同步 2 → 1.
    await waitFor(() => { expect(screen.getAllByRole('button', { name: '恢复' }).length).toBeGreaterThan(0) })
    expect(document.querySelector('[data-alert-inbox-count]')?.textContent).toBe('1')
  })

  it('改判 A: 已读行点【恢复】→ POST restore', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      report: { at: NOW, unread: 3, escalated: 0, total: 3, entries: panelEntries },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    render(<AlertInboxBadge useSessionHealth={selector => selector(panel)} t={t} />)
    fireEvent.click(document.querySelector('[data-alert-inbox-open]') as HTMLElement)
    // 最近24h栏里的已读行（fam-read）显示【恢复】.
    const restore = screen.getAllByRole('button', { name: '恢复' })[0]!
    fireEvent.click(restore)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ id: 'fam-read', action: 'restore' })
  })

  it('反例判据: 面板按钮存在但 ⛔ 不占 question/attention 面（无 health-detail、无 role=img 滥用）', () => {
    render(<AlertInboxBadge useSessionHealth={selector => selector(pending3)} t={t} />)
    const badge = badgeOf()
    expect(badge.querySelector('button[data-alert-inbox-open]')).not.toBeNull()
    expect(badge.querySelector('[data-health-detail]')).toBeNull()
    // 关闭前不渲染面板（面板由 open 态控制，徽标自身不带条目）.
    expect(document.querySelector('[data-alert-inbox-column]')).toBeNull()
  })
})
