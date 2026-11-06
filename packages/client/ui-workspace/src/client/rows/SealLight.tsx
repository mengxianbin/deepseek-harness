/**
 * The archive-seal row light (FORK archive-seal-light-1101): a lamp badge
 * hung at a Session row's trailing edge — 「先读后归」的读面 (archive-seal-light.md
 * §〇/§三) made one glance wide.
 *
 * Seat and form are both deliberate: it lives OUTSIDE `.rowResting`, because
 * that strip (and the `sidebar.session.row.trailing` seat inside it) hides
 * while the row is hovered on hover-capable devices, and a lamp whose detail
 * tooltip can never be hovered is no read surface. It also never shares the
 * leading cell: StateDot owns that seat, and the design demands visual
 * separation — the dot is a bare 6px core at the row's head, this lamp is a
 * ringed core at the row's end.
 *
 * Lamp table = design §四 (刻意不同于归档门的 `isGreenSeal`),
 * GREEN-ONLY since the 2026-11-02 丙-最简 revision (m-note
 * content/tech/ai/dsh/archive-seal-light.md §〇修订注 / §四修订段,判据源 =
 * decision-log `2026-11-02T16:55` 条): 🟢 `DONE` (save 收口完成 =
 * 归档触发灯), DONE-only since 2026-11-06 — `N_A` went dark
 * (seal-light-nadark-1106): N_A = 本轮无产物、归不归全凭人判, a lit lamp
 * reads as 「有产物入 main」 so it stops guiding (判据源 = 用户 2026-11-06
 * 原话「NA 灭灯」; the gate's `isGreenSeal` keeps `N_A` green, untouched
 * here) · `UNSEALED` / `UNKNOWN` no longer paint red — 「未收口」是多轮
 * 编辑的正常中间态,常亮红把状态当警报、违反警报经济学,红的职责整体移交归档门
 * (单2,点归档那一刻的单条预检) · dark = `NEUTRAL` / `LEGACY` / no verdict for
 * the row — and the whole channel fails dark when contract C1's endpoint is
 * absent or fails (单1 在途 = 当前预期常态), so an unlanded endpoint paints
 * nothing and says nothing. Registration rides the component's mount, so an
 * archived or blank row — which renders no lamp — never joins the check's id
 * set either.
 *
 * The 2026-11-06 running 短路 (seal-light-running-dark-1106) precedes the
 * table: a row whose session is working renders exactly what a dark row
 * renders — nothing — because any verdict its snapshot holds is the previous
 * turn's reading (a fake sentinel once answered DONE and held the lamp green
 * through a whole run; 判据源 = m-note
 * content/tech/ai/dsh/tasks.md#seal-light-running-dark-1106).
 */
import { useEffect } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SealLightSeal, SealRowObserver, WorkspaceBrowserProps } from '../contract/slots.ts'
import css from './Rows.module.css'

/** The locale seat, prop-passed from the browser root (Rows' own alias). */
type SealLightTranslate = WorkspaceBrowserProps['t']

/** The lamp's only lit tone (2026-11-02 丙-最简: red exited the row); no tone is a dark row — or a running one (2026-11-06 短路). */
export type SealLightTone = 'ready'

/**
 * The design's lamp table (archive-seal-light.md §四 灯绿; 2026-11-02 丙-最简
 * 修订 = 行内绿-only): save 收口完成 lights the archive-trigger green, and
 * every other verdict — including `UNSEALED` / `UNKNOWN`, whose red left the
 * row for the archive gate — stays dark for the human.
 *
 * DONE-only since 2026-11-06 (seal-light-nadark-1106): `N_A` no longer
 * lights. N_A = 本轮无产物、归不归全凭人判 — a lit lamp reads as 「有产物入
 * main」, so the light stops guiding (判据源 = 用户 2026-11-06 原话「NA 灭灯」;
 * the gate's `isGreenSeal` keeps `N_A` green, untouched here).
 *
 * The running short-circuit (2026-11-06 seal-light-running-dark-1106) comes
 * first: while the row's session works, the verdict on screen is the previous
 * turn's reading, so a running row paints nothing and never a `ready` — the
 * same form as a dark row.
 * @param seal - the verdict C1 reported for this row.
 * @param running - the row's live running flag; defaults to false, the state
 *   the store registers a row in (`watch`), so an unreported row keeps the
 *   pre-revision lamp table exactly.
 * @returns the tone to paint, or nothing for a dark or running row.
 */
