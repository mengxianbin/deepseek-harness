/**
 * State file behind the state route (offhost-1110): the route's two-state
 * answer through the REAL Connection fetch registry — a fresh collector file
 * answers directly (新鲜即读), a stale one answers the last fresh judgment
 * (过期回上次值), absent/stale-with-none answers the unavailable 504, a
 * malformed body answers 500 — plus the deadline fallback the 1107
 * cache/timeout fix introduced, which the off-host move keeps verbatim, and
 * the sub-500ms stored-read answer that replaced the TTL-hit answer.
 */
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerRestartSignal } from '../src/restart-signal-host.ts'
import {
  RESTART_SIGNAL_STATE_FILE,
  RESTART_SIGNAL_STATE_SCHEMA,
  STATE_FRESH_MS,
  collectRestartSignal,
  onRestartSignalJudgment,
  resetRestartSignalForTest,
  type RestartSignalJudgment,
} from '../src/restart-signal.ts'
import { RESTART_SIGNAL_STATE_PATH } from '../src/restart.ts'

const temporary: string[] = []

/** Throwaway DSH home for one state test. */
function fixtureHome(): string {
  const dshHome = mkdtempSync(join(tmpdir(), 'restart-route-home-'))
  temporary.push(dshHome)
  return dshHome
}

/** Write one collector-shaped state file; `ageMs` backdates the mtime to make it stale. */
function writeState(
  dshHome: string,
  judgment: Partial<RestartSignalJudgment> & Pick<RestartSignalJudgment, 'state'>,
  options: { readonly ageMs?: number } = {},
): string {
  const path = join(dshHome, RESTART_SIGNAL_STATE_FILE)
  writeFileSync(path, JSON.stringify({
    schema: RESTART_SIGNAL_STATE_SCHEMA,
    collectedAt: new Date().toISOString(),
    repositoryRoot: 'C:\\repo',
    judgment: { detail: 'fixture', ...judgment },
  }))
  if (options.ageMs !== undefined) {
    const backdated = new Date(Date.now() - options.ageMs)
    utimesSync(path, backdated, backdated)
  }
  return path
}

afterEach(() => {
  vi.restoreAllMocks()
  resetRestartSignalForTest()
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** Real Connection fetch registry over `/api/restart-signal/state`. */
function routeFixture(collect: () => Promise<RestartSignalJudgment>) {
  const ctx = new Context()
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const handler = connection.createSharedFetchHandler('/api')
  const post = () => handler.fetch(new Request(`http://localhost${RESTART_SIGNAL_STATE_PATH}`, { method: 'POST' }), connection.browserPeer)
  registerRestartSignal(ctx, { collect })
  return { ctx, post }
}

describe('state route over the collector state file', () => {
  it('answers200 straight from a fresh state file — the fresh half of the two states (新鲜即读)', async () => {
    const dshHome = fixtureHome()
    const startedAt = '2026-11-07T04:00:03.000Z'
    writeState(dshHome, { state: 'BUILDING', startedAt })
    const { post } = routeFixture(() => collectRestartSignal({ dshHome }))
    const response = await post()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ state: 'BUILDING', startedAt })
  })

  it('passes the linked build pair through the wire body, and omits an unconfirmed seat (linked-lamp-twostate-1111)', async () => {
    const dshHome = fixtureHome()
    writeState(dshHome, { state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuild: 'failed', linkedBuildFailures: 9 })
    const { post } = routeFixture(() => collectRestartSignal({ dshHome }))
    expect(await (await post()).json())
      .toEqual({ state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web', linkedBuild: 'failed', linkedBuildFailures: 9 })
    // An unconfirmed judgment serves without the seats — the browser copy
    // falls back to the plain linked line rather than guessing.
    resetRestartSignalForTest()
    writeState(dshHome, { state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web' })
    expect(await (await post()).json()).toEqual({ state: 'NEED_BUILD', linkedRepo: 'D:/tech/dsh-web' })
  })

  it('answers200 with the LAST fresh judgment once the file is stale — the stale half (过期回上次值)', async () => {
    const dshHome = fixtureHome()
    writeState(dshHome, { state: 'NEED_RESTART', reason: 'config' })
    const { post } = routeFixture(() => collectRestartSignal({ dshHome }))
    expect((await (await post()).json())).toEqual({ state: 'NEED_RESTART', reason: 'config' })
    // A backdated rewrite: the route keeps serving the fresh judgment it read,
    // never the stale body.
    writeState(dshHome, { state: 'OK' }, { ageMs: STATE_FRESH_MS + 60_000 })
    const staleAnswer = await post()
    expect(staleAnswer.status).toBe(200)
    expect(await staleAnswer.json()).toEqual({ state: 'NEED_RESTART', reason: 'config' })
  })

  it('answers 504 with one stderr line when the state file is absent', async () => {
    const dshHome = fixtureHome()
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const { post } = routeFixture(() => collectRestartSignal({ dshHome }))
    const response = await post()
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: 'restart-signal state unavailable' })
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('state file absent'))
  })

  it('answers 504 when the only state was collected before the freshness bound', async () => {
    const dshHome = fixtureHome()
    writeState(dshHome, { state: 'OK' }, { ageMs: STATE_FRESH_MS + 60_000 })
    const { post } = routeFixture(() => collectRestartSignal({ dshHome }))
    const response = await post()
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: 'restart-signal state unavailable' })
  })

  it('answers 500 with one stderr line when the body is malformed', async () => {
    const dshHome = fixtureHome()
    writeFileSync(join(dshHome, RESTART_SIGNAL_STATE_FILE), '{not json')
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const { post } = routeFixture(() => collectRestartSignal({ dshHome }))
    const response = await post()
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'restart-signal state read failed' })
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('not JSON'))
  })

  it('answers a second pull from the stored read in well under 500ms — startedAt rides the same absolute instant', async () => {
    const dshHome = fixtureHome()
    const startedAt = '2026-11-07T04:00:03.000Z'
    writeState(dshHome, { state: 'BUILDING', startedAt })
    const { post } = routeFixture(() => collectRestartSignal({ dshHome }))
    const first = await post()
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ state: 'BUILDING', startedAt })
    const started = Date.now()
    const second = await post()
    const elapsed = Date.now() - started
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ state: 'BUILDING', startedAt })
    // The live acceptance twin of the 1107 sub-500ms read: a stored state
    // answer never waits on anything (unit form; the dsh-web.log form waits
    // on the human restart of the production host).
    expect(elapsed).toBeLessThan(500)
  })

  it('never lets a foreign home answer for this one — a path switch drops the store', async () => {
    const first = fixtureHome()
    writeState(first, { state: 'OK' })
    expect((await collectRestartSignal({ dshHome: first })).state).toBe('OK')
    const second = fixtureHome()
    await expect(collectRestartSignal({ dshHome: second })).rejects.toThrow('state file absent')
  })

  it('publishes once per moved state read — a stored answer fires no observer', async () => {
    const dshHome = fixtureHome()
    writeState(dshHome, { state: 'OK' })
    const seen: RestartSignalJudgment[] = []
    const off = onRestartSignalJudgment((judgment) => { seen.push(judgment) })
    const { post } = routeFixture(() => collectRestartSignal({ dshHome }))
    await post()
    await post()
    off()
    expect(seen).toHaveLength(1)
  })
})
