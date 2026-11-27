// @vitest-environment jsdom
/**
 * The human unfreeze entry (freeze-reclaim-1127 §6.2 解冻永可用 + §2.1 副状态
 * 徽标): the badge store's folding rules and the row badge's one-click wake.
 *
 * 机检面:
 * 1. The state route folds to sessionId → frozen view — active and
 *    session-less records never reach a row (no phantom badges).
 * 2. Fail-open: a dead host keeps the pre-badge world (empty map, no throw).
 * 3. The wake trigger follows the record's reason: 排队位 → quota-free (E4),
 *    前置 → prereq-terminal (E6) — the wake route's own axis (§三 事件集不扩).
 * 4. The badge renders only while frozen, carries the reason in its label,
 *    and its click posts the wake body WITHOUT letting the row's own click
 *    through (stopPropagation) — the wake is human-only, never row-wide.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locales.ts'
import {
  frozenSnapshot, refreshFrozen, resetFrozenStore, useFrozenSession, wakeFrozen, wakeTrigger,
} from '../src/client/session-actions/fsm-freeze.ts'
import { SessionStatusDots } from '../src/client/rows/Rows.tsx'

const t = makeTranslate(zh) as WorkspaceBrowserProps['t']

type Statuses = Parameters<typeof SessionStatusDots>[0]['statuses']
const statuses: Statuses = [{ state: 'error', label: '失败' }]

const STATE_ROUTE = '/api/task-fsm/state'
const WAKE_ROUTE = '/api/task-fsm/wake'

/** One queue-frozen record, one prereq-blocked locked record, plus the negatives. */
const statePayload = {
  ok: true,
  file: {
    tasks: {
      'content/tech/ai/dsh/tasks.md#queue-1': {
        session: { id: 'sess-queue', mode: 'frozen', reason: '排队位：等待开工核验' },
      },
      'content/tech/ai/dsh/tasks.md#prereq-1': {
        session: { id: 'sess-prereq', mode: 'locked', reason: '前置未终态：content/x.md#dep' },
      },
      'content/tech/ai/dsh/tasks.md#active-1': {
        session: { id: 'sess-active', mode: 'active', reason: '' },
      },
      'content/tech/ai/dsh/tasks.md#sessionless': {},
    },
  },
}

/** The same map with everything released — the post-wake re-read. */
const releasedPayload = {
  ok: true,
  file: {
    tasks: {
      'content/tech/ai/dsh/tasks.md#queue-1': {
        session: { id: 'sess-queue', mode: 'active', reason: '' },
      },
    },
  },
}

function jsonResponse(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data } as Response
}

/** Row probe: the real hook feeding the real badge. */
function Probe({ id }: { id: string }) {
  const frozen = useFrozenSession(id)
  return <SessionStatusDots statuses={statuses} frozen={frozen} t={t} />
}

