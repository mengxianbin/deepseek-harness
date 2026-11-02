/** Shared fixture and probe machinery for the linked-resolution differential matrix families.
 *
 * Split from linked-resolution-matrix.spec.ts: each family spec runs its own
 * cases in its own worker, so the differential keeps cross-file parallelism
 * while every case still builds, probes, and disposes serially inside one
 * process (the ESM loader interception and NODE_PATH reset are process-global,
 * which is why suites never opt into per-file concurrency).
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRuntimeResolution, type Profile } from '../../src/profile.ts'
import { barePackageName, installRuntimeInterception } from '../../src/profile-resolution/resolver.ts'
import {
  declarationFields, declarations, copies, matrixCases, methods, type DirectoryState, type MatrixCase,
  type MatrixFamily, type MatrixRow, type Method, type NativeLoader, type Observation, type PeerProjection,
  type ProbeModule, type ResolveProbeModule, type Source,
} from './cases.ts'

const requireHere = createRequire(import.meta.url)
const nativeModule = requireHere('node:module') as { _initPaths(): void }
const addon = requireHere('node-addon-require-builtin') as { requireBuiltin(id: string): unknown }
const loaderModule = addon.requireBuiltin('internal/modules/esm/loader') as {
  getOrInitializeCascadedLoader(): NativeLoader
}
const loader = loaderModule.getOrInitializeCascadedLoader()
let fixtureSequence = 0

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function manifest(path: string, content: Record<string, unknown>): void {
  put(join(path, 'package.json'), JSON.stringify(content) + '\n')
}

class MatrixFixture {
  // Node keeps resolved paths and modules after cleanup; no fixture may reuse an earlier fixture's path.
  readonly root = realpathSync.native(mkdtempSync(join(tmpdir(), `dsh-linked-matrix-${++fixtureSequence}-`)))
  readonly home = join(this.root, 'home')
  readonly profileDir = join(this.home, 'profiles', 'web')
  readonly workspace = join(this.root, 'work', 'workspace')
  readonly packageDir: string
  readonly sources = new Map<string, Source>()
  readonly importerDir: string
  readonly installDir = join(this.root, 'installation', 'node_modules', '@deepseek-ai', 'dsh')
  readonly runtimeDir: string
  readonly peerProjection: PeerProjection[] = []

  constructor(readonly scenario: MatrixCase) {
    this.packageDir = scenario.layout === 'pnpm-monorepo'
      ? join(this.workspace, 'packages', 'my-plugin')
      : join(this.root, 'work', 'my-plugin')
    const storeOwner = scenario.layout === 'pnpm-monorepo' ? this.workspace : this.packageDir
    const helper = join(storeOwner, 'node_modules', '.pnpm', 'helper@1.0.0', 'node_modules', 'helper')
    this.importerDir = scenario.importer === 'source' ? join(this.packageDir, 'src')
      : scenario.importer === 'nested' ? join(this.packageDir, 'node_modules', 'nested-helper')
        : scenario.importer === 'pnpm-helper' ? helper : this.packageDir
    this.runtimeDir = join(this.installDir, 'node_modules', scenario.name)
  }

  setup(): void {
    const value = this.scenario
    manifest(this.installDir, {
      name: '@deepseek-ai/dsh', version: '1.0.0',
      dependencies: value.inRuntime ? { [value.name]: '*' } : {},
    })
    if (value.inRuntime) this.package(this.runtimeDir, 'runtime')
    manifest(this.profileDir, { name: 'matrix-profile', private: true, dependencies: { 'my-plugin': '*' } })
    if (value.layout === 'pnpm-monorepo') {
      manifest(this.workspace, { name: 'matrix-workspace', private: true,
        ...declarationFields(value.name, value.workspaceDeclarations ?? 0) })
      put(join(this.workspace, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
    }
    const fields = declarationFields(value.name, value.declarations)
    if (Object.hasOwn(value, 'rawPeers')) fields.peerDependencies = value.rawPeers
    if (value.variant === 'wrong-field') {
      delete fields.peerDependencies
      fields.peerDependecies = { [value.name]: '*' }
    }
    manifest(this.packageDir, { name: 'my-plugin', version: '1.0.0', type: 'module',
      exports: { import: './index.mjs', require: './index.cjs' }, imports: { '#target': value.name }, ...fields })
    put(join(this.packageDir, 'index.mjs'), 'export const plugin = true\n')
    put(join(this.packageDir, 'index.cjs'), 'exports.plugin = true\n')
    if (this.importerDir !== this.packageDir) {
      if (value.importer !== 'source') manifest(this.importerDir, { name: 'matrix-helper', type: 'module',
        ...declarationFields(value.name, value.helperDeclarations ?? 4) })
      put(join(this.importerDir, 'probe.mjs'), 'export {}\n')
      put(join(this.importerDir, 'probe.cjs'), '')
    }
    const profileLink = join(this.profileDir, 'node_modules', 'my-plugin')
    this.link(this.packageDir, profileLink)
    if (value.importer === 'pnpm-helper') this.link(this.importerDir, join(this.packageDir, 'node_modules', 'helper'))
    if (value.layout !== 'single-flat') {
      const storeOwner = value.layout === 'pnpm-monorepo' ? this.workspace : this.packageDir
      put(join(storeOwner, 'node_modules', '.modules.yaml'), 'nodeLinker: isolated\nvirtualStoreDir: .pnpm\n')
    }
    if (value.copies & 1) {
      const local = join(this.packageDir, 'node_modules', value.name)
      if (value.layout === 'single-flat') this.package(local, 'local')
      else {
        const storeOwner = value.layout === 'pnpm-monorepo' ? this.workspace : this.packageDir
        const target = join(storeOwner, 'node_modules', '.pnpm', `${value.name.replaceAll('/', '+')}@2.0.0`, 'node_modules', value.name)
        this.package(target, 'local')
        this.link(target, local)
      }
    }
    if (value.copies & 2) this.package(join(dirname(this.packageDir), 'node_modules', value.name), 'parent')
    if (value.copies & 4) this.package(join(this.profileDir, 'node_modules', value.name), 'profile')
    if (value.copies & 8) {
      if (value.importer === 'pnpm-helper') {
        const storeOwner = value.layout === 'pnpm-monorepo' ? this.workspace : this.packageDir
        const target = join(storeOwner, 'node_modules', '.pnpm', `${value.name.replaceAll('/', '+')}@6.0.0`, 'node_modules', value.name)
        this.package(target, 'private')
        this.link(target, join(dirname(this.importerDir), value.name))
      } else this.package(join(this.importerDir, 'node_modules', value.name), 'private')
    }
    if (value.copies & 16) this.package(join(this.workspace, 'node_modules', value.name), 'workspace')
    if (value.comparison !== undefined) {
      this.configureDirectory(this.importerDir, value.comparison.start, 'local')
      this.configureDirectory(dirname(this.importerDir), value.comparison.parent, 'parent')
      if (value.comparison.grandparent !== undefined) {
        this.configureDirectory(dirname(dirname(this.importerDir)), value.comparison.grandparent, 'workspace')
      }
    }
    put(join(this.importerDir, 'entry-query.mjs'), 'export function locate(specifier) { return import.meta.resolve(specifier) }\n')
  }

  private configureDirectory(directory: string, state: DirectoryState, source: Source): void {
    if (state.manifest === 'absent') rmSync(join(directory, 'package.json'), { force: true })
    else manifest(directory, { name: `matrix-${source}`, type: 'module',
      ...(state.manifest === 'peer' ? { peerDependencies: { [this.scenario.name]: '*' } } : {}) })
    const modules = join(directory, 'node_modules')
    // All configured directories are inside this fixture and are changed before any module is resolved.
    if (state.modules === 'absent') rmSync(modules, { recursive: true, force: true })
    else {
      mkdirSync(modules, { recursive: true })
      if (state.modules === 'target') this.package(join(modules, this.scenario.name), source)
    }
  }

  /** Only the reference fixture materializes peer positions; the product resolver is not replaced. */
  projectPeerPositions(): void {
    // A hoisted monorepo helper outside the recorded linked directory remains native.
    if (this.importerDir !== this.packageDir && !this.importerDir.startsWith(this.packageDir + sep)) return
    const paths = createRequire(join(this.importerDir, 'probe.cjs')).resolve.paths(this.scenario.name) ?? []
    for (const modules of paths) {
      if (!modules.startsWith(this.root + sep)) continue
      const directory = dirname(modules)
      const manifestPath = join(directory, 'package.json')
      const info = existsSync(manifestPath)
        ? JSON.parse(readFileSync(manifestPath, 'utf8')) as { peerDependencies?: Record<string, string> } : {}
      const peerMatches = Object.hasOwn(info.peerDependencies ?? {}, this.scenario.name)
      const target = join(modules, this.scenario.name)
      const projected = peerMatches && this.scenario.inRuntime
      this.peerProjection.push({ directory: relative(this.root, directory).split(sep).join('/'), peerMatches,
        physicalModules: existsSync(modules), physicalTarget: existsSync(target), projected })
      if (!projected) continue
      const entry = lstatSync(target, { throwIfNoEntry: false })
      if (entry?.isSymbolicLink()) unlinkSync(target)
      else if (entry !== undefined) rmSync(target, { recursive: true })
      this.link(this.runtimeDir, target)
    }
  }

  private nativePackageDir(request: string, parent: string): string | undefined {
    const name = barePackageName(request)
    if (name === undefined) return undefined
    for (const modules of createRequire(parent).resolve.paths(name) ?? []) {
      const directory = join(modules, name)
      if (existsSync(join(directory, 'package.json'))) return directory
    }
    return undefined
  }

  private package(dir: string, source: Source): void {
    manifest(dir, { name: this.scenario.name, version: '2.0.0', type: 'module',
      ...this.scenario.legacy === undefined ? { exports: { '.': { import: './index.mjs', require: './index.cjs' },
        './sub': { import: './sub.mjs', require: './sub.cjs' },
        './missing': { import: './missing.mjs', require: './missing.cjs' } } } : { main: './index.cjs' } })
    for (const stem of ['index', 'sub']) {
      if (stem === 'sub' && this.scenario.legacy?.missingSubpaths.includes(source)) continue
      put(join(dir, `${stem}.mjs`), `export const source = ${JSON.stringify(source)}\nexport const token = {}\n`)
      put(join(dir, `${stem}.cjs`), `exports.source = ${JSON.stringify(source)}\nexports.token = {}\n`)
    }
    this.sources.set(realpathSync.native(dir), source)
  }

  private link(target: string, path: string): void {
    mkdirSync(dirname(path), { recursive: true })
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    // import.meta.resolve retains the logical symlink spelling for missing exported files.
    const source = this.sources.get(realpathSync.native(target))
    if (source !== undefined) this.sources.set(path, source)
  }

  private classify(path: string): Observation {
    const exists = existsSync(path)
    const canonical = exists ? realpathSync.native(path) : resolve(path)
    for (const [directory, selected] of this.sources) {
      if (canonical === directory || canonical.startsWith(directory + sep)) {
        return { selected, exists, path: relative(this.root, canonical).split(sep).join('/') }
      }
    }
    return { selected: 'external', exists, path: canonical }
  }

  private failed(error: unknown): Observation {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code : error instanceof Error ? error.name : 'UNKNOWN'
    const message = error instanceof Error ? error.message : String(error)
    return { selected: 'error', code, message: message.replaceAll(this.root, '<fixture>') }
  }

  async observe(mode: 'current' | 'native' = 'current'): Promise<MatrixRow> {
    const profile: Profile = { skippedBundles: [], name: 'web', dir: this.profileDir, layers: [],
      patchPath: join(this.profileDir, 'cordis.patch.yml'), patches: [] }
    const resolution = mode === 'current'
      ? await createRuntimeResolution({ installAnchor: join(this.installDir, 'package.json'), profile, home: this.home }) : undefined
    expect(realpathSync.native(join(this.profileDir, 'node_modules', 'my-plugin'))).toBe(this.packageDir)
    const registration = resolution === undefined ? undefined : installRuntimeInterception(resolution)
    try {
      const request = this.scenario.request ?? this.scenario.name
      const parent = pathToFileURL(join(this.importerDir, 'probe.mjs')).href
      const require = createRequire(join(this.importerDir, 'probe.cjs'))
      const query = await loader.import<ResolveProbeModule>(pathToFileURL(join(this.importerDir, 'entry-query.mjs')).href, parent, {})
      const esmResolve = (): string => 'getOrCreateModuleJob' in loader
        ? loader.resolveSync(parent, { specifier: request, attributes: {} }).url
        : loader.resolveSync(request, parent, {}).url
      const runtimeEntry = (extension: 'mjs' | 'cjs'): string => join(this.runtimeDir,
        `${request.endsWith('/sub') || request.endsWith('/sub.cjs') ? 'sub' : 'index'}.${this.scenario.legacy === undefined ? extension : 'cjs'}`)
      const observe = async (method: Method): Promise<Observation> => {
        try {
          if (method === 'metadata') {
            const path = registration === undefined ? this.nativePackageDir(request, parent) : registration.packageDir(request, parent)
            return path === undefined ? { selected: 'missing' } : this.classify(path)
          }
          const path = method === 'esm-meta-resolve' ? fileURLToPath(query.locate(request))
            : method.startsWith('esm') ? fileURLToPath(esmResolve())
              : method === 'cjs-paths' ? require.resolve(request, {
                paths: [this.scenario.explicitStart === 'profile' ? this.profileDir : this.importerDir],
              }) : require.resolve(request)
          const result = this.classify(path)
          // A real host package is not fixture evidence and must never be evaluated by this probe.
          if (result.selected === 'external') return result
          if (method === 'esm-import') {
            const loaded = await loader.import(request, parent, {})
            result.selected = loaded.source
            if (this.scenario.inRuntime) {
              const entry = runtimeEntry('mjs')
              result.sameRuntimeInstance = existsSync(entry)
                && loaded.token === (await loader.import(pathToFileURL(entry).href, parent, {})).token
            }
          } else if (method === 'cjs-require') {
            const loaded = require(request) as ProbeModule
            result.selected = loaded.source
            if (this.scenario.inRuntime) {
              const entry = runtimeEntry('cjs')
              result.sameRuntimeInstance = existsSync(entry) && loaded.token === (require(entry) as ProbeModule).token
            }
          }
          return result
        } catch (error) { return this.failed(error) }
      }
      const answers = {} as Record<Method, Observation>
      for (const method of methods) answers[method] = await observe(method)
      return { scenario: this.scenario, declarationText: declarations(this.scenario.declarations),
        copiesText: copies(this.scenario.copies), importerPath: relative(this.root, this.importerDir).split(sep).join('/'),
        linkedRoots: resolution?.linkedRoots.map(root => relative(this.root, root.realPath).split(sep).join('/')) ?? [],
        methods: answers }
    } finally { registration?.dispose() }
  }

  dispose(): void { rmSync(this.root, { recursive: true, force: true }) }
}

