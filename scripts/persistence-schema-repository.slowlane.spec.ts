/**
 * Repository-wide persistence-schema extraction — the slow lane of the schema contract.
 *
 * The case builds a TypeScript program over the whole workspace and then
 * re-hashes every reachable schema node, which spent minutes of CPU inside the
 * default full run while its fixture-sized siblings cost seconds. Every
 * assertion is the one it carried in `persistence-schema.spec.ts`; only the
 * cadence changed.
 *
 * Membership in the slow lane is by filename (`*.slowlane.spec.ts`): the
 * default `pnpm test` run excludes it, and `pnpm test:slowlane [filters]` runs
 * it. Trigger conditions live in m-note
 * `content/tech/ai/dsh/worktree-governance.md` §5.7 slow-lane roster.
 */

import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectLogEvents } from './gen-persistence-catalog.ts'
import { canonicalizeSchema, schemaDigest } from './persistence-schema-model.ts'
import { extractPersistenceSchema } from './persistence-schema.ts'

describe('persistent source type extraction (slow lane: repository-wide)', () => {
  // Repository-wide TypeScript extraction and reachable-node hashing use the Windows coverage test budget.
  it('includes every real repository event and fingerprints every reachable node', { timeout: 90_000 }, () => {
    const root = resolve(import.meta.dirname, '..')
    const model = extractPersistenceSchema(root)
    expect(model.roots.filter(root => root.kind === 'event').map(root => root.event).sort())
      .toEqual(collectLogEvents(root).map(event => event.name).sort())
    expect(model.roots.some(root => root.kind === 'header')).toBe(true)
    expect(model.roots.some(root => root.kind === 'envelope')).toBe(true)
    const digests = new Set(model.types.map(type => type.digest))
    for (const root of model.roots) {
      expect(schemaDigest(root.schema)).toBe(root.digest)
      for (let node = 0; node < root.schema.nodes.length; node++) {
        expect(digests.has(schemaDigest(canonicalizeSchema(root.schema.nodes, node)))).toBe(true)
      }
    }
  })
})
