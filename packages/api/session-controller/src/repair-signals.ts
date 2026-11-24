/**
 * The repair-signal ledger read (三态账 + 盾挂, segment 4): the m-note side
 * writes ONE single-source document `<dsh-home>/repair-signal-ledger.json`
 * (watchdog/kick signals with their `repairing` / `queued` / `unmanaged`
 * states), and this side READS it — the shield's read-only mirror line of
 * three signal-repair counters plus the oldest-waiting age.
 *
 * Same fold discipline as revive-health: presence/parse only, fail-quiet
 * (missing / unreadable / shape-invalid document → `undefined` = 「未接线」,
 * never broken — the optional-plane family, inverse of duty's fail-closed).
 * The timeout case needs NO writer and NO new timer: a `queued` signal
 * older than QUEUE_TIMEOUT_MS demotes to `unmanaged` AT READ TIME, so the
 * existing 15s sweep tick is the only clock (zero new periodic timers).
 *
 * Deliberately read-only: nothing here may feed HealthShield's broken
 * verdict or the queue-alert row — this plane only counts.
 *
 * File-name twin: m-note `repair-signal-ledger.json` writer — keep the two
 * constants in sync.
 * @module session-controller/repair-signals
 */
import { readFileSync } from 'node:fs'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { RepairSignalReport } from './types.ts'

/** The m-note writer's ledger filename under the DSH home (twin: m-note side). */
export const REPAIR_SIGNAL_LEDGER_FILE = 'repair-signal-ledger.json'

/**
 * Queue timeout: a `queued` signal whose age (`now - enqueuedAt`) reaches
 * this reads as 无人管 (unmanaged) instead — 「超时无人动」 detected by the
 * fold itself at read time, so the ledger never needs a timer of its own.
 */
export const QUEUE_TIMEOUT_MS = 30 * 60_000

/**
 * Read the repair-signal ledger for one sweep tick.
 * @param now - epoch ms for the queue-timeout demotion and oldest-age fold
 *   (injectable for tests); defaults to the current clock.
 * @param statePath - ledger location (injectable for tests); defaults to the
 *   DSH-home single source the m-note writer publishes.
 * @returns the folded counters, or `undefined` when the plane is not attached
 *   (missing / unreadable / shape-invalid document — quiet, never broken).
 */
export function readRepairSignals(
  now = Date.now(),
  statePath = dshHomePath(REPAIR_SIGNAL_LEDGER_FILE),
): RepairSignalReport | undefined {
  try {
    return foldRepairSignals(JSON.parse(readFileSync(statePath, 'utf8')) as unknown, now)
  } catch {
    return undefined
  }
}

/**
 * The writer's document shape (m-note side); fields typed `unknown` because a
 * version-skewed writer may omit or mistype any of them — the fold judges
 * what it can read and detaches on the rest.
 */
interface RepairSignalDocument {
  version?: unknown
  updatedAt?: unknown
  signals?: unknown
}

/** One signal entry exactly as the writer publishes it (typed unknown, see above). */
interface RepairSignalEntry {
  id?: unknown
  state?: unknown
  enqueuedAt?: unknown
  firstSeen?: unknown
}

/** The three writer states; `unmanaged` may also appear explicitly. */
const REPAIR_SIGNAL_STATES = new Set(['repairing', 'queued', 'unmanaged'])

/**
 * Parse one writer timestamp (ISO-8601 with offset, as the contract writes it).
 * @param value - the raw field.
 * @returns epoch ms, or `undefined` when absent/untyped/unparseable (never NaN).
 */
function epochMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * Pure fold of one parsed ledger at a point in time: count the three states
 * with the read-time queue-timeout demotion, and the oldest `firstSeen` age.
 * @param payload - the parsed `{version, updatedAt, signals}` document.
 * @param now - epoch ms for every age judgment.
 * @returns the counters the wire carries, or `undefined` for a shape-invalid
 *   document (no `signals` array — a document that cannot be counted cannot
 *   be audited by guessing at one).
 */
export function foldRepairSignals(payload: unknown, now: number): RepairSignalReport | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { signals } = payload as RepairSignalDocument
  if (!Array.isArray(signals)) return undefined
  let repairing = 0
  let queued = 0
  let unmanaged = 0
  let oldestMs: number | undefined
  for (const raw of signals) {
    if (typeof raw !== 'object' || raw === null) continue
    const { state, enqueuedAt, firstSeen } = raw as RepairSignalEntry
    // First-seen drives the oldest age over ALL signals; an unparseable one
    // simply cannot contribute (a bad entry never fakes a younger ledger).
    const seen = epochMs(firstSeen)
    if (seen !== undefined && (oldestMs === undefined || seen < oldestMs)) oldestMs = seen
    if (typeof state !== 'string' || !REPAIR_SIGNAL_STATES.has(state)) continue
    if (state === 'repairing') {
      repairing += 1
      continue
    }
    if (state === 'unmanaged') {
      unmanaged += 1
      continue
    }
    // `queued`: fresh under the timeout stays queued, at/over it demotes to
    // unmanaged at READ time (超时无人动 without any timer). An unparseable
    // `enqueuedAt` cannot prove freshness — it reads as timed out.
    const enqueued = epochMs(enqueuedAt)
    const age = enqueued === undefined ? Number.POSITIVE_INFINITY : now - enqueued
    if (age < QUEUE_TIMEOUT_MS) queued += 1
    else unmanaged += 1
  }
  return {
    repairing,
    queued,
    unmanaged,
    // Floor of the minutes since the oldest firstSeen; 0 with no signal.
    oldestMin: oldestMs === undefined ? 0 : Math.max(0, Math.floor((now - oldestMs) / 60_000)),
  }
}
