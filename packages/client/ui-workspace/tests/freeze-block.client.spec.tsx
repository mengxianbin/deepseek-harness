// @vitest-environment jsdom
/**
 * §5.1 预告 + 输入预冻结（freeze-reclaim-design-1127 分期5）机检面:
 * 1. `freezeBlockReason` — a pending preview wins over the frozen record's
 *    own reason; frozen/locked word it through the locale; no state = a live
 *    composer (undefined).
 * 2. `syncFreezeBlocks` — raise the block for frozen/previewed Sessions,
 *    clear it the moment either map releases them, skip Sessions whose
 *    conversation scope does not exist yet (the list subscription retries),
 *    and keep the raised set exact (dispose clears exactly what it raised).
 * 3. 零 LLM、零回合 — preview set/clear and every sync are local writes:
 *    the fetch spy never fires.
 * 4. The row banner renders the announcement as `role=status`, and the wiring
 *    pin keeps the main row reading `usePreview` + the `previewing` modifier.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh } from '../src/client/locales.ts'
import { FreezePreviewBanner } from '../src/client/rows/Rows.tsx'
import { freezeBlockReason, syncFreezeBlocks, type FreezeBlockSessions } from '../src/client/session-actions/freeze-block.ts'
import { clearPreview, resetPreviewStore, setPreview, subscribePreview } from '../src/client/session-actions/fsm-freeze.ts'
import type { FrozenMap } from '../src/client/session-actions/fsm-freeze.ts'

const t = makeTranslate(zh)

const TASK_A = 'content/tech/ai/dsh/tasks.md#freeze-a'
const PREVIEW_TEXT = '❄️ 预告：即将冻结（内存让路）'

const frozen: FrozenMap = new Map([
  ['sess-frozen', { taskRef: TASK_A, mode: 'frozen', reason: '内存地板：FreeMB 1474 < 地板 1611（mem-floor watcher）' }],
])
const locked: FrozenMap = new Map([
  ['sess-locked', { taskRef: TASK_A, mode: 'locked', reason: '排队位：等待开工核验' }],
])
const empty: FrozenMap = new Map()

/** Fake session-scoped services: each id's `blocks.set` is its own spy. */
type BlocksSetMock = Mock<(sessionId: string, block: { readonly reason: string } | undefined) => void>

function fakeSessions(...ids: string[]): { sessions: FreezeBlockSessions; sets: Record<string, BlocksSetMock> } {
  const sets: Record<string, BlocksSetMock> = {}
  for (const id of ids) {
    sets[id] = vi.fn<(sessionId: string, block: { readonly reason: string } | undefined) => void>()
  }
  const sessions: FreezeBlockSessions = {
    list: { subscribe: vi.fn(() => () => {}) },
    scope: (id) => {
      const set = sets[id]
      if (set === undefined) return undefined
      return { get: () => ({ blocks: { set } }) }
    },
  }
  return { sessions, sets }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetPreviewStore()
})

describe('freezeBlockReason（预告 > 冻结原因；无态 = 输入常开）', () => {
  it('a pending preview wins over the frozen record reason', () => {
    const preview = new Map([['sess-frozen', PREVIEW_TEXT]])
    expect(freezeBlockReason('sess-frozen', { frozen, preview }, t)).toBe(PREVIEW_TEXT)
  })

  it('a frozen record words its own reason through the locale', () => {
    const reason = freezeBlockReason('sess-frozen', { frozen, preview: new Map() }, t)
    expect(reason).toContain('输入预冻结')
    expect(reason).toContain('内存地板：FreeMB 1474')
  })

  it('a locked record keeps the locked wording (排队位 family)', () => {
    const reason = freezeBlockReason('sess-locked', { frozen: locked, preview: new Map() }, t)
    expect(reason).toContain('已锁定')
    expect(reason).toContain('排队位：等待开工核验')
  })

  it('no state at all leaves the composer live', () => {
    expect(freezeBlockReason('sess-any', { frozen: empty, preview: new Map() }, t)).toBeUndefined()
  })
})

