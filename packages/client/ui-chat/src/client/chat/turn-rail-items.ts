/**
 * View-layer union of the host turn outline and the loaded rail items. The
 * conversation snapshot never carries projection values, so this merge is the
 * one place the rail's two sources meet: the `turnOutline` projection names
 * every turn of the session and the human interventions inside each, and the
 * loaded window supplies anchors and richer previews for the turns it holds.
 */

import type {} from '@deepseek-ai/dsh-session-turn-outline/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { TurnNavigationItem } from '../contract/snapshot.ts'

/** Which human intervention a mark addresses. */
export type TurnRailInterventionKind = 'question' | 'input'

/** One human-intervention anchor inside a Turn: an answered ask, or a later human message. */
export interface TurnRailIntervention {
  readonly turn: number
  /** The intervention's event seq; the transcript row recorded at it is what a jump aligns. */
  readonly seq: SessionSeq
  readonly kind: TurnRailInterventionKind
  /** 1-based position among this Turn's interventions of the same kind. */
  readonly ordinal: number
  /** Bounded preview of what was asked or written; `''` when the outline could not derive one. */
  readonly preview: string
}

/** One rail mark: a loaded Turn scrolls to its row; an unloaded one pages history through its seq first. */
export interface TurnRailItem {
  readonly turn: number
  /** Bounded prompt preview (loaded window first, outline fallback). */
  readonly prompt: string
  /** Bounded response preview (loaded window first, outline fallback). */
  readonly response: string
  /** Human interventions inside this Turn, ascending by seq; the outline is their only source. */
  readonly interventions: readonly TurnRailIntervention[]
  /** How the rail reaches the Turn. */
  readonly anchor:
    | { readonly kind: 'loaded'; readonly key: string }
    | { readonly kind: 'unloaded'; readonly seq: SessionSeq }
}

/** One flat rail mark: the virtualizer walks marks, not Turns, so both sit in one ladder. */
export type RailMark =
  | { readonly kind: 'turn'; readonly key: string; readonly item: TurnRailItem }
  | { readonly kind: 'intervention'; readonly key: string; readonly item: TurnRailIntervention }

const EMPTY_ITEMS: readonly TurnRailItem[] = []
const EMPTY_MARKS: readonly RailMark[] = []
const EMPTY_INTERVENTIONS: readonly TurnRailIntervention[] = []

/**
 * Structurally narrow one wire intervention (projection values cross the
 * wire). `seq` and `kind` are load-bearing — a mark without them cannot
 * exist or be named — so their damage drops it; the preview is decorative,
 * so a malformed one degrades to `''`.
 * @param value - one wire intervention.
 * @param turn - owning turn number.
 * @returns the narrowed intervention, or undefined when it is unusable.
 */
function outlineIntervention(value: unknown, turn: number): Omit<TurnRailIntervention, 'ordinal'> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const intervention = value as { seq?: unknown; kind?: unknown; preview?: unknown }
  if (typeof intervention.seq !== 'number' || !Number.isSafeInteger(intervention.seq)
    || intervention.seq < 0 || Object.is(intervention.seq, -0)) return undefined
  if (intervention.kind !== 'question' && intervention.kind !== 'input') return undefined
  return {
    turn,
    seq: SessionSeq(intervention.seq),
    kind: intervention.kind,
    preview: typeof intervention.preview === 'string' ? intervention.preview : '',
  }
}

/** Narrow every wire intervention of one turn and number each kind from one. */
function outlineInterventions(value: unknown, turn: number): readonly TurnRailIntervention[] {
  if (!Array.isArray(value) || value.length === 0) return EMPTY_INTERVENTIONS
  const ordinals: Record<TurnRailInterventionKind, number> = { question: 0, input: 0 }
  const interventions: TurnRailIntervention[] = []
  for (const raw of value) {
    const intervention = outlineIntervention(raw, turn)
    if (intervention === undefined) continue
    ordinals[intervention.kind] += 1
    interventions.push({ ...intervention, ordinal: ordinals[intervention.kind] })
  }
  return interventions.length === 0 ? EMPTY_INTERVENTIONS : interventions
}

