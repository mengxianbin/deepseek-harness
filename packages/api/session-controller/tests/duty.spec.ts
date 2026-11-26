/**
 * The 值守总账 read (批2 duty-shield-b2-1103, duty-inventory-shield-1103.md
 * §三约束① + §六): the pure freshness/three-state fold and the fail-closed
 * file read the heartbeat sweep rides — a missing, malformed, or stale ledger
 * must read failed (never quiet), a disabled-only ledger must read ok (灰不亮
 * 不插队), and an unrecognized item status fails closed into failed.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DUTY_LEDGER_FILE, DUTY_LEDGER_STALE_MS, foldDutyInventory, readDutyInventory } from '../src/duty.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One temp DSH-home-shaped dir holding a ledger the reader can be pointed at. */
function ledgerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'duty-ledger-'))
  tempDirs.push(dir)
  return dir
}

/** A schema-shaped ledger document over the given raw items. */
function ledger(items: readonly unknown[]): Record<string, unknown> {
  return { schema: 'duty-inventory-state/1', generatedAt: '2026-11-03 15:33:21', items }
}

const healthyItem = {
  id: 'DSH-Build-Watchdog',
  cadenceLabel: '每 10 分钟',
  intentional: false,
  status: 'healthy',
  reasons: [],
}
const disabledItem = {
  id: 'taskbot-guard-check',
  cadenceLabel: '每 2 分钟',
  intentional: true,
  status: 'disabled',
  reasons: [],
}
const failedItem = {
  id: 'DSH-Host-Revive',
  cadenceLabel: '每 5 分钟',
  intentional: false,
  status: 'failed',
  reasons: ['该跑没跑：LastRunTime 距今 900s > 阈 900s'],
}

describe('foldDutyInventory (三态折叠, 清单档 §6.3)', () => {
  it('a fresh ledger with no failures reads ok and keeps disabled apart from failed', () => {
    const report = foldDutyInventory(ledger([healthyItem, disabledItem]), 30_000)
    expect(report.ok).toBe(true)
    expect(report.fresh).toBe(true)
    expect(report.ageSec).toBe(30)
    expect(report.counts).toEqual({ total: 2, healthy: 1, disabled: 1, failed: 0 })
    expect(report.items).toEqual([
      { id: 'DSH-Build-Watchdog', status: 'healthy', intentional: false, reasons: [], cadenceLabel: '每 10 分钟' },
      { id: 'taskbot-guard-check', status: 'disabled', intentional: true, reasons: [], cadenceLabel: '每 2 分钟' },
    ])
  })

  it('any failed item breaks ok and carries its per-item reasons through (红 + 逐项明细)', () => {
    const report = foldDutyInventory(ledger([healthyItem, failedItem]), 30_000)
    expect(report.ok).toBe(false)
    expect(report.counts.failed).toBe(1)
    expect(report.items.find(item => item.id === 'DSH-Host-Revive')?.reasons)
      .toEqual(['该跑没跑：LastRunTime 距今 900s > 阈 900s'])
  })

  it('a ledger past the freshness bound reads failed while keeping its items (戳过期)', () => {
    const report = foldDutyInventory(ledger([healthyItem]), DUTY_LEDGER_STALE_MS + 1)
    expect(report.fresh).toBe(false)
    expect(report.ok).toBe(false)
    expect(report.counts.total).toBe(1)
    expect(report.ageSec).toBe(Math.round((DUTY_LEDGER_STALE_MS + 1) / 1000))
  })

  it('a shape-invalid document fails closed into an empty unreadable verdict', () => {
    expect(foldDutyInventory({ schema: 'duty-inventory-state/1' }, 0)).toEqual({
      ok: false,
      fresh: false,
      counts: { total: 0, healthy: 0, disabled: 0, failed: 0 },
      items: [],
    })
    expect(foldDutyInventory(null, 0).ok).toBe(false)
  })

  it('an unrecognized item status fails closed into failed, never quiet', () => {
    const report = foldDutyInventory(ledger([{ id: 'mystery', status: 'weird', reasons: [] }]), 0)
    expect(report.ok).toBe(false)
    expect(report.counts.failed).toBe(1)
    expect(report.items[0]?.status).toBe('failed')
    expect(report.items[0]?.reasons[0]).toContain('fail-closed')
  })
})

