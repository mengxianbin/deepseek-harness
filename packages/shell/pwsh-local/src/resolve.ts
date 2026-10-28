/**
 * PowerShell executable resolution, dependency-free so non-package consumers
 * (the repository's coverage-gate probe in `vitest.config.ts`) can share the
 * ONE resolution definition with the executor and its suites — a probe that
 * resolved differently from the code under test could exempt a file whose
 * suites actually run.
 *
 * @module @deepseek-ai/dsh-pwsh-local/resolve
 */

import { lstatSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Well-known Windows PowerShell install locations plus PATH entries, newest
 * first. Explicitly parameterized (env) so resolution is a pure function of
 * its inputs on every platform.
 * @param env - the environment to probe; defaults to the process environment.
 * @param includeLegacy - whether the Windows PowerShell 5.1 last-resort
 *   candidate is appended; deployments that must never run 5.1 pass `false`.
 * @returns candidate `pwsh` executable paths in resolution order.
 */
export function candidatePwshPaths(env: NodeJS.ProcessEnv = process.env, includeLegacy = true): string[] {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const candidates = [
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
  ]
  // Microsoft Store installs (and any user-added location) live on PATH;
  // entries may carry surrounding quotes from `setx`-style definitions.
  for (const entry of (env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0) continue
    candidates.push(join(trimmed, 'pwsh.exe'))
  }
  // Windows PowerShell 5.1 remains the last-resort fallback on legacy hosts,
  // opt-out for deployments where its engine bugs outweigh reaching a shell.
  if (includeLegacy) {
    candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  }
  return candidates
}

/**
 * Whether a candidate can be spawned. lstat opens the entry itself instead of
 * following reparse points, so it sees the Store app execution alias where
 * stat hits the target's ACL (EACCES); Node reports that alias as a symlink
 * on current releases and as a plain file on older ones, and CreateProcess
 * resolves either shape. A real directory never matches. Besides resolution's
 * candidate walk, the executor calls this on its cached path before each
 * command so an executable deleted after caching (a Store update replacing a
 * versioned install directory) triggers a re-resolve instead of a dead spawn.
 * @param candidate - absolute path probed for liveness.
 * @returns whether the entry exists as a file (or link shape).
 */
export function candidateExists(candidate: string): boolean {
  try {
    const stat = lstatSync(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    // ENOENT (the candidate vanished between listing and probing) is the only
    // expected failure; any other error names an unspawnable path, so false
    // is the safe answer for it too.
    return false
  }
}

/**
 * Resolve the pwsh executable this executor spawns.
 * @param configured - an explicit `pwshPath` config value, trusted as-is.
 * @param env - the environment to probe on Windows; defaults to the process environment.
 * @param platform - the platform to resolve for; defaults to the process platform.
 * @param allowLegacyPowerShell - whether resolution may land on Windows
 *   PowerShell 5.1; when `false` the 5.1 candidate is skipped, so a host
 *   without PowerShell 7 falls through to the bare `pwsh` PATH fallback and
 *   fails loudly at spawn instead of silently running 5.1.
 * @returns the first existing well-known location on Windows (PowerShell 7
 *   install, a PATH entry such as the Microsoft Store install, then Windows
 *   PowerShell 5.1 unless excluded), else `pwsh` for PATH resolution.
 */
export function resolvePwshPath(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  allowLegacyPowerShell = true,
): string {
  if (configured !== undefined && configured.length > 0) return configured
  if (platform === 'win32') {
    for (const candidate of candidatePwshPaths(env, allowLegacyPowerShell)) {
      if (candidateExists(candidate)) return candidate
    }
  }
  return 'pwsh'
}
