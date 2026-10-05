/** Per-session guard against an accidental stop landing right after Send flips to Stop. */

/** Windows in milliseconds; both are supplied by a thunk so a caller may read live config. */
export interface StopGateWindows {
  /** Suppression window counted back from the last accepted send. */
  readonly sendWindowMs: number
  /** Suppression window counted back from the Send→Stop flip. */
  readonly stopWindowMs: number
}

/**
 * One gate per session. The double-click accident needs two events: a send the
 * user actually meant, and the primary button flipping to Stop behind it. The
 * gate timestamps both and refuses a stop that lands inside either window —
 * anchoring on the flip is what closes the gap a send-only window leaves when
 * the network delays the running transition past the send window.
 *
 * Scope is per session, so parallel conversations never swallow each other's
 * clicks; the windows arrive as a thunk so a live config value (rather than a
 * construction-time copy) governs every check.
 */
export class StopGate {
  /** `-Infinity` keeps the first check open regardless of the clock origin. */
  private sendAt = Number.NEGATIVE_INFINITY
  private flipAt = Number.NEGATIVE_INFINITY

  constructor(private readonly windows: () => StopGateWindows) {}

  /**
   * Whether a send may fire. An accepted send stamps the gate so the stop that
   * a second click would become is suppressed behind it.
   * @param now - injected clock, for tests.
   * @returns whether the send proceeds.
   */
  allowSend(now: number = performance.now()): boolean {
    if (now - this.sendAt < this.windows().sendWindowMs) return false
    this.sendAt = now
    return true
  }

  /**
   * Stamps the primary button flipping from Send to Stop.
   * @param now - injected clock, for tests.
   */
  noteStopFlip(now: number = performance.now()): void {
    this.flipAt = now
  }

  /**
   * Whether a stop may run: it must fall outside both the send window and the
   * flip window. A stop neither window covers is a deliberate one.
   * @param now - injected clock, for tests.
   * @returns whether the stop proceeds.
   */
  allowStop(now: number = performance.now()): boolean {
    const { stopWindowMs } = this.windows()
    return now - this.sendAt >= stopWindowMs && now - this.flipAt >= stopWindowMs
  }
}
