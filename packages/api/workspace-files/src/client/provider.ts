/**
 * The `file` protocol's provider: a workspace file's metadata as a stream of
 * `RemoteResult` frames.
 *
 * An address names the file in one of two scopes. A `session` address,
 * `dsh-resource://file/session/<sessionId>/<path>`, carries an absolute path or one
 * relative to that Session's workspace root: the Host receives the path as-is and
 * resolves it against the root it holds. Only the Host's `stat.absolutePath`
 * selects the change-feed key; no Client Session summary is needed.
 * An `absolute` address, `dsh-resource://file/absolute/<path>`, carries no
 * Session and cannot authorize a Host call. An address neither scope
 * resolves yields one failure frame — `workspace-file/unsupported-address` for
 * a string outside the grammar, `workspace-file/unknown-workspace` when the
 * address carries no Session — and ends.
 *
 * The first frame is the file's `stat`; subsequent invalidations run `stat`
 * again unless their version or absence is already known. Reconnection also
 * restats the file. Failures travel as `ok: false` frames, never as thrown errors: the
 * Remote face does not reject, and anything thrown inside the stream is a
 * programming error the resource model lets surface. A failed stat does not end
 * the stream: the next write stats again. One {@link ChangeFeed}
 * serves every open file of the Client.
 */
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceFileStat } from '../types.ts'
import type { ChangeFeed } from './change-feed.ts'
import type { WorkspaceFilesRemote } from './remote.ts'
import { clearWatchDegraded, markWatchDegraded } from './watch-status.ts'

/**
 * How long `open` waits for the Host's watch acknowledgement before falling
 * back to a single `stat`. The wait is bounded because it is not: a watch that
 * hangs silently (neither acking nor failing) would otherwise pin the
 * resource in `loading` forever — metadata, and with it every UI affordance
 * derived from it, never arrives.
 */
const DEFAULT_READY_TIMEOUT_MS = 2000

/** Per-provider knobs; production leaves them out, tests shrink the wait. */
export interface FileProviderOptions {
  /** Override the watch-ready wait in milliseconds; `<= 0` waits without a bound. */
  readonly readyTimeoutMs?: number
}

/** The Session and unmodified path submitted to the Host. */
interface HostFile {
  readonly sessionId: SessionId
  /** The path the Host receives: absolute or workspace-relative. */
  readonly path: string
}

/**
 * Build the `file` provider over one Remote face and one change feed.
 * @param remote - the Remote face carrying `workspaceFiles.stat`.
 * @param changes - target-scoped change streams shared by file resources.
 * @returns the provider to register into `ctx.resources`.
 */
export function createFileResourceProvider(
  remote: WorkspaceFilesRemote,
  changes: ChangeFeed,
  options: FileProviderOptions = {},
): ResourceProvider<'file'> {
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  return {
    protocol: 'file',
    async *open(address, { signal }): AsyncIterable<RemoteResult<WorkspaceFileStat>> {
      const resolved = resolve(address)
      if (!resolved.ok) {
        yield resolved
        return
      }
      const { sessionId, path } = resolved.value
      // Queue changes delivered to this Client while stat is pending.
      const notices = changes.follow(sessionId, path, signal)
      const stat = (): Promise<RemoteResult<WorkspaceFileStat>> => remote.workspaceFiles.stat(sessionId, path, signal)
      // Read through a call: a plain `signal.aborted` is narrowed to `false` by
      // the first check and would read as always-false after the later awaits.
      const aborted = (): boolean => signal.aborted
      // Undefined while the last stat failed: the follow is on the address, not
      // on the file, so a write can still bring the file live.
      let current: WorkspaceFileStat | undefined
      try {
        // A fresh evaluation of this address: whatever degraded state a
        // previous attempt left behind, this one settles it again.
        clearWatchDegraded(address)
        const ready = await readyWithin(notices.ready, readyTimeoutMs)
        if (ready !== true) {
          if (aborted()) return
          // A timeout — not a clean `false` — is the degradation: the stream
          // hangs without acknowledging or failing, so the fallback below is
          // the only stat this resource will ever get. A late acknowledgement
          // finds the follower already disposed and changes nothing.
          if (ready === 'timeout') markWatchDegraded(address)
          const result = await stat()
          if (!aborted()) yield result
          return
        }
        if (aborted()) return
        const first = await stat()
        if (aborted()) return
        if (first.ok) {
          notices.bind(first.value.absolutePath)
          current = first.value
          yield { ok: true, value: current }
        } else {
          yield first
        }
        for await (const notice of notices) {
          if (aborted()) return
          if (current === undefined) {
            // Still gone: nothing new to report.
            if (notice.kind === 'absent') continue
          } else if (notice.kind === 'changed') {
            // Frames report observations: holding this version already means the
            // consumer learns nothing new.
            if (notice.version === current.version) continue
          }
          // A Host notice may mean stale content.
          const again = await stat()
          if (aborted()) return
          if (!again.ok) {
            current = undefined
            yield again
            continue
          }
          notices.bind(again.value.absolutePath)
          current = again.value
          yield { ok: true, value: current }
        }
      } finally {
        notices.dispose()
      }
    },
  }
}

/**
 * Await the follow's acknowledgement, bounded.
 * @param ready - the follow's readiness promise.
 * @param timeoutMs - the wait bound in milliseconds; `<= 0` waits unbounded.
 * @returns the acknowledgement, or `timeout` when the bound elapsed first.
 */
async function readyWithin(ready: Promise<boolean>, timeoutMs: number): Promise<boolean | 'timeout'> {
  if (timeoutMs <= 0) return await ready
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      ready,
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => { resolve('timeout') }, timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Resolve one address to the Host call it stands for, or to the failure frame it earns.
 * @param address - the full address, scheme included.
 * @returns the Host file, or the `unsupported-address` / `unknown-workspace` failure.
 */
function resolve(address: string): RemoteResult<HostFile> {
  const parsed = parseFileAddress(address)
  if (parsed === undefined) return { ok: false, error: unsupportedAddress(address) }
  if (parsed.scope === 'session') {
    // The address is a string boundary: its id segment is the Session id it names.
    const sessionId = parsed.sessionId as SessionId
    return { ok: true, value: { sessionId, path: parsed.path } }
  }
  return { ok: false, error: unknownWorkspace(address) }
}

/**
 * The failure frame's error for an address this provider does not serve.
 * @param address - the offending address.
 * @returns the typed error.
 */
function unsupportedAddress(address: string): RemoteError<'workspace-file/unsupported-address'> {
  return new RemoteError(
    'workspace-file/unsupported-address',
    `${address} is not a dsh-resource://file/session/<sessionId>/<path> or dsh-resource://file/absolute/<path> address`,
    { address },
  )
}

/**
 * The failure frame's error for an absolute address with no Session.
 * @param address - the offending address.
 * @returns the typed error.
 */
function unknownWorkspace(address: string): RemoteError<'workspace-file/unknown-workspace'> {
  return new RemoteError(
    'workspace-file/unknown-workspace',
    `${address} requires a dsh-resource://file/session/<sessionId>/<path> address`,
    { address },
  )
}
