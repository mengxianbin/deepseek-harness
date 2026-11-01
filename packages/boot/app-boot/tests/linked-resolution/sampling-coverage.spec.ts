/** Machine-checkable coverage argument for the matrix sampling: pure computation, no fixtures (fast lane). */

import { describe, expect, it } from 'vitest'
import { MATRIX_FAMILIES, familyCases, matrixCases, type MatrixCase, type MatrixFamily } from './cases.ts'
import { familyFactors, legacyEntryOf, requestTemplateOf, selectFamilyCases } from './sampling.ts'

// Plan pin: the full grid the split preserves. Change deliberately when factors change.
const PLAN: Record<MatrixFamily, number> = {
  root: 768,
  placement: 2016,
  'workspace-declaration': 768,
  'malformed-declaration': 144,
  'request-form': 192,
  'helper-declaration': 192,
  'node-comparison': 360,
  'node-comparison-files': 128,
  'node-comparison-explicit': 16,
  'node-legacy': 216,
}

interface Pin {
  readonly label: string
  readonly match: (scenario: MatrixCase) => boolean
}

const malformedVariant = (scenario: MatrixCase): string => scenario.variant ?? 'none'

// Boundary pins are written as single factors or factor pairs — exactly what a
// pairwise covering array guarantees. Multi-factor corners are covered by the
// pairwise loop below, which every family sample must pass.
const boundaryPins: Record<MatrixFamily, readonly Pin[]> = {
  root: [
    { label: 'decl0×copies0 (nothing declared, no copies)', match: scenario => scenario.declarations === 0 && scenario.copies === 0 },
    { label: 'decl7×copies7 (all declarations, all available copies)', match: scenario => scenario.declarations === 7 && scenario.copies === 7 },
    ...[1, 2, 4].map(bit => ({ label: `single declaration bit ${bit} × copies0`,
      match: (scenario: MatrixCase) => scenario.declarations === bit && scenario.copies === 0 })),
    ...[1, 2, 4].map(bit => ({ label: `decl0 × single copy bit ${bit}`,
      match: (scenario: MatrixCase) => scenario.declarations === 0 && scenario.copies === bit })),
    { label: 'layout single-pnpm present', match: scenario => scenario.layout === 'single-pnpm' },
    { label: 'package react present', match: scenario => scenario.name === 'react' },
    { label: 'inRuntime=false present', match: scenario => !scenario.inRuntime },
  ],
  placement: [
    { label: 'decl0×copies8 (no declarations, private-only copy)', match: scenario => scenario.declarations === 0 && scenario.copies === 8 },
    { label: 'decl7×copies31 (all declarations, all copies)', match: scenario => scenario.declarations === 7 && scenario.copies === 31 },
    { label: 'decl1×copies8', match: scenario => scenario.declarations === 1 && scenario.copies === 8 },
    { label: 'decl4×copies31', match: scenario => scenario.declarations === 4 && scenario.copies === 31 },
    ...(['source', 'nested', 'pnpm-helper'] as const).map(value => ({ label: `importer ${value} × copies31`,
      match: (scenario: MatrixCase) => scenario.importer === value && scenario.copies === 31 })),
  ],
  'workspace-declaration': [
    { label: 'decl0×workspace-decl0 (no declarations anywhere)', match: scenario => scenario.declarations === 0 && scenario.workspaceDeclarations === 0 },
    { label: 'decl7×workspace-decl7 (all declarations everywhere)', match: scenario => scenario.declarations === 7 && scenario.workspaceDeclarations === 7 },
    { label: 'decl1×workspace-decl0', match: scenario => scenario.declarations === 1 && scenario.workspaceDeclarations === 0 },
    { label: 'decl0×workspace-decl1', match: scenario => scenario.declarations === 0 && scenario.workspaceDeclarations === 1 },
    { label: 'workspace-decl7×copies17 (workspace copy + hoisted)', match: scenario => scenario.workspaceDeclarations === 7 && scenario.copies === 17 },
  ],
  'malformed-declaration': (['peer-null', 'peer-array', 'peer-string', 'peer-empty', 'wrong-field', 'peer-range-mismatch'] as const)
    .flatMap(variant => [1, 19].map(copies => ({ label: `${variant} × copies${copies}`,
      match: (scenario: MatrixCase) => malformedVariant(scenario) === variant && scenario.copies === copies }))),
  'request-form': (['#target', 'sub', 'private', 'missing'] as const)
    .flatMap(template => [1, 3].map(copies => ({ label: `request ${template} × copies${copies}`,
      match: (scenario: MatrixCase) => requestTemplateOf(scenario) === template && scenario.copies === copies }))),
  'helper-declaration': [
    { label: 'decl2×helper-decl2', match: scenario => scenario.declarations === 2 && scenario.helperDeclarations === 2 },
    { label: 'decl6×helper-decl6', match: scenario => scenario.declarations === 6 && scenario.helperDeclarations === 6 },
    { label: 'helper-decl2 × importer nested', match: scenario => scenario.helperDeclarations === 2 && scenario.importer === 'nested' },
    { label: 'helper-decl6 × importer pnpm-helper', match: scenario => scenario.helperDeclarations === 6 && scenario.importer === 'pnpm-helper' },
    { label: 'helper-decl6 × copies9', match: scenario => scenario.helperDeclarations === 6 && scenario.copies === 9 },
    { label: 'helper-decl2 × copies1', match: scenario => scenario.helperDeclarations === 2 && scenario.copies === 1 },
  ],
  'node-comparison': [
    { label: 'start manifest absent × parent absent/absent',
      match: scenario => scenario.comparison?.start.manifest === 'absent'
        && scenario.comparison.parent.manifest === 'absent' && scenario.comparison.parent.modules === 'absent' },
    { label: 'start peer × parent peer/target',
      match: scenario => scenario.comparison?.start.manifest === 'peer'
        && scenario.comparison.parent.manifest === 'peer' && scenario.comparison.parent.modules === 'target' },
    { label: 'start modules empty × parent peer/absent',
      match: scenario => scenario.comparison?.start.modules === 'empty'
        && scenario.comparison.parent.manifest === 'peer' && scenario.comparison.parent.modules === 'absent' },
    { label: 'start modules target × parent absent/absent',
      match: scenario => scenario.comparison?.start.modules === 'target'
        && scenario.comparison.parent.manifest === 'absent' && scenario.comparison.parent.modules === 'absent' },
    { label: 'start plain × start modules empty',
      match: scenario => scenario.comparison?.start.manifest === 'plain' && scenario.comparison.start.modules === 'empty' },
    { label: 'parent plain/target present',
      match: scenario => scenario.comparison?.parent.manifest === 'plain' && scenario.comparison.parent.modules === 'target' },
  ],
  'node-comparison-files': [
    { label: 'request package × start modules absent',
      match: scenario => requestTemplateOf(scenario) === 'package' && scenario.comparison?.start.modules === 'absent' },
    { label: 'request sub × start modules absent',
      match: scenario => requestTemplateOf(scenario) === 'sub' && scenario.comparison?.start.modules === 'absent' },
    { label: 'request missing × start modules target',
      match: scenario => requestTemplateOf(scenario) === 'missing' && scenario.comparison?.start.modules === 'target' },
    { label: 'request private × start modules target',
      match: scenario => requestTemplateOf(scenario) === 'private' && scenario.comparison?.start.modules === 'target' },
    { label: 'importer source × request package',
      match: scenario => scenario.importer === 'source' && requestTemplateOf(scenario) === 'package' },
    { label: 'importer root × request missing',
      match: scenario => scenario.importer === 'root' && requestTemplateOf(scenario) === 'missing' },
  ],
  'node-comparison-explicit': [
    { label: 'copies0 (no profile copy at explicit start)', match: scenario => scenario.copies === 0 },
    { label: 'copies4 (profile copy at explicit start)', match: scenario => scenario.copies === 4 },
    { label: 'explicit profile start × copies4', match: scenario => scenario.explicitStart === 'profile' && scenario.copies === 4 },
    { label: 'explicit profile start × package react', match: scenario => scenario.explicitStart === 'profile' && scenario.name === 'react' },
  ],
  'node-legacy': [
    ...[
      'missing-sub:none:start=peer/parent=peer',
      'missing-sub:runtime:start=peer/parent=plain',
      'missing-sub:runtime+local:start=plain/parent=peer',
      'missing-sub:runtime:start=peer/parent=peer',
      'missing-sub:local:start=plain/parent=peer',
      'missing-sub:runtime+workspace:start=peer/parent=peer',
    ].map(entry => ({ label: `legacy entry ${entry}`,
      match: (scenario: MatrixCase) => legacyEntryOf(scenario) === entry })),
    { label: 'legacy entry none × request package',
      match: scenario => legacyEntryOf(scenario) === 'missing-sub:none:start=peer/parent=peer' && requestTemplateOf(scenario) === 'package' },
    { label: 'legacy entry runtime×plain × request sub.cjs',
      match: scenario => legacyEntryOf(scenario) === 'missing-sub:runtime:start=peer/parent=plain' && requestTemplateOf(scenario) === 'sub' },
    { label: 'legacy entry runtime+local × request missing.cjs',
      match: scenario => legacyEntryOf(scenario) === 'missing-sub:runtime+local:start=plain/parent=peer' && requestTemplateOf(scenario) === 'missing' },
  ],
}

