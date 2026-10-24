/** Running-Session count behind the restart confirmation copy. */
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'

/**
 * Count the Sessions the status snapshot reports as established running; a
 * Session without a baseline (`running` not yet known) does not count.
 * @param status - current Session status snapshot.
 * @returns how many Sessions are running.
 */
export function countRunningSessions(status: SessionStatusSnapshot): number {
  let count = 0
  for (const entry of status.values()) {
    if (entry.running === true) count += 1
  }
  return count
}
