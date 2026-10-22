/**
 * Host desktop availability, file associations, and open/reveal actions over the Session Remote.
 * The desktop answer is read once per page after it settles; a failed read stays unknown and is
 * re-read instead of latching the page into "no desktop".
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionOpenWorkspacePathRequest, SessionWorkspacePathApplication } from '@deepseek-ai/dsh-api-session-controller/types'

/** What a path gesture asks of the Host desktop: the default application, or the file manager showing the file. */
export type OpenInAppPathAction = 'open' | 'reveal'

/** Failure kind of one settled path gesture, for the initiating control to announce. */
export type OpenInAppPathFailure = 'openError' | 'revealError'

/**
 * How long a failed desktop read waits before it is read again. The wait is short so the
 * page-load races that fail the first call heal on their own, without the user reloading.
 */
export const DESKTOP_RETRY_BACKOFF_MS = 2000

/**
 * Automatic re-reads after the initial attempt; a dead carrier is not polled forever —
 * a newly mounted control still re-queries through `load()`.
 */
export const DESKTOP_RETRY_LIMIT = 3

/** The slice of the Client Remote the path actions call. */
export interface OpenInAppPathRemote {
  readonly session: {
    /** Whether the Host can hand a workspace path to a native desktop. */
    canOpenWorkspacePath(): Promise<RemoteResult<boolean>>
    /** Current registered file handlers and their default selection. */
    workspacePathApplications(
      request: { path: string }, signal?: AbortSignal,
    ): Promise<RemoteResult<readonly SessionWorkspacePathApplication[]>>
    /** Open one Host path in its default application, or reveal it in the file manager. */
    openWorkspacePath(request: SessionOpenWorkspacePathRequest, signal?: AbortSignal): Promise<RemoteResult<unknown>>
  }
}

/** Page-lifetime desktop availability and the open/reveal carrier shared by every path control. */
export class OpenInAppPathController {
  /** Whether the Host desktop can open paths; null until the Host answered — and unknown again after a failed read. */
  readonly desktop: SnapshotStore<boolean | null> = createSnapshotStore<boolean | null>(null)
  private loading: Promise<void> | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private retries = 0

  /**
   * @param remote - the Session Remote namespace answering availability and running gestures.
   * @param retryBackoffMs - wait before an automatic re-read of a failed availability answer.
   */
  constructor(private readonly remote: OpenInAppPathRemote, private readonly retryBackoffMs: number = DESKTOP_RETRY_BACKOFF_MS) {}

  /**
   * Read desktop availability once per controller life after it settles; concurrent calls share
   * the read. A failed read is not latched: it stays unknown, is re-read after a short bounded
   * backoff, and any later `load()` — a newly mounted control seeing the unknown answer — re-queries.
   * @returns after availability is published, or once the failed read has been handed to its retry.
   */
  load(): Promise<void> {
    this.loading ??= this.run()
    return this.loading
  }

  /**
   * Open one Host path in its default application, or reveal it in the file manager.
   * @param path - absolute path on the Host, as the file's metadata reports it.
   * @param action - default application open, or file-manager reveal.
   * @param application - registered application path for an explicit open.
   * @returns the failure kind to announce, or `null` once the Host acknowledged.
   */
  async openPath(path: string, action: OpenInAppPathAction, application?: string): Promise<OpenInAppPathFailure | null> {
    const request: SessionOpenWorkspacePathRequest = action === 'reveal' ? { path, action } : { path, ...(application === undefined ? {} : { application }) }
    let ok = false
    try {
      ok = (await this.remote.session.openWorkspacePath(request)).ok
    } catch {
      // Swallows carrier rejections: a Host that cannot be reached failed the
      // gesture like a Host that refused it, and the control announces that.
    }
    return ok ? null : action === 'open' ? 'openError' : 'revealError'
  }

  /**
   * Refresh the file's OS associations; failures remain distinct from an empty handler list.
   * @param path - file path reported by the Host.
   * @param signal - lifetime of the requesting preview.
   * @returns application metadata, or null when the query fails.
   */
  async applications(path: string, signal: AbortSignal): Promise<readonly SessionWorkspacePathApplication[] | null> {
    let result: RemoteResult<readonly SessionWorkspacePathApplication[]>
    try {
      result = await this.remote.session.workspacePathApplications({ path }, signal)
    } catch (_error) {
      // The control reports query failure and keeps file reveal available.
      return null
    }
    return result.ok ? result.value : null
  }

  private async run(): Promise<void> {
    let answer: boolean | null = null
    try {
      const result = await this.remote.session.canOpenWorkspacePath()
      if (result.ok) {
        answer = result.value
      } else {
        console.warn('open-in-app: desktop availability read failed:', result.error)
      }
    } catch (error) {
      // A carrier rejection (transport refusal, page-load race) is transient. The answer
      // stays unknown and is read again, instead of latching the page into "no desktop"
      // with every path control missing until the next reload.
      console.warn('open-in-app: desktop availability read rejected:', error)
    }
    if (answer === null) {
      this.loading = undefined
      this.armRetry()
      return
    }
    if (this.retry !== undefined) {
      clearTimeout(this.retry)
      this.retry = undefined
    }
    this.desktop.set(answer)
  }

  /** Arm one bounded automatic re-read of a failed answer; mount-driven loads re-query past the bound. */
  private armRetry(): void {
    if (this.retries >= DESKTOP_RETRY_LIMIT || this.retry !== undefined) return
    this.retries += 1
    this.retry = setTimeout(() => {
      this.retry = undefined
      void this.load()
    }, this.retryBackoffMs)
  }
}
