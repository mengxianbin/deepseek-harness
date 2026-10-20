/**
 * The `allowLegacyPowerShell: false` opt-out: resolution must never land on
 * Windows PowerShell 5.1. A host without PowerShell 7 then falls through to
 * the bare `pwsh` PATH fallback and fails loudly at spawn instead of silently
 * running 5.1 — whose engine bugs (ConvertTo-Json wrapper, GBK default
 * encoding) deployments have recorded in the field. The default stays `true`,
 * preserving the historical last-resort fallback; an explicit `pwshPath`
 * short-circuits resolution, so the flag never questions a configured path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { candidatePwshPaths, resolvePwshPath } from '../src/resolve.ts'
import { PwshLocalExecutor } from '../src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

const SYSTEM_ROOT = 'C:\\Windows'
const LEGACY_51 = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const PROBE_ENV = { ProgramFiles: 'C:\\Program Files', SystemRoot: SYSTEM_ROOT, PATH: 'C:\\tools' }

it.skipIf(process.platform !== 'win32')('the 5.1 candidate is appended by default and absent when includeLegacy is false', () => {
  expect(candidatePwshPaths(PROBE_ENV)).toContain(LEGACY_51)
  expect(candidatePwshPaths(PROBE_ENV, true)).toContain(LEGACY_51)
  // The opt-out removes exactly the 5.1 candidate; every other candidate order holds.
  expect(candidatePwshPaths(PROBE_ENV, false))
    .toEqual(candidatePwshPaths(PROBE_ENV).filter(candidate => candidate !== LEGACY_51))
})

it.skipIf(process.platform !== 'win32')('resolution lands on 5.1 only when the legacy fallback is allowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pwsh-legacy-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  // The only reachable candidate is the 5.1 executable: no PowerShell 7 install,
  // no PATH entry.
  const legacyExe = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  mkdirSync(dirname(legacyExe), { recursive: true })
  writeFileSync(legacyExe, '')
  const bare = { ProgramFiles: join(root, 'no-program-files'), SystemRoot: root, PATH: '' }

  expect(resolvePwshPath(undefined, bare, 'win32', true)).toBe(legacyExe)
  expect(resolvePwshPath(undefined, bare, 'win32', false)).toBe('pwsh')
  // An explicit pwshPath short-circuits the whole candidate walk: the flag
  // never questions a configured path.
  expect(resolvePwshPath('X:\\pin\\pwsh.exe', bare, 'win32', false)).toBe('X:\\pin\\pwsh.exe')
})

it.skipIf(process.platform !== 'win32')('the executor re-resolves when allowLegacyPowerShell flips', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pwsh-legacy-exec-'))
  const legacyExe = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  mkdirSync(dirname(legacyExe), { recursive: true })
  writeFileSync(legacyExe, '')
  // Resolution reads process.env at every call: pin all three inputs so the
  // scratch tree owns the whole candidate walk for this test only.
  const saved = { ProgramFiles: process.env.ProgramFiles, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
  process.env.ProgramFiles = join(root, 'no-program-files')
  process.env.PATH = ''
  process.env.SystemRoot = root
  onTestFinished(() => {
    if (saved.ProgramFiles === undefined) delete process.env.ProgramFiles
    else process.env.ProgramFiles = saved.ProgramFiles
    if (saved.PATH === undefined) delete process.env.PATH
    else process.env.PATH = saved.PATH
    if (saved.SystemRoot === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = saved.SystemRoot
    rmSync(root, { recursive: true, force: true })
  })

  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  const live = await liveConfig(ctx, PwshLocalExecutor, { allowLegacyPowerShell: false })
  const executor = ctx.shell as PwshLocalExecutor
  expect(executor.pwshPath).toBe('pwsh')

  await live.update({ allowLegacyPowerShell: true })
  expect(executor.pwshPath).toBe(legacyExe)

  await live.update({ allowLegacyPowerShell: false })
  expect(executor.pwshPath).toBe('pwsh')
})
