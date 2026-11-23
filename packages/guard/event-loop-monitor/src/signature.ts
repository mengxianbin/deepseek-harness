/**
 * Spike signatures, the cold-layer dump bound and the hot-layer event
 * stream — the loop-report-sign-1123 output stop-bleed, adopted verbatim
 * from the「签名+计数」方案 (m-note `loop-report-mode-critique-1123.md` §三,
 * user ruling 2026-11-23「签名+计数 方案 采纳」).
 *
 * The old output mode wrote one full `process.report` (≈62 KB) per
 * unattributed spike behind a 10-minute cooldown: bounded per window, but
 * unbounded over time (≈3.7 MB/day, no retention rule at all). The adopted
 * scheme replaces time-based throttling with structure:
 *
 * - **Signature dedup** — a cheap signature (`worstMs` bucket × slice
 *   attribution state) identifies the *kind* of phenomenon. The first
 *   sighting of a signature in a process writes one full report (the cold
 *   layer); every repeat appends a single line to the hot-layer event
 *   JSONL with an occurrence count. Output scales with distinct phenomena,
 *   not with wall-clock time.
 * - **Bounded layers** — the cold layer is capped on disk at
 *   {@link COLD_PER_SIGNATURE_LIMIT} files per signature and
 *   {@link COLD_GLOBAL_LIMIT} files globally, enforced statelessly from
 *   filenames so the bound survives restarts and covers stock written by
 *   earlier eras; {@link sweepColdLayer} re-asserts the same rules over a
 *   directory (the first scan that takes over pre-signature stock). The hot
 *   layer is a single rolling JSONL of at most {@link EVENT_JSONL_LIMIT}
 *   lines. Worst-case volume is therefore a constant, and the tmp file-count
 *   axis can never be tripped by this writer again.
 *
 * Everything here is synchronous, kilobyte-scale and runs inside the
 * existing 60 s window tick (availability gate Q2: a few ms, only on an
 * unattributed spike). All filesystem failures are the caller's to warn
 * about — this module never throws from a write path except
 * {@link sweepColdLayer}, which the plugin wraps in fail-soft.
 *
 * @module @deepseek-ai/dsh-event-loop-monitor/signature
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SliceName } from './overshoot.ts'

/** Cold layer: at most this many full `process.report` files on disk, globally, ever. */
export const COLD_GLOBAL_LIMIT = 50

/** Cold layer: at most this many full reports per signature on disk (cross-restart, covers stock). */
export const COLD_PER_SIGNATURE_LIMIT = 3

/** Hot layer: the event JSONL keeps at most this many lines (newest kept, oldest dropped). */
export const EVENT_JSONL_LIMIT = 500

/** Hot-layer event stream file name, living beside the dumps in the dump directory. */
export const EVENT_JSONL_FILE = 'loop-events.jsonl'

/** Signature class of dump files written before signatures existed (no `-sig-` segment in the name). */
export const LEGACY_SIGNATURE = 'legacy'

/** Dump-file name prefix; anything else in the directory (event JSONL included) is out of the cold layer's scope. */
const DUMP_PREFIX = 'loop-report-'

/** Dump-file suffix; the event JSONL deliberately does not match it. */
const DUMP_SUFFIX = '.json'

/**
 * Worst-ms tiers as multiples of the configured `maxBadMs` (default
 * 2000 ms → 1-3x = 2–6 s, 3-10x = 6–20 s, 10-30x = 20–60 s, 30x+ = ≥60 s).
 * Relative tiers keep the signature meaningful when a profile retunes the
 * threshold; `sub1x` exists so the function is total (the dump trigger
 * guarantees `max > maxBadMs`, so a dump never carries it).
 */
export type WorstBucket = 'sub1x' | '1-3x' | '3-10x' | '10-30x' | '30x+'

/** Every bucket label, in severity order — the filename parser's allow-list. */
export const WORST_BUCKETS: readonly WorstBucket[] = ['sub1x', '1-3x', '3-10x', '10-30x', '30x+']

/**
 * Bucket a spike's worst milliseconds into a {@link WorstBucket}.
 * @param maxMs - the window max that tripped (ms).
 * @param maxBadMs - the configured single-block threshold (ms), the bucket unit.
 * @returns the tier label.
 */