export function sealLightTone(seal: SealLightSeal, running = false): SealLightTone | undefined {
  if (running) return undefined
  if (seal.verdict === 'DONE') return 'ready'
  return undefined
}

/**
 * The UNSEALED breakdown the tooltip's second line carries (the detail
 * vocabulary seal.ts documents; a stale verdict folds its `followUpCount` in).
 * A verdict the server broke down no further — a bare `DONE`/`N_A`, or an
 * `UNKNOWN` with no named cause — adds no line: the head already names it.
 * @param seal - the verdict C1 reported for this row.
 * @param t - the browser root's locale seat.
 * @returns the localized detail line, or nothing.
 */
function sealDetailLine(seal: SealLightSeal, t: SealLightTranslate): string | undefined {
  switch (seal.detail) {
    case 'sentinel-pending': return t('archive.seal.status.sentinel-pending')
    case 'save-tail-no-sentinel': return t('archive.seal.status.save-tail-no-sentinel')
    case 'save-trace-no-sentinel': return t('archive.seal.status.save-trace-no-sentinel')
    case 'sentinel-stale': return t('archive.seal.status.sentinel-stale', { n: seal.followUpCount ?? 0 })
    default: return undefined
  }
}

/**
 * The tooltip and screen-reader text: the head line carrying the raw verdict
 * token (traceable against a C1 report), plus the server-named detail when
 * there is one. Copy rides the dictionary; only the separator is structural
 * (verify-client-ui-i18n exempts it: no language character).
 * @param seal - the verdict C1 reported for this row.
 * @param t - the browser root's locale seat.
 * @returns the complete label.
 */
function sealLightLabel(seal: SealLightSeal, t: SealLightTranslate): string {
  const head = t('sealLight.ready', { v: seal.verdict })
  const detail = sealDetailLine(seal, t)
  return detail === undefined ? head : `${head} · ${detail}`
}

type SealLightProps = {
  /** Session the row shows; the lamp addresses its C1 verdict by this id. */
  sessionId: SessionId
  /** The row's live running flag, reported to the observer (flip → check). */
  running: boolean
  /** The verdict the browser's snapshot holds for this row; absent = dark. */
  seal: SealLightSeal | undefined
  /** The row-side observation channel (the browser's injected `sealRows`). */
  sealRows: SealRowObserver
  /** The browser root's locale seat. */
  t: SealLightTranslate
}

/**
 * Render one row's lamp, or nothing while the row is dark or running. The
 * registration effect runs before any early return, so a mounted-but-dark (or
 * running) row still joins the check's id set — its verdict arriving on a
 * stopped row is what lights it.
 * @param props - the row identity, its verdict, the observer, and the locale seat.
 * @returns the lamp element tree, or null for a dark or running row.
 */
export function SealLight({ sessionId, running, seal, sealRows, t }: SealLightProps) {
  // Registration lives and dies with this lamp's mount: the mounted set is the
  // check's id set (visible, non-archived, non-blank rows only — a row that
  // renders no lamp asks nothing). The running fact rides its own effect so a
  // flip reports in place instead of reading as an unmount/remount.
  useEffect(() => sealRows.watch(sessionId), [sessionId, sealRows])
  useEffect(() => {
    sealRows.reportRunning(sessionId, running)
  }, [sessionId, running, sealRows])
  const tone = seal === undefined ? undefined : sealLightTone(seal, running)
  if (seal === undefined || tone === undefined) return null
  const label = sealLightLabel(seal, t)
  return (
    <Tooltip label={label} delayMs={500} side="left">
      <span className={css.sealLight} data-seal-tone={tone} role="img" aria-label={label} />
    </Tooltip>
  )
}
