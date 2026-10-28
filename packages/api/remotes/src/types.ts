/**
 * Type face of the forwarded-Host-event allowlist: the consumer key projection
 * and the selection seat it fills. The allowlist VALUE lives in
 * `./remote-events.ts`, keeping this module type-only per the package
 * convention; both compiler faces list both files, so the Host forwarding loop
 * and the consumer `ctx.remote.$on` key face read one declaration instead of
 * two copies that could drift.
 *
 * @module @deepseek-ai/dsh-api-remotes/types
 */

import type { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'

/** Type projection of the allowlist; the consumer and the Host read this one. */
export type ApiRemoteForwardedEvent = typeof API_REMOTE_FORWARDED_EVENTS[number]['event']

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<ApiRemoteForwardedEvent, true> {}
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The Host's restart-signal polling sensor recomputed the state machine
     * after a moved source or configuration fingerprint; subscribed pages
     * recheck to publish the fresh judgment (restart-signal design C.5, the
     * host-detect → push leg that closes R3「页面开着不操作角标自现」).
     * Payload-free by design: the judgment itself rides the recheck route,
     * not the event, so the channel cannot drift from the state machine.
     * Declared here rather than in the ui-settings-general owner package:
     * that package consumes this assembly on its Client face, so an
     * owner-side declaration would close a project-reference cycle.
     * @mode emit
     */
    'restart-signal/changed'(): void
  }
}
