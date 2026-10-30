/**
 * Process-spawning cases set Vitest's case timeout to 90 seconds. Configuration-only
 * cases keep the default.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  acquireHeavyIoLock,
  breakStaleHeavyIoLock,
  defaultLockDirectory,
  isProcessAlive,
  readHeavyIoLock,
  releaseHeavyIoLock,
} from './heavy-io-gate.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const gateScript = fileURLToPath(new URL('./heavy-io-gate.ts', import.meta.url))
const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))
const packageScripts = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>
}).scripts

function lockDir(name: string): string {
  return join(tmpdir(), `heavy-io-gate-spec-${name}`)
}

function runGate(args: readonly string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [tsxCli, gateScript, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
  })
}

describe('heavy-io gate lock', () => {
  it('keeps the default lock directory user-level and outside the per-shell tmpdir', () => {
    const directory = defaultLockDirectory({ LOCALAPPDATA: 'C:/Users/test/AppData/Local' })
    expect(directory).toContain('dsh-heavy-io-gate.lock')
    expect(directory.startsWith(tmpdir())).toBe(false)
  })

  it('lets exactly one caller hold the lock and releases it', async () => {
    const directory = lockDir('exclusive')
    try {
      await rm(directory, { recursive: true, force: true })
      const owner = await acquireHeavyIoLock(directory, 'pnpm run lint')
      expect(owner).toMatchObject({ pid: process.pid, command: 'pnpm run lint' })
      expect(await acquireHeavyIoLock(directory, 'pnpm run typecheck')).toBeUndefined()
      expect((await readHeavyIoLock(directory))?.command).toBe('pnpm run lint')
      await releaseHeavyIoLock(directory)
      expect(await readHeavyIoLock(directory)).toBeUndefined()
      expect(await acquireHeavyIoLock(directory, 'pnpm run typecheck')).toBeDefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps a fresh lock whose owner is alive', async () => {
    const directory = lockDir('fresh')
    try {
      await rm(directory, { recursive: true, force: true })
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'owner.json'), JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: 'pnpm run lint',
      }))
      expect(await breakStaleHeavyIoLock(directory, 60_000)).toBe(false)
      expect(await readHeavyIoLock(directory)).toBeDefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('breaks a lock whose owner died or whose age is past the bound', async () => {
    const directory = lockDir('stale')
    try {
      await rm(directory, { recursive: true, force: true })
      await mkdir(directory, { recursive: true })
      const deadPid = 2_147_480_000
      expect(isProcessAlive(deadPid)).toBe(false)
      await writeFile(join(directory, 'owner.json'), JSON.stringify({
        pid: deadPid,
        startedAt: new Date().toISOString(),
        command: 'pnpm run lint',
      }))
      expect(await breakStaleHeavyIoLock(directory, 60_000)).toBe(true)
      expect(await readHeavyIoLock(directory)).toBeUndefined()

      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'owner.json'), JSON.stringify({
        pid: process.pid,
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        command: 'pnpm run lint',
      }))
      expect(await breakStaleHeavyIoLock(directory, 60_000)).toBe(true)
      expect(await readHeavyIoLock(directory)).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('runs the command under the lock and propagates its exit code', () => {
    const directory = lockDir('e2e')
    const result = runGate(['node -e "process.exit(7)"'], {
      DSH_HEAVY_IO_LOCK_DIR: directory,
      DSH_HEAVY_IO_POLL_MS: '100',
      DSH_HEAVY_IO_WAIT_MS: '2000',
      DSH_HEAVY_IO_STALE_MS: '60000',
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(7)
  }, 90_000)

  it('marks the gated command as a nested holder so inner gates pass through', () => {
    const directory = lockDir('nested')
    const result = runGate(['node -e "process.stdout.write(process.env.DSH_HEAVY_IO_HELD ?? \'unset\')"'], {
      DSH_HEAVY_IO_LOCK_DIR: directory,
      DSH_HEAVY_IO_HELD: '1',
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('1')
  }, 90_000)

  it('fails fast without a command argument', () => {
    const result = runGate([], { CI: 'true' })

    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('expected a shell command argument')
  }, 90_000)
})

describe('heavy-io gate wiring', () => {
  it('routes every heavy entry script through the gate without touching load-bearing originals', () => {
    for (const [entry, inner] of [
      ['heavy:build:lib', 'pnpm run build:lib'],
      ['heavy:build:lib:host', 'pnpm run build:lib:host'],
      ['heavy:build:lib:client', 'pnpm run build:lib:client'],
      ['heavy:test', 'pnpm run test'],
      ['heavy:test:coverage', 'pnpm run test:coverage'],
      ['heavy:test:coverage:partitioned', 'pnpm run test:coverage:partitioned'],
      ['heavy:test:gui', 'vitest run packages/client packages/host'],
      ['heavy:install', 'pnpm install'],
      // B-case bare-path closure: `test` and `test:coverage` previously sat
      // ungated behind these twins, so a direct `pnpm run test` raced queued
      // jobs. Now wrapped in place — inner command text unchanged.
      ['test', 'pnpm run build:native-system && vitest run'],
      ['test:coverage', 'pnpm run build:native-system && vitest run --coverage'],
    ] as const) {
      expect(packageScripts[entry], entry).toBe(`tsx scripts/heavy-io-gate.ts "${inner}"`)
    }

    // The CI gate graph consumes these originals verbatim (ci-workflow/run-gates
    // contracts), so the gated entries must stay separate keys.
    expect(packageScripts.typecheck).toBe('tsx scripts/build.ts --scope typecheck')
    expect(packageScripts['test:coverage:partitioned']).toBe('tsx scripts/run-coverage-partitions.ts')
    expect(packageScripts['test:gui']).toBe('vitest run packages/client packages/host')
    expect(packageScripts['build:lib']).toBe('pnpm run build:lib:host && pnpm run build:lib:client')
    expect(packageScripts['build:lib:host']).toContain('tsc -b tsconfig.host.json')
    expect(packageScripts['build:lib:client']).toContain('tsc -b tsconfig.client.json')
  })

  it('appends trailing wrapper arguments so filters reach the inner command', () => {
    const directory = lockDir('forwarding')
    const result = runGate(['echo', 'alpha', 'beta'], {
      DSH_HEAVY_IO_LOCK_DIR: directory,
      DSH_HEAVY_IO_POLL_MS: '100',
      DSH_HEAVY_IO_WAIT_MS: '2000',
      DSH_HEAVY_IO_STALE_MS: '60000',
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('alpha beta')
  }, 90_000)
})
