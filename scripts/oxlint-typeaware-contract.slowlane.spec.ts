/**
 * Type-aware Oxlint contract cases — the slow lane of the executable contract.
 *
 * Each case spawns Oxlint with the repository's type-aware rules, which forces a
 * fresh TypeScript program build for the owning aggregate project (host and
 * client) on every run: one case regularly spends minutes of CPU, so these four
 * cases alone dominated the full-run test-second budget. They keep every
 * assertion from their former home in `oxlint-contract.spec.ts` verbatim; only
 * the cadence changed.
 *
 * Membership in the slow lane is by filename (`*.slowlane.spec.ts`): the
 * default `pnpm test` run excludes them, and `pnpm test:slowlane [filters]`
 * runs them. Trigger conditions live in m-note
 * `content/tech/ai/dsh/worktree-governance.md` §5.7 slow-lane roster.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  normalizedOutput,
  repositoryRoot,
  runOxlint,
  runRepositoryOxlint,
  writeContractConfig,
} from './oxlint-executable-support.ts'

describe('Oxlint executable contract (slow lane: type-aware project discovery)', () => {
  it('discovers the owning TypeScript project for every file class', async () => {
    const suffix = randomUUID()
    const configPath = await writeContractConfig(suffix)
    const probes = [
      ['host package source', 'packages/fs/fs-observation-policy/src', 'packages/fs/fs-observation-policy/tsconfig.json'],
      ['host package test', 'packages/fs/fs-observation-policy/tests', 'tsconfig.host.json'],
      ['client package source', 'packages/client/ui-primitives/src', 'packages/client/ui-primitives/tsconfig.json'],
      // A test under packages/client states its face in the filename, so the
      // probe carries the Client suffix to reach the Client aggregate.
      ['client package test', 'packages/client/ui-trajectory/tests', 'tsconfig.client.json', '.client.ts'],
      ['CLI profile test', 'apps/cli/tests/profiles/headless/tests', 'tsconfig.host.json'],
      ['website', 'website', 'tsconfig.host.json'],
    ] as const
    const source = `export function probePromise(): Promise<void> {
  return Promise.resolve()
}

probePromise()
`

    try {
      const paths: Array<readonly [label: string, path: string, tsconfig: string]> = []
      for (const [label, parent, tsconfig, extension = '.ts'] of probes) {
        const path = join(repositoryRoot, parent, `oxlint-contract-${suffix}${extension}`)
        await writeFile(path, source)
        paths.push([label, relative(repositoryRoot, path), tsconfig])
      }
      const clientScript = 'scripts/client-bundle-purity.spec.ts'

      const result = runOxlint([
        '--config',
        relative(repositoryRoot, configPath),
        '--format',
        'unix',
        ...paths.map(([, path]) => path),
        clientScript,
      ], { OXC_LOG: 'debug' })
      const output = normalizedOutput(result)

      expect(result.error).toBeUndefined()
      expect(result.status, output).toBe(1)
      for (const [label, path, tsconfig] of paths) {
        expect(output, label).toContain(`${path.replaceAll('\\', '/')}:5:1: Promises must be awaited`)
        expect(output, `${label} project`).toContain(
          `Got tsconfig for file ${join(repositoryRoot, path).replaceAll('\\', '/')}: ${join(repositoryRoot, tsconfig).replaceAll('\\', '/')}`,
        )
      }
      expect(output.match(/typescript\(no-floating-promises\)/g)).toHaveLength(probes.length)
      expect(output, 'client aggregate script project').toContain(
        `Got tsconfig for file ${join(repositoryRoot, clientScript).replaceAll('\\', '/')}: ${join(repositoryRoot, 'tsconfig.client.json').replaceAll('\\', '/')}`,
      )
      expect(output).not.toContain('Unmatched file:')
    } finally {
      await Promise.all([
        ...probes.map(([, parent, , extension = '.ts']) =>
          rm(join(repositoryRoot, parent, `oxlint-contract-${suffix}${extension}`), { force: true })),
        rm(configPath, { force: true }),
      ])
    }
  }, 90_000)

  it('runs JavaScript compatibility and nursery rules', async () => {
    const suffix = randomUUID()
    const configPath = await writeContractConfig(suffix)
    const path = join(repositoryRoot, 'scripts', `oxlint-contract-${suffix}.ts`)
    const source = `export function firstProbe(): number {
  const first = 1
  const second = 2
  return first + second
}

export function secondProbe(): number {
  const first = 1
  const second = 2
  return first + second
}

export function hasValue(value: string): boolean {
  return value !== undefined
}

export const longProbe = 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1
`

    try {
      await writeFile(path, source)
      const result = runOxlint([
        '--config',
        relative(repositoryRoot, configPath),
        '--format',
        'unix',
        relative(repositoryRoot, path),
      ])
      const output = normalizedOutput(result)

      expect(result.error).toBeUndefined()
      expect(result.status, output).toBe(1)
      expect(output).toContain('@stylistic(max-len)')
      expect(output).toContain('sonarjs(no-identical-functions)')
      expect(output).toContain('typescript(no-unnecessary-condition)')
    } finally {
      await Promise.all([
        rm(path, { force: true }),
        rm(configPath, { force: true }),
      ])
    }
  }, 90_000)

  it('reports an unused suppression', async () => {
    const suffix = randomUUID()
    const configPath = await writeContractConfig(suffix)
    const path = join(repositoryRoot, 'scripts', `oxlint-contract-${suffix}.ts`)

    try {
      await writeFile(path, '// oxlint-disable-next-line no-console\nexport const value = 1\n')
      const result = runOxlint([
        '--config',
        relative(repositoryRoot, configPath),
        '--format',
        'unix',
        relative(repositoryRoot, path),
      ])
      const output = normalizedOutput(result)

      expect(result.error).toBeUndefined()
      expect(result.status, output).toBe(0)
      expect(output).toContain('Unused oxlint-disable directive')
    } finally {
      await Promise.all([
        rm(path, { force: true }),
        rm(configPath, { force: true }),
      ])
    }
  }, 90_000)

  it('allows Session history reads only in tests or with existing-call waivers', async () => {
    const suffix = randomUUID()
    const configPath = await writeContractConfig(suffix)
    const exampleRoot = `examples/oxlint-contract-${suffix}`
    const examplePath = `${exampleRoot}/tests/reads.ts`
    const testPaths = [
      `packages/core/session/tests/oxlint-contract-${suffix}.ts`,
      `apps/cli/tests/oxlint-contract-${suffix}.ts`,
      examplePath,
      `scripts/oxlint-contract-${suffix}.spec.ts`,
    ]
    const productionPaths = [
      `packages/core/session/src/oxlint-contract-${suffix}.ts`,
      `scripts/oxlint-contract-${suffix}.ts`,
    ]
    const paths = [...testPaths, ...productionPaths]
    const reads = `import { Session, SessionSeq } from '@deepseek-ai/dsh-session'

export function reads(session: Session): void {
  session.snapshotEvents()
  session.eventAt(SessionSeq(0))
  session.ownEvents()
}
`
    const existing = `import { Session, SessionSeq } from '@deepseek-ai/dsh-session'

export function reads(session: Session): void {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  session.snapshotEvents()
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  session.eventAt(SessionSeq(0))
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  session.ownEvents()
}
`
    const unrelated = `
/** @deprecated Use the replacement API. */
function oldApi(): void {}

