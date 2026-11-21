/**
 * 刀① A/B against the REAL dsh home, strictly read-only (list/stat only —
 * the constructor resolves config and `list` never writes). Opt-in so CI and
 * normal runs never touch the machine's sessions:
 *
 *   DSH_AB_REAL_HOME=1 vitest run packages/session/session-persistence-jsonl/tests/ab-real-home.spec.ts
 *
 * Measures cold vs warm `list()`: the header-frame memo must absorb every
 * repeated `translateGenerationHeader` (zstd + parse) on the warm passes.
 * Opt-in probe committed under b1-land-eval-1122 (2026-11-22): skipped by
 * default, so CI and normal runs never touch the machine's sessions.
 */
import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const enabled = process.env.DSH_AB_REAL_HOME === '1'
const root = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'sessions')
  : join(homedir(), '.dsh', 'sessions')

interface PersistenceFace {
  list(): Promise<readonly unknown[]>
  translateGenerationHeader: (...args: unknown[]) => Promise<unknown>
}

describe.skipIf(!enabled)('刀① real-home A/B (read-only)', () => {
  it('warm list() serves the header-frame memo instead of re-translating', { timeout: 120_000 }, async () => {
    const ctx = new Context()
    // The real home is zstd-owned (2088 .jsonl.zstd; the ten .dec/.full.jsonl
    // sidecars are not generation artifacts) — a 'none' backend refuses it at
    // the root-encoding check.
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    try {
      const p = ctx.sessionPersistence as unknown as PersistenceFace
      let translates = 0
      const original = p.translateGenerationHeader.bind(p)
      p.translateGenerationHeader = (...args: unknown[]) => {
        translates += 1
        return original(...args)
      }

      const t0 = performance.now()
      const cold = await p.list()
      const t1 = performance.now()
      const coldTranslates = translates

      const warm1 = await p.list()
      const t2 = performance.now()
      const warm1Translates = translates - coldTranslates

      await p.list()
      const t3 = performance.now()

      const report = {
        root,
        sessions: cold.length,
        coldMs: Math.round(t1 - t0),
        coldTranslates,
        warm1Ms: Math.round(t2 - t1),
        warm1Translates,
        warm2Ms: Math.round(t3 - t2),
      }
      console.log(`AB_REPORT ${JSON.stringify(report)}`)

      // Real home holds thousands of sessions; a tiny fixture would be the
      // wrong root (report, don't silently "pass" on an empty directory).
      expect(cold.length, `expected real home with >100 sessions at ${root}`).toBeGreaterThan(100)
      // The memo contract: unchanged files → zero new translations on warm runs.
      expect(warm1Translates).toBe(0)
      expect(translates).toBe(coldTranslates)
      expect(cold.length).toBe(warm1.length)
      // Warm must actually be faster — the whole point of 刀①.
      expect(report.warm1Ms).toBeLessThan(report.coldMs)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
