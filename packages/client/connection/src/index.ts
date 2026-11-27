/** Host HTTP bridge for browser-client RPC. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
// Activates the webServer Context merge used below.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH } from './api-path.ts'
import { REFRESH_PATH } from './connect-protocol.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority } from './api-request-trust.ts'
import { HostConnectionService } from './rpc-host.ts'
import { ConnectionAuthentication } from './authentication.ts'
import { ConnectionRecoveryConfigSchema, resolveConnectionConfig, type ConnectionRecoveryConfig } from './recovery-config.ts'

export type {
  AuthenticationProvider,
  PeerAdmission,
  ConnectionFetchMethod,
  ConnectionFetchHandler,
  ConnectionFetchRoute,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcAttachment,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcHandlerResult,
  ConnectionRpcResult,
  ConnectionRequestBodyMode,
  ConnectionTrustRequest,
  ClientRequest,
  HostConnectionHandle,
  HostConnectionFetch,
  HostConnectionRpc,
  RpcMessage,
  ServerResponse,
} from './rpc.ts'
export type { PeerId, PeerScope, Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
export { RpcId, transportError } from './rpc.ts'
export { Peer } from './peer.ts'
export type { PeerOptions } from './peer.ts'
export { CONNECT_PATH, REFRESH_PATH, type ConnectionInteractions } from './connect-protocol.ts'
export {
  clientRequestSchema,
  rpcErrorSchema,
  rpcIdSchema,
  rpcMessageSchema,
  rpcResultSchema,
  serverResponseSchema,
} from './rpc-schema.ts'
export { HostConnectionService } from './rpc-host.ts'
export { ConnectionAuthentication } from './authentication.ts'

export { API_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Admit or wrap an authenticated shared API request, including body transfer.
     * Existing requests continue when a listener refuses subsequent requests.
     * @param request - Authenticated incoming HTTP request.
     * @param response - Response owned until the delegated bridge settles.
     * @param next - Delegate to the next listener or the shared API bridge.
     * @mode waterfall
     */
    'connection/request'(request: IncomingMessage, response: ServerResponse, next: () => Promise<void>): Promise<void>
  }
}

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const HOUR_MILLISECONDS = 60 * 60 * 1000
// Browsers and Node share this maximum signed 32-bit timer delay.
const MAX_TIMER_MS = 2_147_483_647

/**
 * Cadence for the served page's cookie-refresh heartbeat: one sixth of the
 * configured cookie window, clamped to 1–12 hours, so an active page rotates
 * its cookie several window-lengths before absolute expiry.
 * @param cookieMaxAgeDays - configured absolute cookie lifetime in days.
 * @returns refresh interval in milliseconds.
 */
function deriveCookieRefreshIntervalMs(cookieMaxAgeDays: number): number {
  return Math.min(12 * HOUR_MILLISECONDS, Math.max(HOUR_MILLISECONDS, cookieMaxAgeDays * DAY_MILLISECONDS / 6))
}

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection. */
export const inject: string[] = []

/** Browser authentication, request limits, and connection recovery configuration. */
export interface ConnectionConfig {
  /** Browser recovery timing; the browser receives it through its synced Config and reads it once when the plugin activates. */
  recovery?: Volatile<ConnectionRecoveryConfig>
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The fence accepts loopback and the
   * listener's own bind IP independently; other remote authorities require
   * an entry here. A non-canonical or non-bare authority fails plugin load.
   */
  trustedHosts?: string[]
  /**
   * Absolute browser-cookie lifetime window in days the heartbeat cadence derives from;
   * mirrors the Token plugin's `cookieMaxAgeDays`. Default: 30.
   */
  cookieMaxAgeDays?: number
  /**
   * Page heartbeat interval in ms that re-issues the browser cookie before
   * its absolute window ends. Default: one sixth of the cookie window,
   * clamped to 1–12 hours. Explicit 0 disables the heartbeat and its injection.
   */
  cookieRefreshIntervalMs?: number
  /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
}

/** Host request limits and trusted authorities; `recovery` is synced to the browser. */
export const Config: z<Omit<ConnectionConfig, 'recovery'> & { recovery?: ConnectionRecoveryConfig }, ConnectionConfig> = z.object({
  recovery: ConnectionRecoveryConfigSchema.default({}).volatile(),
  trustedHosts: z.array(String).default([]),
  cookieMaxAgeDays: z.natural().min(1).default(30),
  cookieRefreshIntervalMs: z.natural().max(MAX_TIMER_MS),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

/**
 * Provides carrier-neutral RPC and Fetch registries. When `webServer` is
 * present, the plugin applies Host/Origin checks and registered authentication
 * to WebServer routes and mounts the `/api` browser transport.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config?: ConnectionConfig): void {
  // Config boundary: the schema admits a NaN backoff factor, which the synced Config projection cannot carry as lossless
  // JSON; rejecting it at load keeps a row with an unprojectable recovery value off the graph.
  resolveConnectionConfig(config?.recovery?.get())
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const cookieMaxAgeDays = config?.cookieMaxAgeDays ?? 30
  const cookieRefreshIntervalMs = config?.cookieRefreshIntervalMs ?? deriveCookieRefreshIntervalMs(cookieMaxAgeDays)
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  // The cookie-refresh heartbeat stands down the moment this fiber disposes, so
  // a route handler surviving in a test's hand answers like a dead Host.
  let active = true
  ctx.effect(() => () => { active = false }, 'client-connection: cookie refresh fence')
  new ConnectionAuthentication(ctx)
  ctx.inject(['connection.authentication'], (connectionCtx) => {
    const connection = new HostConnectionService(connectionCtx, trustedHosts)
    connectionCtx.inject(['webServer'], (webCtx) => {
      assertImageBodyCapacity(webCtx, maxRequestBodyBytes)
      // The heartbeat exchanges the browser cookie; only the served page
      // without an explicit transport uses that cookie carrier.
      webCtx.on('webserver/index-inject', (table) => {
        if (cookieRefreshIntervalMs > 0) {
          table.push({ kind: 'global', name: '__DSH_COOKIE_REFRESH__', value: { intervalMs: cookieRefreshIntervalMs } })
        }
      })
      const fetchHandler = connection.createSharedFetchHandler(API_PATH)
      const route: WebRoute = {
        kind: 'prefix',
        path: API_PATH,
        auth: 'required',
        handler: async (req, res, peer) => {
          if (peer === undefined || res.destroyed) return
          await webCtx.waterfall('connection/request', req, res, () => bridge(req, res, fetchHandler, peer, maxRequestBodyBytes))
        },
      }
      webCtx.effect(() => webCtx.webServer.register(route), 'client-connection: /api route')
      // Fork cookie rotation: anonymous because the handler itself owns the
      // structured 401 an expired cookie earns; the trust fence still runs
      // first through `webserver/authorize`.
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: REFRESH_PATH,
        auth: 'anonymous',
        handler: (request, response) => {
          const refuse = (): void => {
            response.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
            response.end('unauthorized')
          }
          if (!active) { refuse(); return }
          const auth = ctx.get('browserAuth')
          if (auth === undefined) { refuse(); return }
          auth.refreshCookie(request, response, webCtx.webServer.protocol === 'https:')
        },
      }), 'client-connection: /refresh route')
    })
  })
  ctx.inject(['attachments'], (attachmentCtx) => {
    assertImageBodyCapacity(attachmentCtx, maxRequestBodyBytes)
  })
}
