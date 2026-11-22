// @vitest-environment jsdom
/**
 * The alert-inbox envelope badge + 左右 tab 面板 (设计档 §七 + 2026-11-18 改版
 * 裁定 A/C + 2026-11-21 改判 E): 机检1 badge side — 徽标数 = unread 计数 fixture
 * 对照 (the count rendered IS the fold's published `unread`, the same number duty
 * reads off the same document).
 *
 * 改判 A supersedes the old signal-only seat: the envelope is a BUTTON that opens
 * the mailbox; 改判 E supersedes A's two-column presentation — the panel is two
 * LEFT-RIGHT TABS (未读 / 最近24h, both `lastAt` descending), one list at a time
 * so rows get the full width; tab labels carry both counts; the default tab is
 * judged at open (有未读 → 未读, else → 最近 24h). 改判 C retires the escalation
 * wording — the red now tracks `unread` ONLY (no entry ever flips on its own, so
 * there is no "timed out" state to render).
 *
 * ⛔ still never the `question` attention kind (it feeds health's `awaiting`
 * count: lighting it would collide semantically AND inflate the metric) — the
 * 反例判据 keeps asserting that absence while allowing the panel button.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionHealthState } from '@deepseek-ai/dsh-client-ui-session/client'
import type { AlertInboxEntryView } from '@deepseek-ai/dsh-api-session-controller/types'
import { ALERT_INBOX_PATH } from '../src/client/rows/alert-inbox-path.ts'
import type { WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import { AlertInboxBadge } from '../src/client/rows/AlertInboxBadge.tsx'
import panelCss from '../src/client/rows/AlertInboxBadge.module.css'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as WorkspaceBrowserProps['t']

const base = {
  ok: true,
  total: 1,
  counts: { running: 1, awaiting: 0, failed: 0, rest: 0 },
  issues: [],
} as const

const NOW = Date.now()

/** Tab fodder: one unread source class inside 24h, one read class sliding out. */
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

  it('首帧占位: health source present, first frame pending → envelope seat paints immediately (盾灯同构)', () => {
    // The host sweep folds a health frame only every 15s and never replays on
    // connect — before it lands the seat must not stay empty (2026-11-23 用户
    // 回报「信封图标卡几秒才出现」).
    const firstFrame: SessionHealthState = { report: undefined }
    const view = render(<AlertInboxBadge useSessionHealth={selector => selector(firstFrame)} t={t} />)
    const badge = badgeOf()
    expect(badge.getAttribute('data-alert-inbox-state')).toBe('loading')
    // 占位是带可访问名的信封 span，不是按钮：首帧前没有数据可开 (no phantom click).
    expect(badge.querySelector('button')).toBeNull()
    expect(badge.querySelector('[data-alert-inbox-open]')).toBeNull()
    expect(badge.querySelector('svg')).not.toBeNull()
    expect(screen.getByLabelText('告警信箱加载中')).not.toBeNull()
    // 首帧落地即换真徽标：占位退出渲染，未读计数接管同一 seat.
    view.rerender(<AlertInboxBadge useSessionHealth={selector => selector(pending3)} t={t} />)
    expect(document.querySelector('[data-alert-inbox-state="loading"]')).toBeNull()
    expect(badgeOf().getAttribute('data-alert-inbox-state')).toBe('unread')
    expect(document.querySelector('[data-alert-inbox-count]')?.textContent).toBe('3')
  })

  it('改判 E: 信封是按钮——点开左右两 tab（标签带计数），默认 = 有未读 → 未读 tab', () => {
    render(<AlertInboxBadge useSessionHealth={selector => selector(panel)} t={t} />)
    fireEvent.click(document.querySelector('[data-alert-inbox-open]') as HTMLElement)
    const unreadTab = document.querySelector<HTMLElement>('[data-alert-inbox-tab="unread"]')
    const recentTab = document.querySelector<HTMLElement>('[data-alert-inbox-tab="recent"]')
    expect(unreadTab).not.toBeNull()
    expect(recentTab).not.toBeNull()
    // 计数在场：未读 (2) / 最近 24h (2)——切走也能看到另一维状态.
    expect(unreadTab?.textContent).toBe('未读 (2)')
    expect(recentTab?.textContent).toBe('最近 24h (2)')
    // 默认 tab 判定（分支一：有未读 → 未读 tab，每次打开按当前状态判定）.
    expect(unreadTab?.getAttribute('aria-selected')).toBe('true')
    expect(recentTab?.getAttribute('aria-selected')).toBe('false')
    // 单栏渲染：只有当前 tab 的列表在场，且行拿全宽（旧双栏容器已退役）.
    expect(document.querySelector('[data-alert-inbox-tabpanel="unread"]')).not.toBeNull()
    expect(document.querySelector('[data-alert-inbox-tabpanel="recent"]')).toBeNull()
    expect(document.querySelector('[data-alert-inbox-column]')).toBeNull()
    // 未读 tab 列表 = unread && !archived（fam-storm 与 25h 前仍未读的 fam-death 都在）.
    const rows = document.querySelectorAll('[data-alert-inbox-tabpanel="unread"] [data-alert-inbox-entry]')
    expect(rows.length).toBe(2)
    expect(rows[0]?.textContent).toContain('重启风暴')
    expect(document.body.textContent).toContain('宿主死因不明') // 未读不受 24h 窗约束
  })

  it('改判 E: 默认 tab 判定分支二——无未读 → 最近 24h tab', () => {
    // 已读态：无 unread && !archived 条目，但 24h 窗内仍有记录.
    const allReadEntries = panelEntries.map(entry => ({ ...entry, unread: false, archived: true }))
    const allRead: SessionHealthState = {
      report: { ...base, alertInbox: { at: NOW, unread: 0, escalated: 0, total: 3, entries: allReadEntries } },
    }
    render(<AlertInboxBadge useSessionHealth={selector => selector(allRead)} t={t} />)
    fireEvent.click(document.querySelector('[data-alert-inbox-open]') as HTMLElement)
    expect(document.querySelector('[data-alert-inbox-tab="unread"]')?.getAttribute('aria-selected')).toBe('false')
    expect(document.querySelector('[data-alert-inbox-tab="recent"]')?.getAttribute('aria-selected')).toBe('true')
    const panelbox = document.querySelector('[data-alert-inbox-tabpanel="recent"]')
    expect(panelbox).not.toBeNull()
    expect(document.querySelector('[data-alert-inbox-tabpanel="unread"]')).toBeNull()
    // 最近24h列表 = lastAt 窗内全部（含已读 fam-read；滑出窗的 fam-death 不在）.
    const recentRows = panelbox?.querySelectorAll('[data-alert-inbox-entry]') ?? []
    expect(recentRows.length).toBe(2)
    expect(panelbox?.textContent).toContain('重启风暴')
    expect(panelbox?.textContent).toContain('zero-token') // 未本地化的类回落类键
    expect(panelbox?.textContent).not.toContain('宿主死因不明') // 已滑出 24h 视图窗
  })

  it('改判 E: 手动切换即时生效——点【最近 24h】tab 单栏换列表，未读内容退出渲染', () => {
    render(<AlertInboxBadge useSessionHealth={selector => selector(panel)} t={t} />)
    fireEvent.click(document.querySelector('[data-alert-inbox-open]') as HTMLElement)
    fireEvent.click(document.querySelector('[data-alert-inbox-tab="recent"]') as HTMLElement)
    expect(document.querySelector('[data-alert-inbox-tab="unread"]')?.getAttribute('aria-selected')).toBe('false')
    expect(document.querySelector('[data-alert-inbox-tab="recent"]')?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('[data-alert-inbox-tabpanel="recent"]')).not.toBeNull()
    expect(document.querySelector('[data-alert-inbox-tabpanel="unread"]')).toBeNull()
    // 单栏 = 只渲染当前 tab：未读专属条目（fam-death 滑出 24h 窗）退出 DOM.
    expect(document.body.textContent).not.toContain('宿主死因不明')
    const recentRows = document.querySelectorAll('[data-alert-inbox-tabpanel="recent"] [data-alert-inbox-entry]')
    expect(recentRows.length).toBe(2)
  })

  it('反裁切: 面板对话框带 .panel 类 + 源字面宽度（单栏全宽行，768px 反裁切约束随双栏退役）', () => {
    render(<AlertInboxBadge useSessionHealth={selector => selector(panel)} t={t} />)
    fireEvent.click(document.querySelector('[data-alert-inbox-open]') as HTMLElement)
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    // jsdom 不做布局，这里钉的是「覆盖类确实传到了 dialog 元素」——宽度本身由
    // AlertInboxBadge.module.css `.panel { width: min(560px, …) }` 承载（源文件字面见下断言）.
    expect(dialog?.classList.contains(panelCss.panel!)).toBe(true)
    expect(panelCss.panel).toBeTruthy()
    // 源字面钉死：.panel 必须真的带宽度覆盖（否则类在、宽没改 = 静默回退）；
    // 768px = 双栏几何，随改判 E 退役——.panel 规则里 768px 不得复活（双栏回潮即红，
    // 注释里的历史提法不算，断言只看 .panel 规则体）.
    // jsdom 下 import.meta.url 非 file scheme，按仓根相对路径读（vitest cwd = 仓根）.
    const source = readFileSync(
      'packages/client/ui-workspace/src/client/rows/AlertInboxBadge.module.css',
      'utf8',
    )
    expect(source).toMatch(/\.panel\s*\{[^}]*min\(560px/)
    expect(source).not.toMatch(/\.panel\s*\{[^}]*min\(768px/)
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
    // 乐观翻位：fam-storm 即刻退出未读 tab（改判 E 单栏语义），在最近 24h tab 显示【恢复】；
    // 徽标数同步 2 → 1.
    await waitFor(() => {
      const unreadRows = document.querySelectorAll('[data-alert-inbox-tabpanel="unread"] [data-alert-inbox-entry]')
      expect(unreadRows.length).toBe(1) // fam-death 仍在（未读不受 24h 窗约束）
    })
    fireEvent.click(document.querySelector('[data-alert-inbox-tab="recent"]') as HTMLElement)
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
    // 切到最近 24h tab，已读行（fam-read）显示【恢复】.
    fireEvent.click(document.querySelector('[data-alert-inbox-tab="recent"]') as HTMLElement)
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
    expect(document.querySelector('[data-alert-inbox-tabpanel]')).toBeNull()
  })
})
