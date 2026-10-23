import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractStartupUrl, logCandidates, runPrintUrl } from '../src/print-url.ts'

/** A launch token in the shipped shape: `2-` prefix plus 43 base64url characters. */
const TOKEN = `2-${'abcdefghij'.repeat(4)}x`

let server: Server | undefined
let origin = ''
const tempDirs: string[] = []

/** Answer exactly like the login exchange: 303 for the shipped token, 401 otherwise. */
async function startExchangeServer(): Promise<void> {
  server = createServer((request, response) => {
    const url = request.url ?? ''
    if (url.includes(`token=${TOKEN}`)) {
      response.writeHead(303, { location: '/' })
      response.end()
      return
    }
    if (url.includes('token=broken')) {
      response.writeHead(500)
      response.end()
      return
    }
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end('{"error":"authentication required"}')
  })
  await new Promise<void>((resolveListen) => {
    server?.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server?.address()
  if (address === null || typeof address === 'string') throw new Error('test server bound to no port')
  origin = `http://127.0.0.1:${String(address.port)}`
}

/** A TCP port that nothing listens on: bind it, note the port, release it. */
async function closedPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolveListen) => { probe.listen(0, '127.0.0.1', resolveListen) })
  const address = probe.address()
  if (address === null || typeof address === 'string') throw new Error('probe bound to no port')
  await new Promise<void>((resolveClose) => { probe.close(() => { resolveClose() }) })
  return address.port
}

/** Run `runPrintUrl` with captured sinks. */
async function run(env: Record<string, string | undefined>, overrides: Parameters<typeof runPrintUrl>[0] = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await runPrintUrl({
    env,
    stdout: (line) => { out.push(line) },
    stderr: (line) => { err.push(line) },
    ...overrides,
  })
  return { code, out, err }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-print-url-'))
  tempDirs.push(dir)
  return dir
}

beforeEach(async () => {
  if (server === undefined) await startExchangeServer()
})

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true })
})

afterAll(async () => {
  await new Promise<void>((resolveClose) => {
    if (server === undefined) resolveClose()
    else server.close(() => { resolveClose() })
  })
})

describe('extractStartupUrl', () => {
  it('returns the newest token line, skipping non-URL announcements', () => {
    const tail = [
      'dsh web: opening the default browser; pass --no-open to disable',
      `dsh web: ${origin}/?token=${TOKEN}`,
      '[watch-probe] changes.follow ready-frame sent',
      `dsh web: ${origin}/?token=second-token-value`,
      '',
    ].join('\n')
    expect(extractStartupUrl(tail)).toBe(`${origin}/?token=second-token-value`)
  })

  it('tolerates CRLF line endings and returns nothing for a log without a startup URL', () => {
    expect(extractStartupUrl(`dsh web: ${origin}/?token=abc\r\nother: line\r\n`)).toBe(`${origin}/?token=abc`)
    expect(extractStartupUrl('listening only\n')).toBeUndefined()
    expect(extractStartupUrl('')).toBeUndefined()
  })
})

describe('logCandidates', () => {
  it('treats DSH_WEB_LOG as the single authoritative log', () => {
    const dir = tempDir()
    const anchor = pathToFileURL(join(dir, 'x', 'y', 'z', 'print-url.ts')).href
    expect(logCandidates({ DSH_WEB_LOG: join(dir, 'web.log') }, anchor, join(dir, 'home')))
      .toEqual([join(dir, 'web.log')])
    // Blank overrides are unset; the default chain still applies.
    expect(logCandidates({ DSH_WEB_LOG: '   ' }, anchor, join(dir, 'home')))
      .toEqual([join(dir, 'dsh-web.log'), join(dir, 'home', 'dsh-web.log')])
  })

  it('anchors the default chain on the launcher checkout, then the home, deduplicated', () => {
    const dir = tempDir()
    const anchor = pathToFileURL(join(dir, 'x', 'y', 'z', 'print-url.ts')).href
    expect(logCandidates({}, anchor, join(dir, 'home'))).toEqual([join(dir, 'dsh-web.log'), join(dir, 'home', 'dsh-web.log')])
    expect(logCandidates({}, anchor, dir)).toEqual([join(dir, 'dsh-web.log')])
  })
})

