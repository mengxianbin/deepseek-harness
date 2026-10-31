/**
 * The 安康位 (health-shield) reconciliation (collab step1 §2.2 全局·安康位,
 * step2 §4.3): the status heartbeat sweep re-emits per-Session truth on a
 * fixed cadence, and the SAME traversal — same data source, same period, zero
 * new planes — folds its rows into one three-invariant audit published as the
 * global `api-session/health` frame. The client's shield badge renders the
 * verdict (step3 §3.3: even = faint green, broken = steady red with the
 * per-invariant difference detail); a client that stops hearing frames rings
 * the shield itself (step3 §5.2 执法者纪律, 自指 fail-closed).
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionHealthReport, SessionHealthRow } from './types.ts'

export type { SessionHealthRow } from './types.ts'

/**
 * Fold one sweep's rows into the three-invariant audit (collab step1 §2.2):
 * 总数 = 各态和 / 无未分类 / 无读不到. The buckets are mutually exclusive with
 * the human queue's precedence (等回话 outranks 在跑, and a failure残局 exists
 * only while stopped), so every live projected row lands in exactly one. A
 * dead id — bookkeeping said "published status" but the live registry cannot
 * resolve it — reads `unreadable`; a live row whose projection channel is down
 * cannot be placed and reads `unclassified`. Either also breaks the partition
 * total: one bookkeeping hole, reported per invariant it breaks. Pure: the
 * sweep owns the data source, this owns the accounting.
 * @param rows - one row per id the sweep had published status for.
 * @returns the audit verdict with every broken invariant's witness Sessions.
 */
export function reconcileSessionHealth(rows: readonly SessionHealthRow[]): SessionHealthReport {
  const dead: SessionId[] = []
  const unplaced: SessionId[] = []
  let running = 0
  let awaiting = 0
  let failed = 0
  let rest = 0
  for (const row of rows) {
    if (!row.live) {
      dead.push(row.id)
      continue
    }
    if (!row.projected) {
      unplaced.push(row.id)
      continue
    }
    if (row.attention === 'question') awaiting += 1
    else if (row.running) running += 1
    else if (row.failed) failed += 1
    else rest += 1
  }
  const issues = []
  if (dead.length > 0) issues.push({ invariant: 'unreadable' as const, sessionIds: dead })
  if (unplaced.length > 0) issues.push({ invariant: 'unclassified' as const, sessionIds: unplaced })
  if (running + awaiting + failed + rest !== rows.length) {
    // The uncounted witnesses are exactly the rows no bucket took.
    issues.push({ invariant: 'total-partition' as const, sessionIds: [...dead, ...unplaced] })
  }
  return {
    ok: issues.length === 0,
    total: rows.length,
    counts: { running, awaiting, failed, rest },
    issues,
  }
}
