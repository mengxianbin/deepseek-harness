/**
 * Model-level reasoning effort memory (#M): one plain dictionary of model id to
 * effort id, written only by the effort pane and read by the resolution fold.
 *
 * The dictionary is the whole plugin config, so a profile patch that writes it
 * replaces the whole map. {@link ModelEffortMemory.remember} therefore reads the
 * current entry config, changes one key, and writes the complete map back
 * through the owning profile entry, serialized in submission order.
 *
 * @module @deepseek-ai/dsh-model-effort-memory
 */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-config-editor'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Model-level reasoning effort memory shared by every Host entry point. */
    modelEffortMemory: ModelEffortMemory
  }
}

/** Remembered effort id per provider-owned model id. */
export type EffortMemory = Record<string, string>

/** Config schema: one plain dictionary, live-committed without a plugin remount. */
export const EffortMemoryConfig = z.dict(z.string()).default({}).volatile()

/** Config references held by one plugin instance. */
export type Config = Volatile<EffortMemory>

/**
 * Owns the model-level effort memory independently of any Host or transport.
 * The dictionary root is volatile, so writes commit into the running reference
 * and only the effort pane's calls ever change it.
 */
export class ModelEffortMemory extends Service {
  private saves: Promise<void> = Promise.resolve()

  static Config = EffortMemoryConfig

  constructor(private readonly ownerContext: Context, private config: Config) {
    super(ownerContext, 'modelEffortMemory')

    ownerContext.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ownerContext.fiber))
    })
  }

  /**
   * Read the effort remembered for one model id.
   * @param model - provider-owned model id to look up.
   * @returns the remembered effort id, or undefined when this model has none.
   */
  effortFor(model: string): string | undefined {
    return this.config.get()[model]
  }

  /**
   * Remember an effort for one model id in the owning profile entry.
   * A deployment without a configuration editor keeps its composition entry.
   * Writes commit in submission order; a failed write rejects its caller
   * without blocking later writes.
   * @param model - provider-owned model id to remember.
   * @param effort - adapter-owned effort id to associate with it.
   * @returns fulfillment after the optional profile write settles.
   */
  async remember(model: string, effort: string): Promise<void> {
    await this.write(current => ({ ...current, [model]: effort }))
  }

  /**
   * Drop the effort remembered for one model id, leaving other models untouched.
   * @param model - provider-owned model id to forget.
   * @returns fulfillment after the optional profile write settles.
   */
  async forget(model: string): Promise<void> {
    await this.write((current) => {
      if (!(model in current)) return current
      // Rebuild without the key instead of `delete`: a dynamic delete both
      // trips the lint rule and pushes the object into dictionary mode.
      return Object.fromEntries(Object.entries(current).filter(([key]) => key !== model)) as EffortMemory
    })
  }

  /** Read the entry's whole dictionary, change it, and write it back in order. */
  private async write(change: (current: EffortMemory) => EffortMemory): Promise<void> {
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) return
    const editor = this.ctx.get('configEditor')
    if (editor === undefined) return
    const saved = this.saves.then(() => editor.edit(entry, current => change({ ...current } as EffortMemory)))
    this.saves = saved.catch(() => {})
    await saved
  }
}

export default ModelEffortMemory