export function unrelatedRead(): void {
  oldApi()
}
`

    try {
      await mkdir(join(repositoryRoot, exampleRoot, 'tests'), { recursive: true })
      await writeFile(join(repositoryRoot, exampleRoot, 'tsconfig.json'), JSON.stringify({
        extends: '../../tsconfig.base.json',
        include: ['tests/**/*.ts'],
      }))
      await Promise.all([
        ...testPaths.map(path => writeFile(join(repositoryRoot, path), reads)),
        ...productionPaths.map(path => writeFile(join(repositoryRoot, path), existing)),
      ])
      const args = ['--config', relative(repositoryRoot, configPath), '--format', 'unix', ...paths]
      const allowed = runRepositoryOxlint(args)
      expect(allowed.error).toBeUndefined()
      expect(allowed.signal).toBeNull()
      expect(allowed.status, normalizedOutput(allowed)).toBe(0)

      await Promise.all([
        ...testPaths.map(path => writeFile(join(repositoryRoot, path), reads + unrelated)),
        ...productionPaths.map(path => writeFile(join(repositoryRoot, path), reads)),
      ])
      const rejected = runRepositoryOxlint(args)
      const output = normalizedOutput(rejected)
      expect(rejected.error).toBeUndefined()
      expect(rejected.signal).toBeNull()
      expect(rejected.status, output).toBe(1)
      const diagnostics = output.split('\n').filter(line => /:\d+:\d+: `\w+` is deprecated\./.test(line))
      for (const path of testPaths) {
        const reported = diagnostics.filter(line => line.startsWith(`${path}:`))
        expect(reported, output).toHaveLength(1)
        expect(reported[0]).toContain('`oldApi` is deprecated')
      }
      for (const path of productionPaths) {
        expect(diagnostics.filter(line => line.startsWith(`${path}:`)), output).toHaveLength(3)
      }
      for (const method of ['snapshotEvents', 'eventAt', 'ownEvents', 'oldApi']) {
        expect(output).toContain(`\`${method}\` is deprecated`)
      }
      expect(output).toContain(
        'See the [Agent Note](../../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md).',
      )
    } finally {
      await Promise.all([
        ...paths.filter(path => path !== examplePath).map(path => rm(join(repositoryRoot, path), { force: true })),
        rm(join(repositoryRoot, exampleRoot), { recursive: true, force: true }),
        rm(configPath, { force: true }),
      ])
    }
  }, 90_000)
})
