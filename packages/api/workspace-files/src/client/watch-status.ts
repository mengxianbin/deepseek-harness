/**
 * Degraded watch status by file address.
 *
 * The provider falls back to a single `stat` when the Host's `changes`
 * subscription is not acknowledged in time (see {@link markWatchDegraded}): the
 * file's metadata still loads, but no live invalidation arrives, so the
 * preview shows a stale file without knowing it. This registry is the one
 * place that fact lives; the document preview subscribes and says so.
 *
 * One boolean per address, last writer wins: two tabs on the same file share
 * the Host stream and with it the same fate, so a per-tab state would report
 * the same fact twice. The state is dropped when the last subscriber leaves —
 * a preview that closes takes its hint with it, and a fresh open re-evaluates.
 */

/** The listener signature of one address's degraded state. */
type Listener = (degraded: boolean) => void

const states = new Map<string, boolean>()
const listeners = new Map<string, Set<Listener>>()

/**
 * Report that this address's watch did not acknowledge in time.
 * @param address - the `file` resource address that timed out.
 */
export function markWatchDegraded(address: string): void {
  set(address, true)
}

/**
 * Drop a previous degradation: this address is under evaluation again.
 *
 * A clean first open has nothing to clear and notifies nobody.
 * @param address - the `file` resource address being reopened.
 */
export function clearWatchDegraded(address: string): void {
  if (states.get(address) === true) set(address, false)
}

/**
 * Subscribe to one address's degraded state.
 * @param address - the `file` resource address to watch.
 * @param listener - called on every change and once with the current state on subscribe.
 * @returns the unsubscribe; the last one out drops the address's state.
 */
export function subscribeWatchDegraded(address: string, listener: Listener): () => void {
  let set0 = listeners.get(address)
  if (set0 === undefined) {
    set0 = new Set()
    listeners.set(address, set0)
  }
  set0.add(listener)
  listener(states.get(address) ?? false)
  return () => {
    const current = listeners.get(address)
    if (current === undefined) return
    current.delete(listener)
    if (current.size > 0) return
    listeners.delete(address)
    states.delete(address)
  }
}

/** Publish one address's new state to its subscribers. */
function set(address: string, degraded: boolean): void {
  if (states.get(address) === degraded) return
  states.set(address, degraded)
  for (const listener of listeners.get(address) ?? []) listener(degraded)
}
