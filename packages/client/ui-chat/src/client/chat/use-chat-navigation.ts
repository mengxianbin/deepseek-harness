/** Turn jumps and history-prepend anchoring, independent of DOM measurement. */
import { useLayoutEffect, useState } from 'react'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { RailMark } from './turn-rail-items.ts'
import type { ChatReading, ReadingSample } from './use-chat-reading.ts'
import type { ChatViewport, ViewportLanding } from './use-chat-viewport.ts'

/** History availability and loading operations for the committed Chat window. */
export interface ChatNavigationInput extends Pick<ChatViewSlotProps, 'loadOlder' | 'loadThrough' | 'consumeOlder'> {
  readonly firstSeq: ChatNode['anchorSeq'] | null
  readonly hasMore: boolean
  readonly loadingOlder: boolean
  readonly historyLoadStatus: SessionSnapshot['historyLoadStatus']
  readonly isOpen: boolean
}

interface TurnJump {
  readonly turn: number
  readonly seq: SessionSeq
  /** Row to align once history covers the jump; `null` aligns the Turn's own anchor. */
  readonly anchorSeq: number | null
  phase: 'loading' | 'settled'
  landing: 'pending' | 'landed' | 'interrupted'
  repageHead: ChatNavigationInput['firstSeq']
}

type HistoryIntent = 'none' | 'auto' | 'manual'

/** Owns one replaceable turn jump and the anchor retained while history loads. */
export class ChatNavigation {
  private jump: TurnJump | null = null
  private settleFrame: number | null = null
  /** Last mark this owner navigated to; stands in while the reading line measures no position. */
  private landed: string | null = null
  private historyFrame: number | null = null
  private historyIntent: HistoryIntent = 'none'
  private historyRequested = false

  constructor(
    private readonly viewport: ChatViewport,
    private readonly reading: ChatReading,
    private input: ChatNavigationInput,
    private readonly onBusyTurn: (turn: number | null) => void,
    private readonly onHistoryIntent: (intent: HistoryIntent) => void = () => {},
  ) {}

  /**
   * Adopt committed history availability without starting a request.
   * @param input - history state from the latest committed render.
   */
  setInput(input: ChatNavigationInput): void {
    this.input = input
    this.historyRequested = false
    if (!input.isOpen || input.historyLoadStatus === 'error' || !input.hasMore) this.setHistoryIntent('none')
  }

  /** Cancel navigation when opening a Chat view. */
  reset(): void {
    this.cancel()
    this.landed = null
  }

  /** Cancel local callbacks; late history completions cannot revive a task. */
  dispose(): void {
    this.clearTask()
    if (this.historyFrame !== null) cancelAnimationFrame(this.historyFrame)
    this.historyFrame = null
  }

  /** Release the jump, paging anchor, and busy indicator without cancelling shared history I/O. */
  cancel(): void {
    this.setHistoryIntent('none')
    this.clearTask()
    this.onBusyTurn(null)
  }

  /** Release a jump after reader input without cancelling an accepted history click. */
  readerInteracted(): void {
    this.clearTask()
    this.onBusyTurn(null)
  }

  private clearTask(): void {
    this.cancelFrame()
    this.jump = null
    this.viewport.stopPreserving()
    this.viewport.cancelHistoryPrepend()
  }

  /**
   * Replace the current jump with an explicit rail selection.
   * @param mark - a Turn mark, or a human-intervention mark inside one.
   */
  readonly navigateTo = (mark: RailMark): void => {
    this.landed = mark.key
    if (mark.kind === 'turn') {
      this.cancel()
      if (mark.item.anchor.kind === 'loaded') {
        this.acceptLanding(this.viewport.scrollToTurn(mark.item.turn))
        return
      }
      this.beginJump(mark.item.turn, mark.item.anchor.seq, null)
      return
    }
    this.cancel()
    // An intervention whose row is already mounted lands directly; history
    // only has to buy rows the window has not delivered.
    if (this.acceptLanding(this.viewport.scrollToSeq(mark.item.seq, mark.item.turn))) return
    this.beginJump(mark.item.turn, mark.item.seq, mark.item.seq)
  }

  /** Open a paging jump through `seq`, landing on `anchorSeq` once history covers it. */
  private beginJump(turn: number, seq: SessionSeq, anchorSeq: number | null): void {
    this.viewport.beginPreserving()
    this.reading.pauseFollowing()
    const jump: TurnJump = { turn, seq, anchorSeq, phase: 'loading', landing: 'pending', repageHead: null }
    this.jump = jump
    this.onBusyTurn(jump.turn)
    this.request(jump)
  }

