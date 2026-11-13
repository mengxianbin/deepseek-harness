/**
 * Process-spawning cases set Vitest's case timeout to 90 seconds. Configuration-only
 * cases keep the default.
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  acquireHeavyIoLock,
  breakStaleHeavyIoLock,
  defaultHistoryFile,
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

function historyPath(name: string): string {
  return join(tmpdir(), `heavy-io-gate-spec-history-${name}.log`)
}

function runGate(args: readonly string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [tsxCli, gateScript, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      // Pin the gate ON regardless of the runner's environment (CI=true would
      // silently passthrough every case); per-case env below still overrides.
      CI: 'false',
      // Default every spawned gate to a scratch history file so tests never
      // append to the machine-wide log; history cases override it per case.
      DSH_HEAVY_IO_HISTORY: join(tmpdir(), 'heavy-io-gate-spec-history.log'),
      ...env,
    },
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

  it('keeps a lock whose owner is alive, no matter how long it has held', async () => {
    const directory = lockDir('fresh')
    try {
      await rm(directory, { recursive: true, force: true })
      await mkdir(directory, { recursive: true })
      // 纯排队（2026-11-12 定稿）：live owner 永不被抢，年龄不再构成 stale。
      await writeFile(join(directory, 'owner.json'), JSON.stringify({
        pid: process.pid,
        startedAt: new Date(Date.now() - 120 * 60_000).toISOString(),
        command: 'pnpm run lint',
      }))
      expect(await breakStaleHeavyIoLock(directory)).toBe(false)
      expect(await readHeavyIoLock(directory)).toBeDefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('breaks a lock whose owner died', async () => {
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
      expect(await breakStaleHeavyIoLock(directory)).toBe(true)
      expect(await readHeavyIoLock(directory)).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps an ownerless directory while the winner is still writing its record', async () => {
    const directory = lockDir('ownerless-window')
    try {
      await rm(directory, { recursive: true, force: true })
      // Claim taken (mkdir won) but owner.json not yet written — the exact
      // window in which 2026-11-13 12:39:55Z a waiter broke a live holder.
      await mkdir(directory)
      const breaking = breakStaleHeavyIoLock(directory)
      // The winner finishes its write inside the read backoff.
      await new Promise(done => setTimeout(done, 50))
      await writeFile(join(directory, 'owner.json'), JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: 'pnpm run lint',
      }))
      expect(await breaking).toBe(false)
      expect((await readHeavyIoLock(directory))?.pid).toBe(process.pid)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('breaks an ownerless directory only after the read backoff, not immediately', async () => {
    const directory = lockDir('ownerless-orphan')
    try {
      await rm(directory, { recursive: true, force: true })
      await mkdir(directory)
      const startedAt = Date.now()
      // Nobody ever writes owner.json: the claimant died inside the window, so
      // the directory is an orphan and must still be broken — but only after
      // the backoff has given a live winner time to finish its write.
      expect(await breakStaleHeavyIoLock(directory)).toBe(true)
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
      expect(await readHeavyIoLock(directory)).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports nothing broken when the lock directory vanished under inspection', async () => {
    const directory = lockDir('vanished')
    await rm(directory, { recursive: true, force: true })
    // A holder released (or a rival broke the lock) between our read and our
    // rm: removing here could delete a fresh successor's claim.
    expect(await breakStaleHeavyIoLock(directory)).toBe(false)
  })

  it('runs the command under the lock and propagates its exit code', () => {
    const directory = lockDir('e2e')
    const result = runGate(['node -e "process.exit(7)"'], {
      DSH_HEAVY_IO_LOCK_DIR: directory,
      DSH_HEAVY_IO_POLL_MS: '100',
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
    const wiring = [
      ['heavy:build:lib', 'pnpm run build:lib'],
      ['heavy:build:lib:host', 'pnpm run build:lib:host'],
      ['heavy:build:lib:client', 'pnpm run build:lib:client'],
      // FORK dsh-local (fastlane-2s-1101): `test` split into a fast default
      // (static slow-list exclusion) and `test:all` (the former full run).
      // `heavy:test` keeps the full-suite semantics §5.7's 全量跑法 cites.
      ['heavy:test', 'pnpm run test:all'],
      ['heavy:test:coverage', 'pnpm run test:coverage'],
      ['heavy:test:coverage:partitioned', 'pnpm run test:coverage:partitioned'],
      ['heavy:test:gui', 'vitest run packages/client packages/host'],
      ['heavy:install', 'pnpm install'],
      // B-case bare-path closure: `test` and `test:coverage` previously sat
      // ungated behind these twins, so a direct `pnpm run test` raced queued
      // jobs. Now wrapped in place. FORK dsh-local (fastlane-2s-1101): `test`
      // is the fast lane since the 2s slow-list split — its inner command
      // carries the fast config; `test:all` inherits the former full-run text
      // unchanged (still gated, still the true full suite).
      ['test', 'pnpm run build:native-system && vitest run --config vitest.fast.config.ts'],
      ['test:all', 'pnpm run build:native-system && vitest run'],
      ['test:coverage', 'pnpm run build:native-system && vitest run --coverage'],
      // FORK dsh-local (heavy-gate-expand1-1103): build-family bare keys closed
      // behind the gate (错峰裁决 C · 缺口 G1 扩闸第一批). Each `inner` below is
      // the pre-wrap original byte-for-byte — the `toBe` above therefore doubles
      // as the reverse assertion that the inner command never drifted. Two-checks
      // (spec `toBe` on the key + run-gates/ci-workflow structured reads) passed
      // for all five; `ci-workflow.ts` has no such reader (only the .spec does).
      ['build:artifacts', 'tsx scripts/build.ts --scope artifacts'],
      ['build:check', 'tsx scripts/build.ts --scope check'],
      ['build:official', 'tsx scripts/build.ts --profile official'],
      ['build:web', 'pnpm --filter @deepseek-ai/dsh-web-frontend run build'],
      ['build:desktop', 'pnpm --filter @deepseek-ai/dsh-desktop run build'],
      // FORK dsh-local (heavy-gate-expand1-1103): these four were already gated
      // (build/lint/lint:fix from the original three-layer landing, test:slowlane
      // from fastlane-2s-1101) but never listed here, so the wiring count trailed
      // the package.json gated-key count. Listing them closes that gap with
      // assertions only — no script value changes.
      ['build', 'tsx scripts/build.ts'],
      ['lint', 'tsx scripts/compile-referenced-projects.ts host-contracts && npm run lint:contracts-ready'],
      ['lint:fix', 'tsx scripts/compile-referenced-projects.ts host-contracts && npm run lint:fix:contracts-ready'],
      ['test:slowlane', 'tsx scripts/run-slow-lane.ts'],
      // FORK dsh-local (heavy-io-serial-1112): second wiring batch — 30 keys
      // wrapped in package.json (e2e/web/snapshot/expected test families,
      // doc-typecheck/docs, duplication, package:desktop*). Each `inner` is the
      // pre-wrap original byte-for-byte, so the `toBe` above doubles as the
      // reverse assertion that the inner command never drifted. The completeness
      // check below fails if a future gated key skips this list.
      ['test:e2e', 'vitest run --config vitest.e2e.config.ts'],
      ['test:web', 'npm run build && npm run test:web:built'],
      ['test:web:refresh', 'npm run build && DSH_SNAPSHOT=refresh vitest run --config vitest.web.config.ts'],
      ['test:web:built', 'vitest run --config vitest.web.config.ts'],
      ['test:web:ci', 'tsx scripts/run-web-snapshots.ts'],
      ['test:web:perf', 'npm run build && npm run test:web:perf:built'],
      ['test:web:perf:built', 'DSH_SNAPSHOT=replay vitest run --config vitest.web.perf.config.ts'],
      ['test:web:stress', 'npm run build && vitest run --config vitest.web-stress.config.ts'],
      ['test:snapshot', 'vitest run --config vitest.snapshot.config.ts'],
      ['test:snapshot:record', 'DSH_SNAPSHOT=record vitest run --config vitest.snapshot.config.ts --update'],
      ['test:snapshot:refresh', 'DSH_SNAPSHOT=refresh vitest run --config vitest.snapshot.config.ts'],
      ['test:expected', 'vitest run --config vitest.expected.config.ts'],
      ['test:expected:refresh', 'DSH_SNAPSHOT=refresh vitest run --config vitest.expected.config.ts'],
      ['doc-typecheck', 'tsx scripts/compile-referenced-projects.ts host-contracts && npm run doc-typecheck:contracts-ready'],
      ['doc-typecheck:contracts-ready', 'tsx scripts/doc-typecheck.ts'],
      ['docs:build', 'tsx website/build.ts && pnpm run verify-doc-site-fragments'],
      ['docs:build:mpa', 'tsx website/build.ts --mpa && pnpm run verify-doc-site-fragments'],
      ['docs:check', 'pnpm exec vitest run scripts/project-doc-site.spec.ts scripts/verify-doc-site-fragments.spec.ts website/tests/mermaid-viewer.spec.ts website/tests/image-viewer.spec.ts website/tests/code-groups.spec.ts website/tests/page-markdown-actions.spec.ts website/tests/raw-markdown.spec.ts website/tests/table-filter.spec.ts && pnpm run docs:build'],
      ['duplication', 'jscpd --config .jscpd.json packages scripts'],
      ['package:desktop', 'pnpm --filter @deepseek-ai/dsh-desktop run package'],
      ['package:desktop:dir', 'pnpm --filter @deepseek-ai/dsh-desktop run package:dir'],
      ['package:desktop:mac:arm64', 'pnpm --filter @deepseek-ai/dsh-desktop run package:mac:arm64'],
      ['package:desktop:mac:arm64:unsigned', 'pnpm --filter @deepseek-ai/dsh-desktop run package:mac:arm64:unsigned'],
      ['package:desktop:mac:arm64:dir', 'pnpm --filter @deepseek-ai/dsh-desktop run package:mac:arm64:dir'],
      ['package:desktop:mac:x64', 'pnpm --filter @deepseek-ai/dsh-desktop run package:mac:x64'],
      ['package:desktop:mac:x64:unsigned', 'pnpm --filter @deepseek-ai/dsh-desktop run package:mac:x64:unsigned'],
      ['package:desktop:mac:x64:dir', 'pnpm --filter @deepseek-ai/dsh-desktop run package:mac:x64:dir'],
      ['package:desktop:win:x64', 'pnpm --filter @deepseek-ai/dsh-desktop run package:win:x64'],
      ['package:desktop:win:x64:unsigned', 'pnpm --filter @deepseek-ai/dsh-desktop run package:win:x64:unsigned'],
      ['package:desktop:win:x64:dir', 'pnpm --filter @deepseek-ai/dsh-desktop run package:win:x64:dir'],
    ] as const
    for (const [entry, inner] of wiring) {
      expect(packageScripts[entry], entry).toBe(`tsx scripts/heavy-io-gate.ts "${inner}"`)
    }

    // Reverse completeness: every gate-wrapped key in package.json must appear
    // in the wiring list above. Without this, a newly gated key can sit
    // unwired-in-spec silently — the exact gap that let 30 keys trail the list
    // on 2026-11-12.
    const wired = new Set<string>(wiring.map(([entry]) => entry))
    for (const [key, value] of Object.entries(packageScripts)) {
      if (value.startsWith('tsx scripts/heavy-io-gate.ts ')) {
        expect(wired.has(key), `gated key missing from the wiring list: ${key}`).toBe(true)
      }
    }

    // The CI gate graph consumes these originals verbatim (ci-workflow/run-gates
    // contracts), so the gated entries must stay separate keys.
    expect(packageScripts.typecheck).toBe('tsx scripts/build.ts --scope typecheck')
    expect(packageScripts['test:coverage:partitioned']).toBe('tsx scripts/run-coverage-partitions.ts')
    expect(packageScripts['test:gui']).toBe('vitest run packages/client packages/host')
    expect(packageScripts['build:lib']).toBe('pnpm run build:lib:host && pnpm run build:lib:client')
    // a61a221001 wrapped build:lib:host in the build-stamp runner and moved it
    // to `tsc -p` (the host face compiles under node's size cap, not tsc -b);
    // the lock follows the current load-bearing original.
    expect(packageScripts['build:lib:host']).toContain('tsc -p tsconfig.host.json')
    expect(packageScripts['build:lib:client']).toContain('tsc -b tsconfig.client.json')
  })

  it('appends trailing wrapper arguments so filters reach the inner command', () => {
    const directory = lockDir('forwarding')
    const result = runGate(['echo', 'alpha', 'beta'], {
      DSH_HEAVY_IO_LOCK_DIR: directory,
      DSH_HEAVY_IO_POLL_MS: '100',
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('alpha beta')
  }, 90_000)
})

describe('heavy-io gate history log', () => {
  it('keeps the default history file user-level and outside the lock directory', () => {
    const file = defaultHistoryFile({ LOCALAPPDATA: 'C:/Users/test/AppData/Local' })
    expect(file).toContain('history.log')
    // The lock directory is removed wholesale on release; the log must not sit
    // inside it or every line would evaporate with the lock.
    expect(file).not.toContain('dsh-heavy-io-gate.lock')
    expect(file.startsWith(tmpdir())).toBe(false)
  })

  it('records acquire and release lines for a gated command', async () => {
    const directory = lockDir('history-run')
    const history = historyPath('run')
    try {
      await rm(directory, { recursive: true, force: true })
      await rm(history, { force: true })
      const result = runGate(['node -e "process.stdout.write(\'ok\')"'], {
        DSH_HEAVY_IO_LOCK_DIR: directory,
        DSH_HEAVY_IO_HISTORY: history,
        DSH_HEAVY_IO_POLL_MS: '100',
        DSH_HEAVY_IO_WAIT_MS: '2000',
        DSH_HEAVY_IO_STALE_MS: '60000',
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      const lines = readFileSync(history, 'utf8').trim().split('\n')
      const acquire = lines.find(line => line.includes(' acquire '))
      const release = lines.find(line => line.includes(' release '))
      expect(acquire).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z acquire pid=\d+ cmd=node -e /)
      expect(release).toMatch(/ release pid=\d+ heldMs=\d+ cmd=node -e /)
    } finally {
      await rm(directory, { recursive: true, force: true })
      await rm(history, { force: true })
    }
  }, 90_000)

  it('queues behind a live holder with no bound, then acquires after release (no fail-open)', async () => {
    const directory = lockDir('history-queue')
    const history = historyPath('queue')
    let child: ReturnType<typeof spawn> | undefined
    try {
      await rm(directory, { recursive: true, force: true })
      await rm(history, { force: true })
      await mkdir(directory)
      await writeFile(join(directory, 'owner.json'), JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: 'other heavy job',
      }))
      // 纯排队（2026-11-12 定稿）：waiter 没有等待上限，也不再 fail-open——
      // 在活持有者释放前它必须一直 waiting。
      child = spawn(process.execPath, [tsxCli, gateScript, 'node -e "process.stdout.write(\'queued\')"'], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NO_COLOR: '1',
          CI: 'false',
          DSH_HEAVY_IO_LOCK_DIR: directory,
          DSH_HEAVY_IO_HISTORY: history,
          DSH_HEAVY_IO_POLL_MS: '50',
        },
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      const exited = new Promise<number | null>(finish => child?.on('close', (code) => { finish(code) }))

      await new Promise(done => setTimeout(done, 1_500))
      // Still queued well past any former 400 ms wait bound: alive and waiting.
      expect(child.exitCode).toBeNull()
      expect(stderr).toContain('waiting for other heavy job')
      const during = readFileSync(history, 'utf8')
      expect(during).toMatch(new RegExp(`waiting pid=\\d+ waitedMs=\\d+ holderPid=${process.pid} holderCmd=other heavy job cmd=`))
      expect(during).not.toContain(' fail-open ')
      expect(during).not.toContain(' acquire ')

      // Simulate the holder releasing; the waiter must then acquire and run.
      await rm(directory, { recursive: true, force: true })
      expect(await exited).toBe(0)
      expect(stdout).toBe('queued')
      const after = readFileSync(history, 'utf8')
      expect(after).toMatch(/ acquire pid=\d+ cmd=node -e /)
      expect(after).toMatch(/ release pid=\d+ heldMs=\d+ cmd=node -e /)
      expect(after).not.toContain(' fail-open ')
    } finally {
      child?.kill()
      await rm(directory, { recursive: true, force: true })
      await rm(history, { force: true })
    }
  }, 90_000)

  it('never stale-breaks a live holder under concurrent waiters', async () => {
    const directory = lockDir('two-waiters')
    const history = historyPath('two-waiters')
    const children: ReturnType<typeof spawn>[] = []
    const spawnWaiter = (): ReturnType<typeof spawn> => {
      const child = spawn(process.execPath, [tsxCli, gateScript, 'node -e "process.stdout.write(\'w\')"'], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NO_COLOR: '1',
          CI: 'false',
          DSH_HEAVY_IO_LOCK_DIR: directory,
          DSH_HEAVY_IO_HISTORY: history,
          DSH_HEAVY_IO_POLL_MS: '50',
        },
      })
      children.push(child)
      return child
    }
    try {
      await rm(directory, { recursive: true, force: true })
      await rm(history, { force: true })
      await mkdir(directory)
      await writeFile(join(directory, 'owner.json'), JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: 'live holder',
      }))

      // 2026-11-13 12:39:55Z 事故重演：一个活持有者 + 两个并发等待者。
      // 任何一方对活持有者 stale-break 都会让第二方在其 owner.json 写入前
      // mkdir 成功，两张锁并发进入闸内。
      const waiters = [spawnWaiter(), spawnWaiter()]
      await new Promise(done => setTimeout(done, 1_500))
      for (const child of waiters) expect(child.exitCode).toBeNull()
      const during = readFileSync(history, 'utf8')
      expect(during).toMatch(/ waiting pid=\d+ waitedMs=\d+ holderPid=\d+ holderCmd=live holder cmd=/)
      expect((during.match(/ waiting /g) ?? []).length).toBe(2)
      expect(during).not.toContain(' stale-break ')
      expect(during).not.toContain(' acquire ')

      // 持有者释放后，两个等待者必须串行拿到锁（后到者读到前者的活 owner）。
      await rm(directory, { recursive: true, force: true })
      const codes = await Promise.all(waiters.map(child => new Promise<number | null>(
        finish => child.on('close', (code) => { finish(code) }),
      )))
      expect(codes).toEqual([0, 0])
      const after = readFileSync(history, 'utf8')
      expect(after).not.toContain(' stale-break ')
      expect((after.match(/ acquire /g) ?? []).length).toBe(2)
      expect((after.match(/ release /g) ?? []).length).toBe(2)
    } finally {
      for (const child of children) child.kill()
      await rm(directory, { recursive: true, force: true })
      await rm(history, { force: true })
    }
  }, 90_000)

  it('records a stale-break line when a dead holder is broken', async () => {
    const directory = lockDir('history-stale')
    const history = historyPath('stale')
    const deadPid = 2_147_480_000
    try {
      await rm(directory, { recursive: true, force: true })
      await rm(history, { force: true })
      await mkdir(directory)
      await writeFile(join(directory, 'owner.json'), JSON.stringify({
        pid: deadPid,
        startedAt: new Date().toISOString(),
        command: 'dead job',
      }))
      const result = runGate(['node -e "process.stdout.write(\'recovered\')"'], {
        DSH_HEAVY_IO_LOCK_DIR: directory,
        DSH_HEAVY_IO_HISTORY: history,
        DSH_HEAVY_IO_POLL_MS: '100',
        DSH_HEAVY_IO_WAIT_MS: '2000',
        DSH_HEAVY_IO_STALE_MS: '60000',
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      const text = readFileSync(history, 'utf8')
      expect(text).toMatch(/ stale-break pid=\d+ holderPid=2147480000 holderAgeMs=\d+ holderAlive=false cmd=/)
      expect(text).toMatch(/ acquire pid=\d+ cmd=node -e /)
      expect(text).toMatch(/ release pid=\d+ heldMs=\d+ cmd=node -e /)
    } finally {
      await rm(directory, { recursive: true, force: true })
      await rm(history, { force: true })
    }
  }, 90_000)

  it('records which passthrough path skipped the gate', async () => {
    const history = historyPath('passthrough')
    try {
      await rm(history, { force: true })
      const result = runGate(['node -e "process.stdout.write(\'direct\')"'], {
        DSH_HEAVY_IO_HISTORY: history,
        DSH_HEAVY_IO: '0',
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('direct')
      expect(readFileSync(history, 'utf8')).toMatch(/ passthrough pid=\d+ reason=off cmd=node -e /)
    } finally {
      await rm(history, { force: true })
    }
  }, 90_000)

  it('keeps running when the history path cannot be written', async () => {
    const directory = lockDir('history-failsoft')
    const blocker = join(tmpdir(), 'heavy-io-gate-spec-history-blocker')
    try {
      await rm(directory, { recursive: true, force: true })
      rmSync(blocker, { force: true })
      writeFileSync(blocker, 'not a directory')
      // Parent is a regular file, so the history mkdir/append must fail —
      // the gate itself has to run unaffected (fail-soft observation).
      const result = runGate(['node -e "process.stdout.write(\'alive\')"'], {
        DSH_HEAVY_IO_LOCK_DIR: directory,
        DSH_HEAVY_IO_HISTORY: join(blocker, 'history.log'),
        DSH_HEAVY_IO_POLL_MS: '100',
        DSH_HEAVY_IO_WAIT_MS: '2000',
        DSH_HEAVY_IO_STALE_MS: '60000',
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('alive')
      expect(readFileSync(blocker, 'utf8')).toBe('not a directory')
    } finally {
      await rm(directory, { recursive: true, force: true })
      rmSync(blocker, { force: true })
    }
  }, 90_000)
})
