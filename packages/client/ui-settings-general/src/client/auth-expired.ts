/**
 * Window event the served-page cookie heartbeat dispatches when the Host
 * answers its refresh with an expired-session 401.
 *
 * Redeclared here instead of imported: `@deepseek-ai/dsh-client-connection` is
 * transport, not a static shell module, so a value import would add a
 * non-baseline bundle edge for one string. `tests/apply.client.spec.ts` pins
 * this literal to connection's own `AUTH_EXPIRED_EVENT`, so a rename there
 * cannot silently strand this package's banner.
 */
export const AUTH_EXPIRED_EVENT = 'dsh-auth-expired'