/**
 * Structurally narrow one wire outline entry (projection values cross the
 * wire). `turn` and `seq` are the load-bearing fields — a mark cannot exist
 * or jump without them — so their damage drops the entry; the previews are
 * decorative, so a malformed one degrades to `''` and the turn stays
 * navigable by number.
 */
function outlineEntry(value: unknown): {
  turn: number
  seq: SessionSeq
  prompt: string
  response: string
  interventions: readonly TurnRailIntervention[]
} | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as { turn?: unknown; seq?: unknown; prompt?: unknown; response?: unknown; interventions?: unknown }
  if (typeof entry.turn !== 'number' || !Number.isSafeInteger(entry.turn) || entry.turn < 0) return undefined
  if (typeof entry.seq !== 'number' || !Number.isSafeInteger(entry.seq) || entry.seq < 0 || Object.is(entry.seq, -0)) return undefined
  return {
    turn: entry.turn,
    seq: SessionSeq(entry.seq),
    prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
    response: typeof entry.response === 'string' ? entry.response : '',
    interventions: outlineInterventions(entry.interventions, entry.turn),
  }
}

/** Wire outline entries, or none when the projection is absent or malformed. */
function outlineEntries(outline: unknown): readonly unknown[] {
  return Array.isArray(outline) ? outline : EMPTY_ITEMS
}

/**
 * Merge the host outline with the loaded rail items into the full ladder.
 * A turn present in both sides keeps the loaded anchor, taking an outline
 * preview only where the window's own is empty (a mid-Turn window head, or a
 * turn whose loaded nodes carry no text); turns on one side only pass
 * through. Result ascends by turn.
 * @param loaded - loaded-window rail items (timeline order).
 * @param outline - `turnOutline` projection value, treated as wire data.
 * @returns every known turn, ascending; a stable empty array when none.
 */
export function mergeTurnRailItems(
  loaded: readonly TurnNavigationItem[],
  outline: unknown,
): readonly TurnRailItem[] {
  const byTurn = new Map<number, TurnRailItem>()
  for (const raw of outlineEntries(outline)) {
    const entry = outlineEntry(raw)
    if (entry === undefined) continue
    byTurn.set(entry.turn, {
      turn: entry.turn,
      prompt: entry.prompt,
      response: entry.response,
      interventions: entry.interventions,
      anchor: { kind: 'unloaded', seq: entry.seq },
    })
  }
  for (const item of loaded) {
    const preview = byTurn.get(item.turn)
    byTurn.set(item.turn, {
      turn: item.turn,
      prompt: item.prompt !== '' ? item.prompt : preview?.prompt ?? '',
      response: item.response !== '' ? item.response : preview?.response ?? '',
      interventions: preview?.interventions ?? EMPTY_INTERVENTIONS,
      anchor: { kind: 'loaded', key: item.anchorKey },
    })
  }
  if (byTurn.size === 0) return EMPTY_ITEMS
  return [...byTurn.values()].sort((left, right) => left.turn - right.turn)
}

/**
 * Flatten merged turns into the rail's one ladder: each Turn's own mark
 * first, then its interventions in reading order. Ascending by turn and,
 * within one, by seq — the order a reader walks the transcript in, and the
 * order the prev/next intervention controls step through.
 * @param items - merged rail items, ascending by turn.
 * @returns every mark, or a stable empty array when none.
 */
export function railMarks(items: readonly TurnRailItem[]): readonly RailMark[] {
  if (items.length === 0) return EMPTY_MARKS
  const marks: RailMark[] = []
  for (const item of items) {
    marks.push({ kind: 'turn', key: `turn:${String(item.turn)}`, item })
    for (const intervention of item.interventions) {
      marks.push({ kind: 'intervention', key: `input:${String(item.turn)}:${String(intervention.seq)}`, item: intervention })
    }
  }
  return marks
}
