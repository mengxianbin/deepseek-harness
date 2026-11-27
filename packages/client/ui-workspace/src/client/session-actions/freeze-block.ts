/**
 * §5.1 预告 + 输入预冻结（freeze-reclaim-design-1127 分期5）— the bridge
 * that turns the client-side freeze/preview maps into the conversation's
 * existing ComposerBlockRegistry, so a frozen (or preview-announced)
 * Session's composer is visibly pre-frozen:
 *
 *   · **one disabled textarea, reason as its placeholder** — the block's own
 *     contract (conversation blocked, not disabled: the model seat stays
 *     live because choosing a model is how a user clears some blocks);
 *   · **zero LLM, zero round-trips** — raising/clearing a block is a local
 *     registry write; this module never fetches;
 *   · **解冻永可用 (§6.2)** — clearing the block follows the very same maps
 *     (wake/preview-clear), so the human's unfreeze path (row ❄️ badge)
 *     always removes the input freeze with it;
 *   · the session-scoped faces are STRUCTURAL (no import of ui-conversation's
 *     implementation) — same decoupling convention liveshare uses, and the
 *     dependency direction ui-workspace → ui-conversation is already in the
 *     package inject list.
 *
 * The Phase-2 pipeline will call `setPreview` before Stop; until then the
 * frozen map alone drives the block, and fixtures drive the preview path.
 * @module ui-workspace/session-actions/freeze-block
 */
import type { FrozenMap, PreviewMap } from './fsm-freeze.ts'

/** One Session's composer block face (structural mirror of ComposerBlocks). */
interface ConversationBlocksFace {
  blocks: { set(sessionId: string, block: { readonly reason: string } | undefined): void }
}

/** The session-scoped services this bridge reads (structural, liveshare 同形). */
export interface FreezeBlockSessions {
  list: { subscribe(listener: () => void): () => void }
  scope(id: string): { get(key: 'conversation'): ConversationBlocksFace | undefined } | undefined
}

/** What the block says: a pending preview wins over the frozen record's own reason. */
export interface FreezeBlockState {
  frozen: FrozenMap
  preview: PreviewMap
}

/** Translate shape this bridge needs (the workspace locale bind; only the
 * two block keys are ever said, so the narrow key type keeps the bind
 * assignable without a cast). */
export type FreezeBlockTranslate = (
  key: 'freeze.block.frozen' | 'freeze.block.locked',
  params?: Record<string, string>,
) => string

/**
 * The reason one Session's composer states while frozen/previewed.
 * @param sessionId - the Session in question.
 * @param state - both maps in one read.
 * @param t - locale bind (keys `freeze.block.*`).
 * @returns the localized reason, or undefined when the composer stays live.
 */
export function freezeBlockReason(
  sessionId: string,
  state: FreezeBlockState,
  t: FreezeBlockTranslate,
): string | undefined {
  const previewed = state.preview.get(sessionId)
  if (previewed !== undefined) return previewed
  const frozen = state.frozen.get(sessionId)
  if (frozen === undefined) return undefined
  return frozen.mode === 'locked'
    ? t('freeze.block.locked', { reason: frozen.reason })
    : t('freeze.block.frozen', { reason: frozen.reason })
}

/**
 * Reconcile every affected composer with the two maps: raise the block for
 * Sessions that gained a reason, clear it for Sessions that lost one, and
 * leave Sessions with no conversation scope alone (the list subscription
 * re-runs this when their scope appears).
 * @param sessions - session-scoped service face.
 * @param state - both maps in one read.
 * @param tracked - Sessions whose block this bridge raised (cleared on release/dispose).
 * @param t - locale bind.
 */
export function syncFreezeBlocks(
  sessions: FreezeBlockSessions,
  state: FreezeBlockState,
  tracked: Set<string>,
  t: FreezeBlockTranslate,
): void {
  const candidates = new Set<string>([...state.frozen.keys(), ...state.preview.keys(), ...tracked])
  for (const sessionId of candidates) {
    const reason = freezeBlockReason(sessionId, state, t)
    const conversation = sessions.scope(sessionId)?.get('conversation')
    if (reason === undefined) {
      if (tracked.delete(sessionId)) conversation?.blocks.set(sessionId, undefined)
      continue
    }
    if (conversation === undefined) continue // no composer yet — the list subscription retries
    conversation.blocks.set(sessionId, { reason })
    tracked.add(sessionId)
  }
}
