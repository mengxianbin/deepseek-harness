/** Full (unsampled) case plan for the linked-resolution differential matrix, one family per record. */

export type Layout = 'single-flat' | 'single-pnpm' | 'pnpm-monorepo'
export type Method = 'esm-resolve' | 'esm-meta-resolve' | 'esm-import' | 'cjs-resolve' | 'cjs-require' | 'cjs-paths' | 'metadata'
export type Importer = 'root' | 'source' | 'nested' | 'pnpm-helper'
export type Source = 'runtime' | 'local' | 'parent' | 'workspace' | 'profile' | 'private'
export type ManifestState = 'absent' | 'plain' | 'peer'
export type ModulesState = 'absent' | 'empty' | 'target'

export const MATRIX_FAMILIES = [
  'root', 'placement', 'workspace-declaration', 'malformed-declaration', 'request-form',
  'helper-declaration', 'node-comparison', 'node-comparison-files', 'node-comparison-explicit', 'node-legacy',
] as const

export type MatrixFamily = typeof MATRIX_FAMILIES[number]

export interface DirectoryState {
  manifest: ManifestState
  modules: ModulesState
}

export interface PeerProjection {
  directory: string
  peerMatches: boolean
  physicalModules: boolean
  physicalTarget: boolean
  projected: boolean
}

export interface MatrixCase {
  id: string
  family: MatrixFamily
  layout: Layout
  name: string
  inRuntime: boolean
  declarations: number
  copies: number
  importer: Importer
  workspaceDeclarations?: number
  helperDeclarations?: number
  variant?: string
  rawPeers?: unknown
  request?: string
  explicitStart?: 'profile'
  comparison?: { start: DirectoryState; parent: DirectoryState; grandparent?: DirectoryState }
  legacy?: { missingSubpaths: readonly Source[] } & { start: ManifestState; parent: ManifestState }
}

export interface Observation {
  selected: string
  path?: string
  code?: string
  message?: string
  sameRuntimeInstance?: boolean
  exists?: boolean
}

export interface MatrixRow {
  scenario: MatrixCase
  declarationText: string
  copiesText: string
  importerPath: string
  linkedRoots: string[]
  methods: Record<Method, Observation>
  comparison?: {
    native: Record<Method, Observation>
    reference: Record<Method, Observation>
    peerProjection: readonly PeerProjection[]
  }
}

export interface ProbeModule {
  source: string
  token: object
}

export interface ResolveProbeModule {
  locate(specifier: string): string
}

export interface NativeLoader {
  getOrCreateModuleJob?: unknown
  import<T = ProbeModule>(specifier: string, parent: string, attributes: ImportAttributes): Promise<T>
  resolveSync(
    first: string,
    second: string | { specifier: string; attributes: ImportAttributes },
    attributes?: ImportAttributes,
  ): { url: string }
}

export const methods: readonly Method[] = ['esm-resolve', 'esm-meta-resolve', 'esm-import', 'cjs-resolve', 'cjs-require', 'cjs-paths', 'metadata']
export const layouts: readonly Layout[] = ['single-flat', 'single-pnpm', 'pnpm-monorepo']
// These are real request spellings; each fixture supplies its own package implementations.
export const names = ['@deepseek-ai/dsh-tools', 'react'] as const
const copyBits: readonly [Source, number][] = [
  ['local', 1], ['parent', 2], ['profile', 4], ['private', 8], ['workspace', 16],
]

export function declarationFields(name: string, bits: number): Record<string, unknown> {
  return {
    ...(bits & 1 ? { dependencies: { [name]: '*' } } : {}),
    ...(bits & 2 ? { devDependencies: { [name]: '*' } } : {}),
    ...(bits & 4 ? { peerDependencies: { [name]: '*' } } : {}),
  }
}

export function declarations(bits: number): string {
  return [[1, 'dependency'], [2, 'dev'], [4, 'peer']]
    .filter(([bit]) => bits & Number(bit)).map(([, name]) => name).join('+') || 'none'
}

export function copies(bits: number): string {
  return copyBits.filter(([, bit]) => bits & bit).map(([name]) => name).join('+') || 'none'
}