beforeEach(() => {
  resetFrozenStore()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fsm-freeze store', () => {
  it('folds only frozen/locked records with a session id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(statePayload))
    vi.stubGlobal('fetch', fetchMock)

    await refreshFrozen()

    const map = frozenSnapshot()
    expect(map.size).toBe(2)
    expect(map.get('sess-queue')).toEqual({
      taskRef: 'content/tech/ai/dsh/tasks.md#queue-1',
      mode: 'frozen',
      reason: '排队位：等待开工核验',
    })
    expect(map.get('sess-prereq')?.mode).toBe('locked')
    expect(map.has('sess-active')).toBe(false)
    expect(map.has('sess-sessionless')).toBe(false)
    expect(fetchMock).toHaveBeenCalledWith(STATE_ROUTE, expect.anything())
  })

  it('fails open: a dead host answers the pre-badge world, never a throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('host down')))

    await expect(refreshFrozen()).resolves.toBeUndefined()
    expect(frozenSnapshot().size).toBe(0)
  })

  it('keeps the previous map when a re-read fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(statePayload))
      .mockRejectedValueOnce(new Error('blip'))
    vi.stubGlobal('fetch', fetchMock)

    await refreshFrozen()
    await refreshFrozen()

    expect(frozenSnapshot().size).toBe(2)
  })

  it('maps the wake trigger off the record reason (E4 vs E6, no new event)', () => {
    expect(wakeTrigger('排队位：等待开工核验')).toBe('quota-free')
    expect(wakeTrigger('内存地板：FreeMB 1474 < 地板 1611（mem-floor watcher）')).toBe('quota-free')
    expect(wakeTrigger('前置未终态：content/x.md#dep')).toBe('prereq-terminal')
  })

  it('posts {taskRef, trigger} on wake and re-reads the released map', async () => {
    // First state read = the frozen world (the badge's record); the post-wake
    // re-read answers the released map. One mock, two reads, in order.
    let stateReads = 0
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === WAKE_ROUTE) return Promise.resolve(jsonResponse({ ok: true, woke: true }))
      stateReads += 1
      return Promise.resolve(jsonResponse(stateReads === 1 ? statePayload : releasedPayload))
    })
    vi.stubGlobal('fetch', fetchMock)

    await refreshFrozen()
    const result = await wakeFrozen(frozenSnapshot().get('sess-queue')!)

    expect(result).toEqual({ ok: true })
    const wakeCall = fetchMock.mock.calls.find(([url]) => url === WAKE_ROUTE) as [string, { body: string }] | undefined
    expect(wakeCall).toBeDefined()
    expect(JSON.parse(wakeCall![1].body)).toEqual({
      taskRef: 'content/tech/ai/dsh/tasks.md#queue-1',
      trigger: 'quota-free',
    })
    expect(frozenSnapshot().has('sess-queue')).toBe(false)
  })

  it('answers the server error instead of throwing on a refused wake', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error: 'not frozen (nothing to wake)' }, false, 409)))

    const result = await wakeFrozen({ taskRef: 'content/x.md#t', mode: 'frozen', reason: '排队位' })

    expect(result).toEqual({ ok: false, message: 'not frozen (nothing to wake)' })
  })
})

describe('row freeze badge', () => {
  it('renders the ❄️ button with the reason only while the row is frozen', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(statePayload)))

    const { rerender } = render(<Probe id="sess-queue" />)
    const badge = await screen.findByRole('button', { name: /点击解冻/ })
    expect(badge.textContent).toBe('❄️')
    expect(badge.getAttribute('title')).toContain('排队位：等待开工核验')

    // A released session wears no badge (pre-badge world).
    rerender(<Probe id="sess-active" />)
    await waitFor(() => { expect(screen.queryByRole('button', { name: /点击解冻/ })).toBeNull() })
  })

  it('locks render 🔒', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(statePayload)))

    render(<Probe id="sess-prereq" />)
    const badge = await screen.findByRole('button', { name: /点击解冻/ })
    expect(badge.textContent).toBe('🔒')
  })

  it('clicking the badge wakes the record without firing the row click', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(url === WAKE_ROUTE ? jsonResponse({ ok: true, woke: true }) : jsonResponse(statePayload)))
    vi.stubGlobal('fetch', fetchMock)
    const rowClick = vi.fn()

    render(
      <div onClick={rowClick}>
        <Probe id="sess-queue" />
      </div>,
    )
    const badge = await screen.findByRole('button', { name: /点击解冻/ })
    fireEvent.click(badge)

    await waitFor(() => {
      const wakeCall = fetchMock.mock.calls.find(([url]) => url === WAKE_ROUTE) as [string, { body: string }] | undefined
      expect(wakeCall).toBeDefined()
      expect(JSON.parse(wakeCall![1].body)).toEqual({
        taskRef: 'content/tech/ai/dsh/tasks.md#queue-1',
        trigger: 'quota-free',
      })
    })
    expect(rowClick).not.toHaveBeenCalled()
  })
})
