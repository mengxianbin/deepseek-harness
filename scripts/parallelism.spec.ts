import { describe, expect, it } from 'vitest'
import { COVERAGE_MAX_WORKERS_ENV, LOCAL_PARALLELISM_CAP, LOCAL_TEST_PARALLELISM_CAP, defaultParallelism, describeDefaultParallelism, localVitestMaxWorkers } from './parallelism.ts'

describe('default worker budget', () => {
  it('uses every reported CPU in CI', () => {
    expect(defaultParallelism({ CI: 'true' }, 256)).toBe(256)
    expect(describeDefaultParallelism({ CI: 'true' }, 16)).toBe('16 available CPU(s)')
  })

  it('caps local runs without exceeding the reported CPUs', () => {
    expect(LOCAL_PARALLELISM_CAP).toBe(12)
    expect(defaultParallelism({}, 256)).toBe(12)
    expect(defaultParallelism({ CI: 'false' }, 256)).toBe(12)
    expect(defaultParallelism({}, 4)).toBe(4)
    expect(describeDefaultParallelism({}, 256)).toBe('12 local default worker(s) of 256 CPU(s)')
  })

  it('lets Vitest forks use a larger local cap', () => {
    expect(LOCAL_TEST_PARALLELISM_CAP).toBe(48)
    expect(defaultParallelism({}, 256, LOCAL_TEST_PARALLELISM_CAP)).toBe(48)
    expect(defaultParallelism({ CI: 'true' }, 256, LOCAL_TEST_PARALLELISM_CAP)).toBe(256)
  })
})

describe('local Vitest fork override', () => {
  it('lets a positive-integer DSH_COVERAGE_MAX_WORKERS win over the default', () => {
    expect(COVERAGE_MAX_WORKERS_ENV).toBe('DSH_COVERAGE_MAX_WORKERS')
    expect(localVitestMaxWorkers({ [COVERAGE_MAX_WORKERS_ENV]: '4' }, 256)).toBe(4)
    expect(localVitestMaxWorkers({ [COVERAGE_MAX_WORKERS_ENV]: '4' }, 2)).toBe(4)
    expect(localVitestMaxWorkers({ [COVERAGE_MAX_WORKERS_ENV]: '64' }, 16, LOCAL_TEST_PARALLELISM_CAP)).toBe(64)
  })

  it('keeps the default local budget when the override is unset or empty', () => {
    expect(localVitestMaxWorkers({}, 256, LOCAL_TEST_PARALLELISM_CAP)).toBe(48)
    expect(localVitestMaxWorkers({ [COVERAGE_MAX_WORKERS_ENV]: '' }, 256, LOCAL_TEST_PARALLELISM_CAP)).toBe(48)
    expect(localVitestMaxWorkers({}, 4)).toBe(4)
    expect(localVitestMaxWorkers({ CI: 'true' }, 256, LOCAL_TEST_PARALLELISM_CAP)).toBe(256)
  })

  it('falls back to the default local budget on a malformed override', () => {
    for (const raw of ['0', '-2', '2.5', 'many', '4x', ' 4', '0x4']) {
      expect(localVitestMaxWorkers({ [COVERAGE_MAX_WORKERS_ENV]: raw }, 256, LOCAL_TEST_PARALLELISM_CAP), raw).toBe(48)
    }
  })
})