describe('readDutyInventory (文件读取, fail-closed)', () => {
  it('reads the ledger at the given path and folds its age against the clock', () => {
    const dir = ledgerDir()
    const path = join(dir, DUTY_LEDGER_FILE)
    writeFileSync(path, JSON.stringify(ledger([healthyItem, disabledItem])), 'utf8')
    const now = Date.now()
    const report = readDutyInventory(now, path)
    expect(report.ok).toBe(true)
    expect(report.fresh).toBe(true)
    expect(report.counts).toEqual({ total: 2, healthy: 1, disabled: 1, failed: 0 })
  })

  it('an absent ledger reads unreadable (collector 该跑没跑 at the file level)', () => {
    const report = readDutyInventory(Date.now(), join(ledgerDir(), DUTY_LEDGER_FILE))
    expect(report).toEqual({
      ok: false,
      fresh: false,
      counts: { total: 0, healthy: 0, disabled: 0, failed: 0 },
      items: [],
    })
  })

  it('malformed JSON reads unreadable rather than throwing into the sweep', () => {
    const dir = ledgerDir()
    const path = join(dir, DUTY_LEDGER_FILE)
    writeFileSync(path, '{not json', 'utf8')
    expect(readDutyInventory(Date.now(), path).ok).toBe(false)
  })

  it('a ledger file older than the freshness bound reads untrusted', () => {
    const dir = ledgerDir()
    const path = join(dir, DUTY_LEDGER_FILE)
    writeFileSync(path, JSON.stringify(ledger([healthyItem])), 'utf8')
    const past = new Date(Date.now() - DUTY_LEDGER_STALE_MS - 60_000)
    utimesSync(path, past, past)
    const report = readDutyInventory(Date.now(), path)
    expect(report.fresh).toBe(false)
    expect(report.ok).toBe(false)
    expect(report.counts.total).toBe(1)
  })
})

/**
 * 睡眠窗扣减（duty-sleep-gap-1126，2026-11-26 拍板「A + 灰色豁免标记」）：
 * 断档窗内机器睡了多久由 collector 量出（`sleepOverlapSec`），fold 从原始年龄
 * 里扣掉——睡 6h 扣 6h 不红（无感）、醒着没跑照常红。三道 fail-closed 兜底
 * + 第②层项级红零改，逐条在此钉死（反例判据 = 违反即打回）。
 */
describe('foldDutyInventory 睡眠窗扣减（duty-sleep-gap-1126）', () => {
  /** 21 分钟 > DUTY_LEDGER_STALE_MS(20min) ⇒ 原始判据必红，是扣减的测试面。 */
  const staleAge = DUTY_LEDGER_STALE_MS + 60_000

  it('overlap covering the stale window → fresh + sleepExempt（无感，且原始年龄照报）', () => {
    // 1200s < staleAge(1260s)：不触发 clamp，sleepOverlapSec 报的就是实测量
    const report = foldDutyInventory({ ...ledger([healthyItem]), sleepOverlapSec: 1_200 }, staleAge)
    expect(report.fresh).toBe(true)
    expect(report.sleepExempt).toBe(true)
    // ageSec = 原始年龄不扣减（UI 要显示真实断档 + 睡眠时长两件事）
    expect(report.ageSec).toBe(Math.round(staleAge / 1000))
    expect(report.sleepOverlapSec).toBe(1_200)
    expect(report.ok).toBe(true)
  })

  it('no overlap → stale stays red（醒着没跑 = 真故障，照常红）', () => {
    const report = foldDutyInventory(ledger([healthyItem]), staleAge)
    expect(report.fresh).toBe(false)
    expect(report.ok).toBe(false)
    expect(report.sleepExempt).toBeUndefined()
    expect(report.sleepOverlapSec).toBeUndefined()
  })

  it('overlap > age clamps to age（兜底② effectiveAge ≥ 0 恒成立）', () => {
    const report = foldDutyInventory({ ...ledger([healthyItem]), sleepOverlapSec: 999_999 }, staleAge)
    expect(report.fresh).toBe(true)
    expect(report.sleepExempt).toBe(true)
    expect(report.ageSec).toBeGreaterThan(0)
  })

  it('already-fresh ledger is never marked exempt（不把正常态误标成豁免）', () => {
    const report = foldDutyInventory({ ...ledger([healthyItem]), sleepOverlapSec: 100 }, 30_000)
    expect(report.fresh).toBe(true)
    expect(report.sleepExempt).toBeUndefined()
  })

  it('exemption does NOT hide item-level failures（第②层项级红零改，照常破 ok）', () => {
    const report = foldDutyInventory({ ...ledger([failedItem]), sleepOverlapSec: 1_500 }, staleAge)
    expect(report.fresh).toBe(true)
    expect(report.sleepExempt).toBe(true)
    expect(report.counts.failed).toBe(1)
    // 项级 failed 照旧参与 ok 判定 —— 睡眠豁免只动文件级 fresh
    expect(report.ok).toBe(false)
  })

  it('malformed overlap key deducts nothing（兜底① fail-closed：读不到 = 不扣减 = 照常红）', () => {
    const badValues: readonly unknown[] = ['1500', -5, 0, Number.NaN, null, undefined, { n: 1 }]
    for (const bad of badValues) {
      const report = foldDutyInventory({ ...ledger([healthyItem]), sleepOverlapSec: bad }, staleAge)
      expect(report.fresh, `sleepOverlapSec=${String(bad)}`).toBe(false)
      expect(report.sleepExempt, `sleepOverlapSec=${String(bad)}`).toBeUndefined()
    }
  })

  it('shape-invalid payload still fails closed without an exemption (不可读分支零豁免)', () => {
    const report = foldDutyInventory({ noItems: true, sleepOverlapSec: 9_999 }, staleAge)
    expect(report.fresh).toBe(false)
    expect(report.ok).toBe(false)
    expect(report.sleepExempt).toBeUndefined()
    expect(report.counts.total).toBe(0)
  })
})
