/**
 * The 值守总账 read (批2 duty-shield-b2-1103, duty-inventory-shield-1103.md
 * §三 约束①): the collector (m-note `scripts/dsh/duty-inventory.py`, schtasks
 * `DSH-Duty-Inventory`, every 10 minutes) folds every watch item — scheduled
 * tasks, the guard process, its own self-reference — into ONE ledger at
 * `~/.dsh/duty-inventory-state.json`. The heartbeat sweep rides this reader
 * on its own 15s tick: one small JSON file plus a freshness judgment, never a
 * per-tick scheduler CIM query (评估档 §三 约束①: 同一数据源同一周期, step2
 * §4.3 duty extension — the sweep still publishes ONE frame per tick).
 *
 * Fail-closed throughout (清单档 §6.3 / step3 §5.2 执法者纪律 同源): a
 * missing, unparseable, or stale ledger reads `ok: false`, never quiet — a
 * watch plane the sweep cannot trust is a failed watch plane.
 */
import { readFileSync, statSync } from 'node:fs'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { DutyInventoryItem, DutyInventoryReport } from './types.ts'

/** The collector's ledger filename under the DSH home (single source: duty-inventory.py `STATE_PATH`). */
export const DUTY_LEDGER_FILE = 'duty-inventory-state.json'

/**
 * Freshness bound for the ledger itself: twice the collector's 10-minute
 * cadence — the same 2× relationship the shield's own frame staleness uses
 * (`SESSION_HEALTH_STALE_MS` = 2 × 15s sweep). Older than this and the
 * collector's own task is read as not running on schedule (该跑没跑).
 */
export const DUTY_LEDGER_STALE_MS = 1_200_000

/** The collector's three verdicts (清单档 §6.3); anything else reads failed. */
const DUTY_STATUSES = ['healthy', 'disabled', 'failed'] as const

/** Counts for a ledger the sweep could not read at all (fail-closed shell). */
const UNREADABLE_COUNTS = { total: 0, healthy: 0, disabled: 0, failed: 0 } as const

/**
 * Read and fold the 值守总账 for one sweep tick.
 * @param now - epoch ms for the freshness judgment (injectable for tests).
 * @param ledgerPath - ledger location (injectable for tests); defaults to the
 *   DSH-home single source the collector writes.
 * @returns the fail-closed duty verdict; any IO/parse failure reads `fresh: false, ok: false`.
 */
export function readDutyInventory(
  now = Date.now(),
  ledgerPath = dshHomePath(DUTY_LEDGER_FILE),
): DutyInventoryReport {
  try {
    const text = readFileSync(ledgerPath, 'utf8')
    const ageMs = now - statSync(ledgerPath).mtimeMs
    return foldDutyInventory(JSON.parse(text) as unknown, ageMs)
  } catch {
    return { ok: false, fresh: false, counts: { ...UNREADABLE_COUNTS }, items: [] }
  }
}

/**
 * Sleep-window deduction input (duty-sleep-gap-1126): the collector's measured
 * `sleepOverlapSec` converted to ms, clamped into `[0, ageMs]`.
 *
 * Fail-closed on every path (三道兜底, 违反即打回): a missing / non-numeric /
 * non-finite / non-positive key deducts **nothing**, and the deduction never
 * exceeds the raw age — so a ledger the collector could not explain reads exactly
 * as it did before this feature existed (still red when stale).
 * @param payload - the parsed `duty-inventory-state/1` document.
 * @param ageMs - the raw age; `undefined` means nothing to compare against.
 * @returns ms to subtract from the raw age (0 = no exemption).
 */
function sleepOverlapMsOf(payload: unknown, ageMs: number | undefined): number {
  if (ageMs === undefined || ageMs <= 0) return 0
  if (typeof payload !== 'object' || payload === null) return 0
  const raw = (payload as { sleepOverlapSec?: unknown }).sleepOverlapSec
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0
  // 兜底②: deduction ≤ raw age ⇒ effectiveAge ≥ 0 always.
  return Math.min(raw * 1000, ageMs)
}

