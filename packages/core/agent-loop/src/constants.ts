/** Shared agent-loop scheduler defaults.
 * @module dsh-agent-loop/constants
 */

/** Default maximum in-flight parallel-safe calls per agent step. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10

/**
 * Default upper bound (ms) the first turn waits for the agent's parked
 * creation dispatch (registry startup-barrier mode) before prompt assembly.
 * Hooks.json `timeout` semantic: on expiry the turn proceeds with a warn, so
 * a hung SessionStart hook cannot block the first turn forever.
 */
export const DEFAULT_STARTUP_BARRIER_TIMEOUT_MS = 60_000
