/**
 * The revive mechanism-health read (拍板⑭⑮, ruled 2026-11-15: the shield
 * reports revive mechanism health ONLY — 插件激活 / mode=live / status 端点
 * 可读 / 断路器无连跳 / 无 HALT, 正常静默、异常才亮). The dsh-session-revive
 * plugin stamps `<dsh-home>/session-revive-health.json` ONLY when a fact
 * bundle flips (change-only writer: near-zero writes in normal operation),
 * so the heartbeat sweep attaches by presence/parse — deliberately NO mtime
 * freshness judgment, the inverse of auto-route's per-tick ledger: an old
 * file is still the current truth until the next flip, and a stale-read
 * detach would fake 「未接线」 for a perfectly healthy plane.
 *
 * Absence is a quiet fact, never a break: the file is missing while the
 * plugin is disabled/unloaded (面消失, not 面变坏) or before the first flip,
 * and the client then renders the 「未接线」 line — the optional-plugin
 * family, inverse of duty's fail-closed. An unparseable document detaches
 * the same way (a writer that cannot write a document cannot be audited by
 * guessing at one).
 *
 * File-name twin: dsh-web `packages/dsh-session-revive/src/health-state.ts`
 * `REVIVE_HEALTH_FILE` — keep the two constants in sync.
 * @module session-controller/revive-health
 */
import { readFileSync } from 'node:fs'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { ReviveHealthReport } from './types.ts'

/** The plugin's health filename under the DSH home (twin: dsh-web health-state.ts). */
export const REVIVE_HEALTH_FILE = 'session-revive-health.json'

/**
 * Read the revive mechanism-health document for one sweep tick.
 * @param statePath - document location (injectable for tests); defaults to
 *   the DSH-home single source the plugin writes.
 * @returns the folded verdict, or `undefined` when the plane is not attached
 *   (missing / unreadable / shape-invalid document — quiet, never broken).
 */
export function readReviveHealth(
  statePath = dshHomePath(REVIVE_HEALTH_FILE),
): ReviveHealthReport | undefined {
  try {
    return foldReviveHealth(JSON.parse(readFileSync(statePath, 'utf8')) as unknown)
  } catch {
    return undefined
  }
}

/**
 * The writer's document shape (dsh-web health-state.ts `ReviveHealthState`);
 * fields typed `unknown` because a version-skewed writer may omit or mistype
 * any of them — the fold judges what it can read and defaults the rest.
 */
interface ReviveHealthDocument {
  at?: unknown
  active?: unknown
  mode?: unknown
  status?: unknown
  breakerTrips?: unknown
  breakerOk?: unknown
  halted?: unknown
  ok?: unknown
}

/**
 * Pure fold of one parsed document: echo the writer's facts and derive the
 * red fact tokens for the detail surface.
 * @param payload - the parsed `{at, active, mode, status, breakerTrips, breakerOk, halted, ok}` document.
 * @returns the verdict the wire carries, or `undefined` for a shape-invalid
 *   document (a document without a boolean `ok` cannot be judged).
 */
export function foldReviveHealth(payload: unknown): ReviveHealthReport | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { at, active, mode, status, breakerTrips, breakerOk, halted, ok } = payload as ReviveHealthDocument
  if (typeof ok !== 'boolean') return undefined
  // Raw fact tokens (collector language, like duty reasons / auto-route error):
  // the detail surface names the field that went red, nothing policy-translated.
  const failed: string[] = []
  if (active === false) failed.push('active')
  // Presence-checked like the rest: a skewed writer that omits a field cannot
  // be judged on it (auto-route's missing-failingSince discipline — never
  // fabricate a red fact from absence).
  if (mode !== undefined && mode !== 'live') failed.push('mode')
  if (status === 'error') failed.push('status')
  if (breakerOk === false || (typeof breakerTrips === 'number' && breakerTrips >= 3)) failed.push('breaker')
  if (halted === true) failed.push('halted')
  // The writer says unhealthy but no field reads red (version skew / writer
  // bug): still one token, so the detail never renders an empty failure.
  if (!ok && failed.length === 0) failed.push('ok')
  return {
    ok,
    mode: mode === 'live' ? 'live' : 'shadow',
    status: status === 'error' ? 'error' : 'ok',
    breakerTrips: typeof breakerTrips === 'number' ? breakerTrips : 0,
    halted: halted === true,
    failed,
    at: typeof at === 'number' ? at : 0,
  }
}