/**
 * Pure fold of one parsed ledger against its age (the sweep's freshness
 * judgment): shape-invalid reads unreadable; a shape-valid ledger older than
 * {@link DUTY_LEDGER_STALE_MS} keeps its items for display but reads
 * `fresh: false` → `ok: false` (戳过期 at the file level).
 *
 * **Sleep-window deduction** (duty-sleep-gap-1126, 2026-11-26 ruling
 * 「A + 灰色豁免标记」): when the collector measured that the machine slept for
 * most of the stale window, that time is subtracted before the freshness test —
 * a machine asleep is not a collector broken. The raw `ageSec` stays untouched
 * for display, and `sleepExempt` marks the case so the UI can show a **grey**
 * note instead of red *or* silence (the 偶发检查契机 is kept visible).
 * Only this file-level age is affected: item-level `failed` verdicts are
 * untouched and keep lighting red (第②层项级红零改).
 * @param payload - the parsed `duty-inventory-state/1` document.
 * @param ageMs - ms since the collector stamped the file; `undefined` = no mtime.
 * @returns the duty verdict the wire carries.
 */
export function foldDutyInventory(payload: unknown, ageMs: number | undefined): DutyInventoryReport {
  const rawItems = ledgerItems(payload)
  if (rawItems === undefined) {
    return { ok: false, fresh: false, counts: { ...UNREADABLE_COUNTS }, items: [] }
  }
  const items = rawItems.map(foldItem)
  const counts = {
    total: items.length,
    healthy: items.filter(item => item.status === 'healthy').length,
    // 有意停用 = grey, not failed (警报经济学, archive-seal-light 2026-11-02 教训):
    // disabled items never break `ok` on their own — they are counted, not lit.
    disabled: items.filter(item => item.status === 'disabled').length,
    failed: items.filter(item => item.status === 'failed').length,
  }
  const sleepMs = sleepOverlapMsOf(payload, ageMs)
  const rawStale = ageMs === undefined || ageMs > DUTY_LEDGER_STALE_MS
  const effectiveAgeMs = ageMs === undefined ? undefined : Math.max(0, ageMs - sleepMs)
  const fresh = effectiveAgeMs !== undefined && effectiveAgeMs <= DUTY_LEDGER_STALE_MS
  // 豁免 = 原本会红、因睡眠扣减后不红。只在真扣了东西时才标（sleepMs > 0），
  // 否则「fresh 且无扣减」的正常态也会被误标成豁免。
  const sleepExempt = sleepMs > 0 && rawStale && fresh
  const report: DutyInventoryReport = {
    // fail-closed: untrusted file OR any failed item → not ok (插队 P0/P1 follows).
    // 睡眠豁免只动 fresh，counts.failed 照旧参与 —— 第②层项级红零改。
    ok: fresh && counts.failed === 0,
    fresh,
    ...(sleepExempt ? { sleepExempt: true } : {}),
    ...(sleepMs > 0 ? { sleepOverlapSec: Math.max(0, Math.round(sleepMs / 1000)) } : {}),
    counts,
    items,
  }
  // ageSec = 原始年龄（不扣减）：UI 要显示真实断档时长 + 睡眠时长两件事。
  return ageMs === undefined ? report : { ...report, ageSec: Math.max(0, Math.round(ageMs / 1000)) }
}

/** Pull the items array out of a `duty-inventory-state/1` document; `undefined` = shape invalid. */
function ledgerItems(payload: unknown): readonly unknown[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const items = (payload as { items?: unknown }).items
  return Array.isArray(items) ? items : undefined
}

/** Fold one raw item; an unrecognized `status` fails closed into `failed`. */
function foldItem(raw: unknown): DutyInventoryItem {
  const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const known = typeof item.status === 'string'
    && (DUTY_STATUSES as readonly string[]).includes(item.status)
  const status = known ? item.status as DutyInventoryItem['status'] : 'failed'
  const reasons = Array.isArray(item.reasons)
    ? item.reasons.filter((reason): reason is string => typeof reason === 'string')
    : []
  if (!known) reasons.push('总账条目 status 字段无法识别（fail-closed 判失效）')
  return {
    id: typeof item.id === 'string' ? item.id : '(总账条目缺 id)',
    status,
    intentional: item.intentional === true,
    reasons,
    ...(typeof item.cadenceLabel === 'string' ? { cadenceLabel: item.cadenceLabel } : {}),
  }
}
