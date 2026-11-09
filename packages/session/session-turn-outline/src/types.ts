/**
 * Pure types of the turn-outline domain: the ONE home of the `turnOutline`
 * projection-key declaration, free of this package's host-side value imports
 * (zod, the projection definition). Host consumers import `./types`; client
 * aggregates import `./client`, which re-exports this module.
 *
 * @module @deepseek-ai/dsh-session-turn-outline/types
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'

export {}

/** What a human did inside a Turn, so the rail can name the mark it jumps to. */
export type TurnOutlineInterventionKind = 'question' | 'input'

/**
 * One human-intervention anchor inside a Turn: an answered decision request,
 * or a later human message admitted into the running Turn. Neither opens a
 * Turn, so neither has a `turn/start` of its own to page history through —
 * the intervention's own event seq is the load-through target instead.
 */
export interface TurnOutlineIntervention {
  /** The intervention's event seq; the rail aligns the row recorded at it. */
  readonly seq: SessionSeq
  /** Which intervention this is. */
  readonly kind: TurnOutlineInterventionKind
  /** Bounded preview of what was asked or written; `''` when it cannot be derived. */
  readonly preview: string
}

/** One started turn's outline facts, independent of what a client has paged in. */
export interface TurnOutlineEntry {
  /** Host-assigned turn number (the `turn/start` payload). */
  readonly turn: number
  /** The turn's `turn/start` event seq — paging a window back through this seq loads the whole turn. */
  readonly seq: SessionSeq
  /** Bounded first-human-prompt preview (one rail-card line); `''` until an eligible prompt lands. */
  readonly prompt: string
  /** Bounded final-response preview (up to three rail-card lines); `''` until the turn ends with assistant text. */
  readonly response: string
  /** Human interventions inside this Turn, ascending by seq; empty for a Turn its opening input alone touched. */
  readonly interventions: readonly TurnOutlineIntervention[]
}

/**
 * Fold state: the served entries, the open turn's response draft, and the
 * decision requests awaiting their result. The draft buffers the newest
 * text-bearing assistant message until `turn/end` commits it, and the wire
 * view projects only `turns` — draft-only and pending-only applies keep that
 * array's identity, so the change feed stays quiet between turn boundaries.
 */
export interface TurnOutlineState {
  /** Started turns in ascending turn order. */
  readonly turns: readonly TurnOutlineEntry[]
  /** Newest text-bearing assistant preview of the open turn; `''` outside one. */
  readonly draft: string
  /**
   * Ask call ids awaiting their `tool/result`, each with the preview captured
   * at `tool/call`, so a later result is recognized as a decision without
   * re-deriving the tool name. Capped: a call that never returns must not
   * grow the state.
   */
  readonly pendingAsks: readonly { readonly callId: string; readonly preview: string }[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Every started turn with its `turn/start` seq, bounded previews, and the
     * human interventions inside it, strictly increasing by turn; see
     * {@link TurnOutlineEntry}. Excluded from Session summary payloads: the
     * outline grows with the whole log and no list row renders it.
     */
    turnOutline: SessionProjectionSummaryExcluded<readonly TurnOutlineEntry[]>
  }
}
