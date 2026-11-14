/**
 * Append-only subprocess range ledger: one JSONL line per spawn and per range
 * settlement, written under the DSH home so an out-of-process janitor can
 * reconcile captured pids after the host is gone. Observational by contract:
 * a ledger write never fails, never blocks, and never changes a spawn's
 * outcome — containment is the Job's job, the ledger is only the witness.
 * @module dsh-subprocess-local/ledger
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SweptWindowsProcess } from './windows-inspector.ts'

/** One `spawn` line: the runner that owned the Job for one target launch. */
export interface LedgerSpawnEvent {
  /** Discriminator. */
  event: 'spawn'
  /** Runner pid — the range owner whose death proves the Job handle closed. */
  runner: number | null
  /** Target argv[0] as launched. */
  target: string
}

/** One `settle` line: how the range ended and what the sweep did. */
export interface LedgerSettleEvent {
  /** Discriminator. */
  event: 'settle'
  /** Runner pid matching the `spawn` line. */
  runner: number | null
  /** Whether a termination signal ever captured descendants. */
  signalled: boolean
  /** Why the range settled. */
  via: 'exit' | 'error' | 'host-exit'
  /** Captured descendant count (0 when no capture ran). */
  captured: number
  /** Per-descendant disposition from the sweep. */
  swept: SweptWindowsProcess[]
}

/** Either ledger line type. */
export type LedgerEvent = LedgerSpawnEvent | LedgerSettleEvent

/** Override for tests and relocated installs; defaults to `<DSH home>/subprocess-ledger.jsonl`. */
const LEDGER_ENV = 'DSH_SUBPROCESS_LEDGER'

/**
 * Resolve the ledger path: explicit override first, then the resolved DSH
 * home (F' 四层配置插层——显式参 > `$DSH_HOME` > data-root 配置文件 >
 * `~/.dsh`，见 dsh-home-configfile-1113)，so the ledger follows the single
 * source of truth instead of re-reading the environment alone.
 * @returns the absolute JSONL path.
 */
export function subprocessLedgerPath(): string {
  const override = process.env[LEDGER_ENV]
  if (override !== undefined && override.trim() !== '') return override.trim()
  return join(resolveDshHome(), 'subprocess-ledger.jsonl')
}

/**
 * Append one ledger line with an ISO timestamp. Fully best-effort: an
 * unwritable home, a full disk, or a mid-append crash must never surface
 * through a spawn or teardown path.
 * @param event - the spawn or settle record to journal.
 */
export function appendSubprocessLedger(event: LedgerEvent): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event })
    appendFileSync(subprocessLedgerPath(), line + '\n', { encoding: 'utf8' })
  } catch {
    // The ledger is observational; losing a line degrades the janitor's view,
    // never the containment itself.
  }
}
