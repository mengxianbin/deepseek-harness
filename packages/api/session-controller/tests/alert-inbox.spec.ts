/**
 * The alert-inbox write side (设计档 `session-revival-v2-alert-inbox-1116.md`
 * §七, alert-inbox-signal-face-1116): the fold clusters state-export flips
 * into event families ONCE (机检2: 168 attempts → 1 entry), runs the three
 * channels (客观恢复 / 人工确认 / 超时升级), and keeps the published counts
 * equal to the file's `unread && !archived` predicate (机检1 对账基准 — the
 * badge and duty read the same document). The action-face writers prove归档
 * ≠ 物理删 (机检3) and the `resolution` read/write loop (机检4).
 *
 * `rmSync` here is temp-directory cleanup for the injected `$DSH_HOME`
 * (the revive-health.spec fixture pattern), not an inbox delete path —
 * the inbox itself has zero deletion calls (机检3 greps the sources).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ALERT_ESCALATE_AFTER_MS,
  PROBE_RED_CAUSE,
  acknowledgeAlert,
  foldAlertInbox,
  linkInvestigationSession,
  setAlertResolution,
  syncAlertInbox,
  type AlertInboxDocument,
  type ReviveV2StateDocument,
} from '../src/alert-inbox.ts'

const stateOf = (sessions: Record<string, unknown>): ReviveV2StateDocument => ({ at: 1, sessions })

/** A stopped-session export: the §七 trigger source that delivers a family. */
function stoppedState(lastFailureAt: number, stopped = 'zero-cost-3strike'): ReviveV2StateDocument {
  return stateOf({
    'sess-1': {
      lastFailureAt,
      lastFailureForm: 'zero-token',
      lastFailureTokens: 100,
      stopped,
      lastSuccessAt: 0,
    },
  })
}

let home: string | undefined

function inboxPathOf(): string {
  return join(home ?? '', 'alert-inbox.json')
}

function readInbox(): { at: number; seen: Record<string, unknown>; entries: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(inboxPathOf(), 'utf8'))
}

