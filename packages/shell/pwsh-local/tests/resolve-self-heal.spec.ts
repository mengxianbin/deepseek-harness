/**
 * The resolution cache self-heals when the cached executable dies AFTER it was
 * cached — the 2026-10-15 incident where a Microsoft Store update replaced
 * PowerShell 7.6.6 → 7.6.7, deleted the versioned package directory behind a
 * PATH entry, and every command failed spawn ENOENT until the host process
 * restarted. Win32-only: that walk exists only there; off Windows the
 * executor's fallback is the bare `pwsh`, which PATH re-resolves at every
 * spawn and cannot go stale.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { PwshLocalExecutor } from '../src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

it.skipIf(process.platform !== 'win32')('re-resolves a deleted auto-resolved executable on the next read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pwsh-self-heal-'))
  // Candidate #1 (the Program Files install) plus a live PATH-entry candidate,
  // so deleting the first pick must fall through to the second — dead
  // candidates are skipped on the way to a live one, not merely re-listed.
  const versioned = join(root, 'PowerShell', '7', 'pwsh.exe')
  const pathEntry = join(root, 'store-alias')
  const alias = join(pathEntry, 'pwsh.exe')
  mkdirSync(dirname(versioned), { recursive: true })
  mkdirSync(pathEntry, { recursive: true })
  writeFileSync(versioned, '')
  writeFileSync(alias, '')
  // Resolution reads process.env at every call: pin all three inputs so the
  // scratch tree owns the whole candidate walk for this test only.
  const saved = { ProgramFiles: process.env.ProgramFiles, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
  process.env.ProgramFiles = root
  process.env.PATH = pathEntry
  process.env.SystemRoot = join(root, 'no-windows')
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
  const live = await liveConfig(ctx, PwshLocalExecutor, {})
  const executor = ctx.shell as PwshLocalExecutor
  expect(executor.pwshPath).toBe(versioned)

  // The Store update deletes the versioned directory behind the cached path.
  rmSync(versioned)
  expect(executor.pwshPath).toBe(alias)

  // An explicit pwshPath stays trusted as-is even while absent: liveness is
  // checked, but resolution never silently swaps what was configured.
  const configured = join(root, 'configured-away.exe')
  await live.update({ pwshPath: configured })
  expect(executor.pwshPath).toBe(configured)
  expect(executor.pwshPath).toBe(configured)
})
