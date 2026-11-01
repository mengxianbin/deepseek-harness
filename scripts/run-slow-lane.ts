/**
 * Run the slow-lane contract suites (`*.slowlane.spec.ts`) the default
 * `pnpm test` run excludes.
 *
 * The slow lane holds suites whose every case builds a real TypeScript program
 * or spawns real processes for minutes of CPU (see vitest.config.ts and the
 * trigger roster in m-note worktree-governance §5.7). This runner switches the
 * collection face with `DSH_TEST_SLOWLANE=1` and hands everything else to
 * Vitest: no arguments collects the whole lane, positional arguments narrow it
 * the same way `vitest run` filters do. `pnpm test:slowlane` wraps this in the
 * heavy IO gate because a full lane pass is tens of minutes on a loaded host.
 */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))

/**
 * Spawn Vitest on the slow-lane collection face.
 * @param filters - Vitest positional filters to narrow the lane (optional).
 * @returns the child's exit code.
 */
export function runSlowLane(filters: readonly string[]): Promise<number> {
  return new Promise((finish, fail) => {
    const child = spawn(process.execPath, [vitestCli, 'run', ...filters], {
      stdio: 'inherit',
      env: { ...process.env, DSH_TEST_SLOWLANE: '1' },
    })
    child.on('error', fail)
    child.on('close', (code) => {
      finish(code ?? 1)
    })
  })
}

async function main(argv: readonly string[]): Promise<number> {
  return await runSlowLane(argv)
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
