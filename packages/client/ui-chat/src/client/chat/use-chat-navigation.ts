/** Turn jumps and history-prepend anchoring, independent of DOM measurement. */
import { useLayoutEffect, useState } from 'react'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { RailMark } from './turn-rail-items.ts'
import type { ChatReading, ReadingSample } from './use-chat-reading.ts'
import type { ChatViewport, ViewportLanding } from './use-chat-viewport.ts'

/** History availability and loading operations for the committed Chat window. */
export interface ChatNavigationInput extends Pick<ChatViewSlotProps, 'loadOlder' | 'loadThrough'> {
  readonly firstSeq: ChatNode['anchorSeq'] | null
  readonly hasMore: boolean
  readonly loadingOlder: boolean
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

/** Owns one replaceable turn jump and the anchor retained while history loads. */
export class ChatNavigation {
  private jump: TurnJump | null = null
  private settleFrame: number | null = null

  constructor(
    private readonly viewport: ChatViewport,
    private readonly reading: ChatReading,
    private input: ChatNavigationInput,
    private readonly onBusyTurn: (turn: number | null) => void,
  ) {}

  /**
   * Adopt committed history availability without starting a request.
   * @param input - history state from the latest committed render.
   */
  setInput(input: ChatNavigationInput): void { this.input = input }

  /** Cancel navigation when opening a Chat view. */
  reset(): void {
    this.cancel()
  }

  /** Cancel local callbacks; late history completions cannot revive a task. */
  dispose(): void {
    this.clearTask()
  }

  /** Release the jump, paging anchor, and busy indicator without cancelling shared history I/O. */
  cancel(): void {
    this.clearTask()
    this.onBusyTurn(null)
  }

  private clearTask(): void {
    this.cancelFrame()
    this.jump = null
    this.viewport.stopPreserving()
  }

  /**
   * Replace the current jump with an explicit rail selection.
   * @param mark - a Turn mark, or a human-intervention mark inside one.
   */
  readonly navigateTo = (mark: RailMark): void => {
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
   * Step to the neighbouring human-intervention mark in reading order, which
   * is how a Turn holding several decisions becomes walkable without hunting
   * for each row. The current position is the newest intervention at or above
   * the reading line; with none loaded there, the reading line's own Turn
   * decides whether the neighbour is an older, still-unloaded mark.
   * @param marks - the rail's flattened marks, ascending by Turn and seq.
   * @param delta - `1` for the next intervention, `-1` for the previous one.
   */
  readonly stepIntervention = (marks: readonly RailMark[], delta: 1 | -1): void => {
    const interventions = marks.filter((mark): mark is Extract<RailMark, { kind: 'intervention' }> =>
      mark.kind === 'intervention')
    if (interventions.length === 0) return
    const loaded = this.viewport.readVisibleIntervention()
    let target: Extract<RailMark, { kind: 'intervention' }> | undefined
    if (loaded === null) {
      const turn = this.viewport.readVisibleTurn()
      target = delta > 0
        ? interventions.find(mark => turn === null || mark.item.turn >= turn)
        : interventions.findLast(mark => turn !== null && mark.item.turn < turn)
    } else {
      target = delta > 0
        ? interventions.find(mark => mark.item.seq > loaded)
        : interventions.findLast(mark => mark.item.seq < loaded)
    }
    if (target !== undefined) this.navigateTo(target)
  }

  /** Accept a landing that needs no history request; @returns whether it landed. */
  private acceptLanding(landing: ViewportLanding | null): boolean {
    if (landing === null) return false
    this.reading.acceptNavigation(landing)
    if (this.input.loadingOlder) this.viewport.beginPreserving(landing.position)
    return true
  }

  /** Request one older page while retaining the current semantic position. */
  readonly loadEarlier = (): void => {
    this.cancel()
    this.viewport.beginPaging()
    this.reading.pauseFollowing()
    this.input.loadOlder()
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

  /** Retarget a still-loading page only after inner or outer reader scrolling ends. */
  readerSettled(): void {
    if (this.input.loadingOlder && this.jump === null && !this.viewport.preserving && !this.reading.followingTail) {
      this.viewport.beginPreserving()
    }
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
): { navigation: ChatNavigation; busyTurn: number | null } {
  const [busyTurn, setBusyTurn] = useState<number | null>(null)
  const [navigation] = useState(() => new ChatNavigation(viewport, reading, input, setBusyTurn))
  useLayoutEffect(() => { navigation.setInput(input) }, [navigation, input])
  useLayoutEffect(() => () => { navigation.dispose() }, [navigation])
  return { navigation, busyTurn }
}
