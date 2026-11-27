/** Profile-owned configuration edits, serialized with Loader hot reload. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import { parseEntryYaml, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-hmr'
import {
  composeEntries, loadOptionalPatches, loadProfileDirectory, LOCAL_PATCH_FILENAME, PROFILE_PATCH_FILENAME,
  readProfilePatches, reconcileProfilePatches,
} from '@deepseek-ai/dsh-app-boot'
import { resolveLinkedPath, withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { auditLine } from '@deepseek-ai/dsh-audit-line'
import { isMap, isSeq, parseDocument, Scalar, visit } from 'yaml'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Persistent edits to the active profile's plugin configuration. */
    configEditor: ConfigEditor
  }
}

function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : []])
}

/** Cap on changed-key paths printed in one `patch written` journal line. */
const MAX_AUDIT_KEYS = 24

/** Collect the dotted leaf paths whose value differs between two raw configs. */
function changedKeyPaths(current: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const paths: string[] = []
  const walk = (before: unknown, after: unknown, path: readonly string[]): void => {
    if (isDeepStrictEqual(before, after)) return
    const beforeObject = typeof before === 'object' && before !== null && !Array.isArray(before)
    const afterObject = typeof after === 'object' && after !== null && !Array.isArray(after)
    if (beforeObject && afterObject) {
      const keys = new Set([...Object.keys(before), ...Object.keys(after)])
      for (const key of keys) walk((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], [...path, key])
      return
    }
    if (path.length === 0) return
    paths.push(path.join('.'))
  }
  walk(current, next, [])
  return paths
}

/** Persist complete raw configs and apply them through the normal Loader path. */
export class ConfigEditor extends Service {
  static inject = ['loader', 'profileContext']

  constructor(private readonly ownerContext: Context) {
    super(ownerContext, 'configEditor')
  }

  /** The local patch document edited by this service: the volatile layer above home. */
  get documentPath(): string {
    return resolveLinkedPath(join(this.ownerContext.profileContext.dir, LOCAL_PATCH_FILENAME))
  }

  /** Addressable profile rows; nested Includes have independent configuration ownership.
   * @returns Active entries with unique profile patch ids.
   */
  entries(): Entry[] {
    const candidates = [...this.ownerContext.loader.entries()].filter(entry => entry.parent.tree.ctx.fiber.entry?.id === 'include')
    const counts = new Map<string, number>()
    for (const entry of candidates) counts.set(entry.options.id, (counts.get(entry.options.id) ?? 0) + 1)
    return candidates.filter(entry => counts.get(entry.options.id) === 1)
  }