describe('syncFreezeBlocks（升块 / 降块 / 无作用域跳过）', () => {
  it('raises the block for a frozen Session and tracks it', () => {
    const { sessions, sets } = fakeSessions('sess-frozen')
    const tracked = new Set<string>()

    syncFreezeBlocks(sessions, { frozen, preview: new Map() }, tracked, t)

    expect(sets['sess-frozen']!.mock.calls[0]?.[1]?.reason).toContain('输入预冻结')
    expect(tracked).toEqual(new Set(['sess-frozen']))
  })

  it('clears the block the moment the map releases the Session', () => {
    const { sessions, sets } = fakeSessions('sess-frozen')
    const tracked = new Set<string>()
    syncFreezeBlocks(sessions, { frozen, preview: new Map() }, tracked, t)

    syncFreezeBlocks(sessions, { frozen: empty, preview: new Map() }, tracked, t)

    expect(sets['sess-frozen']).toHaveBeenLastCalledWith('sess-frozen', undefined)
    expect(tracked.size).toBe(0)
  })

  it('a Session with no conversation scope yet is skipped, then raised on retry', () => {
    const { sessions } = fakeSessions() // no scopes at all
    const tracked = new Set<string>()

    syncFreezeBlocks(sessions, { frozen, preview: new Map() }, tracked, t)
    expect(tracked.size).toBe(0)

    const { sessions: later, sets: laterSets } = fakeSessions('sess-frozen')
    syncFreezeBlocks(later, { frozen, preview: new Map() }, tracked, t)
    expect(laterSets['sess-frozen']).toHaveBeenCalledTimes(1)
    expect(tracked).toEqual(new Set(['sess-frozen']))
  })

  it('a previewed Session carries the preview text, not the frozen wording', () => {
    const { sessions, sets } = fakeSessions('sess-frozen')
    const tracked = new Set<string>()

    syncFreezeBlocks(sessions, { frozen, preview: new Map([['sess-frozen', PREVIEW_TEXT]]) }, tracked, t)

    expect(sets['sess-frozen']).toHaveBeenCalledWith('sess-frozen', { reason: PREVIEW_TEXT })
  })

  it('a previewed Session with no frozen record still blocks (预告先行)', () => {
    const { sessions, sets } = fakeSessions('sess-pre')
    const tracked = new Set<string>()

    syncFreezeBlocks(sessions, { frozen: empty, preview: new Map([['sess-pre', PREVIEW_TEXT]]) }, tracked, t)

    expect(sets['sess-pre']).toHaveBeenCalledWith('sess-pre', { reason: PREVIEW_TEXT })
    expect(tracked).toEqual(new Set(['sess-pre']))
  })
})

describe('零 LLM、零回合（preview 与 sync 皆本地写）', () => {
  it('setPreview / clearPreview / every sync never fetch', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { sessions } = fakeSessions('sess-frozen')

    setPreview('sess-frozen', PREVIEW_TEXT)
    syncFreezeBlocks(sessions, { frozen: empty, preview: new Map([['sess-frozen', PREVIEW_TEXT]]) }, new Set(), t)
    clearPreview('sess-frozen')
    syncFreezeBlocks(sessions, { frozen: empty, preview: new Map() }, new Set(), t)

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a repeated setPreview with the same reason does not re-notify', () => {
    const listener = vi.fn()
    const off = subscribePreview(listener)
    setPreview('sess-repeat', PREVIEW_TEXT)
    setPreview('sess-repeat', PREVIEW_TEXT)
    off()
    expect(listener).toHaveBeenCalledTimes(1)
    clearPreview('sess-repeat')
  })
})

describe('预告横幅（行内可见，role=status）', () => {
  it('renders the announcement text as a status strip', () => {
    render(<FreezePreviewBanner reason={PREVIEW_TEXT} />)
    expect(screen.getByRole('status').textContent).toBe(PREVIEW_TEXT)
  })

  it('wiring pin: the main row reads usePreview, applies the previewing modifier, and mounts the banner', () => {
    // jsdom rewrites import.meta.url off the file scheme — resolve from the
    // vitest cwd (the worktree root, as the ENOENT path proved).
    const src = readFileSync(join(process.cwd(), 'packages/client/ui-workspace/src/client/rows/Rows.tsx'), 'utf8')
    expect(src).toContain('usePreview(node.id)')
    expect(src).toContain('previewReason !== undefined && css.previewing')
    expect(src).toContain('<FreezePreviewBanner reason={previewReason} />')
  })
})