describe('matrix sampling coverage argument', () => {
  it('pins the full plan at 4800 cases across exactly the ten families', () => {
    const all = matrixCases()
    expect(all.length).toBe(4800)
    expect([...MATRIX_FAMILIES].sort()).toEqual(Object.keys(PLAN).sort())
    for (const family of MATRIX_FAMILIES) {
      expect(familyCases(family).length, `${family} plan count`).toBe(PLAN[family])
    }
  })

  it('samples only full-grid members, keeps every family executable, and stays strictly smaller than the plan', () => {
    const fullMode = process.env.DSH_RESOLUTION_MATRIX_FULL === '1'
    let sampledTotal = 0
    for (const family of MATRIX_FAMILIES) {
      const full = familyCases(family)
      const sampled = selectFamilyCases(family)
      sampledTotal += sampled.length
      expect(sampled.length, `${family} sample count`).toBeGreaterThan(0)
      const fullIds = new Set(full.map(scenario => scenario.id))
      const sampledIds = sampled.map(scenario => scenario.id)
      expect(new Set(sampledIds).size, `${family} sample ids unique`).toBe(sampledIds.length)
      for (const id of sampledIds) expect(fullIds.has(id), `${family} sample ${id} belongs to the full grid`).toBe(true)
    }
    if (fullMode) expect(sampledTotal).toBe(4800)
    else expect(sampledTotal).toBeLessThan(4800)
  })

  it('keeps every value of every factor in every family sample', () => {
    for (const family of MATRIX_FAMILIES) {
      const full = familyCases(family)
      const sampled = selectFamilyCases(family)
      for (const factor of familyFactors[family]) {
        const fullLevels = new Set(full.map(factor.value))
        const sampledLevels = new Set(sampled.map(factor.value))
        expect([...sampledLevels].sort(), `${family} factor ${factor.name} levels`).toEqual([...fullLevels].sort())
      }
    }
  })

  it('covers every value pair of every factor pair in every family sample (pairwise)', () => {
    for (const family of MATRIX_FAMILIES) {
      const full = familyCases(family)
      const factors = familyFactors[family]
      const sampled = selectFamilyCases(family)
      const uncovered = new Set<string>()
      // The requirement domain comes from the FULL grid, so a lost value cannot hide its own pair.
      const levels = factors.map((factor) => {
        const seen = new Set<string | number | boolean>()
        for (const scenario of full) seen.add(factor.value(scenario))
        return [...seen]
      })
      for (let left = 0; left < factors.length; left++) {
        const leftLevels = levels[left] as (string | number | boolean)[]
        for (let right = left + 1; right < factors.length; right++) {
          const rightLevels = levels[right] as (string | number | boolean)[]
          for (const leftValue of leftLevels) {
            for (const rightValue of rightLevels) uncovered.add(`${left}\u0000${leftValue}\u0000${right}\u0000${rightValue}`)
          }
        }
      }
      for (const scenario of sampled) {
        for (let left = 0; left < factors.length; left++) {
          const leftFactor = factors[left] as typeof factors[number]
          for (let right = left + 1; right < factors.length; right++) {
            const rightFactor = factors[right] as typeof factors[number]
            uncovered.delete(`${left}\u0000${leftFactor.value(scenario)}\u0000${right}\u0000${rightFactor.value(scenario)}`)
          }
        }
      }
      expect(uncovered.size, `${family} uncovered value pairs`).toBe(0)
    }
  })

  it('pins every documented boundary row of every family sample', () => {
    for (const family of MATRIX_FAMILIES) {
      const sampled = selectFamilyCases(family)
      for (const pin of boundaryPins[family]) {
        expect(sampled.some(pin.match), `${family}: ${pin.label}`).toBe(true)
      }
    }
  })
})
