/** Pairwise (2-way covering array) selection over each family's full case grid.
 *
 * The default lane keeps every value pair of every factor pair per family, plus
 * the explicitly pinned boundary rows in sampling-coverage.spec.ts. Full-depth
 * runs (every grid row) stay one env toggle away: DSH_RESOLUTION_MATRIX_FULL=1.
 */

import { familyCases, type MatrixCase, type MatrixFamily } from './cases.ts'

type FactorValue = string | number | boolean

interface Factor {
  readonly name: string
  readonly value: (scenario: MatrixCase) => FactorValue
}

const layout: Factor = { name: 'layout', value: scenario => scenario.layout }
const name: Factor = { name: 'name', value: scenario => scenario.name }
const inRuntime: Factor = { name: 'inRuntime', value: scenario => scenario.inRuntime }
const declarations: Factor = { name: 'declarations', value: scenario => scenario.declarations }
const copies: Factor = { name: 'copies', value: scenario => scenario.copies }
const importer: Factor = { name: 'importer', value: scenario => scenario.importer }

/** Request spellings embed the package name; the template id keeps the factor domain stable. */
export function requestTemplateOf(scenario: MatrixCase): string {
  const request = scenario.request ?? scenario.name
  if (request === scenario.name) return 'package'
  if (request === '#target') return '#target'
  if (request.endsWith('/sub') || request.endsWith('/sub.cjs')) return 'sub'
  if (request.endsWith('/missing') || request.endsWith('/missing.cjs')) return 'missing'
  if (request.endsWith('/private')) return 'private'
  return request
}

const requestTemplate: Factor = { name: 'requestTemplate', value: requestTemplateOf }

const startManifest: Factor = { name: 'startManifest', value: scenario => scenario.comparison?.start.manifest ?? 'none' }
const startModules: Factor = { name: 'startModules', value: scenario => scenario.comparison?.start.modules ?? 'none' }
const parentDirectory: Factor = {
  name: 'parent',
  value: (scenario) => {
    const parent = scenario.comparison?.parent
    return parent === undefined ? 'none' : `${parent.manifest}/${parent.modules}`
  },
}
const grandparentDirectory: Factor = {
  name: 'grandparent',
  value: (scenario) => {
    const grandparent = scenario.comparison?.grandparent
    return grandparent === undefined ? 'none' : `${grandparent.manifest}/${grandparent.modules}`
  },
}
const workspaceDeclarations: Factor = { name: 'workspaceDeclarations', value: scenario => scenario.workspaceDeclarations ?? 0 }
const helperDeclarations: Factor = { name: 'helperDeclarations', value: scenario => scenario.helperDeclarations ?? 0 }
const malformedVariant: Factor = { name: 'variant', value: scenario => scenario.variant ?? 'none' }
/** The six legacy directory/missing-subpath entries, keyed exactly as the factor spells them. */
export function legacyEntryOf(scenario: MatrixCase): string {
  const legacy = scenario.legacy
  return legacy === undefined ? 'none' : `${scenario.variant}:start=${scenario.comparison?.start.manifest}/parent=${scenario.comparison?.parent.manifest}`
}

const legacyEntry: Factor = { name: 'legacyEntry', value: legacyEntryOf }

export const familyFactors: Record<MatrixFamily, readonly Factor[]> = {
  root: [layout, name, inRuntime, declarations, copies],
  placement: [layout, name, inRuntime, declarations, copies, importer],
  'workspace-declaration': [name, inRuntime, declarations, workspaceDeclarations, copies],
  'malformed-declaration': [layout, name, inRuntime, malformedVariant, copies],
  'request-form': [layout, name, inRuntime, declarations, requestTemplate, copies],
  'helper-declaration': [layout, name, inRuntime, declarations, helperDeclarations, copies, importer],
  'node-comparison': [layout, name, inRuntime, startManifest, startModules, parentDirectory],
  'node-comparison-files': [layout, name, inRuntime, importer, requestTemplate, startModules, grandparentDirectory],
  'node-comparison-explicit': [layout, name, inRuntime, copies],
  'node-legacy': [layout, name, inRuntime, legacyEntry, requestTemplate],
}

/** Greedy set cover over all value pairs, in full-grid order; deterministic and fail-loud. */
export function pairwiseSelect(scenarios: readonly MatrixCase[], factors: readonly Factor[]): MatrixCase[] {
  const levels = factors.map((factor) => {
    const seen = new Set<FactorValue>()
    for (const scenario of scenarios) seen.add(factor.value(scenario))
    return [...seen]
  })
  const uncovered = new Set<string>()
  for (let left = 0; left < factors.length; left++) {
    const leftLevels = levels[left] as FactorValue[]
    for (let right = left + 1; right < factors.length; right++) {
      const rightLevels = levels[right] as FactorValue[]
      for (const leftValue of leftLevels) {
        for (const rightValue of rightLevels) uncovered.add(`${left}\u0000${leftValue}\u0000${right}\u0000${rightValue}`)
      }
    }
  }
  const selected: MatrixCase[] = []
  for (const scenario of scenarios) {
    let coversNewPair = false
    for (let left = 0; left < factors.length; left++) {
      const leftFactor = factors[left] as Factor
      for (let right = left + 1; right < factors.length; right++) {
        const rightFactor = factors[right] as Factor
        const key = `${left}\u0000${leftFactor.value(scenario)}\u0000${right}\u0000${rightFactor.value(scenario)}`
        if (uncovered.delete(key)) coversNewPair = true
      }
    }
    if (coversNewPair) selected.push(scenario)
    if (uncovered.size === 0) break
  }
  if (uncovered.size > 0) throw new Error(`pairwise selection left ${uncovered.size} value pairs uncovered`)
  return selected
}

/** Default lane = pairwise sample; DSH_RESOLUTION_MATRIX_FULL=1 runs the full family grid. */
export function selectFamilyCases(family: MatrixFamily): MatrixCase[] {
  const all = familyCases(family)
  if (process.env.DSH_RESOLUTION_MATRIX_FULL === '1') return all
  return pairwiseSelect(all, familyFactors[family])
}