export function matrixCases(): MatrixCase[] {
  const cases: MatrixCase[] = []
  for (const layout of layouts) {
    for (const name of names) {
      for (const inRuntime of [false, true]) {
        for (let declarations = 0; declarations < 8; declarations++) {
          for (let copies = 0; copies < 8; copies++) {
            cases.push({ id: '', family: 'root', layout, name, inRuntime, declarations, copies, importer: 'root' })
          }
        }
      }
    }
  }
  for (const layout of layouts) {
    for (const name of names) {
      for (const inRuntime of [false, true]) {
        for (let declarations = 0; declarations < 8; declarations++) {
          for (const importer of ['source', 'nested', 'pnpm-helper'] as const) {
            for (const copies of [8, 9, 10, 11, 16, 17, 31]) {
              cases.push({ id: '', family: 'placement', layout, name, inRuntime, declarations, copies, importer })
            }
          }
        }
      }
    }
  }
  for (const name of names) {
    for (const inRuntime of [false, true]) {
      for (let declarations = 0; declarations < 8; declarations++) {
        for (let workspaceDeclarations = 0; workspaceDeclarations < 8; workspaceDeclarations++) {
          for (const copies of [1, 16, 17]) {
            cases.push({ id: '', family: 'workspace-declaration', layout: 'pnpm-monorepo', name,
              inRuntime, declarations, workspaceDeclarations, copies, importer: 'root' })
          }
        }
      }
    }
  }
  for (const layout of layouts) {
    for (const name of names) {
      for (const inRuntime of [false, true]) {
        for (const [variant, rawPeers] of [
          ['peer-null', null], ['peer-array', [name]], ['peer-string', name],
          ['peer-empty', {}], ['wrong-field', {}], ['peer-range-mismatch', { [name]: '^999.0.0' }],
        ] as const) {
          for (const copies of [1, 19]) {
            cases.push({ id: '', family: 'malformed-declaration', layout, name, inRuntime,
              declarations: 2, copies, importer: 'root', variant, rawPeers })
          }
        }
        for (const declarations of [2, 6]) {
          for (const request of ['#target', `${name}/sub`, `${name}/private`, `${name}/missing`]) {
            for (const copies of [1, 3]) {
              cases.push({ id: '', family: 'request-form', layout, name, inRuntime,
                declarations, copies, importer: 'root', request })
            }
          }
        }
        for (const importer of ['nested', 'pnpm-helper'] as const) {
          for (const declarations of [2, 6]) {
            for (const helperDeclarations of [2, 6]) {
              for (const copies of [1, 9]) {
                cases.push({ id: '', family: 'helper-declaration', layout, name, inRuntime,
                  declarations, helperDeclarations, copies, importer })
              }
            }
          }
        }
      }
    }
  }
  const parents: readonly DirectoryState[] = [
    { manifest: 'absent', modules: 'absent' },
    { manifest: 'absent', modules: 'target' },
    { manifest: 'plain', modules: 'target' },
    { manifest: 'peer', modules: 'absent' },
    { manifest: 'peer', modules: 'target' },
  ]
  let comparisonId = 0
  for (const layout of ['single-flat', 'pnpm-monorepo'] as const) {
    for (const name of names) {
      for (const inRuntime of [false, true]) {
        for (const startManifest of ['absent', 'plain', 'peer'] as const) {
          for (const startModules of ['absent', 'empty', 'target'] as const) {
            for (const parent of parents) {
              cases.push({ id: `N${String(++comparisonId).padStart(4, '0')}`, family: 'node-comparison', layout, name,
                inRuntime, declarations: startManifest === 'peer' ? 4 : 0, copies: 0, importer: 'root',
                comparison: { start: { manifest: startManifest, modules: startModules }, parent } })
            }
          }
        }
        for (const importer of ['root', 'source'] as const) {
          for (const request of [name, `${name}/sub`, `${name}/missing`, `${name}/private`]) {
            for (const startModules of ['absent', 'target'] as const) {
              cases.push({ id: `N${String(++comparisonId).padStart(4, '0')}`, family: 'node-comparison-files', layout, name,
                inRuntime, declarations: 0, copies: 0, importer, request,
                comparison: { start: { manifest: 'absent', modules: startModules },
                  parent: { manifest: 'plain', modules: 'absent' },
                  grandparent: { manifest: 'peer', modules: 'target' } } })
            }
          }
        }
      }
    }
  }
  for (const layout of ['single-flat', 'pnpm-monorepo'] as const) {
    for (const name of names) {
      for (const inRuntime of [false, true]) {
        for (const copies of [0, 4]) {
          cases.push({ id: `N${String(++comparisonId).padStart(4, '0')}`, family: 'node-comparison-explicit', layout,
            name, inRuntime, declarations: 4, copies, importer: 'root', explicitStart: 'profile',
            comparison: { start: { manifest: 'peer', modules: 'target' },
              parent: { manifest: 'absent', modules: 'absent' } } })
        }
      }
    }
  }
  const legacyCases: readonly { start: ManifestState; parent: ManifestState; missingSubpaths: readonly Source[] }[] = [
    { start: 'peer', parent: 'peer', missingSubpaths: [] },
    { start: 'peer', parent: 'plain', missingSubpaths: ['runtime'] },
    { start: 'plain', parent: 'peer', missingSubpaths: ['runtime', 'local'] },
    { start: 'peer', parent: 'peer', missingSubpaths: ['runtime'] },
    { start: 'plain', parent: 'peer', missingSubpaths: ['local'] },
    { start: 'peer', parent: 'peer', missingSubpaths: ['runtime', 'workspace'] },
  ]
  let legacyId = 0
  for (const layout of layouts) {
    for (const name of names) {
      for (const inRuntime of [false, true]) {
        for (const entry of legacyCases) {
          for (const request of [name, `${name}/sub.cjs`, `${name}/missing.cjs`]) {
            cases.push({ id: `L${String(++legacyId).padStart(4, '0')}`, family: 'node-legacy', layout, name,
              inRuntime, declarations: 0, copies: 0, importer: 'root', request,
              variant: `missing-sub:${entry.missingSubpaths.join('+') || 'none'}`, legacy: entry,
              comparison: { start: { manifest: entry.start, modules: 'target' },
                parent: { manifest: entry.parent, modules: 'target' },
                grandparent: { manifest: 'plain', modules: 'target' } } })
          }
        }
      }
    }
  }
  return cases.map((value, index) => ({ ...value, id: value.id || `M${String(index + 1).padStart(4, '0')}` }))
}

/** One case per family, used by the sampling-coverage pin to keep every family executable. */
export function familyCases(family: MatrixFamily): MatrixCase[] {
  return matrixCases().filter(scenario => scenario.family === family)
}
