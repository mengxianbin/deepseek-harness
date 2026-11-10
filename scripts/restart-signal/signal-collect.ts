/**
 * Restart-signal off-host collector: the ONE process that computes the
 * seven-state judgment — the host never spawns signal-cli again
 * (负载外移, offhost-1110).
 *
 * Each run re-reads the stamp CLI single source (`signal-cli.ts`, spawned
 * exactly here), the host's persisted runtime capture (R — what the running
 * dsh web process loaded, written once at route registration), the fresh
 * manifest/baseline read, and the build markers, judges through the same pure
 * `judgeRestartSignal` the machine always used (判定逻辑零改动), and
 * atomically writes the DSH-home state file with its collection instant. The
 * host route only reads that file (fresh / stale / unavailable semantics live
 * there).
 *
 * Lifecycle: scheduled by the schtasks task `DSH-Restart-Signal-Collect`
 * (every 1 minute — the 60s edge of the design's 30–60s band; registered
 * single-source by `--register`, conhost --headless the same shape the
 * taskbot node tasks use). Failures are loud: a non-zero exit (task
 * LastResult) plus one journal line in `restart-signal-collect.log`; nothing
 * is ever silently swallowed. Missing host runtime capture = the one expected
 * pre-activation failure (the off-host chain only starts after the human
 * restarts dsh web) and fails the same loud way.
 *
 * Usage:
 *   node scripts/restart-signal/signal-collect.ts             # collect once, write the state file
 *   node scripts/restart-signal/signal-collect.ts --register  # (re)register the schtasks task (single source)
 *   node scripts/restart-signal/signal-collect.ts --check     # collect to memory + print summary, no write
 *
 * Exit codes: 0 = collected (and wrote, unless --check) / registered;
 * 1 = collection failed; 2 = registration failed.
 * @module scripts/restart-signal/signal-collect
 */

import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  RESTART_SIGNAL_RUNTIME_FILE,
  RESTART_SIGNAL_RUNTIME_SCHEMA,
  RESTART_SIGNAL_STATE_FILE,
  RESTART_SIGNAL_STATE_SCHEMA,
  combineHostFace,
  judgeRestartSignal,
  readBuildStartCaptureTime,
  type RestartSignalJudgment,
} from '../../packages/client/ui-settings-general/src/restart-signal.ts'
import {
  defaultRepositoryRoot,
  readRestartStamp,
  type RestartManifestComponent,
  type RestartStamp,
} from '../../packages/client/ui-settings-general/src/restart-stamp.ts'
import { readBuildingCapture } from '../../packages/client/ui-settings-general/src/build-start-liveness.ts'
import type { CurrentStamp } from './signal-cli.ts'

const execFileAsync = promisify(execFile)

/** Gitignored directory holding the per-tree build markers (mirrors the package-side constant). */
const STAMP_DIR = '.dsh-build'

/** Build-failure record file name inside the stamp directory (mirrors the package-side constant). */
const FAILURE_FILE = 'restart-stamp.failed.json'

/** Journal beside the collector's state file: one line per run (ok or FAIL),
 * rotated past this size — the loud half of "崩了要响亮失败不静默", since a
 * schtasks run has no console to shout into. */
const RUN_JOURNAL_FILE = 'restart-signal-collect.log'

/** Journal rotation threshold (auto-build-journal pattern, half the size). */
const RUN_JOURNAL_CAP_BYTES = 256 * 1024

/** The scheduled task this collector rides (`--register` is its single source). */
export const COLLECT_TASK_NAME = 'DSH-Restart-Signal-Collect'

/** Task cadence in minutes: schtasks' smallest period, the 60s edge of the design band. */
export const COLLECT_TASK_MINUTES = 1

/** Registration pins the LONG-LIFE main-tree script + absolute interpreter (duty-inventory
 * precedent): running `--register` from a worktree still registers the main checkout,
 * so a worktree removal never leaves a dead task behind. */
const MAIN_SCRIPT = 'D:\\tech\\deepseek-harness\\scripts\\restart-signal\\signal-collect.ts'