export function worstBucket(maxMs: number, maxBadMs: number): WorstBucket {
  if (!Number.isFinite(maxMs) || !Number.isFinite(maxBadMs) || maxMs <= maxBadMs) return 'sub1x'
  if (maxMs <= 3 * maxBadMs) return '1-3x'
  if (maxMs <= 10 * maxBadMs) return '3-10x'
  if (maxMs <= 30 * maxBadMs) return '10-30x'
  return '30x+'
}

/**
 * The cheap spike signature: worst-ms bucket × slice attribution state
 * (`none` for an unattributed spike, otherwise the sorted slice names
 * joined by `.`). Two windows with the same signature are the same
 * phenomenon for retention purposes — that identity is what makes output
 * scale with distinct phenomena instead of time.
 *
 * @param maxMs - the window max that tripped (ms).
 * @param slices - slice points that overshot in the same window (empty = unattributed).
 * @param maxBadMs - the configured single-block threshold (ms).
 * @returns e.g. `1-3x_none` or `3-10x_list.zstd`.
 */
export function spikeSignature(maxMs: number, slices: readonly SliceName[], maxBadMs: number): string {
  const attribution = slices.length > 0 ? [...slices].sort().join('.') : 'none'
  return `${worstBucket(maxMs, maxBadMs)}_${attribution}`
}

/**
 * Full dump file name for a signature: `loop-report-<isoStamp>-sig-<bucket>-<attr>.json`
 * (the attribution segment carries `.` for multi-slice states, which is
 * filename-safe; the signature's `_` separator becomes `-` in the name).
 * @param stamp - the existing ISO-ish dump stamp (`new Date().toISOString()` with `:`/`.` → `-`).
 * @param sig - the signature, e.g. `1-3x_none`.
 * @returns the file name (no directory).
 */
export function dumpFileName(stamp: string, sig: string): string {
  return `${DUMP_PREFIX}${stamp}-sig-${sig.replace('_', '-')}.json`
}

/** Filename pattern for signature-era dumps; group 2 = bucket, group 3 = attribution. */
const SIGNATURE_NAME_RE = new RegExp(
  `^${DUMP_PREFIX}(.+)-sig-(${WORST_BUCKETS.map(bucket => bucket.replace(/[+]/g, '\\+')).join('|')})-([a-z.]+)\\${DUMP_SUFFIX}$`,
)

/**
 * Recover the signature from a dump file name; `undefined` for stock written
 * before signatures existed (the `legacy` class for retention purposes).
 * @param filename - bare file name inside the dump directory.
 * @returns the signature string, or undefined when the name carries none.
 */
export function parseDumpSignature(filename: string): string | undefined {
  const match = SIGNATURE_NAME_RE.exec(filename)
  if (match === null) return undefined
  return `${match[2]}_${match[3]}`
}

/** One cold-layer census: how many dump files exist, grouped by signature. */
export interface ColdLayerCount {
  /** Total dump files (`loop-report-*.json`) in the directory. */
  readonly total: number
  /** Dump files per signature; files without a signature count under {@link LEGACY_SIGNATURE}. */
  readonly perSignature: ReadonlyMap<string, number>
}

/**
 * Census the cold layer without touching it. A missing directory reads as
 * an empty layer (the writer creates it); any other failure reads as
 * `undefined` — the caller must then skip its dump (cannot prove the caps
 * hold → do not write), which keeps the bound fail-safe.
 *
 * @param dir - the dump directory (relative paths resolve against the process cwd).
 * @returns the counts, or undefined when the directory cannot be read.
 */
export function readColdLayer(dir: string): ColdLayerCount | undefined {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { total: 0, perSignature: new Map() }
    return undefined
  }
  const perSignature = new Map<string, number>()
  let total = 0
  for (const name of entries) {
    if (!isDumpFile(name)) continue
    total += 1
    const sig = parseDumpSignature(name) ?? LEGACY_SIGNATURE
    perSignature.set(sig, (perSignature.get(sig) ?? 0) + 1)
  }
  return { total, perSignature }
}

/** Whether a directory entry is a cold-layer dump file (the event JSONL never matches). */
export function isDumpFile(name: string): boolean {
  return name.startsWith(DUMP_PREFIX) && name.endsWith(DUMP_SUFFIX)
}

/** One hot-layer event-stream line: a repeated signature's occurrence, counted instead of dumped. */
export interface LoopEventRecord {
  /** Wall clock of the spike window (ms since epoch). */
  readonly at: number
  /** The spike's signature. */
  readonly sig: string
  /** The window max that tripped (ms). */
  readonly max: number
  /** This signature's occurrence number within the process (the「计数 +1」). */
  readonly occurrence: number
  /** What the cold layer did: a full report was written, or the occurrence was counted only. */
  readonly action: 'dump' | 'count'
}

