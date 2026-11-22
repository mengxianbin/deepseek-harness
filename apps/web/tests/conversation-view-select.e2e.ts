// Browser behavior for the conversation view dropdown: the trigger names the
// current View, the menu lists every registered View with the current one
// marked, and choosing a row switches the view behind the header. (The retired
// tab strip's press-target geometry died with the strip.)
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot, selectConversationView, viewSelectTrigger } from './support.ts'

const FIXTURE = createChatScrollFixture({
  markerPrefix: 'VIEW_SELECT',
  title: 'VIEW_SELECT short session',
  turns: 4,
})
const SEED_ID = 'conversation-view-select-web-e2e'

async function openSeededSession(page: Page): Promise<void> {
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  await page.getByRole('textbox', { name: 'Search session names', exact: true }).fill(FIXTURE.markers.user(1))
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  const deadline = Date.now() + 60_000
  while (await results.count() !== 1) {
    if (Date.now() > deadline) throw new Error('seeded session never appeared in the sidebar search results')
    await page.waitForTimeout(200)
  }
  await results.click()
}

describe('web e2e: conversation view dropdown', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, FIXTURE.log, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 900)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openSeededSession(page)
    await page.getByText(FIXTURE.markers.assistant(FIXTURE.turns), { exact: false }).last()
      .waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('names the trigger after the current View and marks it in the menu', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-conversation-view-select-trigger'))
    const trigger = viewSelectTrigger(page)
    await trigger.waitFor({ timeout: 30_000 })
    expect(await trigger.textContent()).toBe('Chat')
    expect(await trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    await trigger.click()
    const menu = page.getByRole('menu')
    await menu.waitFor()
    expect(await trigger.getAttribute('aria-expanded')).toBe('true')
    expect(await menu.getByRole('menuitem', { name: 'Chat', exact: true }).getAttribute('aria-current'))
      .toBe('page')
    expect(await menu.getByRole('menuitem', { name: 'Trajectory', exact: true }).getAttribute('aria-current'))
      .toBeNull()
    await page.keyboard.press('Escape')
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    expect(tripwire.pageErrors).toEqual([])
  })

  it('switches Views through the menu and follows the current one', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-conversation-view-select-switch'))
    await selectConversationView(page, 'Trajectory')
    await page.getByLabel('Trajectory timeline').waitFor({ timeout: 30_000 })
    // The trigger names the new current View.
    expect(await viewSelectTrigger(page).textContent()).toBe('Trajectory')
    // The reopened menu marks it, not Chat.
    await viewSelectTrigger(page).click()
    const menu = page.getByRole('menu')
    await menu.waitFor()
    expect(await menu.getByRole('menuitem', { name: 'Trajectory', exact: true }).getAttribute('aria-current'))
      .toBe('page')
    expect(await menu.getByRole('menuitem', { name: 'Chat', exact: true }).getAttribute('aria-current'))
      .toBeNull()
    await page.keyboard.press('Escape')
    // Back to Chat: the chat scroller is laid out again.
    await selectConversationView(page, 'Chat')
    await page.locator('[data-conversation-scroll] [data-chat-anchor-key]:visible').first()
      .waitFor({ timeout: 30_000 })
    expect(await viewSelectTrigger(page).textContent()).toBe('Chat')
    expect(tripwire.pageErrors).toEqual([])
  })
})
