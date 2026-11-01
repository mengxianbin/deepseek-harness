/**
 * Shared spawn helpers for the Oxlint executable-contract suites.
 *
 * The default suite (`oxlint-contract.spec.ts`) and the slow-lane type-aware
 * suite (`oxlint-typeaware-contract.slowlane.spec.ts`) exercise the same
 * executables with the same assertions; this module keeps the spawn shape in
 * one place so the split cannot drift between the two files.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root every contract probe writes into and resolves paths against. */
export const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const oxlintCli = fileURLToPath(new URL('../node_modules/oxlint/bin/oxlint', import.meta.url))
const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))

/**
 * Spawn the repository Oxlint wrapper (`scripts/run-oxlint.ts`) synchronously.
 * @param args - Oxlint CLI arguments after the wrapper.
 * @param env - Extra environment for the child (merged over the current one).
 * @returns the completed child result with captured channels.
 */
export function runRepositoryOxlint(args: readonly string[], env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [tsxCli, 'scripts/run-oxlint.ts', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
  })
}

/**
 * Spawn the Oxlint CLI directly and synchronously.
 * @param args - Oxlint CLI arguments.
 * @param env - Extra environment for the child (merged over the current one).
 * @returns the completed child result with captured channels.
 */
export function runOxlint(args: readonly string[], env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [oxlintCli, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
  })
}

/**
 * Combine a child result's channels for output assertions.
 * @param result - A completed Oxlint child result.
 * @returns stdout plus stderr with path separators normalized to forward slashes.
 */
export function normalizedOutput(result: SpawnSyncReturns<string>): string {
  return `${result.stdout}${result.stderr}`.replaceAll('\\', '/')
}

/**
 * Write a contract lint config that extends the repository config with no ignores.
 * @param suffix - Unique suffix naming this probe's config file.
 * @returns the absolute path of the written config.
 */
export async function writeContractConfig(suffix: string): Promise<string> {
  const path = join(repositoryRoot, `.oxlintrc.contract-${suffix}.json`)
  await writeFile(path, JSON.stringify({ extends: ['./.oxlintrc.json'], ignorePatterns: [] }))
  return path
}
