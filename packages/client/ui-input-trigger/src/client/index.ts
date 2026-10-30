/**
 * Slash trigger plugin, browser half: the InputTriggerService (`ctx.inputTriggers`) owning
 * trigger detection, the candidate menu, and the pick pipeline; MenuView
 * self-registers into the conversation.input.overlay slot (the resident
 * InputBar's card) and the conversation.composer.overlay slot (an elected
 * composer takeover's card, e.g. the question composer's answer field on the
 * answer surface). Frozen pipeline contract in ./contract.ts; sources register
 * through ctx.inputTriggers alone.
 */
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { InputTriggerService } from './service.ts'
import type { MenuViewInjected } from './slots.ts'
import { MenuView } from './MenuView.tsx'
import { en, ja, es, fr, de, ru, pt, zh, type MenuKey } from './locales.ts'

export { InputTriggerService } from './service.ts'
export { InputTriggerController } from './controller.ts'
export type { AnswerSurfaceInsert, InputTriggerControllerDeps, SourceRoster } from './controller.ts'
export type { MenuViewInjected } from './slots.ts'
export type { MenuViewProps } from './MenuView.tsx'
export type { MenuKey } from './locales.ts'
export type {
  ArbitrateKey, ArbitrateOutcome, BeginCommandRequest, CandidateRequest, ClientSessionContext,
  CommandClaim, ConsumeTokenRequest, HeaderRequest, InsertReferenceRequest, PickOutcome, PickVia,
  ReferenceCodec, ReferenceInsert, InputTriggerCandidate, InputTriggerCrumb, InputTriggerPick,
  InputTriggerSource, SubmitAttachment, SubmitEnvelope, SubmitOutcome, TokenSpan, TriggerChar,
  TriggerGuard, TriggerPosition, TriggerSurface,
} from '../types.ts'
export type { DetectTrigger, ExactMatch, MenuEvent, MenuReduce, MenuState, TriggerHit } from '../core/contract.ts'
export type { InputTriggerServiceContract } from './contract.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    inputTriggers: import('./contract.ts').InputTriggerServiceContract
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The candidate menu's copy: group titles keyed by source name, the pending row, and the listbox aria. */
    'slash.menu': MenuKey
  }
}

/** Namespace owning the candidate-menu copy. */
const MENU_NS = 'slash.menu'

/** Required services: controller resolution reads the session scope tree; the menu copy is localized. */
export const inject = ['sessions', 'locale']

/**
 * Client plugin body: mount the service, then register MenuView into both
 * composer overlay slots once their declarers are up.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.plugin(InputTriggerService)
  ctx.effect(() => ctx.locale.register(MENU_NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-input-trigger: menu dictionaries')
  ctx.inject(['slots', 'inputTriggers', 'sessions'], (scope: ClientContext) => {
    const inputTriggers = scope.inputTriggers
    const sessions = scope.sessions
    // Session-scoped slot: resolve this session's controller (the slot
    // frame hands ids, not ctx — the registered id→ctx interchange). Shared
    // by both overlay anchors, so one menu store serves whichever composer
    // surface owns the seat.
    const menuInjected = (sessionId: SessionId): MenuViewInjected => {
      const actx = sessions.scope(sessionId)
      if (actx === undefined) throw new Error(`ui-input-trigger: session "${String(sessionId)}" resolved no scope`)
      const controller = inputTriggers.sessionOf(actx)
      return {
        menu: controller.menu,
        headers: controller.headers,
        onPick: (source, index, action) => { controller.pick(source, index, action) },
        onCrumb: (source, index) => { controller.pickCrumb(source, index) },
        onHover: (source, index) => { controller.hover(source, index) },
        onDismiss: () => { controller.dismiss() },
      }
    }
    scope.slots.inject('conversation.input.overlay', () => scope.slots.register({
      name: 'conversation.input.overlay',
      id: 'slash-menu',
      order: 0,
      locale: MENU_NS,
      inject: sessionId => menuInjected(sessionId),
    }, MenuView))
    scope.slots.inject('conversation.composer.overlay', () => scope.slots.register({
      name: 'conversation.composer.overlay',
      id: 'slash-menu',
      order: 0,
      locale: MENU_NS,
      inject: sessionId => menuInjected(sessionId),
    }, MenuView))
  })
}
