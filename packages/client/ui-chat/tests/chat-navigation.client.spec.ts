// @vitest-environment jsdom
/** Recorded layout arithmetic supplements browser geometry; no browser layout is asserted here. */
import { afterEach, expect, it, vi } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ChatNavigation, type ChatNavigationInput } from '../src/client/chat/use-chat-navigation.ts'
import { ChatReading } from '../src/client/chat/use-chat-reading.ts'
import { ChatViewport } from '../src/client/chat/use-chat-viewport.ts'
import { ScrollFollow } from '../src/client/chat/use-scroll-follow.ts'
import type { RailMark, TurnRailIntervention, TurnRailItem } from '../src/client/chat/turn-rail-items.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
})

/** One recorded transcript row. */
interface RowSpec {
  readonly top: number
  readonly height: number
  readonly turn: number
  readonly node: string
  readonly anchorSeq?: number
}

/** Four Turns in a 400px scrollport; Turn 1 also holds the only marked intervention, and Turn 4 an unmarked one. */
const ROWS: readonly RowSpec[] = [
  { top: 0, height: 60, turn: 1, node: 'n1' },
  { top: 60, height: 60, turn: 1, node: 'i69', anchorSeq: 69 },
  { top: 120, height: 400, turn: 1, node: 'r1' },
  { top: 520, height: 300, turn: 2, node: 'n2' },
  { top: 820, height: 600, turn: 2, node: 'r2' },
  { top: 1420, height: 200, turn: 3, node: 'n3' },
  { top: 1620, height: 400, turn: 3, node: 'r3' },
  { top: 2020, height: 100, turn: 4, node: 'n4' },
  { top: 2120, height: 60, turn: 4, node: 'u621', anchorSeq: 621 },
  { top: 2180, height: 600, turn: 4, node: 'r4' },
]

const INTERVENTION: TurnRailIntervention = {
  turn: 1, seq: SessionSeq(69), kind: 'input', ordinal: 1, preview: '',
}

function turnItem(turn: number): TurnRailItem {
  return {
    turn, prompt: '', response: '', interventions: [],
    anchor: { kind: 'loaded', key: `n${String(turn)}` },
  }
}

const FIRST_MARK: RailMark = { kind: 'turn', key: 'turn:1', item: { ...turnItem(1), interventions: [INTERVENTION] } }
const LAST_MARK: RailMark = { kind: 'turn', key: 'turn:4', item: turnItem(4) }

/** The rail's flat ladder: each Turn first, then its interventions, ascending. */
const MARKS: RailMark[] = [
  FIRST_MARK,
  { kind: 'intervention', key: 'input:1:69', item: INTERVENTION },
  { kind: 'turn', key: 'turn:2', item: turnItem(2) },
  { kind: 'turn', key: 'turn:3', item: turnItem(3) },
  LAST_MARK,
]

/** Scroll positions that put the reading line on a chosen row (row top aligned 24px below the scrollport top). */
const AT_TURN_2 = 520 - 24
const AT_INTERVENTION = 60 - 24
const IN_TURN_4_REPLY = 2_300

/**
 * Attach one viewport over the recorded rows and a navigation owner reading it.
 * @param top - initial scroll position of the scrollport.
 * @param mounted - whether the Turns carry anchors in the loaded window.
 * @returns the navigation under test.
 */
