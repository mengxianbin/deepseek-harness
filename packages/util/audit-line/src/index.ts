/**
 * One-line host audit journal written straight to the Host process stdout.
 *
 * The Host launcher captures only `stdout`/`stderr` into `dsh-web.log`, and the
 * Cordis logger has no console exporter in the shipped profile, so a record
 * that must survive for forensics is written with `process.stdout.write` —
 * never through `ctx.logger`, which would discard it. Every line carries one
 * local wall-clock prefix `[yyyy-MM-dd HH:mm:ss]` so journal lines from this
 * package align with the launcher's own timestamped records when an incident
 * timeline is reconstructed. The library keeps no state, opens no stream, and
 * owns no message vocabulary: each caller formats its record body (`access …`,
 * `resumed session …`, `patch written …`) and passes one line of text.
 *
 * @module @deepseek-ai/dsh-audit-line
 */

/**
 * Render one local wall-clock instant as the journal prefix, without brackets.
 * @param now - the instant to render; defaults to the current local time.
 * @returns `yyyy-MM-dd HH:mm:ss` in the host's local zone, zero-padded.
 */
export function auditTimestamp(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

/**
 * Append one audit line to process stdout for the Host log to capture.
 *
 * Line breaks inside `message` are folded to single spaces so one call always
 * produces exactly one journal line; the message itself carries no timestamp.
 * @param message - the record body without surrounding brackets or newline.
 * @returns nothing; a backpressure-short write still leaves the line queued.
 */
export function auditLine(message: string): void {
  process.stdout.write(`[${auditTimestamp()}] ${message.replace(/[\r\n]+/gu, ' ')}\n`)
}
