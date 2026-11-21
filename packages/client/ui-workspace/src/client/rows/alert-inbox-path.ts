/**
 * The mailbox panel's wire path on the CLIENT side.
 *
 * Twin of `ALERT_INBOX_PATH` in `@deepseek-ai/dsh-api-session-controller/types`
 * (the host route's own source): client feature packages may not value-import
 * across the plugin boundary — the client bundle purity gate allows type-only
 * imports (erased) or an injected Cordis service, never a cross-plugin value —
 * so the literal is pinned on BOTH sides by a test each (`RESTART_PATH` in
 * ui-settings-general is the same-package precedent; this is the cross-package
 * shape of that rule). Change one side and its twin test goes red.
 * @module ui-workspace/rows/alert-inbox-path
 */
export const ALERT_INBOX_PATH = '/api/session-controller/alert-inbox'
