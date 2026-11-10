// @vitest-environment jsdom
/**
 * FORK archive-seal-light-1101: the archive-seal row light — the lamp table
 * (archive-seal-light.md §四 灯绿/暗, asserted against the gate's 门绿 so the
 * two stay two tables), the DONE-only lamp table (seal-light-nadark-1106: N_A
 * went dark 2026-11-06 — the lamp stops guiding on a verdict with no
 * product), the 2026-11-06 running 短路 (a running row renders no
 * lamp; both running flips re-check, seal-light-running-dark-1106), the C1
 * fetch policy (visible mounted ids only, id-change / running-flip triggers,
 * ≥2s throttle, single flight, no resident polling), the fail-visible +
 * console-warn backoff over the REAL `requestSealCheck` (单1 在途 = 404 常态:
 * a failed check stamps UNKNOWN — the amber `unreadable` ring, never the
 * fail-dark silence — seal-light-host-state-1109 ④), the Host overlay
 * (`mergeHostSeals`: status-carried verdicts over the pull snapshot), the
 * row's archived/blank gate (§六.6), and the localized detail tooltip.
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
import { createSealLightStore, mergeHostSeals } from '../src/client/session-actions/seal-light.ts'
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
  it('lights green exactly on DONE — N_A went dark 2026-11-06 (seal-light-nadark-1106)', () => {
    expect(sealLightTone({ verdict: 'DONE' })).toBe('ready')
    // N_A = 本轮无产物、归不归全凭人判: the lamp stops guiding, so no tone.
    expect(sealLightTone({ verdict: 'N_A' })).toBeUndefined()
  })

  it('keeps UNSEALED dark (2026-11-02 丙-最简) but rings UNKNOWN — 查失败可见, never a dark that impersonates 未收口 (④)', () => {
    expect(sealLightTone({ verdict: 'UNSEALED' })).toBeUndefined()
    expect(sealLightTone({ verdict: 'UNKNOWN' })).toBe('unreadable')
  })

  it('keeps NEUTRAL and LEGACY dark even though the archive gate calls them green', () => {
    expect(sealLightTone({ verdict: 'NEUTRAL' })).toBeUndefined()
    expect(sealLightTone({ verdict: 'LEGACY' })).toBeUndefined()
    // The 两绿对照 of archive-seal-light.md §四 in one assertion: the gate
    // archives quietly on NEUTRAL, the lamp still asks the human.
    expect(isGreenSeal({ verdict: 'NEUTRAL' })).toBe(true)
    expect(isGreenSeal({ verdict: 'DONE' })).toBe(true)
    // The gate half is untouched by the lamp change: N_A still archives quietly.
    expect(isGreenSeal({ verdict: 'N_A' })).toBe(true)
    expect(isGreenSeal({ verdict: 'UNKNOWN' })).toBe(false)
  })

  it('stays dark while the row runs — the running short-circuit precedes the lamp table (2026-11-06)', () => {
    // A running row's verdict is the previous turn's reading: never `ready`,
    // exactly the dark row's form (seal-light-running-dark-1106).
    expect(sealLightTone({ verdict: 'DONE' }, true)).toBeUndefined()
    expect(sealLightTone({ verdict: 'N_A' }, true)).toBeUndefined()
    // The short-circuit outranks the unreadable ring too: while work runs the
    // UNKNOWN stamp is equally un-confirmable, so a running row stays dark.
    expect(sealLightTone({ verdict: 'UNKNOWN' }, true)).toBeUndefined()
    expect(sealLightTone({ verdict: 'UNKNOWN' }, false)).toBe('unreadable')
    // The short-circuit is running's alone: stopped, a green verdict lights —
    // DONE still; N_A stopped is dark since 2026-11-06 (seal-light-nadark-1106).
    expect(sealLightTone({ verdict: 'DONE' }, false)).toBe('ready')
    expect(sealLightTone({ verdict: 'N_A' }, false)).toBeUndefined()
    // Omitting the flag keeps the pre-revision table (the store registers rows as stopped).
    expect(sealLightTone({ verdict: 'DONE' })).toBe('ready')
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

  it('raises a check on BOTH running flips, painting the verdict each flip proved (false→true since 2026-11-06)', async () => {
    // Rewrite of the old 「never on false→true」 case: its premise ("while work
    // runs no save can be DONE") was disproved by a fake sentinel answering
    // DONE for a whole run (活样本 session-c879796c, 2026-11-06), so false→true
    // now re-checks — the stale reading must not hold the lamp through the run
    // (seal-light-running-dark-1106, conflict reported per AGENTS 必检 #12).
    vi.useFakeTimers()
    const answers: SealLightSeal[] = [
      { verdict: 'DONE' }, // the previous turn's reading, already on screen
      { verdict: 'UNSEALED', detail: 'sentinel-stale', followUpCount: 1 }, // the truth while running
      { verdict: 'DONE' }, // sealed again after the stop
    ]
    const request = vi.fn(async (ids: readonly SessionId[]) => {
      const seals = new Map<SessionId, SealLightSeal>()
      const answer = answers.shift()
      if (answer !== undefined) for (const id of ids) seals.set(id, answer)
      return seals
    })
    const store = createSealLightStore(request)
    store.sealRows.watch(sid('a'))
    await tick()
    expect(request).toHaveBeenCalledTimes(1)
    expect(store.observable.getSnapshot().get(sid('a'))).toEqual({ verdict: 'DONE' })

    // false→true: 开跑即复查 — the flip raises a check under the throttle.
    store.sealRows.reportRunning(sid('a'), true)
    await advance(5_000)
    expect(request).toHaveBeenCalledTimes(2)
    expect(store.observable.getSnapshot().get(sid('a')))
      .toEqual({ verdict: 'UNSEALED', detail: 'sentinel-stale', followUpCount: 1 })

    // true→false: turn 结束真值回灯 — the original trigger, unchanged.
    store.sealRows.reportRunning(sid('a'), false)
    await advance(2_000)
    expect(request).toHaveBeenCalledTimes(3)
    expect(request).toHaveBeenLastCalledWith([sid('a')])
    expect(store.observable.getSnapshot().get(sid('a'))).toEqual({ verdict: 'DONE' })
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

describe('fail-visible + warning backoff (real requestSealCheck, 单1 endpoint absent)', () => {
  it('stamps every asked row UNKNOWN on a failed check — visible degradation, never fail-dark — and warns once per backoff window', async () => {
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
    // Fail-visible (seal-light-host-state-1109 ④): the previously lit row goes
    // UNKNOWN — the lamp renders the amber dashed unreadable ring, so 查失败
    // never impersonates 未收口's dark — instead of the map clearing to empty.
    expect(store.observable.getSnapshot().get(sid('one'))).toEqual({ verdict: 'UNKNOWN' })

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
    expect(store.observable.getSnapshot().get(sid('one'))).toEqual({ verdict: 'UNKNOWN' })

    // The backoff window elapses: one retry, one more warning — not ten.
    await advance(30_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(store.observable.getSnapshot().get(sid('one'))).toEqual({ verdict: 'UNKNOWN' })
  })
})

describe('mergeHostSeals (status-carried verdicts overlay the pull snapshot)', () => {
  it('lets the host verdict win over the pull value and carries its detail fields', () => {
    const store: SealLightSnapshot = new Map([[sid('one'), { verdict: 'UNSEALED' }]])
    const statuses = new Map([[sid('one'), { seal: { verdict: 'DONE', detail: 'sentinel-ok', followUpCount: 3 } }]])
    const merged = mergeHostSeals(store, statuses)
    expect(merged.get(sid('one'))).toEqual({ verdict: 'DONE', detail: 'sentinel-ok', followUpCount: 3 })
    // The pull snapshot itself is untouched: merge is a read-side overlay.
    expect(store.get(sid('one'))).toEqual({ verdict: 'UNSEALED' })
  })

  it('keeps the pull value for a row the host holds no verdict for (拉取链 fallback)', () => {
    const store: SealLightSnapshot = new Map([[sid('one'), { verdict: 'DONE' }]])
    const statuses = new Map([
      [sid('one'), {}],
      [sid('two'), {}],
    ])
    expect(mergeHostSeals(store, statuses)).toBe(store)
  })

  it('returns the store identity when every host verdict already matches — no spurious republish', () => {
    const store: SealLightSnapshot = new Map([[sid('one'), { verdict: 'DONE' }]])
    const statuses = new Map([[sid('one'), { seal: { verdict: 'DONE' } }]])
    expect(mergeHostSeals(store, statuses)).toBe(store)
    expect(mergeHostSeals(store, new Map())).toBe(store)
  })

  it('reads a host verdict token this build does not know as UNKNOWN (fail-visible, never silent)', () => {
    const store: SealLightSnapshot = new Map()
    const statuses = new Map([[sid('one'), { seal: { verdict: 'SOMETHING_NEW' } }]])
    expect(mergeHostSeals(store, statuses).get(sid('one'))).toEqual({ verdict: 'UNKNOWN' })
  })

  it('fills a row only the host knows about', () => {
    const statuses = new Map([[sid('host-only'), { seal: { verdict: 'NEUTRAL' } }]])
    expect(mergeHostSeals(new Map(), statuses).get(sid('host-only'))).toEqual({ verdict: 'NEUTRAL' })
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

  it('renders nothing for an unsealed row even with its detail vocabulary (2026-11-02 丙-最简)', () => {
    const sealRows = observer()
    const view = render(
      <SealLight
        sessionId={sid('one')}
        running={false}
        seal={{ verdict: 'UNSEALED', detail: 'sentinel-stale', followUpCount: 3 }}
        sealRows={sealRows}
        t={t}
      />,
    )
    expect(view.container.querySelector('[data-seal-tone]')).toBeNull()
    expect(view.container.textContent).toBe('')
    // Dark or lit, a mounted lamp registers its row: the verdict arriving is
    // what lights it, so the id set does not depend on the current tone.
    expect(sealRows.watch).toHaveBeenCalledWith(sid('one'))
  })

  it('renders the amber unreadable ring for UNKNOWN with its verdict in the label (④ fail-visible)', () => {
    const sealRows = observer()
    const view = render(
      <SealLight sessionId={sid('one')} running={false} seal={{ verdict: 'UNKNOWN' }} sealRows={sealRows} t={tEn} />,
    )
    expect(view.container.querySelector('[data-seal-tone]')?.getAttribute('data-seal-tone')).toBe('unreadable')
    expect(screen.getByRole('img').getAttribute('aria-label'))
      .toBe('Archive status unreadable (UNKNOWN)')
    expect(sealRows.watch).toHaveBeenCalledWith(sid('one'))
  })

  it('renders nothing for an N_A verdict — the lamp is DONE-only since 2026-11-06 (seal-light-nadark-1106)', () => {
    const sealRows = observer()
    const view = render(
      <SealLight sessionId={sid('one')} running={false} seal={{ verdict: 'N_A' }} sealRows={sealRows} t={t} />,
    )
    expect(view.container.querySelector('[data-seal-tone]')).toBeNull()
    expect(view.container.textContent).toBe('')
    // Dark or lit, a mounted lamp still registers its row.
    expect(sealRows.watch).toHaveBeenCalledWith(sid('one'))
  })

  it('takes its copy from the dictionary: the same verdict reads English in en', () => {
    // Rides DONE since 2026-11-06: an N_A verdict renders no lamp at all
    // (seal-light-nadark-1106), so the copy assertion sits on a lit verdict.
    const sealRows = observer()
    render(<SealLight sessionId={sid('one')} running={false} seal={{ verdict: 'DONE' }} sealRows={sealRows} t={tEn} />)
    expect(screen.getByRole('img').getAttribute('aria-label'))
      .toBe('Archive ready: the save is sealed (DONE)')
  })

  it('renders nothing for NEUTRAL / LEGACY / an absent verdict — real non-green verdicts and no data stay dark', () => {
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

  it('renders nothing for a running row even on a green verdict, and lights when the turn ends (2026-11-06 running 短路)', () => {
    const sealRows = observer()
    const view = render(
      <SealLight sessionId={sid('one')} running seal={{ verdict: 'DONE' }} sealRows={sealRows} t={t} />,
    )
    // The dark-row form, byte for byte: no lamp, no tone, no text.
    expect(view.container.querySelector('[data-seal-tone]')).toBeNull()
    expect(view.container.textContent).toBe('')
    // Running or not, the mounted lamp registers and reports its running fact.
    expect(sealRows.watch).toHaveBeenCalledWith(sid('one'))
    expect(sealRows.reportRunning).toHaveBeenLastCalledWith(sid('one'), true)
    // turn 结束真值回灯: the same verdict lights the moment the row stops.
    view.rerender(
      <SealLight sessionId={sid('one')} running={false} seal={{ verdict: 'DONE' }} sealRows={sealRows} t={t} />,
    )
    expect(screen.getByRole('img', { name: '归档就绪：save 已收口（DONE）' }).getAttribute('data-seal-tone'))
      .toBe('ready')
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
  const KEYS: readonly WorkspaceKey[] = ['sealLight.ready', 'sealLight.unreadable']

  it('carries the lamp line, {v} intact, in all eight dictionaries', () => {
    for (const dictionary of [zh, en, ja, es, fr, de, ru, pt]) {
      for (const key of KEYS) {
        expect(dictionary[key], key).toBeTypeOf('string')
        expect(dictionary[key], key).toContain('{v}')
      }
    }
  })
})
