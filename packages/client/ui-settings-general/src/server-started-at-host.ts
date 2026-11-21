/**
 * Host server start-time route: registers `GET /api/server/started-at` on
 * Connection's authenticated exact-fetch fence — the same fence the restart
 * dispatch and the signal recheck ride — and answers this process's own start
 * instant (server-started-at-1117), the fact the settings-row stamp renders
 * so a glance answers "did the server actually restart".
 *
 * Why a route and not the ready frame: `ConnectionHostInfo` rides
 * `parseRemoteEventReady`'s exact-key validation, so one extra key would
 * refuse every already-open page when the Host restarts (the HostReleasePrompt
 * scenario) — a breaking wire change for a display fact. The instant is
 * captured once at registration (apply runs at process start), so the answer
 * is a pure pass-through with no I/O, no deadline, and `no-store`: a cached
 * answer would show a previous process's start time, which is exactly the
 * lie this route exists to prevent. The route registers unconditionally —
 * the stamp matters whether or not a restart command is configured.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.connection merge (exact Fetch-route registry).
import type {} from '@deepseek-ai/dsh-client-connection'
import { SERVER_STARTED_AT_PATH } from './server-started-at.ts'

/**
 * Register the server start-time route: capture this process's start instant
 * once, then serve it as JSON for the life of the process.
 * @param ctx - Host context carrying the connection service's route registry.
 */
export function registerServerStartedAt(ctx: Context): void {
  // `process.uptime()` counts back from process start, so the captured
  // instant is the dsh web process's own boot time (the server whose restart
  // the user needs to truthfully report).
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString()
  ctx.connection.fetch.register({
    path: SERVER_STARTED_AT_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(Response.json({ startedAt }, { headers: { 'cache-control': 'no-store' } })),
  })
}