/**
 * Append one event line to the hot-layer JSONL and roll it back to
 * {@link EVENT_JSONL_LIMIT} lines (newest kept). Fail-soft by contract: the
 * caller warns on a throw and the watch continues — a lost line costs one
 * count, never the watch.
 *
 * @param dir - the dump directory (created when missing).
 * @param event - the record to append.
 * @param limit - rolling line cap; pass a smaller value in tests.
 * @returns void; throws on filesystem failure (caller warns).
 */
export function appendLoopEvent(dir: string, event: LoopEventRecord, limit: number = EVENT_JSONL_LIMIT): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, EVENT_JSONL_FILE)
  appendFileSync(file, `${JSON.stringify(event)}\n`)
  const lines = readFileSync(file, 'utf8').split('\n').filter(line => line.length > 0)
  if (lines.length > limit) writeFileSync(file, `${lines.slice(-limit).join('\n')}\n`)
}

/** Result of one cold-layer sweep, carrying the before/after readings the closeout pastes. */
export interface SweepResult {
  /** Dump files and bytes before the sweep. */
  readonly before: { readonly files: number; readonly bytes: number }
  /** Dump files and bytes after the sweep. */
  readonly after: { readonly files: number; readonly bytes: number }
  /** Dump files deleted (over per-signature or global cap). */
  readonly removed: number
  /** Surviving dump files grouped by signature (per-bucket readings). */
  readonly keptBySignature: Record<string, number>
}

/**
 * The first scan / periodic re-assert of the cold-layer caps: keep the
 * newest {@link COLD_PER_SIGNATURE_LIMIT} dumps per signature (legacy
 * stock counts as one class), then the newest {@link COLD_GLOBAL_LIMIT}
 * overall, delete the rest. Only files matching {@link isDumpFile} are
 * touched — the event JSONL and any foreign file in the directory stay.
 *
 * This is the function that takes over pre-signature stock (loop-report-sign-1123
 * 分期2): stock names carry no signature, so the whole legacy era is one
 * class and only its newest samples survive.
 *
 * @param dir - the dump directory; a missing directory is an empty layer (no-op).
 * @returns the before/after readings.
 * @throws on filesystem failure other than a missing directory (the plugin warns and continues).
 */
export function sweepColdLayer(dir: string): SweepResult {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { before: { files: 0, bytes: 0 }, after: { files: 0, bytes: 0 }, removed: 0, keptBySignature: {} }
    }
    throw error
  }

  const dumps = entries.filter(isDumpFile).sort().reverse() // ISO stamps: reverse = newest first
  const sizes = new Map<string, number>()
  let beforeBytes = 0
  for (const name of dumps) {
    const bytes = statSync(join(dir, name)).size
    sizes.set(name, bytes)
    beforeBytes += bytes
  }

  // Per-signature cap: newest first, keep at most COLD_PER_SIGNATURE_LIMIT.
  const keep = new Set<string>()
  const perSignature = new Map<string, string[]>()
  for (const name of dumps) {
    const sig = parseDumpSignature(name) ?? LEGACY_SIGNATURE
    const bucket = perSignature.get(sig)
    if (bucket === undefined) perSignature.set(sig, [name])
    else bucket.push(name)
  }
  for (const names of perSignature.values()) {
    for (const name of names.slice(0, COLD_PER_SIGNATURE_LIMIT)) keep.add(name)
  }

  // Global cap: newest first among the per-signature survivors.
  if (keep.size > COLD_GLOBAL_LIMIT) {
    const ranked = [...keep].sort().reverse()
    for (const name of ranked.slice(COLD_GLOBAL_LIMIT)) keep.delete(name)
  }

  let removed = 0
  let afterBytes = 0
  const keptBySignature: Record<string, number> = {}
  for (const name of dumps) {
    if (keep.has(name)) {
      afterBytes += sizes.get(name) ?? 0
      const sig = parseDumpSignature(name) ?? LEGACY_SIGNATURE
      keptBySignature[sig] = (keptBySignature[sig] ?? 0) + 1
      continue
    }
    unlinkSync(join(dir, name))
    removed += 1
  }
  return {
    before: { files: dumps.length, bytes: beforeBytes },
    after: { files: keep.size, bytes: afterBytes },
    removed,
    keptBySignature,
  }
}