/** Absolute node interpreter (taskbot schtasks precedent). */
const NODE_EXE = 'D:\\Programs\\nodejs\\node.exe'

/** conhost --headless wrapper (taskbot / token-report precedent): a console app
 * must not flash a window every minute from the scheduler. */
const CONHOST_EXE = 'C:\\Windows\\System32\\conhost.exe'

/**
 * The data root both sides of this chain share. The machine-level `DSH_HOME`
 * setx carries the INSTALL root (env-key catalog 同名两义), while the host
 * boots with `DSH_HOME` cleared by `start.py` so `resolveDshHome()` lands on
 * `~/.dsh` — a schtasks-born run inherits the install-root value and MUST pin
 * the data root the same way `build-watchdog.py` pins it, or the state file
 * would be written where the host never looks.
 * @returns The pinned DSH data home.
 */
export function pinnedDataHome(): string {
  return join(homedir(), '.dsh')
}

/** One collector-written state row: judgment + collection instant + tree. */
export interface CollectedState {
  /** Collection instant (ISO 8601). */
  readonly collectedAt: string
  /** Repository tree this run judged (display/forensics). */
  readonly repositoryRoot: string
  /** The judgment. */
  readonly judgment: RestartSignalJudgment
}

/** Injection seams for one collection; production uses the main tree, `~/.dsh`, and the CLI spawn. */
export interface CollectRunOptions {
  /** DSH data home holding the runtime capture; defaults to the pinned `~/.dsh`. */
  readonly dshHome?: string
  /** Harness tree to judge; defaults to the tree owning this module. */
  readonly repositoryRoot?: string
  /** HKCU\\Environment query; defaults to `reg query`. */
  readonly registryQuery?: () => string
  /** Current-stamp gatherer; defaults to spawning `signal-cli.ts` (the only allowed spawn site). */
  readonly runStampCli?: (repositoryRoot: string, components: readonly RestartManifestComponent[]) => Promise<readonly CurrentStamp[]>
  /** Clock; defaults to now. */
  readonly now?: () => Date
}

/** Validate a parsed runtime capture (R); a malformed capture fails the run loudly. */
function parseRuntimeCapture(text: string, path: string): RestartStamp {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(`runtime capture is not JSON (${path}): ${cause}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`runtime capture has a non-object body (${path})`)
  }
  if (Reflect.get(parsed, 'schema') !== RESTART_SIGNAL_RUNTIME_SCHEMA) {
    throw new Error(`runtime capture schema mismatch (${path}): ${String(Reflect.get(parsed, 'schema'))}`)
  }
  const state: unknown = Reflect.get(parsed, 'state')
  if (state !== 'INIT' && state !== 'BASELINE') throw new Error(`runtime capture has no readable state (${path})`)
  const sCfg: unknown = Reflect.get(parsed, 'sCfg')
  if (typeof sCfg !== 'string') throw new Error(`runtime capture has no sCfg (${path})`)
  const capturedAt: unknown = Reflect.get(parsed, 'capturedAt')
  if (typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt))) {
    throw new Error(`runtime capture has no readable capturedAt (${path})`)
  }
  const hostFaceHash: unknown = Reflect.get(parsed, 'hostFaceHash')
  if (hostFaceHash !== undefined && typeof hostFaceHash !== 'string') {
    throw new Error(`runtime capture has a malformed hostFaceHash (${path})`)
  }
  const reasons = parseStringArray(Reflect.get(parsed, 'reasons'), path, 'reasons')
  const notices = parseStringArray(Reflect.get(parsed, 'notices'), path, 'notices')
  const componentsRaw: unknown = Reflect.get(parsed, 'components')
  if (!Array.isArray(componentsRaw)) throw new Error(`runtime capture has no components array (${path})`)
  const components = componentsRaw.map((value, index) => parseComponent(value, path, index))
  return {
    state,
    reasons,
    notices,
    hostFaceHash: hostFaceHash === undefined ? undefined : hostFaceHash,
    sCfg,
    capturedAt,
    components,
  }
}

function parseStringArray(value: unknown, path: string, seat: string): readonly string[] {
  if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) {
    throw new Error(`runtime capture has a malformed ${seat} (${path})`)
  }
  return value
}

function parseComponent(value: unknown, path: string, index: number): RestartManifestComponent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`runtime capture component #${String(index)} is not an object (${path})`)
  }
  const repository: unknown = Reflect.get(value, 'repository')
  const kind: unknown = Reflect.get(value, 'kind')
  const time: unknown = Reflect.get(value, 'time')
  const builtFaces = parseStringArray(Reflect.get(value, 'builtFaces'), path, `component #${String(index)} builtFaces`)
  const midBuildDirty: unknown = Reflect.get(value, 'midBuildDirty')
  const hostFaceHash: unknown = Reflect.get(value, 'hostFaceHash')
  const clientFaceHash: unknown = Reflect.get(value, 'clientFaceHash')
  if (typeof repository !== 'string') throw new Error(`runtime capture component #${String(index)} has no repository (${path})`)
  if (kind !== 'harness' && kind !== 'dsh-web') throw new Error(`runtime capture component #${String(index)} has no kind (${path})`)
  if (typeof time !== 'string') throw new Error(`runtime capture component #${String(index)} has no time (${path})`)
  if (typeof midBuildDirty !== 'boolean') throw new Error(`runtime capture component #${String(index)} has no midBuildDirty (${path})`)
  if (hostFaceHash !== null && typeof hostFaceHash !== 'string') throw new Error(`runtime capture component #${String(index)} has a malformed hostFaceHash (${path})`)
  if (clientFaceHash !== null && typeof clientFaceHash !== 'string') throw new Error(`runtime capture component #${String(index)} has a malformed clientFaceHash (${path})`)
  return { repository, kind, time, builtFaces, midBuildDirty, hostFaceHash, clientFaceHash }
}

