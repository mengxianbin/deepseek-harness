/** Context details stay inside the viewport with and without Chat's statistics contribution. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { fixtureUserPrompts, launchWebScaffold, selectedSessionFixture, watchConsole, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const NO_CHAT = fileURLToPath(new URL('./fixtures/context-meter-no-chat.patch.yml', import.meta.url))

describe.skipIf(webSnapshotMode() === 'record')('web e2e: context details placement', () => {
  it.each([true, false])('keeps details visible across viewport changes (Chat statistics: %s)', async (withStats) => {
    const fixture = await selectedSessionFixture(FIXTURE, false)
    const scaffold = await launchWebScaffold({
      replayFixture: fixture,
      compareReplaySession: false,
      paceMs: 5,
      ...withStats ? {} : { extraOverlayPath: NO_CHAT },
    })
    try {
      const browser = await chromium.launch()
      try {
        const page = await newEnglishPage(browser)
        const tripwire = watchConsole(page)
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await connectFreshWorkspace(page, scaffold.workspaceCwd)
        const card = page.locator('[data-composer-card]')
        expect(await card.evaluate(element =>
          element.parentElement!.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom,
        )).toBe(0)
        const prompts = fixtureUserPrompts(await readFile(fixture, 'utf8'))
        expect(prompts).toHaveLength(1)
        const settled = scaffold.whenTurnSettled()
        const input = page.locator('[data-composer-input]').first()
        await input.fill(prompts[0]!)
        await input.press('Shift+Enter')
        await settled
        const trigger = page.getByRole('button', { name: /% of context used$/ })
        await trigger.waitFor()
        expect(await trigger.textContent()).toMatch(/^\d+%$/)
        expect(await page.getByRole('button', { name: /tok · Cache hit/ }).count()).toBe(withStats ? 1 : 0)
        // The row is a seat-level sibling of the composer chain output now
        // (ask-dock-row-1122), so it is no longer the card's next sibling:
        // address it directly — exactly one row, inside the composer seat,
        // carrying both 4px bands (the card→row band above, the row→seat band
        // below) the bar's root used to own as padding-bottom.
        const dock = page.locator('[data-composer-dock]')
        expect(await dock.count()).toBe(1)
        expect(await dock.evaluate(element => element.closest('[data-composer-seat]') !== null)).toBe(true)
        expect(await dock.evaluate(element => getComputedStyle(element).paddingTop)).toBe('4px')
        expect(await dock.evaluate(element => getComputedStyle(element).paddingBottom)).toBe('4px')
        await trigger.click()
        const panel = page.getByRole('dialog', { name: 'of context used', exact: true })
        await panel.waitFor()
        for (const width of [390, 800, 1280]) {
          await page.setViewportSize({ width, height: 900 })
          await page.locator('[data-sidebar-collapsed="true"]').waitFor({
            state: width <= 800 ? 'attached' : 'detached',
          })
          await page.evaluate(async () => {
            await Promise.all(document.getAnimations()
              .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
              .map(animation => animation.finished.catch(() => undefined)))
          })
          await expect.poll(async () => {
            const rect = await panel.boundingBox()
            return rect !== null && rect.x >= 12 && rect.x + rect.width <= width - 12
              && rect.y >= 12 && rect.y + rect.height <= 888
          }).toBe(true)
        }
        await panel.getByText('System prompt', { exact: true }).click()
        expect(await panel.isVisible()).toBe(true)
        await page.keyboard.press('Escape')
        await panel.waitFor({ state: 'hidden' })
        await trigger.click()
        await panel.waitFor()
        await page.mouse.click(1260, 400)
        await panel.waitFor({ state: 'hidden' })
        expect(tripwire.pageErrors).toEqual([])
        expect(tripwire.warnings).toEqual([])
      } finally {
        await browser.close()
      }
    } finally {
      await scaffold.close()
    }
  })
})