describe('runPrintUrl', () => {
  it('prints the full startup URL after the exchange proves it works', async () => {
    const log = join(tempDir(), 'dsh-web.log')
    writeFileSync(log, `noise\n[2026-10-23 10:16:00] boot\ndsh web: ${origin}/?token=${TOKEN}\n`)
    const result = await run({ DSH_WEB_LOG: log })
    expect(result.code).toBe(0)
    expect(result.out).toEqual([`${origin}/?token=${TOKEN}`])
    expect(result.out[0]).toContain(`token=${TOKEN}`)
    expect(result.err).toEqual([])
  })

  it('falls from a stale checkout log to the home log the live instance wrote', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'x', 'y', 'z'), { recursive: true })
    const dead = await closedPort()
    writeFileSync(join(dir, 'dsh-web.log'), `dsh web: http://127.0.0.1:${String(dead)}/?token=old\n`)
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'dsh-web.log'), `dsh web: ${origin}/?token=${TOKEN}\n`)
    const result = await run({}, {
      home,
      logAnchorUrl: pathToFileURL(join(dir, 'x', 'y', 'z', 'print-url.ts')).href,
    })
    expect(result.code).toBe(0)
    expect(result.out).toEqual([`${origin}/?token=${TOKEN}`])
  })

  it('reports a missing log file as not running, with the path it checked', async () => {
    const missing = join(tempDir(), 'never-written.log')
    const result = await run({ DSH_WEB_LOG: missing })
    expect(result.code).toBe(1)
    expect(result.out).toEqual([])
    expect(result.err).toHaveLength(1)
    expect(result.err[0]).toContain('dsh web is not running')
    expect(result.err[0]).toContain(missing)
  })

  it('reports a log with no startup URL line as not running', async () => {
    const log = join(tempDir(), 'dsh-web.log')
    writeFileSync(log, 'just a watch probe line\n')
    const result = await run({ DSH_WEB_LOG: log })
    expect(result.code).toBe(1)
    expect(result.out).toEqual([])
    expect(result.err[0]).toContain('dsh web is not running')
    expect(result.err[0]).toContain('no startup URL line')
  })

  it('reports a startup URL whose instance is gone as not running', async () => {
    const log = join(tempDir(), 'dsh-web.log')
    const dead = await closedPort()
    writeFileSync(log, `dsh web: http://127.0.0.1:${String(dead)}/?token=${TOKEN}\n`)
    const result = await run({ DSH_WEB_LOG: log })
    expect(result.code).toBe(1)
    expect(result.out).toEqual([])
    expect(result.err[0]).toContain('dsh web is not running')
    expect(result.err[0]).toContain(`cannot open http://127.0.0.1:${String(dead)}`)
  })

  it('treats a URL fetch refuses before connecting as not running', async () => {
    const log = join(tempDir(), 'dsh-web.log')
    // Port 9 is on the WHATWG forbidden list: fetch rejects it with a message and no code.
    writeFileSync(log, `dsh web: http://127.0.0.1:9/?token=${TOKEN}\n`)
    const result = await run({ DSH_WEB_LOG: log })
    expect(result.code).toBe(1)
    expect(result.out).toEqual([])
    expect(result.err[0]).toContain('dsh web is not running')
    expect(result.err[0]).toContain('bad port')
  })

  it('reports a token the running instance rejects as predating its boot', async () => {
    const log = join(tempDir(), 'dsh-web.log')
    writeFileSync(log, `dsh web: ${origin}/?token=stale-token-value\n`)
    const result = await run({ DSH_WEB_LOG: log })
    expect(result.code).toBe(1)
    expect(result.out).toEqual([])
    expect(result.err[0]).toContain('rejected the startup URL')
    expect(result.err[0]).toContain('HTTP 401')
  })

  it('reports a non-exchange answer from a live origin without claiming it is down', async () => {
    const log = join(tempDir(), 'dsh-web.log')
    writeFileSync(log, `dsh web: ${origin}/?token=broken\n`)
    const result = await run({ DSH_WEB_LOG: log })
    expect(result.code).toBe(1)
    expect(result.out).toEqual([])
    expect(result.err[0]).toContain('answered HTTP 500')
    expect(result.err[0]).not.toContain('is not running')
  })

  it('still prints when the probe cannot verify the exchange but something answered', async () => {
    const log = join(tempDir(), 'dsh-web.log')
    writeFileSync(log, `dsh web: ${origin}/?token=${TOKEN}\n`)
    const tlsRefusal: typeof fetch = () =>
      Promise.reject(new Error('self-signed certificate', { cause: Object.assign(new Error('chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }) }))
    const result = await run({ DSH_WEB_LOG: log }, { fetchImpl: tlsRefusal })
    expect(result.code).toBe(0)
    expect(result.out).toEqual([`${origin}/?token=${TOKEN}`])
  })

  it('treats a probe timeout as an absent instance', async () => {
    const log = join(tempDir(), 'dsh-web.log')
    writeFileSync(log, `dsh web: ${origin}/?token=${TOKEN}\n`)
    const timeout: typeof fetch = () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))
    const result = await run({ DSH_WEB_LOG: log }, { fetchImpl: timeout })
    expect(result.code).toBe(1)
    expect(result.out).toEqual([])
    expect(result.err[0]).toContain('dsh web is not running')
    expect(result.err[0]).toContain('no response within 2000ms')
  })

  it('lists every default location when no log exists anywhere', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'x', 'y', 'z'), { recursive: true })
    const result = await run({}, {
      home: join(dir, 'home'),
      logAnchorUrl: pathToFileURL(join(dir, 'x', 'y', 'z', 'print-url.ts')).href,
    })
    expect(result.code).toBe(1)
    expect(result.out).toEqual([])
    expect(result.err[0]).toContain('dsh web is not running')
    expect(result.err[0]).toContain('no log file at')
    expect(result.err[0]).toContain(join(dir, 'dsh-web.log'))
    expect(result.err[0]).toContain(join(dir, 'home', 'dsh-web.log'))
  })
})
