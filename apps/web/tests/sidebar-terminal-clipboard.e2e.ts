/**
 * Live wiring check for the sidebar terminal clipboard chords: the browser must own
 * Ctrl+V (paste lands in the shell input) and Ctrl+C (copies the selection), while a
 * selection-less Ctrl+C still reaches the shell as SIGINT. The patch's whole point is
 * the platform where xterm used to swallow the chords, so this runs on Windows
 * (cmd.exe) and POSIX (/bin/sh) alike.
 */
import { chromium, type Browser, type Page } from 'playwright'
import { afterEach, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

describe('sidebar terminal clipboard chords', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeEach(async () => {
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
    page = await context.newPage()
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('Workspace did not create a Session')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Open a terminal.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'Ready for terminal input.' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.getByText('Ready for terminal input.').waitFor()
  }, 180_000)

  afterEach(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('hands Ctrl+V/Ctrl+C to the browser and keeps selection-less Ctrl+C as SIGINT', async () => {
    onTestFailed(() => saveFailureShot(page, 'terminal-clipboard'))
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])

    // Open the sidebar terminal (cmd.exe on Windows, /bin/sh on POSIX).
    const expand = page.locator('[data-sidebar-right-expand]')
    if (await expand.isVisible()) await expand.click()
    const entry = page.locator('[data-sidebar-right-guide-entry="terminal"]')
    if (!await entry.isVisible()) await page.locator('[data-dockkit-add-tab]').click()
    await entry.getByRole('button', { name: /^New terminal/u }).click()
    const screen = page.locator('.xterm-rows:visible')
    const promptReady = process.platform === 'win32' ? />/u : /[$#]/u
    await expect.poll(async () => await screen.innerText(), { timeout: 30_000 }).toMatch(promptReady)

    const textarea = page.locator('.xterm-helper-textarea:visible')
    const showsOutputLine = async (text: string): Promise<boolean> => (await screen.innerText()).split('\n').some(row => row.trim() === text)
    // Rows wrap at the terminal width, so innerText can split pasted text across lines.
    const flatScreen = async (): Promise<string> => (await screen.innerText()).replace(/\n/gu, '')

    // 1) Ctrl+V: clipboard text must reach the shell input and execute.
    await textarea.click()
    await page.evaluate(() => navigator.clipboard.writeText('echo PASTE_OK_42'))
    await page.keyboard.press('Control+V')
    await expect.poll(async () => (await flatScreen()).includes('echo PASTE_OK_42'), { timeout: 10_000 }).toBe(true)
    await page.keyboard.press('Enter')
    await expect.poll(() => showsOutputLine('PASTE_OK_42'), { timeout: 10_000 }).toBe(true)

    // 2) Ctrl+C without a selection: still SIGINT — a foreground command must die.
    await page.keyboard.insertText(process.platform === 'win32' ? 'ping -t 127.0.0.1' : 'sleep 300')
    await page.keyboard.press('Enter')
    if (process.platform === 'win32') {
      await expect.poll(async () => (await screen.innerText()).includes('TTL='), { timeout: 15_000 }).toBe(true)
    } else {
      await page.waitForTimeout(700)
    }
    await page.keyboard.press('Control+C')
    await page.keyboard.insertText('echo AFTER_SIGINT')
    await page.keyboard.press('Enter')
    await expect.poll(() => showsOutputLine('AFTER_SIGINT'), { timeout: 10_000 }).toBe(true)

    // 3) Ctrl+C with a selection: copies it instead of interrupting.
    await page.keyboard.insertText('echo COPY_TARGET_9')
    await page.keyboard.press('Enter')
    await expect.poll(() => showsOutputLine('COPY_TARGET_9'), { timeout: 10_000 }).toBe(true)
    await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'))
    // xterm's screen overlay owns pointer events, so dblclick by coordinates instead of the text span.
    const target = await screen.getByText('COPY_TARGET_9', { exact: true }).first().boundingBox()
    if (target === null) throw new Error('COPY_TARGET_9 cell not found')
    await page.mouse.dblclick(target.x + target.width / 2, target.y + target.height / 2)
    await page.keyboard.press('Control+C')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 }).toContain('COPY_TARGET_9')
    expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain('SENTINEL')

    // 4) Ctrl+Shift+V keeps the status quo (the patch explicitly excludes shiftKey).
    //    Observed in Chromium/Windows: no default paste binding, so nothing lands in the
    //    shell — recorded rather than asserted because the effect is the browser's, not ours.
    await page.evaluate(() => navigator.clipboard.writeText('SHIFT_V_MARK_7'))
    await page.keyboard.press('Control+Shift+V')
    await page.waitForTimeout(800)
    console.log(`[ctrlv-verify] Ctrl+Shift+V observed: ${(await screen.innerText()).includes('SHIFT_V_MARK_7') ? 'pasted' : 'no-paste'}`)

    expect(tripwire.pageErrors).toEqual([])
  })
})