/**
 * Read the host's persisted runtime capture (R). The host writes it once at
 * route registration; before the first restart onto the off-host code there is
 * none — and that is a loud, expected failure, not something to guess around
 * (a fresh B compared against a fresh R could never raise NEED_RESTART).
 * @param path - Absolute runtime-capture path.
 * @throws When the file is missing or malformed.
 */
export function readRuntimeCapture(path: string): RestartStamp {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(`runtime capture absent: ${cause} — the host has not persisted R yet (restart dsh web to activate off-host collection)`)
  }
  return parseRuntimeCapture(text, path)
}

/** Parse the stamp CLI's stdout into current stamps (moved verbatim with the spawn). */
function parseCliStamps(text: string): CurrentStamp[] {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('restart-signal: stamp CLI returned a non-object body')
  }
  const stamps: unknown = Reflect.get(parsed, 'stamps')
  if (!Array.isArray(stamps)) throw new Error('restart-signal: stamp CLI response has no stamps array')
  return stamps.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('restart-signal: stamp CLI reported a non-object stamp')
    }
    const kind: unknown = Reflect.get(entry, 'kind')
    if (kind !== 'harness' && kind !== 'dsh-web') throw new Error('restart-signal: stamp CLI reported an unknown kind')
    const host: unknown = Reflect.get(entry, 'host')
    const client: unknown = Reflect.get(entry, 'client')
    if (typeof host !== 'string' || typeof client !== 'string') throw new Error('restart-signal: stamp CLI reported a non-string face stamp')
    return { repository: String(Reflect.get(entry, 'repository')), kind, host, client }
  })
}

/**
 * The single production gatherer spawn: run the stamp CLI against every
 * repository whose manifest carries a host-face baseline (a `null` baseline
 * contributes the combination's `ABSENT` token on both sides). This call site
 * IS the boundary the machine check guards — signal-cli runs here, in the
 * external collector, and nowhere in the host package.
 * @param repositoryRoot - Harness repository tree holding the CLI.
 * @param components - Fresh manifest components naming the in-scope repositories.
 * @returns Current per-repository stamps.
 * @throws When the CLI exits non-zero or prints an unreadable body.
 */
