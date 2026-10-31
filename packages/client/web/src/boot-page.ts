/**
 * Framework-free boot page and failure report. It remains available when a
 * client plugin fails because React arrives only with the UI renderer.
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import type { LoaderEntryState } from './loader-status.ts'
import css from './boot-page.module.css'

/** Create a div with one module class and optional text. */
function div(className: string | undefined, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className ?? ''
  if (text !== undefined) el.textContent = text
  return el
}

/**
 * FORK dsh-local (f5-shell-skeleton, marker: data-dsh-shell-skeleton): the
 * shell-level list skeleton column. The list skeleton used to first appear
 * only when ui-workspace mounted (~2.4s into the plugin chain), leaving the
 * first two seconds feedback-free; this column renders the same row shape
 * (`data-list-state="loading"`, six fixed-height rows) from the first screen
 * of JS instead. It lives INSIDE the boot root: `mountApp` snapshots
 * `[data-dsh-boot].innerHTML` and hydrates over it, so only a descendant
 * rides the atomic boot→app swap — a sibling would outlive the boot page and
 * double-render against ui-workspace's own skeleton. The list data flow and
 * the activation chain are untouched; ui-workspace's real
 * `SessionListSkeleton` takes over in the same commit that removes this.
 * Row metrics mirror `WorkspaceBrowser.module.css` `.skeletonRow` (48px row
 * height, 16px dot, 65%/90% bars); the ~3px right-inset difference from
 * the live scrollbar vars is imperceptible during a placeholder's lifetime.
 */
function buildListSkeleton(): HTMLDivElement {
  const column = div(css.skeletonColumn)
  column.dataset.dshShellSkeleton = ''
  const list = div(css.skeletonList)
  list.dataset.listState = 'loading'
  list.setAttribute('role', 'status')
  list.setAttribute('aria-label', 'Loading sessions…')
  for (let i = 0; i < 6; i += 1) {
    const row = div(css.skeletonRow)
    row.setAttribute('aria-hidden', 'true')
    const dot = document.createElement('span')
    dot.className = css.skeletonDot ?? ''
    const bars = div(css.skeletonBars)
    const bar = document.createElement('span')
    bar.className = css.skeletonBar ?? ''
    const barWide = document.createElement('span')
    barWide.className = `${css.skeletonBar ?? ''} ${css.skeletonBarWide ?? ''}`
    bars.append(bar, barWide)
    row.append(dot, bars)
    list.append(row)
  }
  column.append(list)
  return column
}

/** Kernel-owned page mounted below the application's root element. */
export class BootPage {
  private readonly root: HTMLDivElement
  private readonly card: HTMLDivElement
  private readonly wordmark: HTMLDivElement
  private readonly spinner: HTMLDivElement
  private readonly hint: HTMLDivElement
  /** FORK dsh-local (f5-shell-skeleton): first-screen list placeholder. */
  private readonly listSkeleton: HTMLDivElement
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private total = 0
  private failure: string | undefined

  /**
   * Build and attach the boot page.
   * @param container - Application mount point.
   */
  constructor(container: HTMLElement) {
    this.root = div(css.boot)
    this.root.dataset.dshBoot = ''
    this.card = div(css.card)
    this.wordmark = div(css.wordmark, 'HARNESS')
    this.spinner = div(css.spinner)
    this.spinner.dataset.dshBootSpinner = ''
    this.hint = div(css.hint, 'Loading plugins…')
    this.card.append(this.wordmark, this.spinner, this.hint)
    this.root.append(this.card)
    // FORK dsh-local (f5-shell-skeleton): first-screen list placeholder; the
    // boot→app hydration swap removes it together with the boot root.
    this.listSkeleton = buildListSkeleton()
    this.root.append(this.listSkeleton)
    container.append(this.root)
    this.updateProgress()
  }

  /**
   * Set the number of loader entries represented by the progress arc.
   * @param total - Complete boot roster size.
   */
  setTotal(total: number): void {
    this.total = total
    this.updateProgress()
  }

  /**
   * Project one loader entry's fiber state.
   * @param id - Loader entry name.
   * @param state - Projected fiber state.
   */
  setState(id: string, state: LoaderEntryState): void {
    this.states.set(id, state)
    if (state === 'active') this.active.add(id)
    this.updateProgress()
    this.render()
  }

  /**
   * Display the boot failure report.
   * @param message - Failure report text.
   */
  fail(message: string): void {
    this.failure = message
    this.render()
  }

  /** Detach the page before or after the UI renderer takes the mount point. */
  dispose(): void {
    this.root.remove()
  }

  /** Redraw the state-dependent content below the wordmark. */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      if (this.spinner.parentElement !== this.card) {
        this.card.replaceChildren(this.wordmark, this.spinner, this.hint)
      }
      return
    }
    // FORK dsh-local (f5-shell-skeleton): a failure report replaces the boot
    // card while the page stays up — the list placeholder must not keep
    // claiming "loading" beside it.
    this.listSkeleton.remove()
    const report = div(css.failed)
    report.append(div(css.failedTitle, 'Failed to load plugins'))
    for (const id of failed) report.append(div(css.failedItem, id))
    if (this.failure !== undefined) report.append(div(css.failedItem, this.failure))
    this.card.replaceChildren(this.wordmark, report)
  }

  /** Grow the rotating arc monotonically as loader entries activate. */
  private updateProgress(): void {
    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
    this.spinner.style.setProperty('--dsh-boot-arc', `${String(Math.round(72 + ratio * 216))}deg`)
  }
}
