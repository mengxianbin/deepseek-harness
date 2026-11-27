/** Browser geometry for sidebar controls, text clearance, and drag previews. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import {
  compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const GEOMETRY_EXPECTED = fileURLToPath(new URL('./expected/sidebar-alignment/geometry.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const ACTION_TARGET_SIZE = 24
const ACTION_LAYOUT_SIZE = 16
const ACTION_CENTER_SPACING = 28
const ACTION_TRAILING_INSET = 7
const SEARCH_HEIGHT = 32
const SEARCH_TRANSITION_MS = 180
/** Collapsed search slot: a 28px icon button at the row's left edge. */
const COLLAPSED_SEARCH_WIDTH = 28
/**
 * Seat of each header control from the row's content-box left edge, in px.
 * The 工作区 / 会话 title label is gone (2026-11-26), so the search leads at 0
 * and the two cluster buttons follow at search(28) + gap(4) and then +32.
 */
const HEADER_CONTROL_LEFT_OFFSETS = { search: 0, view: 32, add: 64 }

/**
 * Measure painted glyphs and pointer targets independently of the row's layout cells.
 * @param row - visible, hovered Workspace or Session row.
 * @returns row bounds, action geometry, and browser hit-test results.
 */
async function measureRowActions(row: Locator) {
  return row.evaluate((element) => {
    const rowRect = element.getBoundingClientRect()
    const title = element.querySelector<HTMLElement>('[class*="title"]')
    if (title === null) throw new Error('row title not in the DOM')
    const buttons = [...element.querySelectorAll<HTMLButtonElement>('button')]
    return {
      height: rowRect.height,
      overflows: element.scrollWidth > element.clientWidth,
      titleRight: title.getBoundingClientRect().right,
      actions: buttons.map((button) => {
        const rect = button.getBoundingClientRect()
        const glyph = button.querySelector('svg')
        if (glyph === null) throw new Error('row action glyph not in the DOM')
        const glyphRect = glyph.getBoundingClientRect()
        const style = getComputedStyle(button)
        const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        // Side samples cover the outer target; corner samples stay inside the rounded border.
        const points = [
          { x: center.x - 11.5, y: center.y },
          { x: center.x + 11.5, y: center.y },
          { x: center.x, y: center.y - 11.5 },
          { x: center.x, y: center.y + 11.5 },
          { x: center.x - 9.5, y: center.y - 9.5 },
          { x: center.x + 9.5, y: center.y - 9.5 },
          { x: center.x - 9.5, y: center.y + 9.5 },
          { x: center.x + 9.5, y: center.y + 9.5 },
        ]
        const hits = (x: number, y: number): boolean => {
          const target = document.elementFromPoint(x, y)
          return target !== null && button.contains(target)
        }
        return {
          label: button.getAttribute('aria-label'),
          width: rect.width,
          height: rect.height,
          layoutWidth: rect.width + Number.parseFloat(style.marginLeft) + Number.parseFloat(style.marginRight),
          layoutHeight: rect.height + Number.parseFloat(style.marginTop) + Number.parseFloat(style.marginBottom),
          margins: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft],
          pseudoContent: getComputedStyle(button, '::after').content,
          center,
          rowCenterOffset: center.y - (rowRect.y + rowRect.height / 2),
          trailingInset: rowRect.right - rect.right,
          glyphLeft: glyphRect.left,
          glyphRight: glyphRect.right,
          glyphWidth: glyphRect.width,
          glyphHeight: glyphRect.height,
          glyphCenterOffset: {
            x: glyphRect.x + glyphRect.width / 2 - center.x,
            y: glyphRect.y + glyphRect.height / 2 - center.y,
          },
          insideRow: center.x - 12 >= rowRect.left && center.x + 12 <= rowRect.right
            && center.y - 12 >= rowRect.top && center.y + 12 <= rowRect.bottom,
          points,
          edgeHits: points.map(({ x, y }) => hits(x, y)),
          // Clear Chromium's boundary rounding while still rejecting an oversized 28px target.
          outsideHits: [
            hits(center.x - 13.5, center.y), hits(center.x + 13.5, center.y),
            hits(center.x, center.y - 13.5), hits(center.x, center.y + 13.5),
          ],
        }
      }),
    }
  })
}