export async function runStampCli(
  repositoryRoot: string,
  components: readonly RestartManifestComponent[],
): Promise<readonly CurrentStamp[]> {
  const cli = join(repositoryRoot, 'scripts', 'restart-signal', 'signal-cli.ts')
  const args: string[] = [cli]
  for (const component of components) {
    if (component.hostFaceHash === null) continue
    args.push('--stamp', `${component.repository}:${component.kind}`)
  }
  if (args.length === 1) return []
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: repositoryRoot,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    // Pin the data root for the child too (watchdog precedent): whatever DSH_HOME
    // spelling the scheduler birth gave this run, downstream resolution lands on
    // the shared data home, never an install-root coincidence.
    env: { ...process.env, DSH_HOME: pinnedDataHome() },
  })
  return parseCliStamps(stdout)
}

/**
 * Compute one judgment — the host-side gather chain, moved out of the host
 * wholesale (manifest read, markers + orphan liveness, stamp-CLI combination,
 * pure judgment). Nothing here differs from what `collectRestartSignal` used
 * to do in the host process, except that R is read from the host's persisted
 * capture instead of this process's memory (a collector-start `restartStamp()`
 * would only ever mirror fresh B and erase NEED_RESTART).
 * @param options - Seams; production uses this tree, the pinned data home, and the CLI spawn.
 * @returns The judgment plus the tree it judged.
 */
export async function computeJudgment(options: CollectRunOptions = {}): Promise<CollectedState> {
  const dshHome = options.dshHome ?? pinnedDataHome()
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot()
  const runtime = readRuntimeCapture(join(dshHome, RESTART_SIGNAL_RUNTIME_FILE))
  const fresh = readRestartStamp({
    repositoryRoot,
    dshHome,
    ...(options.registryQuery === undefined ? {} : { registryQuery: options.registryQuery }),
  })
  // O-1103 liveness: the same read the host-side compute made — a dead build's
  // marker is cleared (journal line in the tree's auto-build journal) so the
  // judgment recovers in this pass instead of staying BUILDING forever.
  const building = readBuildingCapture(repositoryRoot)
  const buildingStartedAt = building ? readBuildStartCaptureTime(repositoryRoot) : undefined
  const failed = existsSync(join(repositoryRoot, STAMP_DIR, FAILURE_FILE))
  const configStamp = fresh.sCfg
  const nowIso = (options.now ?? ((): Date => new Date()))().toISOString()
  if (fresh.state === 'INIT') {
    return {
      collectedAt: nowIso,
      repositoryRoot,
      judgment: attachFacts(judgeRestartSignal({
        runtime, fresh, configStamp, building, buildingStartedAt, failed,
        currentHostFace: undefined, currentClientFace: undefined,
      }), { currentHostFace: undefined, configStamp }),
    }
  }
  const needsHostStamp = fresh.components.some(component => component.hostFaceHash !== null)
  // 构建触发口径 = 主仓面: this tree's own component (always present at BASELINE —
  // INIT owns the missing-own case) and its current stamp decide ownFaceMoved.
  const own = fresh.components.find(component => normalizeRepository(component.repository) === normalizeRepository(repositoryRoot))
  let ownFaceMoved: boolean | undefined = own !== undefined && own.hostFaceHash === null ? false : undefined
  let linkedRepos: readonly string[] | undefined
  let currentHostFace: string | undefined
  let currentClientFace: string | undefined
  if (needsHostStamp) {
    try {
      // The CLI always launches from this module's own harness tree (it lives
      // there); the components it stamps may name other repositories.
      const stamps = await (options.runStampCli ?? runStampCli)(defaultRepositoryRoot(), fresh.components)
      const byRepository = new Map(stamps.map(stamp => [normalizeRepository(stamp.repository), stamp]))
      currentHostFace = combineHostFace(
        fresh.components.map(component => [component.repository, component.hostFaceHash === null
          ? 'ABSENT'
          : byRepository.get(normalizeRepository(component.repository))?.host ?? 'ABSENT'] as const),
      )
      const harness = stamps.find(stamp => stamp.kind === 'harness')
      currentClientFace = harness?.client
      if (own !== undefined && own.hostFaceHash !== null) {
        ownFaceMoved = byRepository.get(normalizeRepository(own.repository))?.host !== own.hostFaceHash
      }
      // A (build-scope-rework-1105): every non-own component whose current stamp
      // exists and moved past its own baseline — the linked trees that owe a build.
      linkedRepos = fresh.components
        .filter(component => normalizeRepository(component.repository) !== normalizeRepository(repositoryRoot)
          && component.hostFaceHash !== null)
        .filter((component) => {
          const stamp = byRepository.get(normalizeRepository(component.repository))
          return stamp !== undefined && stamp.host !== component.hostFaceHash
        })
        .map(component => component.repository)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`collect: restart-signal stamp gathering failed: ${message}\n`)
      currentHostFace = undefined
      currentClientFace = undefined
      ownFaceMoved = undefined
      linkedRepos = undefined
    }
  } else {
    currentHostFace = undefined
    currentClientFace = undefined
  }
  return {
    collectedAt: nowIso,
    repositoryRoot,
    judgment: attachFacts(judgeRestartSignal({
      runtime, fresh, configStamp, building, buildingStartedAt, failed,
      currentHostFace, currentClientFace, ownFaceMoved, linkedRepos,
    }), { currentHostFace, configStamp, ownFaceMoved }),
  }
}

