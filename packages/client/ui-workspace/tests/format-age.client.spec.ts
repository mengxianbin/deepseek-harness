import { describe, expect, it } from 'vitest'
import { formatAgeSec } from '../src/client/format-age.ts'

describe('formatAgeSec', () => {
  it('keeps a sub-minute age in whole seconds', () => {
    expect(formatAgeSec(0)).toBe('0s')
    expect(formatAgeSec(45)).toBe('45s')
    expect(formatAgeSec(59)).toBe('59s')
  })

  it('prints the two largest nonzero units for longer ages', () => {
    expect(formatAgeSec(60)).toBe('1m')
    expect(formatAgeSec(312)).toBe('5m 12s')
    expect(formatAgeSec(9_631)).toBe('2h 40m')
    expect(formatAgeSec(45_266)).toBe('12h 34m')
    expect(formatAgeSec(172_800)).toBe('2d')
  })

  it('reads negative and non-finite input as zero', () => {
    expect(formatAgeSec(-1)).toBe('0s')
    expect(formatAgeSec(Number.NaN)).toBe('0s')
    expect(formatAgeSec(Number.POSITIVE_INFINITY)).toBe('0s')
  })
})