function fixture(top: number, mounted = true): { navigation: ChatNavigation } {
  const column = document.createElement('div')
  column.dataset.chatFlow = ''
  document.body.append(column)
  Object.defineProperties(column, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 3_000 },
  })
  vi.spyOn(column, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 400))
  for (const row of ROWS) {
    const element = document.createElement('div')
    element.textContent = row.node
    element.dataset.chatNodeKey = row.node
    element.dataset.chatAnchorKey = row.node
    element.dataset.chatFlowKey = row.node
    element.dataset.chatPagingAnchor = ''
    element.dataset.chatTurn = String(row.turn)
    if (row.anchorSeq !== undefined) {
      element.dataset.chatAnchorSeq = String(row.anchorSeq)
      element.dataset.chatIntervention = String(row.anchorSeq)
    }
    column.append(element)
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() =>
      new DOMRect(0, row.top - column.scrollTop, 500, row.height))
  }
  const viewport = new ChatViewport()
  viewport.attach(column, column)
  if (mounted) {
    viewport.updateTurns([1, 2, 3, 4].map(turn => ({
      turn, anchorKey: `n${String(turn)}`, prompt: '', response: '',
    })))
  }
  column.scrollTop = top
  const reading = new ChatReading(
    viewport,
    { read: () => null, save: vi.fn() },
    { initialized: true, followingTail: false, activeTurn: null },
    vi.fn(),
    new ScrollFollow(false, 25),
  )
  const input: ChatNavigationInput = {
    firstSeq: null,
    hasMore: true,
    loadingOlder: false,
    loadOlder: vi.fn(),
    loadThrough: vi.fn(() => new Promise<void>(() => {})),
  }
  const navigation = new ChatNavigation(viewport, reading, input, vi.fn())
  cleanups.push(() => { viewport.detach(); column.remove() })
  return { navigation }
}

it('steps down to the next mark instead of adopting an earlier Turn\'s intervention above the line', () => {
  const { navigation } = fixture(AT_TURN_2)
  expect(navigation.stepIntervention(MARKS, 1)?.key).toBe('turn:3')
})

it('steps up to the previous mark instead of walking past it into an earlier Turn', () => {
  const { navigation } = fixture(AT_TURN_2)
  expect(navigation.stepIntervention(MARKS, -1)?.key).toBe('input:1:69')
})

it('adopts the reading Turn\'s own intervention once the line reaches it', () => {
  const up = fixture(AT_INTERVENTION)
  expect(up.navigation.stepIntervention(MARKS, -1)?.key).toBe('turn:1')
  const down = fixture(AT_INTERVENTION)
  expect(down.navigation.stepIntervention(MARKS, 1)?.key).toBe('turn:2')
})

it('falls back to the reading Turn when the visible intervention carries no mark', () => {
  const { navigation } = fixture(IN_TURN_4_REPLY)
  expect(navigation.stepIntervention(MARKS, -1)?.key).toBe('turn:3')
})

it('keeps the visible intervention as the position while no Turn is mounted', () => {
  const { navigation } = fixture(AT_INTERVENTION, false)
  expect(navigation.stepIntervention(MARKS, -1)?.key).toBe('turn:1')
})

it('walks off both edges when nothing measures a position, instead of the downward step claiming the top', () => {
  // No Turn is mounted and the visible intervention carries no mark, so the reading line names
  // no position and this rail has never landed: both directions must stop rather than the
  // downward step jumping to the first mark while the upward one is a dead end.
  const down = fixture(IN_TURN_4_REPLY, false)
  expect(down.navigation.stepIntervention(MARKS, 1)).toBeUndefined()
  const up = fixture(IN_TURN_4_REPLY, false)
  expect(up.navigation.stepIntervention(MARKS, -1)).toBeUndefined()
})

it('steps from the last mark this rail landed on while no Turn is mounted', () => {
  const end = fixture(IN_TURN_4_REPLY, false)
  end.navigation.navigateTo(LAST_MARK)
  expect(end.navigation.stepIntervention(MARKS, 1)).toBeUndefined()

  const start = fixture(IN_TURN_4_REPLY, false)
  start.navigation.navigateTo(FIRST_MARK)
  expect(start.navigation.stepIntervention(MARKS, -1)).toBeUndefined()

  const inside = fixture(IN_TURN_4_REPLY, false)
  inside.navigation.navigateTo(FIRST_MARK)
  expect(inside.navigation.stepIntervention(MARKS, 1)?.key).toBe('input:1:69')
  expect(inside.navigation.stepIntervention(MARKS, -1)?.key).toBe('turn:1')
})
