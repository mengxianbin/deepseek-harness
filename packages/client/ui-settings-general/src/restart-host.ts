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
import { claimRestartDispatch } from './restart-disposition.ts'
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
export const spawnDetached: RestartLauncher = (commandLine, options) => spawn(commandLine, options)

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
    // 如实回报（D, 2026-10-26 修订 design §四 P10「202 恒定」）：真派发才回
    // 202 {dispatched:true}；claim 窗口内被跳过回 409 {dispatched:false,
    // reason:'in-flight'}——旧实现恒 202 导致「点了没反应还显示已发送」的假成功
    // （12:57 事故：派发未起内层 + 后续4次点击全被 in-flight 静默吞掉仍报 202）。
    // claim 带 DISPATCH_CLAIM_TTL_MS 自动释放（restart-disposition），锁只防抖不锁死。
    fetch: () => {
      if (!claimRestartDispatch()) {
        process.stderr.write('ui-settings-general: restart dispatch skipped: already in flight\n')
        return Promise.resolve(Response.json({ dispatched: false, reason: 'in-flight' }, { status: 409 }))
      }
      dispatchRestart(commandLine, launch)
      return Promise.resolve(Response.json({ dispatched: true }, { status: 202 }))
    },
  })
}
