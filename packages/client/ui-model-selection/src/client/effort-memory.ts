/** Browser-local per-model reasoning-effort memory (pi-style: each route keeps its own level). */

import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'

const STORAGE_KEY = 'dsh.model-selection.effort-memory.v1'
const LIMIT = 200

type EffortMemory = Record<string, string>

/** Route key shared with the catalog's reasoning cache convention. */
function routeKey(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

/** Read the stored map, dropping anything a hand edit made unusable. */
function load(): EffortMemory {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const memory: EffortMemory = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value !== '') memory[key] = value
    }
    return memory
  } catch {
    return {}
  }
}

function persist(memory: EffortMemory): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(memory))
  } catch {
    // A private or full browser store must not block model selection.
  }
}

/**
 * Remember the effort explicitly chosen for one route, refreshing its recency
 * and evicting the least recently remembered routes beyond the bound.
 * @param provider - the provider id owning the model.
 * @param model - the provider-owned model id.
 * @param effort - the adapter-owned effort id the user picked.
 */
export function rememberModelEffort(provider: string, model: string, effort: string): void {
  if (effort === '') return
  const memory = load()
  const key = routeKey(provider, model)
  // Delete-then-set refreshes the key's recency at the insertion-order tail.
  Reflect.deleteProperty(memory, key)
  memory[key] = effort
  const keys = Object.keys(memory)
  for (const evicted of keys.slice(0, Math.max(0, keys.length - LIMIT))) Reflect.deleteProperty(memory, evicted)
  persist(memory)
}

/**
 * Drop one route's remembered effort: the user re-picked the provider default,
 * so later switches to this route must fall back to the adapter default again.
 * @param provider - the provider id owning the model.
 * @param model - the provider-owned model id.
 */
export function forgetModelEffort(provider: string, model: string): void {
  const memory = load()
  const key = routeKey(provider, model)
  if (!(key in memory)) return
  Reflect.deleteProperty(memory, key)
  persist(memory)
}

/**
 * The remembered effort for a fresh selection of one route, validated against
 * the route's currently advertised levels. A level the model no longer (or
 * never) offers is ignored, so an adapter vocabulary change falls back to the
 * model default instead of submitting an unsupported value; each route only
 * ever reads its own entry, so cross-provider switches never carry a foreign
 * vocabulary.
 * @param provider - the provider id owning the model.
 * @param model - the provider-owned model id.
 * @param reasoning - the model's current catalog reasoning metadata, when loaded.
 * @returns the remembered effort id, or undefined when none applies.
 */
export function modelEffortFor(
  provider: string,
  model: string,
  reasoning: ModelProviderGroup['models'][number]['reasoning'],
): string | undefined {
  const effort = load()[routeKey(provider, model)]
  if (effort === undefined) return undefined
  return reasoning?.efforts.some(level => level.id === effort) === true ? effort : undefined
}