  /** Read inherited and explicit values for the active entries across every file layer.
   * @returns Detached layer values alongside their Loader entries.
   */
  configuration(): Array<{ entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown> }> {
    const profile = this.ownerContext.profileContext
    const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
    const home = loadOptionalPatches('dsh', join(profile.home, PROFILE_PATCH_FILENAME)) ?? []
    const local = loadOptionalPatches('dsh', join(profile.dir, LOCAL_PATCH_FILENAME)) ?? []
    const entries = this.entries()
    // An own config key can replace inherited config even when its value is undefined.
    // The local document is the edited layer, so only its own keys count as overrides.
    const overridden = new Set(local.filter(patch => patch.insert === undefined && Object.hasOwn(patch, 'config')).map(patch => patch.id))
    const composed = new Map<string, EntryOptions>()
    if (entries.some(entry => !overridden.has(entry.options.id))) {
      for (const row of flatten(composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches, home, local]))) {
        if (!composed.has(row.id)) composed.set(row.id, row)
      }
    }
    return entries.map(entry => ({
      entry,
      inherited: overridden.has(entry.options.id)
        ? this.inherited(entry, loaded, home, local)
        : structuredClone((composed.get(entry.options.id)?.config ?? {}) as Record<string, unknown>),
      override: structuredClone((local.findLast(
        row => row.id === entry.options.id && row.config !== undefined,
      )?.config ?? {}) as Record<string, unknown>),
    }))
  }

  /** Compose the layers beneath the local document: bundle, profile, and home, then the local layer minus this entry's own config. */
  private inherited(
    entry: Entry,
    loaded: ReturnType<typeof loadProfileDirectory>,
    home: PatchOptions[],
    local: PatchOptions[],
  ): Record<string, unknown> {
    const patches = local.map((patch) => {
      if (patch.id !== entry.options.id || patch.insert !== undefined) return patch
      const rest = { ...patch }; Reflect.deleteProperty(rest, 'config')
      return rest
    })
    const row = flatten(composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches, home, patches]))
      .find(row => row.id === entry.options.id)
    return structuredClone((row?.config ?? {}) as Record<string, unknown>)
  }

  /** Validate, persist, and reconcile a plugin's next config; ordinary fields keep normal lifecycle rules.
   * @param entry Current Loader entry, also used to detect replacement during the write.
   * @param change Derive a raw config from the current entry and its inherited layer.
   * @param by Author of the write — the Remote caller's `peer:<id>` when the change
   *   arrived over the gateway, `unknown` for in-process callers; recorded on the
   *   `patch written` journal line once the write commits.
   * @returns Fulfillment after Loader reconciliation completes.
   */
  async edit(
    entry: Entry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
    by: string = 'unknown',
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const path = this.documentPath
      await withFileLock(join(this.ownerContext.profileContext.dir, 'package.json'), async () => {
        if (!this.entries().includes(entry) || entry.fiber === undefined) throw new Error('Configuration entry is no longer available')
        const beforePatches = readProfilePatches('dsh', this.ownerContext.profileContext)
        await reconcileProfilePatches(this.ownerContext[Context.root], beforePatches, 'dsh')
        if (!this.entries().includes(entry)) throw new Error('Configuration entry changed during reload')
        const current = structuredClone((entry.options.config ?? {}) as Record<string, unknown>)
        const profile = this.ownerContext.profileContext
        const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
        const home = loadOptionalPatches('dsh', join(profile.home, PROFILE_PATCH_FILENAME)) ?? []
        const local = loadOptionalPatches('dsh', join(profile.dir, LOCAL_PATCH_FILENAME)) ?? []
        const inherited = this.inherited(entry, loaded, home, local)
        const next = change(current, inherited)
        const fiber = entry.fiber
        if (fiber.state !== FiberState.ACTIVE) throw new Error('Configuration plugin is no longer active')
        fiber.resolveConfig(next)
        let before: string
        try { before = await readFile(path, 'utf8') }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          before = '[]\n'
        }
        const document = parseDocument(before, {
          customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
        })
        if (document.errors[0] !== undefined) throw document.errors[0]
        if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
        document.contents.flow = false
        const index = document.contents.items.findLastIndex((item, index) => isMap(item)
          && document.getIn([index, 'id']) === entry.options.id && !item.has('insert')
          && (!item.has('name') || document.getIn([index, 'name']) === entry.options.name))
        if (isDeepStrictEqual(next, inherited)) {
          for (let index = document.contents.items.length - 1; index >= 0; index--) {
            const row = document.contents.items[index]
            if (!isMap(row) || document.getIn([index, 'id']) !== entry.options.id || row.has('insert')) continue
            row.delete('config')
            if (row.items.length === Number(row.has('id')) + Number(row.has('name'))) document.delete(index)
          }
        } else if (index < 0) document.add(document.createNode({ id: entry.options.id, name: entry.options.name, config: next }))
        else document.setIn([index, 'config'], document.createNode(next))
        visit(document, { Map(_key, node) {
          if (node.items.length !== 1 || typeof node.get('__jsExpr') !== 'string') return
          const expression = new Scalar(node.get('__jsExpr'))
          expression.tag = 'tag:yaml.org,2002:js'
          return expression
        } })
        // The document sits in the local slot, above bundle, profile, and home:
        // only a `--patch` overlay applied after it can still change the outcome.
        const documentPatches = parseEntryYaml(String(document)) as PatchOptions[]
        const patches = readProfilePatches('dsh', profile, loaded, documentPatches)
        const effective = flatten(composeEntries([patches])).find(row => row.id === entry.options.id)
        if (!isDeepStrictEqual(effective?.config ?? {}, next)) {
          throw new Error(`Configuration for "${entry.options.id}" is overridden by a command-line overlay`)
        }
        await writeFileAtomic(path, String(document), { mode: 0o600 })
        try {
          await reconcileProfilePatches(this.ownerContext[Context.root], patches, 'dsh', [entry.options.id])
        } catch (error) {
          await writeFileAtomic(path, before, { mode: 0o600 })
          await reconcileProfilePatches(this.ownerContext[Context.root], beforePatches, 'dsh')
          throw error
        }
        // A committed patch write is the configuration-change audit point: the
        // profile patch is the first cause of every reload chain, yet nothing
        // recorded who wrote it or which keys changed. Emitted only after
        // reconciliation succeeds — a rolled-back write leaves no line; direct
        // stdout so the launcher captures it into the host journal (a logger
        // console exporter is not mounted in the shipped profile).
        const changed = changedKeyPaths(current, next).map(path => `${entry.options.id}.${path}`)
        const keys = changed.length > MAX_AUDIT_KEYS
          ? `${changed.slice(0, MAX_AUDIT_KEYS).join(',')},…+${changed.length - MAX_AUDIT_KEYS}`
          : changed.join(',')
        auditLine(`patch written keys=[${keys}] by=${by}`)
      })
    }
    const hmr = this.ownerContext.get('hmr')
    await (hmr === undefined ? run() : hmr.runExclusive(run))
  }
}

export default ConfigEditor
