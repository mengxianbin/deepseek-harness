/** Client Session status plugin: the `uiSession.sessionStatus` service, the `useSessionStatus` root hook, and reading. */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: declares the `sessions` Controller service.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only service merge for ctx.slots.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { installReading } from './read.ts'
import { UiSessionStatus } from './status.ts'

export type {
  SessionCompletionOutcome, SessionStatus, SessionStatusSnapshot, UiSessionStatus, UseSessionStatus,
} from './status.ts'

/** Required Controller, Remote, generated reading namespace, access, renderer, and Session UI services. */
export const inject = ['remote', 'remote.sessionStatus', 'remoteAccess', 'sessions', 'slots', 'uiSession']

type ForkTable = ConstructorParameters<typeof UiSessionStatus>[3]

/**
 * The fork engine's raw table is the plain `sessionStatus` member of ui-session's service. The
 * first `apply()` reads it through the member fall-through; from this face's first registration
 * of the `uiSession.sessionStatus` service on, that dotted path is service-gated, so a later
 * re-enable of this plugin would throw `cannot get property "uiSession.sessionStatus" without
 * inject` (upstream guide v0.2.2-rc.2: readers must inject — and a provider cannot inject the
 * service it itself provides, which blocks boot entirely). Capture the observable per
 * ui-session service instance instead: a re-enable folds the same live table rather than
 * degrading to the reading-only face.
 */
const forkTables = new WeakMap<object, ForkTable>()

function captureForkTable(ctx: Context): ForkTable {
  const owner = ctx.uiSession as object
  if (forkTables.has(owner)) return forkTables.get(owner)
  let table: ForkTable
  try {
    table = ctx.uiSession.sessionStatus
  } catch {
    // Gated before any member read could succeed (e.g. an HMR-reminted module over an
    // already-registered path): fall back to the reading-only table.
    table = undefined
  }
  forkTables.set(owner, table)
  return table
}

/**
 * Install `ctx.uiSession.sessionStatus`, publish it through the `useSessionStatus` root hook, and follow Host reading
 * records into it.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  // Capture the fork engine's raw table before this Service registers under
  // `uiSession.sessionStatus`; after registration the dotted lookup resolves
  // to the instance being constructed.
  const status = new UiSessionStatus(
    ctx, ctx.sessions, ctx.uiSession.pendingInteractions, captureForkTable(ctx),
  )
  ctx.slots.provideRoot({ hooks: { sessionStatus: status } })
  installReading(ctx, status)
}
