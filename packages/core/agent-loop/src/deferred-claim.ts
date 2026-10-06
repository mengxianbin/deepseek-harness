/**
 * Durable deferred-claim projection: claimed input the loop parked while the
 * surface was still virgin, folded from `agent/claim-deferred` records and
 * released by the `user/message` that materializes it.
 *
 * The fold is the idempotent-by-id restoration oracle: a defer record whose id
 * already has a `user/message` is already materialized, so a restart or fork
 * seed restores only claims the log still lacks. Rejects, empty rewrites, and
 * discarded (canceled) input never write a defer record, so they can never
 * re-enter through this state.
 *
 * @module @deepseek-ai/dsh-agent-loop/deferred-claim
 */

import type { DeferredClaimState } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

/** State validation for pending deferred claims reconstructed from durable records. */
export const deferredClaimProjectionSchema = z.object({
  messages: z.array(z.custom<UserMessage>()).readonly(),
}).readonly()

/**
 * Standard fold that restores parked claims and drops them once a
 * `user/message` with the same id commits. Returning the previous state
 * reference on no-ops keeps the eager drive from publishing phantom changes.
 */
export const deferredClaimProjectionDefinition = {
  key: 'deferredClaim',
  stateSchema: deferredClaimProjectionSchema,
  init: (): DeferredClaimState => ({ messages: [] }),
  apply(state: DeferredClaimState, event) {
    if (event.type === 'agent/claim-deferred') {
      const pending = new Set(state.messages.map(message => message.id))
      const restored = event.data.messages.filter(message => !pending.has(message.id))
      return restored.length === 0 ? state : { messages: [...state.messages, ...restored] }
    }
    if (event.type === 'user/message') {
      const index = state.messages.findIndex(message => message.id === event.data.id)
      return index < 0 ? state : { messages: state.messages.toSpliced(index, 1) }
    }
    return state
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'deferredClaim', DeferredClaimState>