/** Attach the machine facts a judgment consumed — the change-sensitive consumers
 * (auto-build throttle trigger scope) read them off the served judgment, so the
 * collector's file must carry exactly what the host-side compute used to publish. */
function attachFacts(
  judgment: ReturnType<typeof judgeRestartSignal>,
  facts: { readonly currentHostFace: string | undefined; readonly configStamp: string; readonly ownFaceMoved?: boolean | undefined },
): ReturnType<typeof judgeRestartSignal> {
  return { ...judgment, facts }
}

/** Separator-insensitive repository comparison (moved with the compute chain). */
function normalizeRepository(repository: string): string {
  return repository.replace(/\\/g, '/')
}

/**
 * Atomically write the collected state where the host reads it: temp file +
 * rename, so a host stat can never catch a half-written body.
 * @param path - Absolute state-file path.
 * @param state - The row to persist.
 */
export function writeStateFile(path: string, state: CollectedState): void {
  mkdirSync(dirname(path), { recursive: true })
  const body = JSON.stringify({
    schema: RESTART_SIGNAL_STATE_SCHEMA,
    collectedAt: state.collectedAt,
    repositoryRoot: state.repositoryRoot,
    judgment: state.judgment,
  })
  const tempPath = `${path}.tmp-${String(process.pid)}`
  writeFileSync(tempPath, body)
  renameSync(tempPath, path)
}

/** Append one line to the collector's run journal (rotated; best-effort observability). */
export function writeRunJournal(dataHome: string, line: string): void {
  const path = join(dataHome, RUN_JOURNAL_FILE)
  try {
    mkdirSync(dataHome, { recursive: true })
    if (existsSync(path) && statSync(path).size > RUN_JOURNAL_CAP_BYTES) renameSync(path, `${path}.old`)
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Observability only: the exit code and stderr still carry the verdict.
  }
}

/** The settings patch mirroring duty-inventory's register (IgnoreNew so a slow
 * run never overlaps the next minute; PT10M is the kill switch). The ISO
 * duration strings are load-bearing: assigning TimeSpan objects writes an
 * unparseable XML value (duty-inventory 2026-11-03 实发). */
function settingsPayload(taskName: string): string {
  return [
    `$t = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction Stop`,
    '$s = $t.Settings',
    '$s.StartWhenAvailable = $true',
    '$s.DisallowStartIfOnBatteries = $false',
    '$s.StopIfGoingOnBatteries = $false',
    "$s.MultipleInstances = 'IgnoreNew'",
    "$s.ExecutionTimeLimit = 'PT10M'",
    `Set-ScheduledTask -TaskName '${taskName}' -Settings $s | Out-Null`,
  ].join('\n')
}

