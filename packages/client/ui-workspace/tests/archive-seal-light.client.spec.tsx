// @vitest-environment jsdom
/**
 * FORK archive-seal-light-1101: the archive-seal row light — the lamp table
 * (archive-seal-light.md §四 灯绿/暗, asserted against the gate's 门绿 so the
 * two stay two tables), the C1 fetch policy (visible mounted ids only,
 * id-change / running-flip triggers, ≥2s throttle, single flight, no resident
 * polling), the fail-dark + console-warn backoff over the REAL
 * `requestSealCheck` (单1 在途 = 404 常态), the row's archived/blank gate
 * (§六.6), and the localized detail tooltip.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  SealLightSeal, SealLightSnapshot, SealRowObserver, WorkspaceBrowserProps,
} from '../src/client/contract/slots.ts'
import type { SessionNode } from '../src/client/tree.ts'
import { SealLight, sealLightTone } from '../src/client/rows/SealLight.tsx'
import { SessionNodeItem } from '../src/client/rows/Rows.tsx'
import { createSealLightStore } from '../src/client/session-actions/seal-light.ts'
import { isGreenSeal } from '../src/client/session-actions/seal.ts'
import { de, en, es, fr, ja, pt, ru, zh, type WorkspaceKey } from '../src/client/locales.ts'

const sid = (id: string) => id as SessionId
const t = makeTranslate(zh) as WorkspaceBrowserProps['t']
const tEn = makeTranslate(en) as WorkspaceBrowserProps['t']

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** One inert row observer that records what a mounted lamp drives. */
function observer() {
  const release = vi.fn()
  const watch = vi.fn(() => release)
  const reportRunning = vi.fn()
  return { watch, reportRunning, release } as const
}

/** Advance the fake clock, then drain the microtasks a dispatch leaves behind. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await Promise.resolve()
}

/** Run the timers due right now (the store arms its first check at delay 0). */
async function tick(): Promise<void> {
  await advance(0)
}

/** The id set a fake C1 answers for: every asked id, green for `greenId`. */
function answerFor(greenId: SessionId) {
  return async (ids: readonly SessionId[]): Promise<Map<SessionId, SealLightSeal>> => {
    const seals = new Map<SessionId, SealLightSeal>()
    for (const id of ids) seals.set(id, { verdict: id === greenId ? 'DONE' : 'NEUTRAL' })
    return seals
  }
}

describe('sealLightTone (design §四: the lamp green is not the gate green)', () => {
  it('lights green exactly on DONE and N_A', () => {
    expect(sealLightTone({ verdict: 'DONE' })).toBe('ready')
    expect(sealLightTone({ verdict: 'N_A' })).toBe('ready')
  })

  it('lights red exactly on UNSEALED and UNKNOWN', () => {
    expect(sealLightTone({ verdict: 'UNSEALED' })).toBe('blocked')
    expect(sealLightTone({ verdict: 'UNKNOWN' })).toBe('blocked')
  })

  it('keeps NEUTRAL and LEGACY dark even though the archive gate calls them green', () => {
    expect(sealLightTone({ verdict: 'NEUTRAL' })).toBeUndefined()
    expect(sealLightTone({ verdict: 'LEGACY' })).toBeUndefined()
    // The 两绿对照 of archive-seal-light.md §四 in one assertion: the gate
    // archives quietly on NEUTRAL, the lamp still asks the human.
    expect(isGreenSeal({ verdict: 'NEUTRAL' })).toBe(true)
    expect(isGreenSeal({ verdict: 'DONE' })).toBe(true)
    expect(isGreenSeal({ verdict: 'UNKNOWN' })).toBe(false)
  })
})

