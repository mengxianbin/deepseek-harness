// Real-composition acceptance for the DeepSeek account surface in a plain browser. The
// scaffold boots the shipped Web Loader tree, so the real account provider drives the
// credential-stored stream, profile/balance reads, and the shared avatar loader against
// a loopback Platform double. FORK dsh-local (settings-launcher, 2026-10-21): the sidebar
// account menu that started the browser sign-in is gone — this build has no explicit
// sign-in entry — so the scenario boots from a stored grant bound to the double's origin
// instead of driving the tab handoff, and it observes the account only through Settings
// (the sidebar carries no avatar either). The themed-tab handoff stays covered by the
// sign-in dialog unit suites.
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const OVERLAY_TEMPLATE = fileURLToPath(new URL('./fixtures/account-login/cordis.patch.yml', import.meta.url))
const MODE = webSnapshotMode()
const TOKEN = 'dsh_web_login_test'
const CODE = 'web-login-code'
const AVATAR_EXPECTED = fileURLToPath(new URL('./expected/account-login/avatar-retry.expected.md', import.meta.url))

/** Loopback Platform double: authorization handoff, code exchange, and the signed-in profile reads. */
async function mockPlatform() {
  const inits: Record<string, unknown>[] = []
  const pages: string[] = []
  let state: string | undefined
  let redirectUri: string | undefined
  let avatarRequests = 0
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const reply = (payload: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: payload } }))
    }
    if (url.pathname === '/dsh/authorize') {
      pages.push(url.href)
      // The user approves at once: Platform returns the browser to the Host callback.
      const callback = new URL(redirectUri ?? '/')
      callback.searchParams.set('code', CODE)
      callback.searchParams.set('state', state ?? '')
      res.writeHead(302, { location: callback.href }).end()
      return
    }
    if (url.pathname === '/dsh/authorized') {
      pages.push(url.href)
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Authorized</title>')
      return
    }
    if (req.method === 'POST' && url.pathname.startsWith('/auth-api/v0/dsh/')) {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        const payload = JSON.parse(body) as Record<string, unknown>
        if (url.pathname === '/auth-api/v0/dsh/auth_init') {
          inits.push(payload)
          state = String(payload.state)
          redirectUri = String(payload.redirect_uri)
          reply({ authorize_url: `${origin}/dsh/authorize?authorize_id=web`, authorize_id: 'web', expires_in: 300 })
          return
        }
        if (url.pathname === '/auth-api/v0/dsh/auth_exchange' && payload.code === CODE) {
          reply({ token: TOKEN, authorized_url: `${origin}/dsh/authorized` })
          return
        }
        res.writeHead(404).end()
      })
      return
    }
    if (url.pathname === '/avatar.svg') {
      avatarRequests++
      if (avatarRequests < 3) { res.writeHead(503, { 'cache-control': 'no-store' }).end(); return }
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' })
        .end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="blue"/></svg>')
      return
    }
    if (req.headers['x-dsh-auth-token'] !== TOKEN) { res.writeHead(401).end(); return }
    if (url.pathname === '/auth-api/v0/users/current') {
      // `email` is required by the provider's profile schema even when the account has none.
      reply({ id: 'web-user', email: '', id_profile: { name: 'Web User', picture: `${origin}/avatar.svg` } })
      return
    }
    if (url.pathname === '/api/v0/users/get_user_summary') {
      reply({ normal_wallets: [{ currency: 'CNY', balance: '1.00' }], bonus_wallets: [] })
      return
    }
    if (url.pathname === '/api/v0/users/get_unnotified_bonuses') { reply([]); return }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('account login: missing mock listener')
  const origin = `http://127.0.0.1:${String(address.port)}`
  return {
    origin, inits, pages, avatarRequests: () => avatarRequests,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

describe.skipIf(MODE === 'record')('web e2e: DeepSeek account sign-in in a plain browser', () => {
  let root: string | undefined
  let scaffold: WebScaffold
  let browser: Browser
  let platform: Awaited<ReturnType<typeof mockPlatform>>

  beforeAll(async () => {
    platform = await mockPlatform()
    root = await mkdtemp(join(tmpdir(), 'dsh-web-account-login-'))
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    // A stored grant bound to the double's origin starts the account credential-stored
    // without driving the browser sign-in flow (FORK dsh-local: the menu entry that used
    // to start it is gone, so this is the scenario's only way in).
    await writeFile(join(home, '.credentials.yaml'),
      `version: 1\nrefs: {}\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      version: 1\n      token: ${TOKEN}\n      issuer: ${platform.origin}\n`,
      { mode: 0o600 })
    const overlay = join(root, 'account-login.overlay.yml')
    await writeFile(overlay, (await readFile(OVERLAY_TEMPLATE, 'utf8')).replaceAll('{{origin}}', platform.origin))
    scaffold = await launchWebScaffold({ harnessHome: home, extraOverlayPath: overlay })
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await platform?.close()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it('serves the seeded grant and recovers the account avatar across Settings entries', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US', colorScheme: 'dark' })
    onTestFinished(() => context.close())
    const page = await context.newPage()
    const console = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-account-login'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
    await settingsButton.waitFor()
    // The stream serves the grant at boot: the first profile discovery fires the avatar
    // request on its own, with no UI entry involved.
    await expect.poll(() => platform.avatarRequests(), { timeout: 30_000 }).toBe(1)

    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    const account = settings.getByRole('region', { name: 'Account', exact: true })
    const openSettings = async (): Promise<void> => {
      await settingsButton.click()
      await settings.waitFor()
    }
    const closeSettings = async (): Promise<void> => {
      await settings.getByRole('button', { name: 'Close', exact: true }).click()
      await settings.waitFor({ state: 'detached' })
    }
    const states: string[] = []
    const capture = async (stage: string): Promise<void> => {
      const mounted = await account.count() > 0
      const settingsStatus = mounted
        ? await account.locator('[data-avatar-status]').getAttribute('data-avatar-status') : 'unmounted'
      states.push(`${stage}: settings=${settingsStatus}, `
        + `settingsImages=${mounted ? await account.locator('img').count() : 0}, `
        + `requests=${platform.avatarRequests()}`)
    }
    await capture('Initial load')

    await openSettings()
    await expect.poll(platform.avatarRequests).toBe(2)
    await account.locator('[data-avatar-status="failed"]').waitFor()
    expect(await account.locator('img').count()).toBe(0)
    // The seeded identity reaches the Account page; the sidebar carries neither label nor picture.
    expect(await account.textContent()).toContain('Web User')
    await capture('First Settings entry')
    await closeSettings()

    await openSettings()
    await expect.poll(() => account.locator('img').count()).toBe(1)
    await expect.poll(() => account.locator('img').evaluate(element =>
      element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true)
    expect(await account.locator('img').getAttribute('src')).toBe(`${platform.origin}/avatar.svg`)
    await capture('Second Settings entry')
    await closeSettings()

    await openSettings()
    await account.waitFor()
    expect(await account.locator('img').count()).toBe(1)
    expect(platform.avatarRequests()).toBe(3)
    await capture('Third Settings entry')
    await account.locator('img').dispatchEvent('error')
    await account.locator('[data-avatar-status="failed"]').waitFor()
    expect(await account.locator('img').count()).toBe(0)
    await capture('Rendered image failure')
    await closeSettings()

    await openSettings()
    await expect.poll(() => account.locator('img').count()).toBe(1)
    await capture('Settings entry after rendered failure')
    await compareOrRefreshGolden(AVATAR_EXPECTED, states.join('\n'), MODE)
    expect(console.pageErrors).toEqual([])
    await context.close()
  }, 90_000)
})
