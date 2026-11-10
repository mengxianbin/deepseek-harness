/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-config-editor'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Default model selection supplied by plugin configuration. */
export interface Config {
  /** Registered provider route. */
  provider: Volatile<string>
  /** Provider-owned model id. */
  model: Volatile<string>
}

/**
 * Project stored settings onto the Agent-facing selection type.
 *
 * The stored default carries the direction only. Effort is not part of it:
 * a fresh selection stays bare and the resolution fold supplies whatever the
 * model's memory or route default says, so the deployment default can never
 * pin a level the effort pane did not choose.
 */
function selection(settings: { provider: string; model: string }): ModelSelection {
  return { provider: settings.provider, model: settings.model }
}

/**
 * Owns the default model selection independently of any Host or transport.
 * Each operation reads the owning Config references.
 */
export class AgentDefaultModelConfig extends Service {
  private saves: Promise<void> = Promise.resolve()

  static Config = z.object({
    provider: z.string().required().volatile(),
    model: z.string().required().volatile(),
  })

  constructor(private readonly ownerContext: Context, private config: Config) {
    super(ownerContext, 'agentDefaultModel')

    ownerContext.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ownerContext.fiber)) })
  }

  /**
   * Read the current default model selection.
   * @returns a detached provider and model; effort is never stored here.
   */
  currentSelection(): ModelSelection {
    return selection({ provider: this.config.provider.get(), model: this.config.model.get() })
  }

  /**
   * Save the direction of the default model selection. A deployment without a
   * configuration editor keeps its composition entry. Any effort on `next` is
   * dropped rather than persisted: effort lives in the model-level memory, and
   * writing it here would let a model switch repin a level. Saves commit in
   * submission order; a failed save rejects its caller without blocking later
   * saves.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional profile write settles.
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) return
    const editor = this.ctx.get('configEditor')
    if (editor === undefined) return
    const config = { provider: next.provider, model: next.model }
    const saved = this.saves.then(() => editor.edit(entry, () => config))
    this.saves = saved.catch(() => {})
    await saved
  }
}

export default AgentDefaultModelConfig