describe('createSealLightStore (the C1 fetch policy)', () => {
  it('asks once for every mounted lamp row and paints what comes back', async () => {
    vi.useFakeTimers()
    const request = vi.fn(answerFor(sid('a')))
    const store = createSealLightStore(request)
    store.sealRows.watch(sid('a'))
    store.sealRows.watch(sid('b'))
    await tick()
    // Both mounts ride one dispatch: the arm is a macrotask, so every row
    // that mounts in the same commit is in the same batch.
    expect(request).toHaveBeenCalledExactlyOnceWith([sid('a'), sid('b')])
    expect(store.observable.getSnapshot().get(sid('a'))).toEqual({ verdict: 'DONE' })
    expect(store.observable.getSnapshot().get(sid('b'))).toEqual({ verdict: 'NEUTRAL' })
  })

  it('refetches on an id-set change, throttled to ≥2s between checks', async () => {
    vi.useFakeTimers()
    const request = vi.fn(answerFor(sid('a')))
    const store = createSealLightStore(request)
    store.sealRows.watch(sid('a'))
    await tick()
    expect(request).toHaveBeenCalledTimes(1)

    const release = store.sealRows.watch(sid('b'))
    await advance(1_999)
    expect(request).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith([sid('a'), sid('b')])

    // A row leaving the list is an id-set change too, and obeys the same gap.
    release()
    await advance(1_999)
    expect(request).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(request).toHaveBeenCalledTimes(3)
    expect(request).toHaveBeenLastCalledWith([sid('a')])
  })

  it('raises a check on a running true→false flip and never on false→true', async () => {
    vi.useFakeTimers()
    const request = vi.fn(answerFor(sid('a')))
    const store = createSealLightStore(request)
    store.sealRows.watch(sid('a'))
    await tick()
    expect(request).toHaveBeenCalledTimes(1)

    store.sealRows.reportRunning(sid('a'), true)
    await advance(5_000)
    expect(request).toHaveBeenCalledTimes(1)

    store.sealRows.reportRunning(sid('a'), false)
    await advance(2_000)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith([sid('a')])
  })

  it('never runs two checks at once: a trigger mid-flight waits its turn', async () => {
    vi.useFakeTimers()
    let answer: ((seals: Map<SessionId, SealLightSeal> | null) => void) | undefined
    const request = vi.fn(() => new Promise<Map<SessionId, SealLightSeal> | null>((resolve) => { answer = resolve }))
    const store = createSealLightStore(request)
    store.sealRows.watch(sid('a'))
    await tick()
    expect(request).toHaveBeenCalledTimes(1)

    store.sealRows.watch(sid('b'))
    await advance(5_000)
    expect(request).toHaveBeenCalledTimes(1)

    answer?.(new Map())
    await advance(2_000)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith([sid('a'), sid('b')])
  })

  it('settles into silence without a resident poll', async () => {
    vi.useFakeTimers()
    const request = vi.fn(answerFor(sid('a')))
    const store = createSealLightStore(request)
    store.sealRows.watch(sid('a'))
    await tick()
    expect(request).toHaveBeenCalledTimes(1)
    await advance(120_000)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('asks nothing when no lamp is mounted', async () => {
    vi.useFakeTimers()
    const request = vi.fn(answerFor(sid('a')))
    const store = createSealLightStore(request)
    const release = store.sealRows.watch(sid('a'))
    release()
    await tick()
    expect(request).not.toHaveBeenCalled()
    expect(store.observable.getSnapshot().size).toBe(0)
  })

  it('answers dark for a row the service says nothing about (行无数据 → 暗)', async () => {
    vi.useFakeTimers()
    const answers = [answerFor(sid('a')), () => new Map<SessionId, SealLightSeal>()]
    const request = vi.fn((ids: readonly SessionId[]) => {
      const answer = answers.shift()
      /* v8 ignore next -- both calls above are prepared by this test. */
      return answer === undefined ? Promise.resolve(null) : Promise.resolve(answer(ids))
    })
    const store = createSealLightStore(request)
    store.sealRows.watch(sid('a'))
    await tick()
    expect(store.observable.getSnapshot().get(sid('a'))).toEqual({ verdict: 'DONE' })

    store.sealRows.watch(sid('b'))
    await advance(2_000)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith([sid('a'), sid('b')])
    expect(store.observable.getSnapshot().size).toBe(0)
  })
})

describe('fail-dark + warning backoff (real requestSealCheck, 单1 endpoint absent)', () => {
  it('paints every light dark on a failed check and warns once per backoff window', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ id: 'one', verdict: 'DONE' }] }),
      })
      .mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    const store = createSealLightStore()

    store.sealRows.watch(sid('one'))
    await tick()
    expect(store.observable.getSnapshot().get(sid('one'))).toEqual({ verdict: 'DONE' })
    expect(warn).not.toHaveBeenCalled()

    // The flip is the stated trigger; the answer is the expected 404常态.
    store.sealRows.reportRunning(sid('one'), true)
    store.sealRows.reportRunning(sid('one'), false)
    await advance(2_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Fail-dark: the previously lit lamp goes out instead of staying stale.
    expect(store.observable.getSnapshot().size).toBe(0)
    expect(warn).toHaveBeenCalledExactlyOnceWith('seal check rejected: HTTP 404')

    // Ten more flip waves inside the cooldown: the failure state still costs
    // exactly one warning — seal.ts warns per attempt, so the store simply
    // stops attempting (翻转不再 warn).
    for (let wave = 0; wave < 10; wave++) {
      store.sealRows.reportRunning(sid('one'), true)
      store.sealRows.reportRunning(sid('one'), false)
      await advance(1_000)
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)

    // The backoff window elapses: one retry, one more warning — not ten.
    await advance(30_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(store.observable.getSnapshot().size).toBe(0)
  })
})

