/**
 * Age display for this namespace's health and status lines (health-age-human-1128):
 * the wire carries whole seconds (`DutyInventoryReport.ageSec`, `failingForSec`,
 * `staleSeconds`), and a raw second count reads as noise once it grows — the duty
 * red line rendered `45266s` for a ~12.6 h gap. Every age slot here formats
 * through {@link formatAgeSec} instead of printing the number as-is.
 */

/**
 * Format a whole-second age as its two largest nonzero units.
 * @param totalSec - age in seconds; negative and non-finite values read as zero.
 * @returns e.g. `0s`, `45s`, `5m 12s`, `12h 34m`, `2d 3h`.
 */
export function formatAgeSec(totalSec: number): string {
  const total = Number.isFinite(totalSec) ? Math.max(0, Math.round(totalSec)) : 0
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  const units = [
    days > 0 ? `${days}d` : undefined,
    hours > 0 ? `${hours}h` : undefined,
    minutes > 0 ? `${minutes}m` : undefined,
    seconds > 0 || total === 0 ? `${seconds}s` : undefined,
  ].filter((unit): unit is string => unit !== undefined)
  // Two units carry the reading; a third only widens the line (12h 34m, not 12h 34m 26s).
  return units.slice(0, 2).join(' ')
}