/**
 * (Re)register the schtasks task — single source of the collector's
 * lifecycle, run from wherever but always pinning the main-tree script
 * (duty-inventory `--register` pattern), then verifying the written XML on
 * every face that matters.
 * @returns 0 when registered and verified; 2 otherwise (loud prints).
 */
export function registerCollectTask(): number {
  const action = `${CONHOST_EXE} --headless ${NODE_EXE} ${MAIN_SCRIPT}`
  if (!existsSync(MAIN_SCRIPT)) {
    process.stderr.write(`register REFUSED: main-tree script missing ${MAIN_SCRIPT} (merge to the main checkout first)\n`)
    return 2
  }
  if (!existsSync(NODE_EXE)) {
    process.stderr.write(`register REFUSED: node interpreter missing ${NODE_EXE}\n`)
    return 2
  }
  if (action.length > 261) {
    process.stderr.write(`register REFUSED: /tr over the 261-char limit (${action.length})\n`)
    return 2
  }
  try {
    execFileSync('schtasks', ['/create', '/f', '/tn', COLLECT_TASK_NAME, '/sc', 'MINUTE', '/mo', String(COLLECT_TASK_MINUTES), '/tr', action], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`register: schtasks /create FAILED: ${message}\n`)
    return 2
  }
  try {
    execFileSync('pwsh', ['-NoProfile', '-Command', settingsPayload(COLLECT_TASK_NAME)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`register: settings patch FAILED: ${message}\n`)
    return 2
  }
  let xml = ''
  try {
    xml = execFileSync('schtasks', ['/query', '/tn', COLLECT_TASK_NAME, '/xml'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    // falls through to the failed checks below
  }
  const checks: Record<string, boolean> = {
    'conheadless-node': xml.includes(CONHOST_EXE) && xml.includes('--headless') && xml.includes(NODE_EXE),
    'script=main-tree': xml.includes(MAIN_SCRIPT),
    'interval=PT1M': xml.includes('<Interval>PT1M</Interval>'),
    'ignore-new': xml.includes('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'),
    'batteries-not-gate': xml.includes('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>')
      && xml.includes('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'),
    'start-when-available': xml.includes('<StartWhenAvailable>true</StartWhenAvailable>'),
  }
  const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
  process.stdout.write(`register action=${action}\n`)
  process.stdout.write(`register verify: ${bad.length === 0 ? 'ALL OK' : `FAILED ${bad.join(',')}`}\n`)
  if (bad.length === 0) writeRunJournal(pinnedDataHome(), `register: action=${action} verify=ALL-OK`)
  return bad.length === 0 ? 0 : 2
}

/** The default flow: pin the data root, compute, write, journal one line. */
async function collectOnce(checkOnly: boolean): Promise<number> {
  const dataHome = pinnedDataHome()
  // Watchdog precedent (build-watchdog.py): override whatever the scheduler
  // birth gave us so every resolveDshHome() downstream lands on `~/.dsh` —
  // the root the booted host reads its state file from.
  process.env.DSH_HOME = dataHome
  const state = await computeJudgment({ dshHome: dataHome })
  if (checkOnly) {
    process.stdout.write(`${JSON.stringify(state, undefined, 2)}\n`)
    return 0
  }
  writeStateFile(join(dataHome, RESTART_SIGNAL_STATE_FILE), state)
  writeRunJournal(dataHome, `ok state=${state.judgment.state} tree=${state.repositoryRoot} collectedAt=${state.collectedAt}`)
  process.stdout.write(`${JSON.stringify({ state: state.judgment.state, collectedAt: state.collectedAt, path: join(dataHome, RESTART_SIGNAL_STATE_FILE) })}\n`)
  return 0
}

function main(args: readonly string[]): number | Promise<number> {
  if (args.includes('--register')) return registerCollectTask()
  const checkOnly = args.includes('--check')
  return collectOnce(checkOnly)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const args = process.argv.slice(2)
  Promise.resolve()
    .then(() => main(args))
    .then(
      (code) => { process.exitCode = code },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`collect: ${message}\n`)
        writeRunJournal(pinnedDataHome(), `FAIL ${message}`)
        process.exitCode = 1
      },
    )
}
