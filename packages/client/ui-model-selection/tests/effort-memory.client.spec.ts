// @vitest-environment jsdom
/**
 * Per-model effort memory over browser-local storage: each provider/model
 * route keeps its own explicitly chosen level, a route only ever validates its
 * entry against its own advertised vocabulary (a foreign provider's ids can
 * never ride along), Provider-default forgets, and a hostile or corrupt store
 * degrades to "no memory" without blocking selection.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { forgetModelEffort, modelEffortFor, rememberModelEffort } from '../src/client/effort-memory.ts'

const KEY = 'dsh.model-selection.effort-memory.v1'

const reasoning = (...ids: string[]) => ({ efforts: ids.map(id => ({ id, name: id })) })

const routeOf = (key: string): string => localStorage.getItem(KEY)?.includes(key) === true ? key : '<absent>'

beforeEach(() => { localStorage.clear() })

describe('modelEffortMemory', () => {
  it('remembers one route\'s level and restores it only for that exact route', () => {
    rememberModelEffort('deepseek', 'v4-flash', 'max')
    expect(modelEffortFor('deepseek', 'v4-flash', reasoning('off', 'max'))).toBe('max')
    expect(modelEffortFor('deepseek', 'v4-pro', reasoning('off', 'max'))).toBeUndefined()
    expect(modelEffortFor('other', 'v4-flash', reasoning('off', 'max'))).toBeUndefined()
  })

  it('validates the remembered level against the route\'s own vocabulary only', () => {
    rememberModelEffort('vendor-a', 'model-a', 'max')
    // A foreign route whose vocabulary happens to contain the id still reads
    // nothing: the entry belongs to its own route.
    expect(modelEffortFor('vendor-b', 'model-a', reasoning('max'))).toBeUndefined()
    // The owning route after a vocabulary change falls back instead of
    // submitting a level the adapter no longer offers.
    rememberModelEffort('deepseek', 'v4-flash', 'max')
    expect(modelEffortFor('deepseek', 'v4-flash', reasoning('off', 'low'))).toBeUndefined()
    expect(modelEffortFor('deepseek', 'v4-flash', undefined)).toBeUndefined()
  })

  it('re-picks refresh the entry and later routes evict the least recently remembered', () => {
    rememberModelEffort('deepseek', 'v4-flash', 'low')
    rememberModelEffort('deepseek', 'v4-flash', 'max')
    expect(modelEffortFor('deepseek', 'v4-flash', reasoning('low', 'max'))).toBe('max')
    for (let index = 0; index < 200; index += 1) {
      rememberModelEffort('vendor', `model-${index}`, 'high')
    }
    // 201 distinct routes: only the least recently remembered ("v4-flash") is
    // evicted; every loop route still fits under the bound.
    expect(modelEffortFor('deepseek', 'v4-flash', reasoning('high'))).toBeUndefined()
    expect(modelEffortFor('vendor', 'model-0', reasoning('high'))).toBe('high')
    expect(modelEffortFor('vendor', 'model-199', reasoning('high'))).toBe('high')
  })

  it('forget removes only the named route and tolerates a missing entry', () => {
    rememberModelEffort('deepseek', 'v4-flash', 'max')
    rememberModelEffort('deepseek', 'v4-pro', 'low')
    forgetModelEffort('deepseek', 'v4-flash')
    expect(modelEffortFor('deepseek', 'v4-flash', reasoning('max'))).toBeUndefined()
    expect(modelEffortFor('deepseek', 'v4-pro', reasoning('low'))).toBe('low')
    expect(() => { forgetModelEffort('deepseek', 'never-stored') }).not.toThrow()
  })

  it.each([
    ['not json', '{not json'],
    ['an array', '["deepseek","max"]'],
    ['non-string entries', '{"[\\"deepseek\\",\\"v4-flash\\"]":42,"[\\"deepseek\\",\\"v4-pro\\"]":""}'],
  ])('degrades to no memory for a corrupt store (%s)', (_label, raw) => {
    localStorage.setItem(KEY, raw)
    expect(modelEffortFor('deepseek', 'v4-flash', reasoning('max'))).toBeUndefined()
    // A write over the corrupt store recovers cleanly.
    rememberModelEffort('deepseek', 'v4-flash', 'max')
    expect(modelEffortFor('deepseek', 'v4-flash', reasoning('max'))).toBe('max')
  })

  it('ignores empty levels and survives a throwing store', () => {
    rememberModelEffort('deepseek', 'v4-flash', '')
    expect(routeOf('v4-flash')).toBe('<absent>')
    const original = globalThis.localStorage
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') } },
      })
      expect(() => { rememberModelEffort('deepseek', 'v4-flash', 'max') }).not.toThrow()
      expect(modelEffortFor('deepseek', 'v4-flash', reasoning('max'))).toBeUndefined()
      expect(() => { forgetModelEffort('deepseek', 'v4-flash') }).not.toThrow()
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original })
    }
  })
})