describe('web e2e: sidebar search alignment and row action targets', () => {
  const workspaceTitle = 'Sidebar geometry workspace'
  const sessionTitle = 'Sidebar geometry session'
  const archivedTitle = 'Archived geometry session with a long title that fills its sidebar row'
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, workspaceTitle)
    const id = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'sidebar-action-geometry')
    await workspace.attachSession(id)
    await scaffold.ctx.sessionController.rename({ sessionId: id, title: sessionTitle })
    const archivedId = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'sidebar-search-geometry')
    await workspace.attachSession(archivedId)
    await scaffold.ctx.sessionController.rename({ sessionId: archivedId, title: archivedTitle })
    await scaffold.ctx.workspaceRegistry.archiveSession(archivedId)
    browser = await chromium.launch()
  })

  beforeEach(async () => {
    page = await newEnglishPage(browser, 800)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const workspace = page.locator('[data-row-key^="workspace:"]').filter({ hasText: workspaceTitle })
    await workspace.waitFor({ timeout: 30_000 })
    await expect.poll(async () => {
      if (await workspace.getAttribute('aria-expanded') !== 'true') {
        await workspace.getByText(workspaceTitle, { exact: true }).click()
      }
      return workspace.getAttribute('aria-expanded')
    }, { timeout: 10_000 }).toBe('true')
    await page.locator('[data-row-key="session:sidebar-action-geometry"]').waitFor()
  })

  afterEach(async () => {
    await page?.close()
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('left-aligns the header controls and grows the expanded search from the row start (2026-11-26)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-search-alignment'))
    const header = page.locator('[class*="sectionHeader"]')
      .filter({ has: page.getByRole('button', { name: 'Search sessions', exact: true }) })
    const searchButton = page.getByRole('button', { name: 'Search sessions', exact: true })
    const input = page.getByPlaceholder('Search session names', { exact: true })
    const search = input.locator('..')
    // The row's own content box is the reference: the 工作区 / 会话 title label
    // was removed (2026-11-26), so the old New session capsule it used to
    // measure against no longer exists in the wide non-darwin sidebar.
    const contentBox = async () => {
      const box = await header.boundingBox()
      if (box === null) throw new Error('section header has no layout box')
      const insets = await header.evaluate((element) => {
        const style = getComputedStyle(element)
        return { left: Number.parseFloat(style.paddingLeft), right: Number.parseFloat(style.paddingRight) }
      })
      return { left: box.x + insets.left, right: box.x + box.width - insets.right }
    }
    const offsets = async () => {
      const content = await contentBox()
      const controls = [
        searchButton,
        page.getByRole('button', { name: 'View options', exact: true }),
        page.getByRole('button', { name: 'Add workspace', exact: true }),
      ]
      const boxes = await Promise.all(controls.map(control => control.boundingBox()))
      return boxes.map(box => (box === null ? null : Math.round(box.x - content.left)))
    }
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
      // 0 / 32 / 64: the search leads the row, then the two cluster buttons at
      // a 4px gap — nothing stands before them any more, and the 安康位 shield
      // and alert inbox follow the cluster instead of floating at the right end.
      await expect.poll(offsets).toEqual(Object.values(HEADER_CONTROL_LEFT_OFFSETS))
      expect(await page.locator('[class*="sectionHeader"] [class*="sectionLabel"]').count()).toBe(0)
      await searchButton.click()
      await expect.poll(() => searchButton.getAttribute('aria-expanded')).toBe('true')
      await expect.poll(async () => {
        const content = await contentBox()
        const box = await search.boundingBox()
        if (box === null) throw new Error('search has no layout box')
        return {
          height: box.height,
          leftOffset: Math.round(box.x - content.left),
          grew: box.width > COLLAPSED_SEARCH_WIDTH,
        }
      }, { timeout: 10_000 }).toEqual({ height: SEARCH_HEIGHT, leftOffset: 0, grew: true })
      expect(await input.evaluate(element => element === document.activeElement)).toBe(true)
      await input.press('Escape')
      await expect.poll(() => searchButton.getAttribute('aria-expanded')).toBe('false')
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it.each(['Search sessions', 'View options', 'Add workspace'])('keeps the %s tooltip visible across its full bounds', async (name) => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-toolbar-tooltip'))
    const trigger = page.getByRole('button', { name, exact: true })
    await trigger.hover()
    const tooltip = page.getByRole('tooltip')
    await tooltip.waitFor({ state: 'visible', timeout: 10_000 })
    const bounds = await tooltip.evaluate((element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      const sidebar = document.querySelector('[class*="sidebarCol"]')!.getBoundingClientRect()
      const originalStyle = element.getAttribute('style')
      try {
        // Tooltips ignore pointer input; enabling it only for this read exposes ancestor clipping.
        element.style.pointerEvents = 'auto'
        const points = [
          [rect.left + 2, rect.top + rect.height / 2],
          [rect.right - 2, rect.top + rect.height / 2],
          [rect.left + rect.width / 2, rect.top + 2],
          [rect.left + rect.width / 2, rect.bottom - 2],
        ]
        return {
          outsideSidebar: rect.right > sidebar.right,
          hits: points.map(([x, y]) => {
            const hit = document.elementFromPoint(x!, y!)
            return hit !== null && element.contains(hit)
          }),
        }
      } finally {
        if (originalStyle === null) element.removeAttribute('style')
        else element.setAttribute('style', originalStyle)
      }
    })
    if (name === 'Add workspace') expect(bounds.outsideSidebar).toBe(true)
    expect(bounds.hits).toEqual([true, true, true, true])
    await page.mouse.move(1000, 400)
    await tooltip.waitFor({ state: 'detached' })
    expect(tripwire.pageErrors).toEqual([])
  })

  it('interpolates header spacing with the search expansion and collapse', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-search-transition'))
    const header = page.locator('[class*="sectionHeader"]').filter({ has: page.getByRole('button', { name: 'Search sessions', exact: true }) })
    for (const expand of [true, false]) {
      const samples = await header.evaluate(async (element, { expand, duration }) => {
        const button = element.querySelector<HTMLButtonElement>('button[aria-label="Search sessions"]')
        const input = element.querySelector<HTMLInputElement>('input')
        if (button === null || input === null) throw new Error('Search controls are missing')
        // Pause transitions at their first frame, before scheduler delays can consume their duration.
        const pause = (event: Event): void => {
          if (event.target instanceof Element) {
            for (const animation of event.target.getAnimations()) animation.pause()
          }
        }
        element.addEventListener('transitionrun', pause, true)
        try {
          await new Promise<void>((resolve) => {
            element.addEventListener('transitionrun', () => { resolve() }, { once: true })
            if (expand) button.click()
            else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          })
          const animations = element.getAnimations({ subtree: true })
          const headerTransitions = element.getAnimations().map(animation => ({
            property: animation instanceof CSSTransition ? animation.transitionProperty : '',
            duration: animation.effect?.getTiming().duration,
          }))
          const frames = [0, 0.25, 0.5, 0.75, 1].map((progress) => {
            for (const animation of animations) { animation.pause(); animation.currentTime = duration * progress }
            const style = getComputedStyle(element)
            return {
              marginRight: Number.parseFloat(style.marginRight),
              paddingLeft: Number.parseFloat(style.paddingLeft),
              paddingRight: Number.parseFloat(style.paddingRight),
              gap: Number.parseFloat(style.columnGap),
              width: element.getBoundingClientRect().width,
            }
          })
          for (const animation of animations) animation.finish()
          return { headerTransitions, frames }
        } finally {
          element.removeEventListener('transitionrun', pause, true)
        }
      }, { expand, duration: SEARCH_TRANSITION_MS })
      for (const property of ['margin-right', 'padding-left', 'padding-right', 'column-gap']) {
        expect(samples.headerTransitions).toContainEqual({ property, duration: SEARCH_TRANSITION_MS })
      }
      const first = samples.frames[0]!
      const last = samples.frames.at(-1)!
      expect(first).toMatchObject(expand
        ? { marginRight: -4, paddingLeft: 8, paddingRight: 1, gap: 4 }
        : { marginRight: 0, paddingLeft: 4, paddingRight: 4, gap: 0 })
      expect(last).toMatchObject(expand
        ? { marginRight: 0, paddingLeft: 4, paddingRight: 4, gap: 0 }
        : { marginRight: -4, paddingLeft: 8, paddingRight: 1, gap: 4 })
      for (const frame of samples.frames.slice(1, -1)) {
        for (const key of ['marginRight', 'paddingLeft', 'paddingRight', 'gap', 'width'] as const) {
          expect(frame[key]).toBeGreaterThan(Math.min(first[key], last[key]))
          expect(frame[key]).toBeLessThan(Math.max(first[key], last[key]))
        }
        const progress = (frame.marginRight - first.marginRight) / (last.marginRight - first.marginRight)
        for (const key of ['paddingLeft', 'paddingRight', 'gap'] as const) {
          expect((frame[key] - first[key]) / (last[key] - first[key])).toBeCloseTo(progress, 2)
        }
      }
    }
  })

  it.each([
    { usedSearch: false, entry: 'toggle' },
    { usedSearch: true, entry: 'toggle' },
    { usedSearch: false, entry: 'search' },
    { usedSearch: true, entry: 'search' },
    { usedSearch: true, entry: 'toggle-with-query' },
  ] as const)('lands the header at its final rail-to-wide geometry ($entry, prior search: $usedSearch)', async ({ usedSearch, entry }) => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-sidebar-rail-${entry}-${String(usedSearch)}`))
    if (usedSearch) {
      await page.getByRole('button', { name: 'Search sessions', exact: true }).click()
      const input = page.getByPlaceholder('Search session names', { exact: true })
      if (entry === 'toggle-with-query') await input.fill(sessionTitle)
      else await input.press('Escape')
    }
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    // Live collapse signal: the sidebar toggle flips its accessible name to
    // "Open sidebar" once the rail lands (SidebarRoot `toggleLabel`). The old
    // probe polled `data-collapsed` on the account seat — that attribute left
    // with the account More row when the settings-launcher fork replaced it
    // (AccountMenu.module.css FORK note: `[data-collapsed]`, `[data-signed-out]`
    // "left with the menu"), so the poll could never resolve.
    await expect.poll(() => page.getByRole('button', { name: 'Open sidebar', exact: true }).count()).toBe(1)
    const add = page.getByRole('button', { name: 'Add workspace', exact: true })
    const samples = await add.evaluate(async (button, entry) => {
      const header = button.closest<HTMLElement>('[class*="sectionHeader"]')
      const root = header?.parentElement
      if (header === null || root === null || root === undefined) throw new Error('Workspace header is missing')
      const railClass = root.className
      const measure = () => {
        const origin = root.getBoundingClientRect()
        const bounds = header.getBoundingClientRect()
        const addBounds = button.getBoundingClientRect()
        const style = getComputedStyle(header)
        return {
          left: bounds.left - origin.left, right: bounds.right - origin.left,
          top: bounds.top - origin.top, height: bounds.height,
          // Search hides this cluster with its own animation; only compare the visible add control.
          add: entry === 'toggle'
            ? { left: addBounds.left - origin.left, right: addBounds.right - origin.left }
            : null,
          marginRight: Number.parseFloat(style.marginRight),
          paddingLeft: Number.parseFloat(style.paddingLeft), paddingRight: Number.parseFloat(style.paddingRight),
          gap: Number.parseFloat(style.columnGap),
          transitionDuration: style.transitionDuration,
          searchExpanded: header.querySelector('button[aria-label="Search sessions"]')?.getAttribute('aria-expanded'),
        }
      }
      // Test-defect fix, expectations unchanged: both waits below had no
      // ceiling, so a missed class mutation or a never-settling animation hung
      // the whole spec until the 180s test timeout without naming the step.
      // Each leg now rejects with the step it was waiting on — a passing run
      // behaves exactly as before.
      const first = await new Promise<ReturnType<typeof measure>>((resolve, reject) => {
        // Observe the first rendered wide frame after the rail gesture's React updates.
        const ceiling = setTimeout(() => {
          observer.disconnect()
          // Name the capture as well as the outcome: without `railClass` a
          // "never changed" report cannot tell "captured too early (still
          // wide)" from "watching an element the rail class never lands on".
          const chain: string[] = []
          for (let node: Element | null = root; node !== null && chain.length < 5; node = node.parentElement) {
            chain.push(`${node.tagName.toLowerCase()}:${String(node.className)}`)
          }
          reject(new Error(`rail expansion never changed the root class (railClass="${railClass}" now="${String(root.className)}" chain=[${chain.join(' > ')}])`))
        }, 20_000)
        const observer = new MutationObserver(() => {
          if (root.className === railClass) return
          observer.disconnect()
          clearTimeout(ceiling)
          requestAnimationFrame(() => {
            // A throw inside rAF would otherwise vanish as an unhandled error
            // and leave this promise pending forever.
            try { resolve(measure()) } catch (error) { reject(error) }
          })
        })
        observer.observe(root, { attributes: true, attributeFilter: ['class'] })
        const trigger = entry === 'search'
          ? root.querySelector<HTMLButtonElement>('button[aria-label="Search sessions"]')
          : document.querySelector<HTMLButtonElement>('button[aria-label="Open sidebar"]')
        if (trigger === null) { observer.disconnect(); clearTimeout(ceiling); reject(new Error('Rail expansion trigger is missing')); return }
        trigger.click()
      })
      const headerTransitions = header.getAnimations()
        .filter(animation => animation instanceof CSSTransition)
        .map(animation => animation.transitionProperty)
      await Promise.race([
        Promise.all(root.getAnimations({ subtree: true })
          .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
          .map(animation => animation.finished.then(() => undefined, () => undefined))),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('sidebar animations never settled')), 20_000)
        }),
      ])
      return {
        first, last: measure(), headerTransitions,
        sameHeader: root.querySelector('[class*="sectionHeader"]') === header,
        sameAdd: root.querySelector('button[aria-label="Add workspace"]') === button,
      }
    }, entry)
    expect(samples.headerTransitions).toEqual([])
    expect(samples.first.transitionDuration).toBe('0s')
    expect(samples.first).toEqual(samples.last)
    expect(samples.first).toMatchObject(entry !== 'toggle'
      ? { marginRight: 0, paddingLeft: 4, paddingRight: 4, gap: 0, searchExpanded: 'true' }
      : { marginRight: -4, paddingLeft: 8, paddingRight: 1, gap: 4, searchExpanded: 'false' })
    expect(samples.sameHeader).toBe(true)
    expect(samples.sameAdd).toBe(true)
    if (entry === 'search') {
      await expect.poll(() => page.getByPlaceholder('Search session names', { exact: true })
        .evaluate(element => element === document.activeElement)).toBe(true)
    }
    expect(tripwire.pageErrors).toEqual([])
  })

  it('keeps a clipped search title clear of the unarchive target', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-search-title-clearance'))
    await page.getByRole('button', { name: 'View options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'All conversations (show archived)', exact: true }).click()
    await expect.poll(() => page.locator('[data-row-key="session:sidebar-search-geometry"]').textContent()).toContain(archivedTitle)
    await page.getByRole('button', { name: 'Search sessions', exact: true }).click()
    await page.getByPlaceholder('Search session names', { exact: true }).fill('Archived geometry')
    const row = page.getByRole('treeitem').filter({ hasText: archivedTitle })
    await row.hover()
    await row.getByRole('button', { name: 'Unarchive session', exact: true }).waitFor()
    const geometry = await row.evaluate((element) => {
      const title = element.querySelector<HTMLElement>('[class*="searchResultTitle"]')
      const button = element.querySelector('button')
      if (title === null || button === null) throw new Error('Search result title or action is missing')
      const titleRect = title.getBoundingClientRect()
      const buttonRect = button.getBoundingClientRect()
      const titleEdge = document.elementFromPoint(titleRect.right - 0.5, titleRect.top + titleRect.height / 2)
      return {
        clipped: title.scrollWidth > title.clientWidth,
        labelGap: Number.parseFloat(getComputedStyle(title).marginRight),
        targetWidth: buttonRect.width,
        clearance: buttonRect.left - titleRect.right,
        titleEdgeHitsTitle: titleEdge !== null && title.contains(titleEdge),
        overflows: element.scrollWidth > element.clientWidth,
      }
    })
    expect(geometry).toEqual({
      clipped: true, labelGap: 6, targetWidth: ACTION_TARGET_SIZE, clearance: 2, titleEdgeHitsTitle: true, overflows: false,
    })
    await compareOrRefreshGolden(GEOMETRY_EXPECTED, [
      '# Sidebar alignment', '',
      `- search title is clipped: ${String(geometry.clipped)}`,
      `- unarchive hit target width: ${geometry.targetWidth}px`,
      `- clipped search title label gap: ${geometry.labelGap}px`,
      `- clipped search title clearance from unarchive hit target: ${geometry.clearance}px`,
      `- clipped search title edge hit-tests to title: ${String(geometry.titleEdgeHitsTitle)}`,
    ].join('\n'), MODE)
    expect(tripwire.pageErrors).toEqual([])
  })

  it('spans the first root workspace with its insertion marker during a native drag', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-first-workspace-drop'))
    const directory = await mkdtemp(join(tmpdir(), 'dsh-sidebar-drag-'))
    try {
      const extra = await scaffold.ctx.workspaceRegistry.create(directory, 'Sidebar drag workspace')
      try {
        const rows = page.locator('[role="tree"][aria-label="Sessions"] [data-row-key^="workspace:"]')
        await expect.poll(() => rows.count()).toBe(2)
        const before = await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-row-key')))
        await rows.last().hover()
        const source = await rows.last().boundingBox()
        const target = await rows.first().boundingBox()
        if (source === null || target === null) throw new Error('Workspace drag rows have no layout boxes')
        await page.mouse.move(source.x + 30, source.y + source.height / 2)
        await page.mouse.down()
        try {
          await page.mouse.move(source.x + 40, source.y + source.height / 2, { steps: 3 })
          await page.mouse.move(target.x + 30, target.y + 2, { steps: 5 })
          await page.mouse.move(target.x + 31, target.y + 2)
          const marker = page.locator('[class*="listTopDropIndicator"]')
          await marker.waitFor({ state: 'attached', timeout: 10_000 })
          const geometry = await marker.evaluate((element) => {
            const rect = element.getBoundingClientRect()
            const tree = element.parentElement!.querySelector('[role="tree"]')!.getBoundingClientRect()
            const first = element.parentElement!.querySelector('[data-row-key^="workspace:"]')!.getBoundingClientRect()
            return {
              width: rect.width, height: rect.height,
              treeWidth: tree.width, leftInset: rect.left - first.left,
              rightInset: first.right - rect.right, topOffset: rect.top - first.top,
            }
          })
          expect(geometry.width).toBeGreaterThan(0)
          expect(geometry.width).toBe(geometry.treeWidth)
          expect(geometry).toMatchObject({ height: 12, leftInset: 0, rightInset: 0, topOffset: -8 })
        } finally {
          await page.mouse.up()
        }
        await expect.poll(() => rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-row-key'))))
          .toEqual(before.toReversed())
      } finally {
        await scaffold.ctx.workspaceRegistry.delete(extra.id)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it.each(['session', 'workspace'] as const)('retains %s row spacing in the native drag preview', async (kind) => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-sidebar-${kind}-drag-preview`))
    const row = kind === 'session'
      ? page.locator('[data-row-key="session:sidebar-action-geometry"]')
      : page.locator('[data-row-key^="workspace:"]').filter({ hasText: workspaceTitle })
    await row.evaluate((element) => {
      element.parentElement!.style.setProperty('--dsh-workspace-indent', '24px')
      element.parentElement!.style.setProperty('--unrelated-preview-variable', '17px')
    })
    const box = await row.boundingBox()
    if (box === null) throw new Error('Drag source has no layout box')
    await page.mouse.move(box.x + 40, box.y + box.height / 2)
    await page.mouse.down()
    try {
      await page.mouse.move(box.x + 45, box.y + box.height + 10, { steps: 8 })
      const preview = page.locator('body > [inert][aria-hidden="true"] > [role="treeitem"]')
      await preview.waitFor({ state: 'attached' })
      const spacing = (target: Locator) => target.evaluate((element) => {
        const style = getComputedStyle(element)
        const slot = [...element.querySelectorAll('[class*="slot"]')].find(candidate => candidate.getBoundingClientRect().width > 0)
        if (slot === undefined) throw new Error('Row leading slot is missing')
        return {
          paddingStart: style.paddingInlineStart, paddingEnd: style.paddingInlineEnd,
          borderStart: style.borderInlineStartWidth, borderEnd: style.borderInlineEndWidth,
          gap: style.columnGap,
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
          slotOffset: slot.getBoundingClientRect().left - element.getBoundingClientRect().left,
        }
      })
      expect(await spacing(preview)).toEqual(await spacing(row))
      expect(await preview.evaluate(element => [...element.parentElement!.style].filter(name => name.startsWith('--')).sort()))
        .toEqual(['--dsh-sidebar-label-gap', '--dsh-sidebar-paint-inset', '--dsh-sidebar-row-padding'])
      const titleOffset = (target: Locator) => target.evaluate((element) => {
        const title = element.querySelector<HTMLElement>('[class*="title"]')
        if (title === null) throw new Error('Row title is missing')
        return title.getBoundingClientRect().left - element.getBoundingClientRect().left
      })
      expect(await titleOffset(preview)).toBe(await titleOffset(row))
    } finally {
      await page.keyboard.press('Escape')
      await page.mouse.up()
    }
    await page.locator('body > [inert][aria-hidden="true"] > [role="treeitem"]').waitFor({ state: 'detached' })
    expect(tripwire.pageErrors).toEqual([])
  })

  it.each([false, true])('keeps the footer settings seat geometry in wide and rail layouts (signed in: %s)', async (signedIn) => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-sidebar-account-${String(signedIn)}`))
    const account = scaffold.ctx.deepseekAccount
    const state: AccountView = {
      status: 'credential-stored', attempt: null,
      links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
    }
    // Only Platform identity is synthetic; the account provider's RPC and client renderer remain composed.
    const mocks = signedIn ? [
      vi.spyOn(account, 'getState').mockResolvedValue(state),
      vi.spyOn(account, 'getProfile').mockResolvedValue({
        status: 'ready', value: { id: null, name: 'Sidebar account', contact: null, avatarUrl: null },
      }),
      vi.spyOn(account, 'getBalance').mockResolvedValue({ status: 'ready', value: [], bonusWallets: [] }),
      vi.spyOn(account, 'watch').mockImplementation(async function* (signal) {
        yield { type: 'snapshot', state }
        if (signal.aborted) return
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      }),
    ] : []
    try {
      if (signedIn) await page.reload({ waitUntil: 'load' })
      // Ruling A (ask t2-account-repair, 2026-11-26): the account More row is
      // gone — the settings-launcher fork replaced the footer seat with the
      // settings trigger (AccountMenu.module.css FORK note: `.anchor`, `.avatar`,
      // `.label`, `[data-collapsed]`, `[data-signed-out]` "left with the menu";
      // SidebarRoot.tsx round 3 rules the wide foot as Settings → ⋯). So the
      // subject is now that trigger (SettingsRoot.tsx `aria-label={t('trigger')}`
      // = "Settings") and the reference is its own `.triggerRow` — the direct
      // layout container, CSS-fixed in BOTH states. `footArea` was dropped as a
      // reference because its wide right edge also carries the ⋯ menu
      // (content-sized, not a contract), and the `newSession` capsule never
      // renders in the wide non-darwin sidebar at all.
      const seat = page.getByRole('button', { name: 'Settings', exact: true })
      await expect.poll(() => seat.count()).toBe(1)
      const measure = () => seat.evaluate((element) => {
        const button = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        const row = element.closest<HTMLElement>('[class*="triggerRow"]')
        if (row === null) throw new Error('Settings trigger row is missing')
        const reference = row.getBoundingClientRect()
        return {
          // Contract-only: every retained field is derived from CSS, never from
          // an observed run — `.trigger { height:42px; margin:0; flex:1;
          // border-inline:3px }` over `--dsh-sidebar-paint-inset: 3px`.
          // DROPPED as content-sized, not contractual: `width` (flex:1 over an
          // auto-width container) and the right-edge fields, because the seat
          // shares its row with a trailing control (~85.6px measured) — those
          // measure the sibling, and pinning them would freeze observed content.
          height: button.height,
          leftOffset: button.left - reference.left,
          paintedLeftOffset: button.left + Number.parseFloat(style.borderLeftWidth) - reference.left,
        }
      })
      const wide = await measure()
      // Signed-out sits flush at the row start (0 / +3px painted border).
      // Signed-in shifts right by exactly 2px: `AccountMenu.module.css:4`
      // `.root[data-inset='true'] { margin-inline: 2px }` with
      // `data-inset={signedIn && wide}` (AccountMenu.tsx:54).
      expect(wide).toEqual(
        signedIn
          ? { height: 42, leftOffset: 2, paintedLeftOffset: 5 }
          : { height: 42, leftOffset: 0, paintedLeftOffset: 3 },
      )
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      // Live collapse signal: the toggle flips its accessible name to
      // "Open sidebar" once the rail lands (SidebarRoot `toggleLabel`). The old
      // probe polled `data-collapsed` on the account seat, which left with it.
      await expect.poll(() => page.getByRole('button', { name: 'Open sidebar', exact: true }).count()).toBe(1)
      await expect.poll(async () => {
        const rect = await seat.boundingBox()
        return rect === null ? null : { width: rect.width, height: rect.height }
      }).toEqual({ width: 36, height: 36 })
      const rail = await measure()
      // Rail: `.trigger.rail { 36x36; border-inline: 0 }` centred by
      // `.triggerRow.railRow { width:36px; align-items:center }`, and the
      // `data-inset` margin requires `wide`, so sign-in cannot shift this state.
      expect(rail).toEqual({ height: 36, leftOffset: 0, paintedLeftOffset: 0 })
      await compareOrRefreshGolden(
        fileURLToPath(new URL(`./expected/sidebar-alignment/account-${signedIn ? 'signed-in' : 'signed-out'}.expected.md`, import.meta.url)),
        JSON.stringify({ wide, rail }, null, 2), MODE,
      )
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page.close()
      mocks.forEach((mock) => { mock.mockRestore() })
    }
  })

  it.each(['session', 'workspace'] as const)('keeps %s action glyphs in 16px layout space with 24px buttons', async (kind) => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-sidebar-${kind}-action-targets`))
    const row = kind === 'session'
      ? page.locator('[data-row-key="session:sidebar-action-geometry"]')
      : page.locator('[data-row-key^="workspace:"]').filter({ hasText: workspaceTitle })
    const restingBox = await row.boundingBox()
    await row.hover()
    const labels = kind === 'session'
      // FORK session-relay-1106: relay leads the strip before archive and pin.
      ? [`Session actions for ${sessionTitle}`, 'Relay', 'Archive session', 'Pin session'] as const
      : [`Workspace actions for ${workspaceTitle}`, `New session in ${workspaceTitle}`] as const
    await row.getByRole('button', { name: labels[0], exact: true }).waitFor()
    const metrics = await measureRowActions(row)
    expect(await row.boundingBox()).toEqual(restingBox)
    expect(metrics.height).toBe(32)
    expect(metrics.overflows).toBe(false)
    expect(metrics.actions.map(action => action.label)).toEqual(labels)
    for (const [index, action] of metrics.actions.entries()) {
      expect(action.width).toBe(ACTION_TARGET_SIZE)
      expect(action.height).toBe(ACTION_TARGET_SIZE)
      expect(action.layoutWidth).toBe(ACTION_LAYOUT_SIZE)
      expect(action.layoutHeight).toBe(ACTION_LAYOUT_SIZE)
      expect(action.margins).toEqual(['-4px', '-4px', '-4px', '-4px'])
      expect(action.pseudoContent).toBe('none')
      expect(action.rowCenterOffset).toBe(0)
      expect(action.glyphWidth).toBe(14)
      expect(action.glyphHeight).toBe(14)
      expect(action.glyphCenterOffset).toEqual({ x: 0, y: 0 })
      expect(action.insideRow).toBe(true)
      expect(action.edgeHits).toEqual(Array<boolean>(8).fill(true))
      expect(action.outsideHits).toEqual([false, false, false, false])
      const previous = metrics.actions[index - 1]
      if (previous !== undefined) {
        expect(action.center.x - previous.center.x).toBe(ACTION_CENTER_SPACING)
        expect(action.glyphLeft - previous.glyphRight).toBe(14)
        expect(previous.center.x + 12).toBeLessThan(action.center.x - 12)
      } else {
        expect(metrics.titleRight).toBeLessThanOrEqual(action.center.x - 12)
        if (kind === 'session') expect(action.glyphLeft - metrics.titleRight).toBe(14)
      }
    }
    expect(metrics.actions.at(-1)?.trailingInset).toBe(ACTION_TRAILING_INSET)

    if (kind === 'session') expect(await row.getAttribute('aria-selected')).toBe('false')
    const selectedRows = page.locator('[role="tree"][aria-label="Sessions"] [aria-selected="true"]')
    const selectedKeys = await selectedRows.evaluateAll(rows => rows.map(row => row.getAttribute('data-row-key')))
    const expanded = await row.getAttribute('aria-expanded')
    const menuButton = row.getByRole('button', { name: labels[0], exact: true })
    const menu = page.getByRole('menu')
    const menuAction = kind === 'session' ? 'Pin session' : 'Rename'
    const first = metrics.actions[0]
    if (first === undefined) throw new Error('row has no menu trigger')
    for (const point of first.points.slice(0, 4)) {
      // Edge clicks exercise the enlarged target rather than the glyph's center.
      await page.mouse.click(point.x, point.y)
      await menu.getByRole('menuitem', { name: menuAction, exact: true }).waitFor()
      expect(await selectedRows.evaluateAll(rows => rows.map(row => row.getAttribute('data-row-key')))).toEqual(selectedKeys)
      expect(await row.getAttribute('aria-expanded')).toBe(expanded)
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })
      await menuButton.hover()
    }
    // FORK session-relay-1106: relay leads the session strip, so the archive
    // tooltip anchor moved one seat over; the workspace tuple is unchanged.
    const tooltipAnchor = row.getByRole('button', { name: kind === 'session' ? 'Archive session' : labels[1], exact: true })
    const tooltip = page.getByRole('tooltip').filter({ hasText: kind === 'session' ? 'Archive' : 'New session' })
    await tooltipAnchor.hover()
    await tooltip.waitFor({ timeout: 10_000 })
    const anchorBox = await tooltipAnchor.boundingBox()
    const tooltipBox = await tooltip.boundingBox()
    if (anchorBox === null || tooltipBox === null) throw new Error('hover tooltip or its anchor has no layout box')
    expect(tooltipBox.y).toBe(anchorBox.y + anchorBox.height + 8)
    expect(tooltipBox.x + tooltipBox.width).toBe(anchorBox.x + anchorBox.width)
    await page.mouse.move(1000, 400)
    await tooltip.waitFor({ state: 'detached' })
    if (kind === 'session') {
      expect(await menuButton.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await tooltipAnchor.isVisible()).toBe(true)
    }
    await page.mouse.click(1000, 400)
    expect(await tooltipAnchor.isVisible()).toBe(false)
    expect(await page.getByRole('tooltip').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
