/** Default-loaded entry controls activate through the real Web profile and Loader. */
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold, type WebConsoleTripwire } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

describe('default navigation entry customization', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let tripwire: WebConsoleTripwire

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('keeps panels reachable through More and offers only browsing and creation after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'entry-customization'))
    // FORK(rail-more-sync-1030): no navigation landmark renders in either
    // state — panels live in the ⋯ menu (wide foot anchor / rail top anchor).
    const anchor = page.locator('[class*="panelMoreSlot"]')
    await anchor.waitFor({ state: 'attached' })
    const more = anchor.getByRole('button', { name: 'More', exact: true })
    const openPanel = async (label: string): Promise<void> => {
      await more.click()
      await page.getByRole('menuitem', { name: label, exact: true }).click()
    }
    await openPanel('Automation tasks')
    await page.getByRole('heading', { name: 'Automation tasks', exact: true }).waitFor()
    for (const reload of [false, true]) {
      if (reload) {
        await page.reload({ waitUntil: 'load' })
        await anchor.waitFor({ state: 'attached' })
        await openPanel('Automation tasks')
        await page.getByRole('heading', { name: 'Automation tasks', exact: true }).waitFor()
      }
      await more.click()
      const menu = page.getByRole('menu')
      await menu.getByRole('menuitem', { name: 'Browse other plugins', exact: true }).waitFor()
      expect(await menu.getByRole('separator').count()).toBe(0)
      // The menu keeps full reachability: MiMo sign-in and New Session lead,
      // then the panel rows, then the browsing/creation actions.
      const items = await menu.getByRole('menuitem').allTextContents()
      expect(items.slice(-2)).toEqual(['Browse other plugins', 'Create your plugin'])
      expect(items).toContain('Automation tasks')
      await menu.getByRole('menuitem', { name: 'Browse other plugins', exact: true }).click()
      await menu.waitFor({ state: 'detached' })
      await openPanel('Automation tasks')
      await page.getByRole('heading', { name: 'Automation tasks', exact: true }).waitFor()
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