  /**
   * Step to the neighbouring mark on the rail's flat ladder — Turn marks and
   * human-intervention marks alike — so every node stays walkable without
   * hunting for each row and the step carries no sense of mark kind. The
   * current position is the newest mark at or above the reading line: the
   * reading line's own Turn's intervention when one lies at or above the
   * line, otherwise the reading line's own Turn's mark. An intervention of an
   * earlier Turn never counts — it lies far above the line, and adopting it
   * would send the next step back into that older Turn instead of to the mark
   * beside the line; with no mounted Turn its visible intervention still
   * counts. When neither the line nor a mounted Turn names a position, the
   * last mark this rail landed on stands in; with no such mark either
   * direction walks off the edge instead of the downward step claiming the
   * ladder's top, so the two directions always agree at both ends.
   * @param marks - the rail's flattened marks, ascending by Turn and seq.
   * @param delta - `1` for the next mark, `-1` for the previous one.
   * @returns the mark the step landed on, or undefined when it walked off an edge.
   */
  readonly stepIntervention = (marks: readonly RailMark[], delta: 1 | -1): RailMark | undefined => {
    if (marks.length < 2) return undefined
    const intervention = this.viewport.readVisibleIntervention()
    const turn = this.viewport.readVisibleTurn()
    let position: number | null = null
    if (intervention !== null) {
      const current = marks.findIndex(mark => mark.kind === 'intervention' && mark.item.seq === intervention)
      if (current >= 0 && (turn === null || marks[current]?.item.turn === turn)) position = current
    }
    if (position === null && turn !== null) {
      const own = marks.findIndex(mark => mark.kind === 'turn' && mark.item.turn === turn)
      const inherited = own >= 0 ? own : marks.findLastIndex(mark => mark.item.turn < turn)
      if (inherited >= 0) position = inherited
    }
    if (position === null && this.landed !== null) {
      const settled = marks.findIndex(mark => mark.key === this.landed)
      if (settled >= 0) position = settled
    }
    if (position === null) return undefined
    const target = marks[position + delta]
    if (target === undefined) return undefined
    this.navigateTo(target)
    return target
  }

  /** Accept a landing that needs no history request; @returns whether it landed. */
  private acceptLanding(landing: ViewportLanding | null): boolean {
    if (landing === null) return false
    this.reading.acceptNavigation(landing)
    if (this.input.loadingOlder) this.viewport.beginPreserving(landing.position)
    return true
  }

  /** Request and consume one page, retaining the click until success, exhaustion, or failure. */
  readonly loadEarlier = (): void => {
    this.cancel()
    this.setHistoryIntent('manual')
    this.reading.pauseFollowing()
    if (this.input.historyLoadStatus === 'error') {
      this.historyRequested = true
      this.input.loadOlder()
    } else this.requestHistoryCheck()
  }

  private setHistoryIntent(intent: HistoryIntent): void {
    if (intent === this.historyIntent) return
    this.historyIntent = intent
    this.onHistoryIntent(intent)
  }

  /** Coalesce event-driven checks; waiting never schedules its own next frame. */
  requestHistoryCheck(): void {
    if (!this.input.isOpen || this.input.historyLoadStatus === 'error') return
    if (this.historyIntent === 'none' && (this.input.historyLoadStatus !== 'idle'
      || !this.input.hasMore || this.reading.followingTail)) return
    if (this.historyFrame !== null || typeof requestAnimationFrame !== 'function') return
    this.historyFrame = requestAnimationFrame(() => {
      this.historyFrame = null
      this.checkHistory()
    })
  }

  private checkHistory(): void {
    const input = this.input
    if (!input.isOpen || this.jump !== null || this.historyRequested || input.loadingOlder) return
    if (input.historyLoadStatus === 'error') return
    if (input.historyLoadStatus === 'pendingConsumption') {
      if (this.historyIntent === 'none') return
      if (this.reading.followingTail && this.historyIntent === 'auto') {
        this.setHistoryIntent('none')
        return
      }
      if (this.historyIntent === 'manual') {
        this.viewport.beginManualPaging()
        this.reading.pauseFollowing()
        this.consumeHistory('preserve')
        return
      }
      const mode = this.viewport.historyConsumption()
      switch (mode) {
        case 'touch':
        case 'inner-scroll':
          return
        case 'motion':
        case 'pointer':
        case 'unavailable':
          this.setHistoryIntent('none')
          return
        case 'prepend':
          if (!this.viewport.beginHistoryPrepend() && input.firstSeq !== null) {
            this.setHistoryIntent('none')
            return
          }
          break
        case 'preserve':
        case 'native':
          break
      }
      if (mode === 'preserve') {
        this.viewport.beginPreserving()
        if (!this.viewport.preserving) this.viewport.beginPaging()
        if (!this.viewport.preserving && input.firstSeq !== null) {
          this.setHistoryIntent('none')
          return
        }
        this.reading.pauseFollowing()
      }
      this.consumeHistory(mode)
      return
    }
    if (!input.hasMore || this.historyIntent !== 'manual' && (this.reading.followingTail
      || !this.viewport.confirmHistoryStart())) return
    if (this.historyIntent === 'none') this.setHistoryIntent('auto')
    this.historyRequested = true
    input.loadOlder()
  }

