/**
 * Host restart dispatch: registers `POST /api/restart` and the capability page
 * global when — and only when — the user configured a restart command, then
 * runs that command detached so the browser's 202 never waits for the restart.
 */
import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.connection merge (exact Fetch-route registry).
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the `webserver/index-inject` event merge.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { RESTART_GLOBAL, RESTART_PATH, type RestartCapability } from './restart.ts'

/** Environment variable carrying the whole restart command line. */
export const RESTART_COMMAND_ENV = 'DSH_WEB_RESTART_COMMAND'

/** Detached child-process surface the dispatch relies on. */
export interface RestartChild {
  /** Keep the child out of this process's exit wait. */
  readonly unref: () => void
  /** Observe an asynchronous spawn failure. */
  readonly on: (event: 'error', listener: (error: Error) => void) => void
}

/** Detached command launcher seam: one whole command line through the OS shell. */
export type RestartLauncher = (commandLine: string, options: SpawnOptions) => RestartChild

/** Injectable host facts: the detached launcher, defaulted from this process. */
export interface RestartInternals {
  /** Detached launcher; defaults to a hidden, stdio-ignored shell spawn. */
  launch?: RestartLauncher
}

/** Default launcher: one command line through the OS shell, hidden and detached. */
const spawnDetached: RestartLauncher = (commandLine, options) => spawn(commandLine, options)

/**
 * Run the restart command detached from this process: the response never waits
 * for it, the child outlives this process, and an asynchronous spawn failure
 * only reaches stderr.
 * @param commandLine - whole command line from the user's environment.
 * @param launch - detached launcher seam.
 */
export function dispatchRestart(commandLine: string, launch: RestartLauncher): void {
  const child = launch(commandLine, {
    shell: true,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    // Full inheritance on purpose: this child runs inside the server's own
    // trust domain — the deployment script that restarts dsh web itself
    // (restart.ps1 → schtasks → start.ps1 → dsh web) — so it inherits nothing
    // the server process does not already hold, and the restart wiring names
    // (DSH_WEB_PORT/DSH_WEB_HOST/DSH_RESTART_LOG) plus proxy routing arrive
    // with the inheritance. open-in-app's scrubbed parent env guards launches
    // of THIRD-PARTY apps — a different trust boundary, not this one.
    env: process.env,
  })
  child.on('error', (error) => {
    process.stderr.write(`ui-settings-general: restart dispatch failed: ${error.message}\n`)
  })
  child.unref()
}

/**
 * Serve `POST /api/restart` and announce the capability page global when —
 * and only when — the user configured a restart command; with no command
 * nothing is registered, so the route stays a natural 404 and the global
 * stays absent from the served page.
 * @param ctx - Host context carrying the connection and webserver services.
 * @param internals - injectable launcher seam for tests.
 */
export function registerRestart(ctx: Context, internals: RestartInternals = {}): void {
  const commandLine = process.env[RESTART_COMMAND_ENV]
  if (commandLine === undefined || commandLine === '') return
  const launch = internals.launch ?? spawnDetached
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: RESTART_GLOBAL, value: { configured: true } satisfies RestartCapability })
  })
  ctx.connection.fetch.register({
    path: RESTART_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: () => {
      const response = Response.json({ dispatched: true }, { status: 202 })
      dispatchRestart(commandLine, launch)
      return Promise.resolve(response)
    },
  })
}
