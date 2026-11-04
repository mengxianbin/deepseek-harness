/**
 * The auto-route controller poll read (2026-11-04 ruling: sustained meter-
 * poll failure is an availability fact for the 安康盾). The dsh-auto-route
 * plugin stamps `<dsh-home>/auto-route-poll-state.json` after EVERY tick
 * (its30–60 s cadence + up to 15 s meter timeout), so the heartbeat sweep
 * rides this reader on its own 15 s tick — one small JSON file plus a
 * freshness judgment, folded into the SAME `api-session/health` frame as the
 * Session invariants and the 值守总账 (同一数据源同一周期, step2 §4.3).
 *
 * Deliberate inverse of the duty reader's fail-closed: the duty collector is
 * MANDATORY (absence = a watch that should run did not), while auto-route is
 * an OPTIONAL plugin (absence = not installed / disabled / writer stopped =
 * the plane is not attached — never "broken"). Only a fresh, parseable
 * ledger speaks, and only its `sustained` verdict may redden the shield —
 * transient misses stay non-sustained so a blip never rings the alarm
 * (狼来了 discipline; the glance tooltip keeps showing the live route's
 * transient state on its own channel).
 *
 * File-name twin: dsh-auto-route `src/poll-state.ts` `POLL_STATE_FILE` —
 * keep the two constants in sync.
 */
import { readFileSync, statSync } from 'node:fs'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { AutoRoutePollReport } from './types.ts'

/** The plugin's ledger filename under the DSH home (twin: dsh-auto-route poll-state.ts). */
export const AUTO_ROUTE_POLL_FILE = 'auto-route-poll-state.json'

/**
 * Freshness bound: 3× the controller's 60 s poll clamp. The writer stamps
 * the file every tick, so an older file means the writer stopped — the plane
 * detaches instead of guessing (a stale file must neither fake health nor
 * grow a failure streak forever). 3× absorbs the 15 s meter timeout and a
 * slow tick without ever detaching a live writer.
 */
export const AUTO_ROUTE_STALE_MS = 180_000

/**
 * The sustained-failure alarm threshold: the ruling's ~5 minutes of
 * consecutive misses (≈ N=7 at the 45 s default cadence). Time-based, not
 * count-based, so a cadence change inside the 30–60 s clamp cannot silently
 * retune the alarm.
 */
export const AUTO_ROUTE_SUSTAINED_MS = 300_000

/**
 * Read the auto-route poll ledger for one sweep tick.
 * @param now - epoch ms for freshness and streak-age judgments (injectable for tests).
 * @param statePath - ledger location (injectable for tests); defaults to the
 *   DSH-home single source the plugin writes.
 * @returns the folded verdict, or `undefined` when the plane is not attached
 *   (missing / unreadable / stale ledger — optional plugin, never broken).
 */
export function readAutoRoutePoll(
  now = Date.now(),
  statePath = dshHomePath(AUTO_ROUTE_POLL_FILE),
): AutoRoutePollReport | undefined {
  try {
    const text = readFileSync(statePath, 'utf8')
    const ageMs = now - statSync(statePath).mtimeMs
    if (ageMs > AUTO_ROUTE_STALE_MS) return undefined
    return foldAutoRoutePoll(JSON.parse(text) as unknown, ageMs, now)
  } catch {
    return undefined
  }
}

/**
 * Pure fold of one parsed ledger against its age and the current time.
 * @param payload - the parsed `{at, ok, error?, failingSince?}` document.
 * @param ageMs - ms since the writer stamped the file (freshness judgment).
 * @param now - epoch ms for the streak-age computation.
 * @returns the verdict the wire carries, or `undefined` for a shape-invalid
 *   document (an unparseable writer is a stopped writer: detach, never guess).
 */
export function foldAutoRoutePoll(payload: unknown, ageMs: number, now: number): AutoRoutePollReport | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { ok, error, failingSince } = payload as { ok?: unknown; error?: unknown; failingSince?: unknown }
  if (typeof ok !== 'boolean') return undefined
  const ageSec = Math.max(0, Math.round(ageMs / 1000))
  if (ok) return { ok: true, sustained: false, ageSec }
  // Failing tick. An old writer without `failingSince` (version skew) cannot
  // prove duration — it reads transient forever rather than false-red.
  const since = typeof failingSince === 'number' ? failingSince : undefined
  const failingForMs = since === undefined ? undefined : Math.max(0, now - since)
  return {
    ok: false,
    ...(since === undefined ? {} : { failingSince: since }),
    ...(failingForMs === undefined ? {} : { failingForSec: Math.round(failingForMs / 1000) }),
    sustained: failingForMs !== undefined && failingForMs >= AUTO_ROUTE_SUSTAINED_MS,
    ...(typeof error === 'string' && error !== '' ? { error } : {}),
    ageSec,
  }
}