  private consumeHistory(mode: 'native' | 'preserve' | 'prepend'): void {
    this.historyRequested = true
    if (this.input.consumeOlder()) this.setHistoryIntent('none')
    else {
      this.historyRequested = false
      if (mode === 'preserve') this.viewport.stopPreserving()
      if (mode === 'prepend') this.viewport.cancelHistoryPrepend()
    }
  }

  /**
   * Preserve reader ownership across pending history work.
   * @param sample - settled reader movement that can update or interrupt an anchor.
   */
  readerSampled(sample: ReadingSample): void {
    if (sample.movedByReader && this.jump?.landing === 'landed') this.jump.landing = 'interrupted'
    if (sample.followingTail || sample.movedByReader) this.viewport.stopPreserving()
  }

  /**
   * Preserve one paging anchor after a commit or a later size change, regardless of head identity.
   * @returns whether the retained anchor handled the layout change.
   */
  contentCommitted(): boolean {
    if (!this.viewport.preserving || this.reading.pending) return false
    if (this.landJump(false)) return true
    const landing = this.viewport.preserve()
    if (landing === null) return false
    this.reading.preservePosition(landing)
    return true
  }

  /** Land, retry, or complete the current jump against the committed window. */
  reconcile(): void {
    const jump = this.jump
    if (jump === null || this.reading.pending) return
    if (jump.phase === 'loading') {
      if (jump.landing === 'pending') this.landJump(false)
      return
    }
    if (this.input.loadingOlder) return
    if (this.landJump(true)) return
    const uncovered = this.input.firstSeq === null || this.input.firstSeq > jump.seq
    if (uncovered && this.input.hasMore && jump.repageHead !== this.input.firstSeq) {
      jump.repageHead = this.input.firstSeq
      this.viewport.beginPreserving()
      this.request(jump)
      return
    }
    const fallback = this.viewport.scrollToTurnAtOrAfter(jump.turn)
    this.cancel()
    if (fallback !== null) this.reading.acceptNavigation(fallback)
  }

  private landJump(settle: boolean): boolean {
    const jump = this.jump
    if (jump === null) return false
    if (jump.landing === 'interrupted') {
      if (settle) { this.cancel(); return true }
      return false
    }
    const landing = jump.anchorSeq === null
      ? this.viewport.scrollToTurn(jump.turn)
      : this.viewport.scrollToSeq(jump.anchorSeq, jump.turn) ?? this.viewport.scrollToTurn(jump.turn)
    if (landing === null) return false
    this.reading.acceptNavigation(landing)
    if (settle) this.cancel()
    else {
      this.viewport.beginPreserving(landing.position)
      jump.landing = 'landed'
    }
    return true
  }

  private request(jump: TurnJump): void {
    jump.phase = 'loading'
    const settled = (): void => {
      if (this.jump !== jump) return
      jump.phase = 'settled'
      this.cancelFrame()
      if (typeof requestAnimationFrame !== 'function') this.reconcile()
      else this.settleFrame = requestAnimationFrame(() => {
        this.settleFrame = null
        if (this.jump === jump) this.reconcile()
      })
    }
    void this.input.loadThrough(jump.seq).then(settled, settled)
  }

  private cancelFrame(): void {
    if (this.settleFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.settleFrame)
    this.settleFrame = null
  }
}

/**
 * Retain one navigation owner for the component's lifetime.
 * @param viewport - turn-aware DOM operations.
 * @param reading - reading and follow policy receiving navigation landings.
 * @param input - committed history state and load operations.
 * @returns the navigation owner and its visible busy turn.
 */
export function useChatNavigation(
  viewport: ChatViewport, reading: ChatReading, input: ChatNavigationInput,
): { navigation: ChatNavigation; busyTurn: number | null; historyPending: boolean; historyProcessing: boolean } {
  const [busyTurn, setBusyTurn] = useState<number | null>(null)
  const [historyIntent, setHistoryIntent] = useState<HistoryIntent>('none')
  const [navigation] = useState(() => new ChatNavigation(viewport, reading, input, setBusyTurn, setHistoryIntent))
  useLayoutEffect(() => { navigation.setInput(input) }, [navigation, input])
  useLayoutEffect(() => () => { navigation.dispose() }, [navigation])
  return { navigation, busyTurn, historyPending: historyIntent === 'manual', historyProcessing: historyIntent !== 'none' }
}
