/**
 * Host restart dispatch: registers `POST /api/restart` and the capability page
 * global when — and only when — the user configured a restart command, then
 * runs that command in the background so the browser's 202 never waits for
 * the restart. The spawn is non-detached (2026-11-06 摘掉 detached 开关，
 * 修法卡 D0/D1 验证): the child shares this process's hidden console — the
 * default terminal (Windows Terminal) never gets a new window to show — and
 * the child still outlives this process.
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

/** Child-process surface the dispatch relies on. */
export interface RestartChild {
  /** Keep the child out of this process's exit wait. */
  readonly unref: () => void
  /** Observe an asynchronous spawn failure. */
  readonly on: (event: 'error', listener: (error: Error) => void) => void
}

/** Command launcher seam: one whole command line through the OS shell. */
export type RestartLauncher = (commandLine: string, options: SpawnOptions) => RestartChild

/** Injectable host facts: the launcher, defaulted from this process. */
export interface RestartInternals {
  /** Launcher; defaults to a hidden, stdio-ignored, non-detached shell spawn. */
  launch?: RestartLauncher
}

/**
 * Default launcher: one command line through the OS shell, hidden and
 * non-detached (name kept for call-site stability; since 2026-11-06 the
 * spawn shares this process's hidden console — zero new windows).
 * @param commandLine - whole command line to run through the OS shell.
 * @param options - spawn options passed through: shell, stdio, windowsHide, env.
 */
export const spawnDetached: RestartLauncher = (commandLine, options) => spawn(commandLine, options)

/** Caller-supplied reason bound: the audit field clips to this many characters. */
const RESTART_REASON_MAX_CHARS = 200

/**
 * Read the optional restart reason the caller rode on the request: query string
 * first (`?reason=`), then the buffered body (a JSON object's `reason` string,
 * or the plain body as the value). Every failure path — malformed URL, an
 * unreadable body, an absent field — degrades to `-`, and an over-long value
 * clips to {@link RESTART_REASON_MAX_CHARS}: the audit field is fail-open and
 * can never delay or block the dispatch (restart-reason-audit-1111 ①; restart
 * semantics unchanged).
 * @param request - the `POST /api/restart` request.
 * @returns the reason to log; `-` when absent or unreadable.
 */
export async function readRestartReason(request: Request): Promise<string> {
  try {
    const clip = (value: string): string => (value.length > RESTART_REASON_MAX_CHARS ? value.slice(0, RESTART_REASON_MAX_CHARS) : value)
    const query = new URL(request.url).searchParams.get('reason')
    if (query !== null && query !== '') return clip(query)
    const text = (await request.text()).trim()
    if (text === '') return '-'
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const value: unknown = Reflect.get(parsed, 'reason')
        return typeof value === 'string' && value !== '' ? clip(value) : '-'
      }
    } catch { /* not JSON — the plain body itself is the reason */ }
    return clip(text)
  } catch {
    return '-'
  }
}

/**
 * Best-effort caller identity for the dispatch line: the proxy's first
 * `x-forwarded-for` hop when present, else the caller's user-agent, else `-`
 * (fault-audit §2.4 B shape `remote=<ip/ua>`). The fetch carrier hands this
 * route only client headers — no socket face — so the authoritative socket IP
 * keeps riding the webserver's access line (`access POST /api/restart 202 <ip>`);
 * this field is the line-local echo of who called.
 * @param request - the `POST /api/restart` request.
 * @returns a non-empty identity token, `-` when nothing is readable.
 */
function requestRemote(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  const first = forwarded?.split(',')[0]?.trim()
  if (first !== undefined && first !== '') return first
  const userAgent = request.headers.get('user-agent')
  if (userAgent !== null && userAgent !== '') return userAgent
  return '-'
}

/**
 * Run the restart command in the background: the response never waits
 * for it, the child outlives this process, and an asynchronous spawn failure
 * only reaches stderr.
 * @param commandLine - whole command line from the user's environment.
 * @param launch - launcher seam.
 */
export function dispatchRestart(commandLine: string, launch: RestartLauncher): void {
  const child = launch(commandLine, {
    shell: true,
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
    fetch: async (request) => {
      if (!claimRestartDispatch()) {
        process.stderr.write('ui-settings-general: restart dispatch skipped: already in flight\n')
        return Response.json({ dispatched: false, reason: 'in-flight' }, { status: 409 })
      }
      // Spawn first, audit second: the reason read happens after the dispatch,
      // so a hostile or broken body can never stand between the claim and the
      // restart — the audit field degrades, the 202 stays (fail-open, ①).
      dispatchRestart(commandLine, launch)
      const reason = await readRestartReason(request)
      // Two channels, one shape: this manual-route line mirrors auto-restart's
      // `auto-restart dispatched (…, reason=…)` so both dispatch paths carry
      // their motive (fault-audit §2.4 B extended, restart-reason-audit-1111 ①).
      process.stderr.write(`ui-settings-general: restart dispatched (manual route, reason=${reason}, remote=${requestRemote(request)})\n`)
      return Response.json({ dispatched: true }, { status: 202 })
    },
  })
}