afterEach(() => {
  vi.unstubAllEnvs()
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

describe('foldAlertInbox (写侧聚类 + 三通道, 设计档 §七)', () => {
  it('机检2: 168 条 attempt fixture → 1 条事件族 (写侧折出, 非展示层)', () => {
    const step = 5 * 60 * 1000
    let now = 1_700_000_000_000
    let base: AlertInboxDocument | undefined
    for (let i = 1; i <= 167; i += 1) {
      now += step
      const state = stateOf({
        'sess-1': { lastFailureAt: now, lastFailureForm: 'zero-token', lastFailureTokens: 100, stopped: null, lastSuccessAt: 0 },
      })
      const result = foldAlertInbox(state, base, now)
      expect(result).toBeDefined()
      base = result?.doc
    }
    // The 168th attempt carries the stop — §七 `stopped` 非空 = 清单条目触发源.
    now += step
    const final = foldAlertInbox(stoppedState(now), base, now)
    expect(final?.doc.entries).toHaveLength(1)
    const entry = final?.doc.entries[0]
    expect(entry?.attempts).toBe(168)
    expect(entry?.tokens).toBe(16_800)
    expect(entry?.cause).toBe('zero-token')
    expect(entry?.sessionIds).toEqual(['sess-1'])
    expect(entry?.unread).toBe(true)
    expect(entry?.escalated).toBe(false)
    expect(entry?.deliveredAt).toBe(now)
  })

  it('投递门槛: 没有 stopped 的失败只在内部聚类, 不进信箱 (瞬时无影响留日志)', () => {
    const step = 5 * 60 * 1000
    let now = 1_700_000_000_000
    let base: AlertInboxDocument | undefined
    for (let i = 1; i <= 3; i += 1) {
      now += step
      base = foldAlertInbox(
        stateOf({ 'sess-1': { lastFailureAt: now, lastFailureForm: 'zero-token', stopped: null, lastSuccessAt: 0 } }),
        base,
        now,
      )?.doc
    }
    expect(base?.entries).toHaveLength(1)
    expect(base?.entries[0]?.attempts).toBe(3)
    expect(base?.entries[0]?.unread).toBe(false)
    expect(base?.entries[0]?.deliveredAt).toBeNull()
  })

  it('聚类分族: 同因超窗开新族; 异因即使同时段也分族', () => {
    const start = 1_700_000_000_000
    let base = foldAlertInbox(
      stateOf({ 'sess-1': { lastFailureAt: start, lastFailureForm: 'zero-token', stopped: null, lastSuccessAt: 0 } }),
      undefined,
      start,
    )?.doc
    // Same cause 7h later (> 6h 同时段 window) → a NEW family.
    base = foldAlertInbox(
      stateOf({ 'sess-1': { lastFailureAt: start + 7 * 60 * 60 * 1000, lastFailureForm: 'zero-token', stopped: null, lastSuccessAt: 0 } }),
      base,
      start + 7 * 60 * 60 * 1000,
    )?.doc
    // A different cause inside the window → its own family, even concurrently.
    base = foldAlertInbox(
      stateOf({
        'sess-1': { lastFailureAt: start + 7 * 60 * 60 * 1000, lastFailureForm: 'zero-token', stopped: null, lastSuccessAt: 0 },
        'sess-2': { lastFailureAt: start + 7 * 60 * 60 * 1000 + 60_000, lastFailureForm: 'spend-progress', stopped: null, lastSuccessAt: 0 },
      }),
      base,
      start + 7 * 60 * 60 * 1000 + 60_000,
    )?.doc
    expect(base?.entries).toHaveLength(3)
    expect(base?.entries.map(entry => entry.cause).sort()).toEqual(['spend-progress', 'zero-token', 'zero-token'])
  })

  it('客观恢复: 会话复活并完成一个 turn → 自动归档 (heal=auto, 条目不删)', () => {
    const start = 1_700_000_000_000
    const delivered = foldAlertInbox(stoppedState(start), undefined, start)?.doc
    expect(delivered?.entries[0]?.unread).toBe(true)
    const recovered = foldAlertInbox(
      stateOf({ 'sess-1': { lastFailureAt: start, lastFailureForm: 'zero-token', stopped: null, lastSuccessAt: start + 5_000 } }),
      delivered,
      start + 6_000,
    )?.doc
    expect(recovered?.entries).toHaveLength(1)
    const entry = recovered?.entries[0]
    expect(entry?.archived).toBe(true)
    expect(entry?.unread).toBe(false)
    expect(entry?.heal).toBe('auto')
    expect(entry?.endedAt).toBe(start + 6_000)
  })

  it('接力恢复: relay 会话完成一个 turn → heal=relay', () => {
    const start = 1_700_000_000_000
    const delivered = foldAlertInbox(stoppedState(start), undefined, start)?.doc
    const recovered = foldAlertInbox(
      stateOf({
        'sess-1': { lastFailureAt: start, lastFailureForm: 'zero-token', stopped: 'zero-cost-3strike', lastSuccessAt: 0, relaySessionId: 'relay-9' },
        'relay-9': { lastSuccessAt: start + 5_000, stopped: null },
      }),
      delivered,
      start + 6_000,
    )?.doc
    expect(recovered?.entries[0]?.archived).toBe(true)
    expect(recovered?.entries[0]?.heal).toBe('relay')
  })

  it('超时升级: unread 停留 > 2 个冷却周期 → escalated=true 且条目不消失', () => {
    const start = 1_700_000_000_000
    const delivered = foldAlertInbox(stoppedState(start), undefined, start)?.doc
    const late = foldAlertInbox(undefined, delivered, start + ALERT_ESCALATE_AFTER_MS + 1)?.doc
    expect(late?.entries).toHaveLength(1)
    expect(late?.entries[0]?.unread).toBe(true)
    expect(late?.entries[0]?.escalated).toBe(true)
    // …and it stays escalated through every later tick (不消失反升红).
    const later = foldAlertInbox(undefined, late, start + ALERT_ESCALATE_AFTER_MS * 10)?.doc
    expect(later?.entries[0]?.escalated).toBe(true)
  })

  it('探针持续红: probeRedAlarmed 置位一次 → 探针族出生即投递', () => {
    const start = 1_700_000_000_000
    const result = foldAlertInbox(
      stateOf({ 'sess-1': { probe: 'red', probeRedSince: start, probeRedAlarmed: true, stopped: null, lastFailureAt: 0, lastSuccessAt: 0 } }),
      undefined,
      start,
    )?.doc
    expect(result?.entries).toHaveLength(1)
    expect(result?.entries[0]?.cause).toBe(PROBE_RED_CAUSE)
    expect(result?.entries[0]?.unread).toBe(true)
    // Re-alarmed ticks do not stack events (the watermark eats the rise).
    const again = foldAlertInbox(
      stateOf({ 'sess-1': { probe: 'red', probeRedSince: start, probeRedAlarmed: true, stopped: null, lastFailureAt: 0, lastSuccessAt: 0 } }),
      result,
      start + 60_000,
    )?.doc
    expect(again?.entries).toHaveLength(1)
    expect(again?.entries[0]?.attempts).toBe(1)
  })

  it('双输入缺席 → undefined (安静, 永不判坏)', () => {
    expect(foldAlertInbox(undefined, undefined, 1)).toBeUndefined()
  })
})

describe('syncAlertInbox (读写 + change-only + 对账基准)', () => {
  it('机检1 数据层: report.unread = 文件内 unread&&!archived 计数 (徽标数同源)', () => {
    home = mkdtempSync(join(tmpdir(), 'alert-inbox-'))
    vi.stubEnv('DSH_HOME', home)
    const start = 1_700_000_000_000
    writeFileSync(join(home, 'session-revive-v2-state.json'), JSON.stringify(stoppedState(start)), 'utf8')
    const report = syncAlertInbox(start)
    expect(report).toBeDefined()
    const doc = readInbox()
    const unread = doc.entries.filter(entry => entry.unread === true && entry.archived !== true).length
    expect(report?.unread).toBe(unread)
    expect(report?.unread).toBe(1)
    expect(report?.escalated).toBe(0)
    expect(report?.total).toBe(1)
  })

  it('安静缺席: 两文件皆无 → undefined 且不落盘; 仅状态在场 → 白0 报告', () => {
    home = mkdtempSync(join(tmpdir(), 'alert-inbox-'))
    vi.stubEnv('DSH_HOME', home)
    expect(syncAlertInbox(1)).toBeUndefined()
    expect(existsSync(inboxPathOf())).toBe(false)
    writeFileSync(join(home, 'session-revive-v2-state.json'), JSON.stringify({ at: 1, sessions: {} }), 'utf8')
    expect(syncAlertInbox(2)).toEqual({ at: 0, unread: 0, escalated: 0, total: 0 })
    // Nothing flipped — change-only writes nothing.
    expect(existsSync(inboxPathOf())).toBe(false)
  })

  it('change-only: 状态不翻转 → 第二次 sync 零重写 (文件逐字节不动)', () => {
    home = mkdtempSync(join(tmpdir(), 'alert-inbox-'))
    vi.stubEnv('DSH_HOME', home)
    writeFileSync(join(home, 'session-revive-v2-state.json'), JSON.stringify(stoppedState(1_700_000_000_000)), 'utf8')
    syncAlertInbox(1_700_000_000_000)
    const raw = readFileSync(inboxPathOf(), 'utf8')
    syncAlertInbox(1_700_000_600_000)
    expect(readFileSync(inboxPathOf(), 'utf8')).toBe(raw)
  })

  it('清单读失败: 损坏文档 → undefined 且零覆盖 (结论不能删, clobber guard)', () => {
    home = mkdtempSync(join(tmpdir(), 'alert-inbox-'))
    vi.stubEnv('DSH_HOME', home)
    writeFileSync(inboxPathOf(), 'not-json{{', 'utf8')
    writeFileSync(join(home, 'session-revive-v2-state.json'), JSON.stringify(stoppedState(1_700_000_000_000)), 'utf8')
    expect(syncAlertInbox(1_700_000_000_000)).toBeUndefined()
    expect(readFileSync(inboxPathOf(), 'utf8')).toBe('not-json{{')
  })

  it('状态缺席但清单在场: 徽标仍报数 (人工通道不依赖状态导出)', () => {
    home = mkdtempSync(join(tmpdir(), 'alert-inbox-'))
    vi.stubEnv('DSH_HOME', home)
    const start = 1_700_000_000_000
    writeFileSync(join(home, 'session-revive-v2-state.json'), JSON.stringify(stoppedState(start)), 'utf8')
    syncAlertInbox(start)
    rmSync(join(home, 'session-revive-v2-state.json'))
    expect(syncAlertInbox(start + 60_000)?.unread).toBe(1)
  })
})

describe('三通道写侧 API (人工确认 + 结论回填, §七 行动面回路)', () => {
  /** Materialize a delivered entry and return its family id. */
  function deliveredId(): string {
    home = mkdtempSync(join(tmpdir(), 'alert-inbox-'))
    vi.stubEnv('DSH_HOME', home)
    const start = 1_700_000_000_000
    writeFileSync(join(home, 'session-revive-v2-state.json'), JSON.stringify(stoppedState(start)), 'utf8')
    syncAlertInbox(start)
    const id = readInbox().entries[0]?.id
    expect(typeof id).toBe('string')
    return id as string
  }

  it('机检3: acknowledge → 转归档不物理删, 条目仍可读, 且幂等零重写', () => {
    const id = deliveredId()
    const before = readFileSync(inboxPathOf(), 'utf8')
    expect(acknowledgeAlert(id)).toBe(true)
    const doc = readInbox()
    expect(doc.entries).toHaveLength(1)
    expect(doc.entries[0]).toMatchObject({ id, unread: false, archived: true, heal: 'manual' })
    // The entry leaves the badge count but stays in the archive (history kept).
    expect(syncAlertInbox(1_700_000_060_000)?.unread).toBe(0)
    expect(syncAlertInbox(1_700_000_060_000)?.total).toBe(1)
    // Idempotent re-ack: true, and no content flip → no rewrite.
    const afterFirst = readFileSync(inboxPathOf(), 'utf8')
    expect(acknowledgeAlert(id, inboxPathOf(), 1_700_000_120_000)).toBe(true)
    expect(readFileSync(inboxPathOf(), 'utf8')).toBe(afterFirst)
    expect(before).not.toBe(afterFirst)
    // A persistent `stopped` in the state export must NOT resurrect the filing.
    expect(syncAlertInbox(1_700_000_180_000)?.unread).toBe(0)
  })

  it('机检4: resolution 读写测例 — 写入可读、后续 fold 不丢、追查会话拿到结构化字段', () => {
    const id = deliveredId()
    expect(setAlertResolution(id, {
      at: 1_700_000_050_000,
      ref: 'content/tech/ai/dsh/revive-incident-1117.md',
      note: '根因 = provider 5xx 连跳',
    })).toBe(true)
    const doc = readInbox()
    expect(doc.entries[0]).toMatchObject({
      id,
      unread: false,
      archived: true,
      heal: 'manual',
      resolution: {
        at: 1_700_000_050_000,
        ref: 'content/tech/ai/dsh/revive-incident-1117.md',
        note: '根因 = provider 5xx 连跳',
      },
    })
    // The next fold (state export still stopped) must not clobber the backfill.
    syncAlertInbox(1_700_000_060_000)
    expect(readInbox().entries[0]?.resolution).toMatchObject({ ref: 'content/tech/ai/dsh/revive-incident-1117.md' })
    // …and an empty ref is refused rather than filed as a fake conclusion.
    expect(setAlertResolution(id, { at: 1, ref: '' })).toBe(false)
    expect(readInbox().entries[0]?.resolution).toMatchObject({ ref: 'content/tech/ai/dsh/revive-incident-1117.md' })
  })

  it('关联追查会话 id: link 写入可读; 未知 id / 未知文档 → false 零写', () => {
    const id = deliveredId()
    expect(linkInvestigationSession(id, 'inv-session-7')).toBe(true)
    expect(readInbox().entries[0]?.investigationSessionId).toBe('inv-session-7')
    expect(linkInvestigationSession('fam-nope', 'inv-session-8')).toBe(false)
    expect(acknowledgeAlert('fam-nope')).toBe(false)
    // Untrusted document (corrupt) → the writers refuse instead of clobbering.
    writeFileSync(inboxPathOf(), 'corrupt', 'utf8')
    expect(acknowledgeAlert(id)).toBe(false)
    expect(readFileSync(inboxPathOf(), 'utf8')).toBe('corrupt')
  })
})
