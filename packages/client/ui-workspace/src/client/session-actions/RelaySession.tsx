/**
 * The relay action (FORK session-relay-1106): one hover button on a Session
 * row that hands the Session's unfinished work to a fresh Session. The
 * injected callback owns the whole chain — dispatch the successor in the
 * owning Workspace, seat and open it, then archive this row through the seal
 * gate — and this component owns only what the row shows: when the button
 * exists, when it is disabled, and which reason its tooltip names.
 *
 * The gate is deliberate. The button is visible on a real row (not the blank
 * placeholder, not archived, not without archive access) and never hidden
 * for being unsealed: a disabled button with a reason beats an invisible
 * one. It enables only while the row's C1 verdict is exactly `DONE` and the
 * Session is stopped — fail-closed, the mirror of the archive gate's
 * fail-open green groups, because dispatching must never race a save.
 * Pending covers the server calls only: save is never in this path (the
 * button is a thin orchestrator over dispatch + archive, direction 7), and
 * a successor already dispatched spends the row — the button hides rather
 * than ever offering a second relay.
 */
import { useId, useState } from 'react'
import { IconRightUpOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RelaySessionInjected, SessionRowActionProps } from '../contract/slots.ts'
import css from '../rows/Rows.module.css'

/** Why the button cannot act right now; undefined means it can. */
type RelayGate = 'pending' | 'running' | 'seal'

/**
 * The row's relay button. Absent on a blank, archived, or access-refused
 * row; disabled with its reason in the tooltip while the Session runs, its
 * seal is not exactly `DONE`, or a relay is in flight.
 * @param props - owner share, the relay share, the access Hook, and the global standard seats.
 * @returns the button, its reason line, or nothing when relay does not apply.
 */
export function RelaySessionRowButton(props: SessionRowActionProps<RelaySessionInjected>) {
  const { sessionId, blank, useArchived, useSealLight, useSessionAccess, useSessionStatus, useSessions, relaySession, t } = props
  const reasonId = useId()
  const [phase, setPhase] = useState<'idle' | 'pending' | 'done'>('idle')
  const archived = useArchived(set => set.has(sessionId))
  const verdict = useSealLight(snapshot => snapshot.get(sessionId)?.verdict)
  // Same fallback the row's own node uses (tree.ts): the live status wins,
  // the list summary carries the Host's state until a baseline lands.
  const running = useSessionStatus(statuses => statuses.get(sessionId)?.running)
    ?? useSessions(list => list.byId[sessionId]?.running) ?? false
  const allowed = useSessionAccess(sessionId, 'workspace/archiveSession')
  // Hooks all run before the gate, per the rules of hooks; the access verdict
  // shares the early exit with blank and archived.
  if (blank || archived || !allowed || phase === 'done') return null
  const gate: RelayGate | undefined = phase === 'pending' ? 'pending'
    : running ? 'running'
      : verdict !== 'DONE' ? 'seal'
        : undefined
  const disabled = gate !== undefined
  const reason = !disabled ? ''
    : gate === 'pending' ? t('relay.pending')
      : gate === 'running' ? t('relay.disabled.running')
        : t('relay.disabled.seal')
  return (
    <>
      <Tooltip label={disabled ? reason : t('actions.relay')} side="bottom" align="end" delayMs={500} portal>
        {/* Native disabled buttons do not deliver the hover/focus events Tooltip needs. */}
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('actions.relay')}
          aria-disabled={disabled || undefined}
          aria-describedby={disabled ? reasonId : undefined}
          data-unavailable={disabled || undefined}
          onClick={disabled ? undefined : () => {
            setPhase('pending')
            void relaySession(sessionId).then(
              (dispatched) => { setPhase(dispatched ? 'done' : 'idle') },
              // A rejection breaks the never-rejects contract; recover the row
              // instead of pinning it pending forever. The notice, when there
              // is one, was already raised inside the callback.
              (error: unknown) => { console.warn('session relay rejected:', error); setPhase('idle') },
            )
          }}
        >
          <IconRightUpOutlineRegular size={14} />
        </button>
      </Tooltip>
      {disabled && <span id={reasonId} className={css.visuallyHidden}>{reason}</span>}
    </>
  )
}