export function outcome(value: Observation): string {
  return value.code ?? `${value.selected}${value.exists === false ? ':path-absent' : ''}`
}

export function comparable(value: Observation): object {
  return { outcome: outcome(value), sameRuntimeInstance: value.sameRuntimeInstance,
    ...(value.exists ? { path: value.path } : {}) }
}

function writeNodeComparison(output: string, selected: readonly MatrixRow[]): void {
  const records = selected.flatMap((row) => {
    const comparison = row.comparison
    const directories = row.scenario.comparison
    if (comparison === undefined) return []
    return methods.map(method => ({
      id: row.scenario.id, layout: row.scenario.layout, name: row.scenario.name,
      inRuntime: row.scenario.inRuntime, request: row.scenario.request ?? row.scenario.name,
      importer: row.scenario.importer, startManifest: directories?.start.manifest ?? row.declarationText,
      explicitStart: row.scenario.explicitStart ?? 'importer',
      startModules: directories?.start.modules ?? row.copiesText, parentManifest: directories?.parent.manifest ?? 'layout',
      parentModules: directories?.parent.modules ?? 'layout', grandparentManifest: directories?.grandparent?.manifest ?? 'layout',
      grandparentModules: directories?.grandparent?.modules ?? 'layout', method,
      native: outcome(comparison.native[method]), current: outcome(row.methods[method]),
      peerReference: outcome(comparison.reference[method]),
      currentMatchesReference: JSON.stringify(comparable(row.methods[method])) === JSON.stringify(comparable(comparison.reference[method])),
    }))
  })
  if (records.length === 0) return
  const columns = ['id', 'layout', 'name', 'inRuntime', 'request', 'importer', 'explicitStart', 'startManifest', 'startModules',
    'parentManifest', 'parentModules', 'grandparentManifest', 'grandparentModules', 'method',
    'native', 'current', 'peerReference', 'currentMatchesReference'] as const
  const csv = [columns.join(','), ...records.map(record => columns.map(column => JSON.stringify(String(record[column]))).join(','))]
  writeFileSync(join(output, 'node-comparison.csv'), csv.join('\n') + '\n', { flag: 'wx' })
  const markdown = [
    '# Node baseline and peer-position reference', '',
    'Native, current, and reference runs use independent fixture paths. Only the reference fixture materializes peer mappings before Node resolves them. Explicit paths and importers outside recorded linked directories use the unmodified native behavior. Assertions compare selected packages, existing file paths, failure codes, and runtime module identity.', '',
    '| ID | Layout | Package | Runtime | Request | Importer | Explicit paths start | JSON here | node_modules here | Parent JSON | Parent node_modules | Method | Native Node | Current DSH | Peer reference | Matches reference |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...records.map(record => `| ${[record.id, record.layout, record.name, record.inRuntime, record.request, record.importer,
      record.explicitStart, record.startManifest, record.startModules, record.parentManifest, record.parentModules,
      record.method, record.native, record.current, record.peerReference, record.currentMatchesReference].join(' | ')} |`), '',
  ]
  writeFileSync(join(output, 'node-comparison.md'), markdown.join('\n'), { flag: 'wx' })
}

function writeFamilyReport(family: MatrixFamily, planned: number, rows: readonly MatrixRow[]): void {
  const parent = process.env.DSH_RESOLUTION_MATRIX_REPORT_DIR
  if (parent === undefined) return
  mkdirSync(parent, { recursive: true })
  const output = mkdtempSync(join(resolve(parent), `${family}-`))
  const sorted = [...rows].sort((left, right) => left.scenario.id.localeCompare(right.scenario.id))
  const csv = [
    ['id', 'family', 'layout', 'package', 'inRuntime', 'declarations', 'workspaceDeclarations', 'helperDeclarations',
      'variant', 'request', 'copies', 'importer', ...methods],
    ...sorted.map(row => [row.scenario.id, row.scenario.family, row.scenario.layout, row.scenario.name,
      row.scenario.inRuntime, declarations(row.scenario.declarations), declarations(row.scenario.workspaceDeclarations ?? 0),
      declarations(row.scenario.helperDeclarations ?? 4), row.scenario.variant ?? '', row.scenario.request ?? row.scenario.name,
      copies(row.scenario.copies), row.importerPath,
      ...methods.map(method => outcome(row.methods[method]))]),
  ].map(line => line.map(value => JSON.stringify(String(value))).join(',')).join('\n') + '\n'
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  writeFileSync(join(output, `matrix-${family}.json`), JSON.stringify({ node: process.versions.node, platform: process.platform,
    sourceHead, family, mode: process.env.DSH_RESOLUTION_MATRIX_FULL === '1' ? 'full' : 'sampled',
    plannedCases: planned, observedCases: sorted.length, rule: 'native-node-with-peer-positions',
    rows: sorted }, null, 2) + '\n', { flag: 'wx' })
  writeFileSync(join(output, `matrix-${family}.csv`), csv, { flag: 'wx' })
  writeNodeComparison(output, sorted)
  const markdown = [
    `# Linked resolution regression matrix · ${family}`, '',
    'Every row is checked against native Node with only the matching peer positions replaced by the runtime package. The node-comparison report includes both baselines and the per-operation verdict.', '',
    '| ID | Family | Layout | Package | Runtime entry | Declaration | Workspace declaration | Helper declaration | Variant | Request | Copies | Importer | ESM resolve | import.meta.resolve | ESM import | CJS resolve | CJS require | CJS paths | Metadata |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...sorted.map(row => `| ${[row.scenario.id, row.scenario.family, row.scenario.layout, row.scenario.name, row.scenario.inRuntime,
      declarations(row.scenario.declarations), declarations(row.scenario.workspaceDeclarations ?? 0),
      declarations(row.scenario.helperDeclarations ?? 4), row.scenario.variant ?? '',
      row.scenario.request ?? row.scenario.name, copies(row.scenario.copies), row.scenario.importer,
      ...methods.map(method => outcome(row.methods[method]))].join(' | ')} |`),
    '',
  ].join('\n')
  writeFileSync(join(output, `matrix-${family}.md`), markdown, { flag: 'wx' })
  console.info(`Resolution matrix: family=${family} mode=${process.env.DSH_RESOLUTION_MATRIX_FULL === '1' ? 'full' : 'sampled'} `
    + `${sorted.length}/${planned} observations at ${output}`)
}

/** Register one family's suite: NODE_PATH isolation, serial differential cases, and the env-gated report. */
export function runFamilySuite(family: MatrixFamily, scenarios: readonly MatrixCase[]): void {
  const originalNodePath = process.env.NODE_PATH
  const rows: MatrixRow[] = []
  // pnpm's launcher adds repository packages to NODE_PATH; fixtures must supply their own copies.
  beforeAll(() => {
    delete process.env.NODE_PATH
    nativeModule._initPaths()
  })
  afterAll(() => {
    if (originalNodePath === undefined) delete process.env.NODE_PATH
    else process.env.NODE_PATH = originalNodePath
    nativeModule._initPaths()
  })
  afterAll(() => { writeFamilyReport(family, matrixCases().filter(scenario => scenario.family === family).length, rows) })
  describe(`linked resolution differential matrix · ${family}`, { concurrent: false }, () => {
    it.each(scenarios)('$id $family $layout $name runtime=$inRuntime declarations=$declarations copies=$copies importer=$importer', async (scenario) => {
      const fixtures: MatrixFixture[] = []
      try {
        const baseline = new MatrixFixture(scenario)
        fixtures.push(baseline)
        baseline.setup()
        const native = await baseline.observe('native')
        const fixture = new MatrixFixture(scenario)
        fixtures.push(fixture)
        fixture.setup()
        const row = await fixture.observe()
        const reference = new MatrixFixture(scenario)
        fixtures.push(reference)
        reference.setup()
        reference.projectPeerPositions()
        const projected = await reference.observe('native')
        // Explicit paths are exempt from the policy and use the pristine native filesystem.
        projected.methods['cjs-paths'] = native.methods['cjs-paths']
        row.comparison = { native: native.methods, reference: projected.methods, peerProjection: reference.peerProjection }
        rows.push(row)
        if (reference.peerProjection.every(layer => !layer.projected)) expect(projected.methods).toEqual(native.methods)
        for (const method of methods) {
          for (const observed of [native, row, projected]) expect(observed.methods[method].selected).not.toBe('external')
          expect(comparable(row.methods[method]), `${scenario.id}: ${method}`).toEqual(comparable(projected.methods[method]))
        }
        expect(Object.keys(row.methods)).toEqual(methods)
      } finally { for (const fixture of fixtures.reverse()) fixture.dispose() }
    })
  })
}