describe('SealLight (the lamp on the row)', () => {
  it('paints green with its verdict in the localized tooltip', async () => {
    vi.useFakeTimers()
    const sealRows = observer()
    render(<SealLight sessionId={sid('one')} running={false} seal={{ verdict: 'DONE' }} sealRows={sealRows} t={t} />)
    const lamp = screen.getByRole('img', { name: '归档就绪：save 已收口（DONE）' })
    expect(lamp.getAttribute('data-seal-tone')).toBe('ready')
    fireEvent.pointerEnter(lamp)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(screen.getByRole('tooltip').textContent).toBe('归档就绪：save 已收口（DONE）')
  })

  it('folds the detail vocabulary and the stale follow-up count into one label', () => {
    const sealRows = observer()
    render(
      <SealLight
        sessionId={sid('one')}
        running={false}
        seal={{ verdict: 'UNSEALED', detail: 'sentinel-stale', followUpCount: 3 }}
        sealRows={sealRows}
        t={t}
      />,
    )
    const lamp = screen.getByRole('img')
    expect(lamp.getAttribute('data-seal-tone')).toBe('blocked')
    expect(lamp.getAttribute('aria-label'))
      .toBe('未收口：归档前先处理（UNSEALED） · 上次 save 已 DONE、其后续聊 3 条')
  })

  it('names an unreadable verdict with its own line (UNKNOWN is not 未收口)', () => {
    const sealRows = observer()
    render(<SealLight sessionId={sid('one')} running={false} seal={{ verdict: 'UNKNOWN' }} sealRows={sealRows} t={t} />)
    expect(screen.getByRole('img').getAttribute('aria-label'))
      .toBe('收口状态不可读：归档前先处理（UNKNOWN）')
  })

  it('takes its copy from the dictionary: the same verdict reads English in en', () => {
    const sealRows = observer()
    render(<SealLight sessionId={sid('one')} running={false} seal={{ verdict: 'N_A' }} sealRows={sealRows} t={tEn} />)
    expect(screen.getByRole('img').getAttribute('aria-label'))
      .toBe('Archive ready: the save is sealed (N_A)')
  })

  it('renders nothing for NEUTRAL / LEGACY / an absent verdict (fail-dark)', () => {
    const seals: readonly (SealLightSeal | undefined)[] = [
      { verdict: 'NEUTRAL' }, { verdict: 'LEGACY' }, undefined,
    ]
    for (const seal of seals) {
      const sealRows = observer()
      const view = render(<SealLight sessionId={sid('one')} running={false} seal={seal} sealRows={sealRows} t={t} />)
      expect(view.container.querySelector('[data-seal-tone]')).toBeNull()
      expect(view.container.textContent).toBe('')
      cleanup()
      // Dark or lit, a mounted lamp registers its row: the verdict arriving is
      // what lights it, so the id set does not depend on the current tone.
      expect(sealRows.watch).toHaveBeenCalledWith(sid('one'))
    }
  })

  it('registers on mount, reports running flips in place, releases on unmount', () => {
    const sealRows = observer()
    const view = render(
      <SealLight sessionId={sid('one')} running={false} seal={undefined} sealRows={sealRows} t={t} />,
    )
    expect(sealRows.watch).toHaveBeenCalledWith(sid('one'))
    expect(sealRows.reportRunning).toHaveBeenCalledWith(sid('one'), false)
    expect(sealRows.release).not.toHaveBeenCalled()

    view.rerender(
      <SealLight sessionId={sid('one')} running seal={{ verdict: 'DONE' }} sealRows={sealRows} t={t} />,
    )
    expect(sealRows.reportRunning).toHaveBeenLastCalledWith(sid('one'), true)

    view.unmount()
    expect(sealRows.release).toHaveBeenCalledTimes(1)
  })
})

