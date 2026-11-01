/**
 * Publication ordering gate for Workspace-attached create/fork Sessions.
 *
 * The agent-loop publishes a fresh Session before its setup window runs the
 * attach hook, so an `api-session/added` frame emitted at `session/created`
 * reaches the client before the Workspace feed establishes the row's group:
 * the row renders ungrouped and then jumps (the S2 flash). A gated creation
 * withholds that first frame and re-publishes it exactly once — when the
 * attach hook settles, in either loop order — so the row's first visibility
 * already carries its Workspace membership. Attach failure settles the gate
 * the same way: the row must still appear (its Ungrouped fallback) under the
 * unchanged `session/workspace-attach-failed` contract.
 *
 * Only create/fork paths that wired an attach hook ever hold the gate; reuse
 * and resume never do, so their publication is untouched.
 */

import type { Session, SessionId } from '@deepseek-ai/dsh-session'

/** One gated creation between its hold and its single published frame. */
interface GateEntry {
  /** `suppressing` withholds frames; `latched` has published and swallows the agent/created duplicate. */
  phase: 'suppressing' | 'latched'
  /** The announced Session, remembered so a later attach settle can publish it. */
  session?: Session
  /** Whether the attach hook has settled (success or recorded failure). */
  attachSettled: boolean
}

/**
 * Hold a Workspace-attached creation's first `api-session/added` frame until
 * its attach settles, then publish it exactly once.
 */
export class SessionPublicationGate {
  /**
   * Publisher for the withheld frame, installed by the Session Controller's
   * listener wiring; unset in controller-less unit harnesses, where no
   * `api-session/added` listener exists to withhold from.
   */
  publish: ((session: Session) => void) | undefined

  private readonly entries = new Map<SessionId, GateEntry>()

  /**
   * Gate the Session an attaching create/fork is about to publish.
   * @param sessionId - identity of the creation whose first frame is held.
   */
  hold(sessionId: SessionId): void {
    this.entries.set(sessionId, { phase: 'suppressing', attachSettled: false })
  }

  /**
   * Decide what a `session/created` frame does for a gated Session.
   * @param session - the announced Session.
   * @returns true when the caller emits the frame; false when the gate
   *   withholds it — or has just re-published it after an attach that
   *   settled before the announcement (a setup-first loop order).
   */
  sessionCreated(session: Session): boolean {
    const entry = this.entries.get(session.id)
    if (entry === undefined) return true
    entry.session = session
    if (entry.attachSettled) this.publishLatched(entry, session)
    return false
  }

  /**
   * Release the withheld frame once the attach hook settles — the row's
   * first visible frame then carries the membership the Workspace feed has
   * already delivered, whatever the loop's internal order does next. The
   * held frame publishes the announced Session the gate remembered, so the
   * caller only owes the shared Agent/Session id.
   * @param sessionId - identity of the attaching (or attach-failed) creation.
   */
  attachSettled(sessionId: SessionId): void {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return
    entry.attachSettled = true
    if (entry.session !== undefined) this.publishLatched(entry, entry.session)
  }

  /**
   * Decide what `agent/created` availability does for a gated Session: its
   * re-emission would duplicate the frame this gate publishes for the same
   * creation, so a published creation's duplicate is swallowed.
   * @param sessionId - identity of the announced Agent.
   * @returns true when the caller emits; false when the gate swallows it.
   */
  agentCreated(sessionId: SessionId): boolean {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return true
    if (entry.phase === 'latched') this.entries.delete(sessionId)
    return false
  }

  /**
   * Decide what `agent/disposed` availability does for a gated Session.
   * A disposal during a gated creation means the creation is folding back;
   * its withheld frame must never surface as a row that then vanishes.
   * @param sessionId - identity of the disposing Agent.
   * @returns true when the caller emits; false when the gate swallows it.
   */
  agentDisposed(sessionId: SessionId): boolean {
    return !this.entries.delete(sessionId)
  }

  /**
   * Drop a gated creation without publishing: the Session never became a row.
   * @param sessionId - identity whose gate state is discarded.
   */
  release(sessionId: SessionId): void {
    this.entries.delete(sessionId)
  }

  private publishLatched(entry: GateEntry, session: Session): void {
    entry.phase = 'latched'
    this.publish?.(session)
  }
}