describe('the lamp’s seat on a Session row (design §三 / §六.6)', () => {
  const row = (overrides: Partial<SessionNode> = {}): SessionNode => ({
    id: sid('one'),
    title: 'One',
    blank: false,
    running: false,
    runningSubagentCount: 0,
    completed: false,
    updatedAt: 0,
    pinned: false,
    archived: false,
    ...overrides,
  })
  const seals = (seal: SealLightSeal | undefined): SealLightSnapshot =>
    seal === undefined ? new Map() : new Map([[sid('one'), seal]])

  function renderRow(node: SessionNode, snapshot: SealLightSnapshot, sealRows: SealRowObserver) {
    return render(
      <SessionNodeItem
        node={node}
        currentId={undefined}
        now={0}
        onOpen={vi.fn()}
        onRenameRequest={vi.fn()}
        renderSlot={() => null}
        seals={snapshot}
        sealRows={sealRows}
        useSessionAccess={allowAllAccess.useSessionAccess}
        t={t}
      />,
    )
  }

  it('hangs the lamp on a visible row and watches it', () => {
    const sealRows = observer()
    renderRow(row(), seals({ verdict: 'DONE' }), sealRows)
    expect(screen.getByRole('img', { name: '归档就绪：save 已收口（DONE）' })).toBeTruthy()
    expect(sealRows.watch).toHaveBeenCalledWith(sid('one'))
    expect(sealRows.reportRunning).toHaveBeenCalledWith(sid('one'), false)
  })

  it('keeps an archived row dark and out of the check’s id set (§六.6)', () => {
    const sealRows = observer()
    renderRow(row({ archived: true }), seals({ verdict: 'DONE' }), sealRows)
    expect(screen.queryByRole('img')).toBeNull()
    expect(sealRows.watch).not.toHaveBeenCalled()
  })

  it('keeps a blank placeholder dark and out of the check’s id set', () => {
    const sealRows = observer()
    renderRow(row({ blank: true }), seals({ verdict: 'DONE' }), sealRows)
    expect(screen.queryByRole('img')).toBeNull()
    expect(sealRows.watch).not.toHaveBeenCalled()
  })

  it('mounts the registration for a row with no verdict yet (dark, awaiting C1)', () => {
    const sealRows = observer()
    renderRow(row(), seals(undefined), sealRows)
    expect(screen.queryByRole('img')).toBeNull()
    expect(sealRows.watch).toHaveBeenCalledWith(sid('one'))
  })

  it('renders no lamp in a composition without the channel (pre-fork wiring)', () => {
    render(
      <SessionNodeItem
        node={row()}
        currentId={undefined}
        now={0}
        onOpen={vi.fn()}
        onRenameRequest={vi.fn()}
        renderSlot={() => null}
        seals={seals({ verdict: 'DONE' })}
        useSessionAccess={allowAllAccess.useSessionAccess}
        t={t}
      />,
    )
    expect(screen.queryByRole('img')).toBeNull()
  })
})

describe('the light copy ships with every published language', () => {
  // The literal keys are checked against `WorkspaceKey` at compile time (a
  // typo stops the build), and every dictionary already `satisfies` that key
  // set — the runtime check below covers the placeholder and the values.
  const KEYS: readonly WorkspaceKey[] = ['sealLight.ready', 'sealLight.blocked', 'sealLight.unreadable']

  it('carries all three lamp lines, {v} intact, in all eight dictionaries', () => {
    for (const dictionary of [zh, en, ja, es, fr, de, ru, pt]) {
      for (const key of KEYS) {
        expect(dictionary[key], key).toBeTypeOf('string')
        expect(dictionary[key], key).toContain('{v}')
      }
    }
  })
})
