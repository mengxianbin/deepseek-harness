// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { allowAllAccess } from '@deepseek-ai/dsh-client-test-runtime'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createWaterfallRequest, PendingQuestion, type QuestionCardSnapshot, type QuestionComposerProps } from '../src/client/contract/slots.ts'
import type { ArbitrateKey, ArbitrateOutcome } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AnswerSurfaceInsert } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { createQuestionDraftStore } from '../src/client/draft-store.ts'
import { QuestionComposer as Composer, intentSurfaceOf, parseRecommendedLabel } from '../src/client/QuestionComposer.tsx'
import { en, zh } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// Every session-scope fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)


const SID = 's1' as SessionId

const seatOver = (dict: Record<string, string>, common: Record<string, string>): QuestionComposerProps['t'] =>
  (key, params) => {
    const template = dict[key] ?? common[key] ?? key
    return params === undefined
      ? template
      : template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in params ? String(params[name]) : match)
  }

type SessionState = Parameters<Parameters<QuestionComposerProps['useSession']>[0]>[0]
type ConversationState = Parameters<Parameters<QuestionComposerProps['useConversation']>[0]>[0]
type ChatState = Parameters<Parameters<QuestionComposerProps['useChat']>[0]>[0]
type TrajectoryState = Parameters<Parameters<QuestionComposerProps['useTrajectory']>[0]>[0]
type InputState = Parameters<Parameters<QuestionComposerProps['useInput']>[0]>[0]
type AttentionState = Parameters<Parameters<QuestionComposerProps['useSessionStatus']>[0]>[0]

const sessionState: SessionState = {
  sessionId: SID,
  pendingSubmissions: [],
  running: false,
  subagent: null,
  removed: false,
  openState: 'open',
  openError: null,
  hasMore: false,
  loadingOlder: false,
  promptError: null,
  blank: false,
  lastAgentError: null,
  promptAttempted: false,
  awaitingFirstTurn: false,
}
const sessionList = {
  ids: [SID],
  byId: { [SID]: { id: SID, displayTitle: 'Session', running: false, retainedBy: {}, blank: false, updatedAt: 0 } },
  phase: 'ready' as const,
  projectionsBySession: {},
}
const attentionState: AttentionState = new Map()
const workspaceState = {
  items: [],
  archivedSessionIds: [],
  pinnedSessionIds: [],
  state: 'idle' as const,
  phase: 'ready' as const,
  error: null,
}
const conversationState: ConversationState = {
  views: { get: () => undefined, grouped: () => undefined },
  activeTargets: new Set(),
}
const emptyKeys: readonly string[] = []
const emptyNodeSource = { getSnapshot: () => undefined, subscribe: () => () => {} }
const chatState: ChatState = {
  order: emptyKeys,
  nodes: {
    get: () => undefined,
    source: () => emptyNodeSource,
    bottomSource: () => ({ getSnapshot: () => false, subscribe: () => () => {} }),
    turnDataSource: () => { throw new Error('unused') },
    processSource: () => emptyNodeSource,
    values: () => [],
  },
  locations: { getTurn: () => emptyKeys, getStep: () => emptyKeys },
  navigation: { items: () => [] },
  timeline: { turnOrder: [], turns: new Map() },
  legacy: {
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
  },
}
const trajectoryState: TrajectoryState = {
  eventNodes: [],
  eventLocations: new Map(),
  requests: [],
  callSchemas: new Map(),
  partial: null,
  runningCalls: [],
}
const inputState: InputState = {
  draft: '',
  attachmentIds: [],
  draftRev: 0,
  phase: 'plain',
  occurrences: [],
  queue: [],
}

/** Framework standard-kit stubs: the composer consumes the locale and draft-store seats;
 *  the composed props type mandates delivery of the rest (framework hooks are
 *  plain stubs per the client testing discipline). */
const kitBase: Omit<QuestionComposerProps, 'matched' | 'useStore' | 'useQuestionCard' | 'actions'> = {
  renderSlot: () => null,
  // Inert answer-surface face: this spec drives the flow's own handlers; the
  // wiring asserts itself through per-test overrides (see the answer-surface
  // describes) and the pipeline side lives in ui-input-trigger's spec.
  answerTriggers: {
    attach: () => () => {},
    track: () => {},
    arbitrate: () => 'pass',
  },
  SessionProvider: ({ children }) => children,
  session: undefined,
  sessionId: SID,
  pendingInteraction: undefined,
  useSession: selector => selector(sessionState),
  useSessions: selector => selector(sessionList),
  usePanelInfo, useResource,
  useSessionStatus: selector => selector(attentionState),
  useSessionRetainInfo: () => undefined,
  useWorkspaces: selector => selector(workspaceState),
  ...allowAllAccess,
  useConversation: selector => selector(conversationState),
  useChat: selector => selector(chatState),
  useTrajectory: selector => selector(trajectoryState),
  useProjection: (() => undefined),
  useInput: selector => selector(inputState),
  inputActions: {
    insertQuote: () => false,
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
    insertText: () => false,
    setDraft: () => { throw new Error('unused') },
    persistDraft: () => { throw new Error('unused') },
    addAttachments: () => { throw new Error('unused') },
    removeAttachment: () => { throw new Error('unused') },
    pruneAttachments: () => { throw new Error('unused') },
    submit: () => { throw new Error('unused') },
  },
  // The seat's key domain is question ∪ common.
  t: seatOver(zh, commonZh),
}

let kit: Omit<QuestionComposerProps, 'matched' | 'useQuestionCard'>
let draftInstance: ReturnType<ReturnType<typeof createQuestionDraftStore>['create']>

function QuestionComposer(props: Omit<QuestionComposerProps, 'useQuestionCard'>) {
  const source = props.matched
  const useQuestionCard = ((_key: string, selector?: (value: QuestionCardSnapshot | undefined) => unknown) => {
    const value = useSyncExternalStore(source.subscribe, source.getSnapshot)
    return selector === undefined ? value : selector(value)
  }) as QuestionComposerProps['useQuestionCard']
  return <Composer {...props} useQuestionCard={useQuestionCard} />
}

beforeEach(() => {
  localStorage.clear()
  const instance = createQuestionDraftStore().create(SID)
  draftInstance = instance
  const useStore: QuestionComposerProps['useStore'] = selector => useSyncExternalStore(
    listener => instance.subscribe(listener),
    () => selector(instance.getSnapshot()),
    () => selector(instance.getSnapshot()),
  )
  kit = { ...kitBase, useStore, actions: instance.actions }
})

/**
 * Approval intent: routes the batch to the retained option decision card
 * (ask-panel-retire-1127 D3 — an approval intent keeps QuestionFlow; an
 * intent-less batch never reaches a card at all, the chain selector declining
 * it so the resident composer keeps the seat, ask-native-input-1128). ask()
 * validation never runs in this spec, so the labels only have to exist for the
 * type.
 */
const approval = (approve: string, reject: string) => ({ kind: 'approval' as const, approve, reject })

const QUESTIONS: PendingQuestion['questions'] = [
  {
    id: 'profile', header: '偏好', question: '选择候选人类型',
    detail: '按当前空缺岗位的优先级选择。',
    intent: approval('工程落地型 (Recommended)', '研究潜力型'),
    options: [
      { label: '工程落地型 (Recommended)', description: '优先工程交付。' },
      { label: '研究潜力型', description: '优先研究能力。' },
    ],
  },
  {
    id: 'detail', question: '补充你的要求',
  },
  {
    id: 'signals', question: '选择重要信号（可多选）', multiSelect: true,
    options: [{ label: '系统设计' }, { label: '代码质量' }, { label: '产品判断' }],
  },
]

/** Pending waterfall fixture with observable Client response methods. */
function wait(questions: PendingQuestion['questions'] = QUESTIONS, deadline?: number) {
  const carrier = new PendingQuestion(SID, questions)
  const request = createWaterfallRequest(deadline, undefined, (channel) => { carrier.detachWaterfall(channel) })
  carrier.attachWaterfall(request.channel)
  const answer = vi.spyOn(carrier, 'answer')
  const dismiss = vi.spyOn(carrier, 'dismiss')
  void request.result.catch(() => {})
  return { carrier, answer, dismiss }
}

const answerBatch = (answers: object[]) => ({ answers })

describe('QuestionComposer', () => {
  it('a blocking request shows no wait status before or after the first edit, exactly as before timed questions', () => {
    // There is no countdown left to describe (ask-native-input-1128: a pending
    // question is unlimited), so the header keeps only the question itself —
    // and with the close affordance gone there is nothing to dismiss either.
    const { carrier } = wait()
    const view = render(<QuestionComposer matched={carrier} {...kit} />)
    const status = () => view.container.querySelector('[class*="waitStatus"]')

    expect(status()).toBeNull()
    expect(screen.queryByText('会一直等你回答')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /工程落地型/ }))
    expect(carrier.snapshot()).toMatchObject({ state: 'open', channel: 'waterfall' })
    expect(status()).toBeNull()
    expect(screen.queryByText('会一直等你回答')).toBeNull()
    expect(screen.queryByRole('button', { name: '慢慢回答' })).toBeNull()
    expect(screen.queryByRole('button', { name: '放弃整组问题' })).toBeNull()
  })

  it('keeps a recommended default selected without disturbing a timed wait', () => {
    const { carrier } = wait(QUESTIONS, Date.now() + 30_000)
    const view = render(<QuestionComposer matched={carrier} {...kit} />)
    expect(screen.getByRole('radio', { name: /工程落地型/ }).getAttribute('aria-checked')).toBe('true')
    expect(carrier.snapshot().channel).toBe('waterfall')

    fireEvent.click(screen.getByLabelText('下一题'))
    view.unmount()
    render(<QuestionComposer matched={carrier} {...kit} />)
    expect(carrier.snapshot().channel).toBe('waterfall')
    expect(screen.getByText('2 / 3')).toBeTruthy()
  })

  it('starts every recommended choice of a multi-select question selected', () => {
    const { carrier, answer } = wait([{
      id: 'checks', question: 'Which checks?', multiSelect: true,
      intent: approval('Unit (Recommended)', 'Lint'),
      options: [{ label: 'Unit (Recommended)' }, { label: 'Lint' }, { label: 'Types（推荐）' }],
    }])
    render(<QuestionComposer matched={carrier} {...kit} />)
    expect(screen.getByRole('checkbox', { name: 'Unit' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('checkbox', { name: 'Lint' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('checkbox', { name: 'Types' }).getAttribute('aria-checked')).toBe('true')

    // FORK dsh-local (ask-keys-focus 2026-11-17 A3): bare Enter on an option
    // is not a submit hijack — the event stays unprevented so the button's own
    // activation toggles the choice (jsdom never performs that activation, so
    // the click below stands in for it).
    const lint = screen.getByRole('checkbox', { name: 'Lint' })
    expect(fireEvent.keyDown(lint, { key: 'Enter' })).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'Lint' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(lint)
    expect(screen.getByRole('checkbox', { name: 'Lint' }).getAttribute('aria-checked')).toBe('true')

    // Shift+Enter on the only question continues the flow into a batch submit.
    fireEvent.keyDown(screen.getByRole('checkbox', { name: 'Lint' }), { key: 'Enter', shiftKey: true })
    expect(answer).toHaveBeenCalledWith(answerBatch([
      { id: 'checks', selected: ['Unit (Recommended)', 'Types（推荐）', 'Lint'] },
    ]))
  })

  it('keeps several recommended multi-select defaults without disturbing a timed wait', () => {
    const { carrier } = wait([
      {
        id: 'checks', question: 'Which checks?', multiSelect: true,
        intent: approval('Unit (Recommended)', 'Lint'),
        options: [{ label: 'Unit (Recommended)' }, { label: 'Lint' }, { label: 'Types (Recommended)' }],
      },
      { id: 'note', question: 'Anything else?' },
    ], Date.now() + 30_000)
    const view = render(<QuestionComposer matched={carrier} {...kit} />)
    fireEvent.click(screen.getByLabelText('下一题'))
    view.unmount()
    render(<QuestionComposer matched={carrier} {...kit} />)
    expect(carrier.snapshot().channel).toBe('waterfall')
    fireEvent.click(screen.getByLabelText('上一题'))
    expect(screen.getByRole('checkbox', { name: 'Unit' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('checkbox', { name: 'Types' }).getAttribute('aria-checked')).toBe('true')
  })

  it('starts only a recommended first choice of a single-select question selected', () => {
    const { carrier } = wait([
      { id: 'first', question: 'First?', intent: approval('A (Recommended)', 'B (Recommended)'), options: [{ label: 'A (Recommended)' }, { label: 'B (Recommended)' }] },
      { id: 'later', question: 'Later?', options: [{ label: 'C' }, { label: 'D (Recommended)' }] },
    ])
    render(<QuestionComposer matched={carrier} {...kit} />)
    expect(screen.getByRole('radio', { name: 'A' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'B' }).getAttribute('aria-checked')).toBe('false')

    fireEvent.click(screen.getByLabelText('下一题'))
    expect(screen.getByRole('radio', { name: 'C' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('radio', { name: 'D' }).getAttribute('aria-checked')).toBe('false')
  })

  it('clears a single-select pick when its own option is clicked again, without stepping the page', () => {
    const { carrier } = wait([
      { id: 'first', question: 'First?', intent: approval('A (Recommended)', 'B'), options: [{ label: 'A (Recommended)' }, { label: 'B' }] },
      { id: 'later', question: 'Later?', options: [{ label: 'C' }, { label: 'D' }] },
    ])
    render(<QuestionComposer matched={carrier} {...kit} />)
    const a = screen.getByRole('radio', { name: 'A' })
    expect(a.getAttribute('aria-checked')).toBe('true')

    // The recommended pick is the current selection, so this click removes it
    // (ask-deselect-1126 裁定 A) and the page stays put: a deselect is not a
    // step. The cleared draft reads as unanswered again.
    fireEvent.click(a)
    expect(a.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('1 / 2')).toBeTruthy()
    // The flow gesture reports the cleared draft as unanswered instead of
    // stepping. (getByLabelText('下一题') would hit the pager arrow, which turns
    // the page unconditionally — hence the option gesture here.)
    fireEvent.keyDown(a, { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('status').textContent).toBe('请选择一个选项或填写自定义答案。')

    // Clicking it back picks it again — and only then does the flow step on
    // (custom is empty, so reaching page 2 already implies the selection).
    // Re-query after the turn: the first node unmounted with page 1.
    fireEvent.click(a)
    expect(screen.getByText('2 / 2')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('上一题'))
    expect(screen.getByRole('radio', { name: 'A' }).getAttribute('aria-checked')).toBe('true')
  })

  it('classifies Enter on an option: bare selects through native activation, Shift/Ctrl+Enter runs the flow', () => {
    const { carrier, answer } = wait([
      { id: 'mode', question: 'Which mode?', intent: approval('Alpha', 'Beta'), options: [{ label: 'Alpha' }, { label: 'Beta' }] },
      { id: 'next', question: 'Then what?', options: [{ label: 'Gamma' }] },
    ])
    render(<QuestionComposer matched={carrier} {...kit} />)
    const alpha = screen.getByRole('radio', { name: 'Alpha' })
    // Bare Enter is never prevented and never submits: the button's own
    // activation runs choose() (jsdom does not perform it; the click below
    // stands in for the browser's Enter → click default action).
    expect(fireEvent.keyDown(alpha, { key: 'Enter' })).toBe(true)
    expect(alpha.getAttribute('aria-checked')).toBe('false')
    expect(answer).not.toHaveBeenCalled()
    fireEvent.click(alpha)
    // Single-select steps to the next question with the choice recorded.
    expect(screen.getByText('2 / 2')).toBeTruthy()

    // Ctrl+Enter (accelerated) is claimed for the flow, same as Shift+Enter:
    // it continues only when the current question is answered.
    const gamma = screen.getByRole('radio', { name: 'Gamma' })
    expect(fireEvent.keyDown(gamma, { key: 'Enter', ctrlKey: true })).toBe(false)
    expect(screen.getByRole('status').textContent).toBe('请选择一个选项或填写自定义答案。')
    fireEvent.click(gamma)
    expect(screen.getByRole('radio', { name: 'Gamma' }).getAttribute('aria-checked')).toBe('true')

    // The last question's continue gesture submits the whole batch.
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Gamma' }), { key: 'Enter', shiftKey: true })
    expect(answer).toHaveBeenCalledWith(answerBatch([
      { id: 'mode', selected: ['Alpha'] },
      { id: 'next', selected: ['Gamma'] },
    ]))
  })

  it('keeps an IME-composed Enter on an option with the IME', () => {
    const { carrier, answer } = wait([{
      id: 'mode', question: 'Which mode?', intent: approval('Alpha', 'Beta'),
      options: [{ label: 'Alpha' }, { label: 'Beta' }],
    }])
    render(<QuestionComposer matched={carrier} {...kit} />)
    const alpha = screen.getByRole('radio', { name: 'Alpha' })

    expect(fireEvent.keyDown(alpha, { key: 'Enter', isComposing: true })).toBe(true)
    expect(alpha.getAttribute('aria-checked')).toBe('false')
    expect(fireEvent.keyDown(alpha, { key: 'Enter', keyCode: 229 })).toBe(true)
    expect(alpha.getAttribute('aria-checked')).toBe('false')
    expect(answer).not.toHaveBeenCalled()
  })

  it('collects single, custom, and multi-select answers before one batch submit', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByText('偏好')).toBeTruthy()
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(screen.getByText('推荐')).toBeTruthy()
    expect(screen.getByText('工程落地型')).toBeTruthy()
    expect(screen.getByRole('radio', { name: /工程落地型/ }).getAttribute('aria-checked')).toBe('true')
    const detail = screen.getByText('按当前空缺岗位的优先级选择。')
    const scrollRegion = detail.closest('[data-question-scroll]')
    expect(scrollRegion).toBeTruthy()
    expect(scrollRegion?.contains(screen.getByRole('heading', { name: '选择候选人类型' }))).toBe(true)
    expect(scrollRegion?.contains(screen.getByRole('radio', { name: /工程落地型/ }))).toBe(true)
    expect(scrollRegion?.contains(screen.getByText('下一题').closest('button'))).toBe(false)
    // Page turn only: 工程落地型 is the pre-selected recommendation, and a click
    // on the selected option now clears it (ask-deselect-1126 裁定 A), so the
    // walk rides the pager instead of the option.
    fireEvent.click(screen.getByLabelText('下一题'))

    expect(screen.getByText('2 / 3')).toBeTruthy()
    // detail is per-question: the second question carries none.
    expect(screen.queryByText('按当前空缺岗位的优先级选择。')).toBeNull()
    expect(screen.queryByRole('button', { name: '填写答案' })).toBeNull()
    const custom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(custom, { target: { value: '要能独立排查线上问题' } })
    fireEvent.keyDown(custom, { key: 'Enter', shiftKey: true })

    expect(screen.getByText('3 / 3')).toBeTruthy()
    // The model's question text renders verbatim — no marker filtering.
    expect(screen.getByText('选择重要信号（可多选）')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '代码质量' }))
    const multiCustom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(multiCustom, { target: { value: '沟通能力' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '产品判断' }))
    expect(screen.getByRole('checkbox', { name: '系统设计' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('checkbox', { name: '代码质量' }).getAttribute('aria-checked')).toBe('true')
    expect((multiCustom as HTMLInputElement).value).toBe('沟通能力')
    fireEvent.keyDown(multiCustom, { key: 'Enter', shiftKey: true })

    // The domain face encoded the whole batch into one carrier envelope.
    expect(answer).toHaveBeenCalledWith(answerBatch([
      { id: 'profile', selected: ['工程落地型 (Recommended)'] },
      { id: 'detail', selected: [], custom: '要能独立排查线上问题' },
      { id: 'signals', selected: ['系统设计', '代码质量', '产品判断'], custom: '沟通能力' },
    ]))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在提交…' }).disabled).toBe(true)
  })

  it('keeps a single-select selection and a typed custom answer together', () => {
    const { carrier, answer } = wait([{
      id: 'one', question: 'Pick one', intent: approval('Alpha', 'Beta'), options: [{ label: 'Alpha' }, { label: 'Beta' }],
    }])
    render(<QuestionComposer matched={carrier} {...kit} />)

    // Pick first, then type: the typed answer must not clear the selection
    // (2026-11-25 裁定 B, ask-focus-restore-1125).
    fireEvent.click(screen.getByRole('radio', { name: 'Alpha' }))
    const custom = screen.getByPlaceholderText<HTMLTextAreaElement>(zh['custom.placeholder'])
    fireEvent.change(custom, { target: { value: '理由写在这里' } })
    // Re-pick another option: the typed answer must not be cleared either.
    fireEvent.click(screen.getByRole('radio', { name: 'Beta' }))
    expect(custom.value).toBe('理由写在这里')
    expect(screen.getByRole('radio', { name: 'Beta' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(answer).toHaveBeenCalledWith(answerBatch([
      { id: 'one', selected: ['Beta'], custom: '理由写在这里' },
    ]))
  })

  it('keeps a card-level remark across pages and submits it with the batch', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    // The 题外话 box opens from the footer toggle and takes the keyboard.
    const toggle = screen.getByRole('button', { name: zh['note.toggle'] })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    const note = screen.getByPlaceholderText(zh['note.placeholder'])
    expect(document.activeElement).toBe(note)
    fireEvent.change(note, { target: { value: '题外话：顺带看看部署日志' } })

    // Typed on the first page: page turns must not drop it. The first turn
    // rides the pager — clicking the pre-selected recommendation would now
    // clear it (ask-deselect-1126 裁定 A) and the batch below keeps it.
    // Skip is abolished (ask-native-input-1128), so the free-text question in
    // the middle is answered instead of stepped over.
    fireEvent.click(screen.getByLabelText('下一题'))
    expect(screen.getByText('2 / 3')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText(zh['custom.placeholder']), { target: { value: '只要能跑通' } })
    fireEvent.click(screen.getByLabelText('下一题'))
    expect(screen.getByText('3 / 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    expect(answer).toHaveBeenCalledWith({
      answers: [
        { id: 'profile', selected: ['工程落地型 (Recommended)'] },
        { id: 'detail', selected: [], custom: '只要能跑通' },
        { id: 'signals', selected: ['系统设计'] },
      ],
      note: '题外话：顺带看看部署日志',
    })
  })

  it('expands long copy in place without choosing an option', () => {
    const description = 'Remove the experimental client from every shipped template and require an explicit profile install.'
    const { carrier } = wait([{
      id: 'release', question: 'How should the release graph change?',
      intent: approval('Explicit install', 'Optional bundle'),
      options: [
        { label: 'Explicit install', description },
        { label: 'Optional bundle' },
        { label: 'Empty description', description: '' },
        { label: 'Whitespace description', description: '   ' },
      ],
    }])
    render(<QuestionComposer matched={carrier} {...kit} />)

    // CSS shows each toggle only while its copy overflows; every candidate is rendered.
    const heading = screen.getByRole('heading', { name: 'How should the release graph change?' })
    const [questionToggle, descriptionToggle, ...rest] = screen.getAllByRole('button', { name: '展开' })
    expect(rest).toHaveLength(0)
    if (questionToggle === undefined || descriptionToggle === undefined) throw new Error('Both copy toggles must render')
    expect(questionToggle.getAttribute('aria-describedby')).toBe(heading.id)
    expect(questionToggle.getAttribute('aria-controls')).toBe(heading.id)
    const option = screen.getByRole('radio', { name: 'Explicit install' })
    const text = screen.getByText(description)
    expect(option.getAttribute('aria-describedby')).toBe(text.id)
    expect(descriptionToggle.getAttribute('aria-controls')).toBe(text.id)
    expect(descriptionToggle.getAttribute('aria-describedby')).toBe(text.id)
    expect(descriptionToggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(descriptionToggle)
    expect(descriptionToggle.getAttribute('aria-expanded')).toBe('true')
    expect(descriptionToggle.getAttribute('aria-label')).toBe('收起')
    expect(text.closest('[data-option-row]')?.hasAttribute('data-expanded')).toBe(true)
    expect(screen.getByText(description)).toBe(text)
    expect(option.getAttribute('aria-checked')).toBe('false')
    expect(questionToggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(questionToggle)
    expect(questionToggle.getAttribute('aria-expanded')).toBe('true')
    expect(questionToggle.getAttribute('aria-label')).toBe('收起')
    expect(heading.parentElement?.hasAttribute('data-expanded')).toBe(true)
    fireEvent.click(questionToggle)
    fireEvent.click(descriptionToggle)
    expect(heading.parentElement?.hasAttribute('data-expanded')).toBe(false)
    expect(text.closest('[data-option-row]')?.hasAttribute('data-expanded')).toBe(false)
    expect(screen.getAllByRole('button', { name: '展开' })).toEqual([questionToggle, descriptionToggle])
  })

  it('resets scrolling and expanded copy when the question changes', () => {
    const firstDescription = 'First question detail that was expanded.'
    const secondDescription = 'Second question detail starts collapsed.'
    const { carrier } = wait([
      {
        id: 'first', question: 'First question?',
        intent: approval('Continue', 'Stop'),
        options: [{ label: 'Continue', description: firstDescription }],
      },
      {
        id: 'second', question: 'Second question?',
        options: [{ label: 'Continue', description: secondDescription }],
      },
    ])
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByRole('region', { name: 'First question?' })).toBeTruthy()
    const firstScroll = screen.getByText('First question?').closest('[data-question-scroll]') as HTMLElement
    firstScroll.scrollTop = 80
    for (const toggle of screen.getAllByRole('button', { name: '展开' })) fireEvent.click(toggle)
    expect(screen.getAllByRole('button', { name: '收起' }).map(toggle => toggle.getAttribute('aria-expanded'))).toEqual(['true', 'true'])
    fireEvent.click(screen.getByRole('radio', { name: 'Continue' }))

    const secondScroll = screen.getByText('Second question?').closest('[data-question-scroll]') as HTMLElement
    expect(screen.queryByRole('region', { name: 'First question?' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Second question?' })).toBeTruthy()
    expect(secondScroll).toBe(firstScroll)
    expect(secondScroll.scrollTop).toBe(0)
    expect(screen.queryByRole('button', { name: '收起' })).toBeNull()
    expect(secondScroll.querySelector('[data-expanded]')).toBeNull()
    expect(screen.queryByText(firstDescription)).toBeNull()
    const descriptionToggle = screen.getAllByRole('button', { name: '展开' })[1]
    expect(document.getElementById(descriptionToggle?.getAttribute('aria-controls') ?? '')?.textContent).toBe(secondDescription)
  })

  it('pins the body to its bottom while typing, and leaves a scrolled-up body alone', () => {
    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)
    const body = document.querySelector('[data-question-scroll]') as HTMLElement
    // jsdom has no layout: pin the metrics so "at the bottom" and "scrolled
    // up" are both expressible (own properties on HTMLElement.prototype
    // shadow Element's inherited zeros).
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 500 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 300 })
    try {
      const custom = screen.getByPlaceholderText(zh['custom.placeholder'])
      // At the bottom (200 + 300 = 500): a keystroke's growth pins the body
      // to its new bottom so the choices scroll out of view.
      body.scrollTop = 200
      fireEvent.change(custom, { target: { value: '一' } })
      expect(body.scrollTop).toBe(500)
      // Guard: the user scrolls up to read the choices — the next keystroke
      // must not yank the body back down.
      body.scrollTop = 100
      fireEvent.change(custom, { target: { value: '一二' } })
      expect(body.scrollTop).toBe(100)
    } finally {
      if (scrollHeightDescriptor === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
      } else {
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDescriptor)
      }
      if (clientHeightDescriptor === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
      } else {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightDescriptor)
      }
    }
  })

  it('keeps expansions with their question when the shared position moves elsewhere', () => {
    const { carrier } = wait([
      { id: 'first', question: 'First question?', intent: approval('Continue', 'Stop'), options: [{ label: 'Continue', description: 'First detail.' }] },
      { id: 'second', question: 'Second question?', options: [{ label: 'Continue', description: 'Second detail.' }] },
    ])
    render(<QuestionComposer matched={carrier} {...kit} />)
    fireEvent.click(screen.getAllByRole('button', { name: '展开' })[1] as HTMLElement)
    expect(screen.getByRole('button', { name: '收起' })).toBeTruthy()

    // Another surface of the same Session moves the shared question position.
    const blank = { selected: [], custom: '', skipped: false }
    act(() => { kit.actions.replace(carrier.key, { index: 1, drafts: [blank, blank] }) })

    expect(screen.getByRole('region', { name: 'Second question?' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '收起' })).toBeNull()
    expect(document.querySelector('[data-expanded]')).toBeNull()
  })

  it('renders plan detail through the shared assistant Markdown primitive', () => {
    const { carrier } = wait([{
      id: 'plan',
      question: '批准这个计划吗？',
      detail: '# 实施计划\n\n- **先验证**现状\n- 修改 `QuestionComposer`',
      intent: approval('批准', '拒绝'),
      options: [{ label: '批准' }],
    }])
    const view = render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByRole('heading', { level: 1, name: '实施计划' })).toBeTruthy()
    expect(view.container.querySelector('strong')?.textContent).toBe('先验证')
    expect(view.container.querySelector('code')?.textContent).toBe('QuestionComposer')
    expect(view.container.querySelectorAll('li')).toHaveLength(2)
  })

  it('answers each question in turn without discarding earlier answers', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByRole('radio', { name: /工程落地型/ }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByText('下一题').closest('button') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: '研究潜力型' }))
    expect(screen.getByText('2 / 3')).toBeTruthy()
    // Skip is abolished (ask-native-input-1128): the free-text question is
    // answered, and the last page submits the whole batch.
    fireEvent.change(screen.getByPlaceholderText('输入你的答案'), { target: { value: '补充说明' } })
    fireEvent.click(screen.getByLabelText('下一题'))
    expect(screen.getByText('3 / 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    expect(answer).toHaveBeenCalledWith(answerBatch([
      { id: 'profile', selected: ['研究潜力型'] },
      { id: 'detail', selected: [], custom: '补充说明' },
      { id: 'signals', selected: ['系统设计'] },
    ]))
  })

  it('keeps IME Enter inside the custom input until composition finishes', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.click(screen.getByRole('radio', { name: '研究潜力型' }))
    const custom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(custom, { target: { value: '中文输入' } })

    fireEvent.keyDown(custom, { key: 'Enter', isComposing: true })
    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()

    fireEvent.keyDown(custom, { key: 'Enter', keyCode: 229 })
    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()

    fireEvent.keyDown(custom, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('3 / 3')).toBeTruthy()
  })

  it('shows the inline custom input, reports missing answers, and supports pager navigation', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByPlaceholderText('输入你的答案')).toBeTruthy()
    // Page turn via the pager: 工程落地型 is already the selected recommendation,
    // and clicking the selected option now clears it (ask-deselect-1126 裁定 A).
    fireEvent.click(screen.getByLabelText('下一题'))
    const emptyCustom = screen.getByPlaceholderText('输入你的答案')
    // Plain Enter is the newline gesture: it neither advances nor validates.
    expect(fireEvent.keyDown(emptyCustom, { key: 'Enter' })).toBe(true)
    expect(screen.getByText('2 / 3')).toBeTruthy()
    // Shift+Enter runs the flow, which reports the missing answer.
    fireEvent.keyDown(emptyCustom, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('请选择一个选项或填写自定义答案。')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('下一题'))
    fireEvent.click(screen.getByRole('checkbox', { name: '产品判断' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(screen.getByText('请先完成这道问题。')).toBeTruthy()
    expect(screen.getByText('2 / 3')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('上一题'))
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()
  })

  it('answers over multiple lines: both fields grow with the draft and keep Enter a newline', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    // Both question shapes answer into a textarea, so the engine soft-wraps a
    // long answer and Enter breaks the line natively.
    const inline = screen.getByPlaceholderText('输入你的答案')
    expect(inline.tagName).toBe('TEXTAREA')

    const multiline = '第一行\n第二行'
    fireEvent.change(inline, { target: { value: multiline } })
    // The hidden height ruler carries the draft plus the trailing newline the
    // textarea's own last line needs, so the box is as tall as the answer.
    expect(inline.previousElementSibling?.textContent).toBe(`${multiline}\n`)
    // Enter belongs to the field, never to the flow: it stays unprevented.
    expect(fireEvent.keyDown(inline, { key: 'Enter' })).toBe(true)
    expect(screen.getByText('1 / 3')).toBeTruthy()

    fireEvent.keyDown(inline, { key: 'Enter', shiftKey: true })
    const optionless = screen.getByPlaceholderText('输入你的答案')
    expect(optionless.tagName).toBe('TEXTAREA')
    fireEvent.change(optionless, { target: { value: multiline } })
    expect(optionless.previousElementSibling?.textContent).toBe(`${multiline}\n`)
    expect(fireEvent.keyDown(optionless, { key: 'Enter' })).toBe(true)
    expect(screen.getByText('2 / 3')).toBeTruthy()

    fireEvent.keyDown(optionless, { key: 'Enter', shiftKey: true })
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    // Line breaks reach the model verbatim: nothing along the way flattens them.
    // The single-select's recommended default now rides alongside the typed
    // answer — the exclusivity that used to drop it is gone (2026-11-25 裁定 B).
    expect(answer).toHaveBeenCalledWith(answerBatch([
      { id: 'profile', selected: ['工程落地型 (Recommended)'], custom: multiline },
      { id: 'detail', selected: [], custom: multiline },
      { id: 'signals', selected: ['系统设计'] },
    ]))
  })

  it('surfaces answer rejection and resets local drafts for a different request', async () => {
    const first = wait()
    const view = render(<QuestionComposer matched={first.carrier} {...kit} />)

    fireEvent.click(screen.getByRole('radio', { name: /研究潜力型/ }))
    expect(screen.getByText('2 / 3')).toBeTruthy()
    const second = wait()
    second.answer
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockRejectedValueOnce('字符串错误')
    view.rerender(<QuestionComposer matched={second.carrier} {...kit} />)
    expect(screen.getByRole('radio', { name: /研究潜力型/ }).getAttribute('aria-checked')).toBe('false')

    // Page turn via the pager: the fresh card opens on the pre-selected
    // recommendation, and clicking it would now clear it (ask-deselect-1126).
    fireEvent.click(screen.getByLabelText('下一题'))
    const custom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(custom, { target: { value: 'x' } })
    fireEvent.keyDown(custom, { key: 'Enter', shiftKey: true })
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(second.answer).toHaveBeenNthCalledWith(1, answerBatch([
      { id: 'profile', selected: ['工程落地型 (Recommended)'] },
      { id: 'detail', selected: [], custom: 'x' },
      { id: 'signals', selected: ['系统设计'] },
    ]))
    expect(await screen.findByText('网络中断')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '提交' }).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(await screen.findByText('字符串错误')).toBeTruthy()
  })

  it('renders chrome copy through the English dictionary', () => {
    const { carrier } = wait([{ id: 'detail', question: '补充你的要求' }])
    render(<QuestionComposer matched={carrier} {...kit} t={seatOver(en, commonEn)} />)
    expect(screen.getByPlaceholderText('Type your answer')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remark' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy()
  })

  it('restores the current page and drafts after the strict Session entry remounts', () => {
    const pending = wait()
    const view = render(<QuestionComposer matched={pending.carrier} {...kit} />)
    fireEvent.click(screen.getByRole('radio', { name: /研究潜力型/ }))
    const custom = screen.getByPlaceholderText('输入你的答案')
    fireEvent.change(custom, { target: { value: '保留这段草稿' } })
    expect(screen.getByText('2 / 3')).toBeTruthy()

    view.unmount()
    render(<QuestionComposer matched={pending.carrier} {...kit} />)

    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>('输入你的答案').value).toBe('保留这段草稿')
    fireEvent.click(screen.getByLabelText('上一题'))
    expect(screen.getByRole('radio', { name: /研究潜力型/ }).getAttribute('aria-checked')).toBe('true')
  })
})

describe('PendingQuestion domain face', () => {
  it('exposes its Client render identity and scoped request values', () => {
    const question = new PendingQuestion(SID, QUESTIONS)
    expect(question.key).toMatch(/^question:[0-9a-f]{32}:\d+$/)
    expect(new PendingQuestion(SID, QUESTIONS).key).not.toBe(question.key)
    expect(question.sessionId).toBe(SID)
    expect(question.questions).toBe(QUESTIONS)
  })

  it('does not restore an old unnamed request draft into a new card', () => {
    draftInstance.actions.replace('question:1', {
      index: 7,
      drafts: [{ selected: ['stale'], custom: '', skipped: false }],
    })
    const question = new PendingQuestion(SID, QUESTIONS)
    render(<QuestionComposer matched={question} {...kit} />)

    expect(question.key).not.toBe('question:1')
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(screen.queryByText('stale')).toBeNull()
  })

  it('ignores persisted progress that no longer matches the question batch', () => {
    const carrier = new PendingQuestion(SID, QUESTIONS, ToolCallId('stale-progress'))
    draftInstance.actions.replace(carrier.key, { index: 7, drafts: [] })

    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByRole('heading', { name: QUESTIONS[0]!.question })).toBeTruthy()
    expect(screen.getByText(`1 / ${QUESTIONS.length}`)).toBeTruthy()
  })

  it('folds the card to the header strip on a press outside the frame, and the strip press expands it back', () => {
    const { carrier } = wait()
    const view = render(<QuestionComposer matched={carrier} {...kit} />)
    // Expanded: the option list is visible.
    expect(screen.getByRole('radiogroup')).toBeTruthy()
    // The manual minimize toggle is gone (2026-11-17 裁定 A1), and so is the
    // close action (ask-native-input-1128): the header strip carries no control.
    expect(screen.queryByLabelText(zh['nav.minimize'])).toBeNull()
    expect(view.container.querySelector('[class*="headerActions"] button')).toBeNull()
    // Fold: options leave the tree; the strip keeps the stem readable.
    fireEvent.pointerDown(view.container.ownerDocument.body, { bubbles: true })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByText('选择候选人类型')).toBeTruthy()
    // Expand: the strip press brings the options back.
    fireEvent.click(screen.getByText('选择候选人类型'))
    expect(screen.getByRole('radiogroup')).toBeTruthy()
  })

  it('keeps the close button out of the fold path and preserves drafts across a fold', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)
    // Page turn via the pager — clicking the pre-selected recommendation would
    // now clear it (ask-deselect-1126 裁定 A). The recommendation rides the
    // saved draft into the batch below either way; folding and re-expanding
    // must not lose either the picked option or the position.
    fireEvent.click(screen.getByLabelText('下一题'))
    fireEvent.pointerDown(document.body, { bubbles: true })
    fireEvent.click(screen.getByText('补充你的要求'))
    expect(screen.getByRole('radiogroup')).toBeTruthy()
    const custom = screen.getByPlaceholderText(zh['custom.placeholder'])
    fireEvent.change(custom, { target: { value: '要能独立排查线上问题' } })
    // Re-expanding over an EMPTY field must not steal focus into the
    // textarea: the fold-reentry restore ladder (2026-11-25 裁定 A,
    // ask-focus-restore-1125) is content-gated — with nothing typed at the
    // moment of re-entry the landing stays where it was. (With content the
    // ladder takes the caret to the field's end and both scrollports to their
    // bottoms — its own case below.)
    expect(document.activeElement).not.toBe(custom)
    fireEvent.click(screen.getByLabelText('下一题'))
    fireEvent.click(screen.getByRole('checkbox', { name: '系统设计' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(answer).toHaveBeenCalledWith(answerBatch([
      { id: 'profile', selected: ['工程落地型 (Recommended)'] },
      { id: 'detail', custom: '要能独立排查线上问题', selected: [] },
      { id: 'signals', selected: ['系统设计'] },
    ]))
  })

  it('re-expanding over a typed draft restores the caret and both scrollports to the end', () => {
    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)
    // Reach the optionless second question and write into its field first —
    // by pager, since clicking the pre-selected recommendation would now clear
    // it (ask-deselect-1126 裁定 A).
    fireEvent.click(screen.getByLabelText('下一题'))
    const custom = screen.getByPlaceholderText(zh['custom.placeholder'])
    fireEvent.change(custom, { target: { value: '第一段\n第二段' } })
    // Fold: the body unmounts, taking the caret and both scroll positions
    // with it — exactly what the ladder has to restore.
    fireEvent.pointerDown(document.body, { bubbles: true })
    expect(screen.queryByPlaceholderText(zh['custom.placeholder'])).toBeNull()
    // jsdom has no layout: pin the scrollports' metrics so the ladder has a
    // bottom to scroll to (own property on HTMLElement.prototype shadows
    // Element's inherited zero).
    const scrollTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 500 })
    try {
      fireEvent.click(screen.getByText('补充你的要求'))
      const restored = screen.getByPlaceholderText<HTMLTextAreaElement>(zh['custom.placeholder'])
      // Focus lands in the field, at the end of the text.
      expect(document.activeElement).toBe(restored)
      expect(restored.selectionStart).toBe(restored.value.length)
      expect(restored.selectionEnd).toBe(restored.value.length)
      // Both scrollports sit at their bottom.
      expect(restored.scrollTop).toBe(500)
      const body = document.querySelector('[data-question-scroll]') as HTMLElement
      expect(body.scrollTop).toBe(500)
    } finally {
      if (scrollTopDescriptor === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
      } else {
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollTopDescriptor)
      }
    }
  })

  it('a folded strip keeps the stem readable with no control to flash it open', () => {
    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)
    fireEvent.pointerDown(document.body, { bubbles: true })
    expect(screen.queryByRole('radiogroup')).toBeNull()

    // The close action left with the three pseudo-problem affordances
    // (ask-native-input-1128), so the strip has no button that could unfold it.
    expect(screen.getByText('选择候选人类型')).toBeTruthy()
    expect(document.querySelector('[class*="headerActions"] button')).toBeNull()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })
})

describe('attention fold', () => {
  /** The real seat ancestry, kept for realism: the sensor itself no longer
   *  reads transcript reach or the card's share of the viewport (2026-11-17
   *  裁定 A2 — any pointerdown/focusin outside the frame folds), so there is
   *  no layout left for jsdom to pin down. */
  function renderInSeatView(card: QuestionComposerProps['matched']) {
    const view = render(
      <div data-conversation-scroll="">
        <div data-composer-seat="">
          <QuestionComposer matched={card} {...kit} />
        </div>
      </div>,
    )
    const frame = view.container.querySelector('[data-question-key]') as HTMLElement
    return { view, frame }
  }

  it('a freshly presented question starts expanded: no fold fires without an outside gesture', () => {
    const { carrier } = wait()
    const { frame } = renderInSeatView(carrier)

    // Focus sits wherever it was before the card appeared; presentation alone
    // folds nothing — the sensor is edge-triggered on a card-external gesture.
    expect(screen.getByRole('radiogroup')).toBeTruthy()
    expect(frame.hasAttribute('data-question-folded')).toBe(false)
  })

  it('folds when a press lands outside the frame, and the strip press unfolds it', () => {
    const { carrier } = wait()
    const { frame } = renderInSeatView(carrier)
    expect(screen.getByRole('radiogroup')).toBeTruthy()

    // The reader presses the conversation to scroll/read: the card yields.
    fireEvent.pointerDown(document.querySelector('[data-conversation-scroll]')!, { bubbles: true })

    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByText('选择候选人类型')).toBeTruthy()
    expect(frame.hasAttribute('data-question-folded')).toBe(true)

    // Pressing the strip brings the card back; the fold flag lifts with it.
    fireEvent.click(screen.getByText('选择候选人类型'))
    expect(screen.getByRole('radiogroup')).toBeTruthy()
    expect(frame.hasAttribute('data-question-folded')).toBe(false)
  })

  it('folds on a press anywhere outside the frame — composer furniture included', () => {
    const { carrier } = wait()
    renderInSeatView(carrier)
    const seat = document.querySelector('[data-composer-seat]')!

    // Attention left the card: under the 2026-11-17 rule there is no
    // transcript-reach carve-out and no size gate — the seat counts too.
    fireEvent.pointerDown(seat, { bubbles: true })

    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('a press inside the card never folds it', () => {
    const { carrier } = wait()
    renderInSeatView(carrier)

    fireEvent.pointerDown(screen.getByRole('radiogroup'), { bubbles: true })

    expect(screen.getByRole('radiogroup')).toBeTruthy()
  })

  it('keeps focus inside the card on a text press: the frame takes focus itself, so the scrollport never reads as transcript reach', () => {
    const { carrier } = wait()
    const { frame } = renderInSeatView(carrier)

    // The browser contract behind the sensor: pressing non-focusable copy
    // (question title, option prose, markdown detail) moves focus to the
    // nearest focusable ancestor. The frame must be it — the alternative is
    // the transcript scrollport (tabIndex 0), whose focusin this sensor
    // reads as leaving the card and folds it under the reader's cursor.
    // jsdom never moves focus on click, so the escape itself is browser-only
    // (real-Chromium probe, 2026-11-12); this pins the containment — focus
    // arriving on the frame is card engagement: no fold, and it lifts an
    // auto-fold.
    expect(frame.getAttribute('tabindex')).toBe('-1')

    fireEvent.focusIn(frame, { bubbles: true })
    expect(screen.getByRole('radiogroup')).toBeTruthy()
    expect(frame.hasAttribute('data-question-folded')).toBe(false)

    fireEvent.pointerDown(document.querySelector('[data-conversation-scroll]')!, { bubbles: true })
    expect(screen.queryByRole('radiogroup')).toBeNull()

    fireEvent.focusIn(frame, { bubbles: true })
    expect(screen.getByRole('radiogroup')).toBeTruthy()
  })

  it('a busy submission keeps its card up even when the transcript is pressed', async () => {
    const { carrier, answer } = wait([{ id: 'scope', question: '选择范围', intent: approval('仅工具', '全部'), options: [{ label: '仅工具' }, { label: '全部' }] }])
    answer.mockReturnValueOnce(new Promise(() => {}))
    renderInSeatView(carrier)

    fireEvent.click(screen.getByRole('radio', { name: '仅工具' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在提交…' }).disabled).toBe(true)

    fireEvent.pointerDown(document.querySelector('[data-conversation-scroll]')!, { bubbles: true })

    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在提交…' })).toBeTruthy()
  })

  it('folds when focus reaches the transcript, and focus back into the card unfolds it', () => {
    const { carrier } = wait()
    renderInSeatView(carrier)

    fireEvent.focusIn(document.querySelector('[data-conversation-scroll]')!, { bubbles: true })
    expect(screen.queryByRole('radiogroup')).toBeNull()

    fireEvent.focusIn(screen.getByText('选择候选人类型'), { bubbles: true })
    expect(screen.getByRole('radiogroup')).toBeTruthy()
  })
})

describe('PageUp / PageDown question paging', () => {
  it('turns the page from anywhere in the card and leaves the boundaries alone', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)

    // The keydown bubbles from the focused option up to the frame, which
    // claims it (prevented) and moves through the pager's own motion.
    const option = screen.getByRole('radio', { name: /工程落地型/ })
    expect(fireEvent.keyDown(option, { key: 'PageDown' })).toBe(false)
    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(fireEvent.keyDown(screen.getByPlaceholderText('输入你的答案'), { key: 'PageDown' })).toBe(false)
    expect(screen.getByText('3 / 3')).toBeTruthy()

    // The last question's PageDown is a plain no-op: nothing submitted, the
    // key never claimed (native scroll stays the browser's own there).
    expect(fireEvent.keyDown(screen.getByRole('checkbox', { name: '系统设计' }), { key: 'PageDown' })).toBe(true)
    expect(screen.getByText('3 / 3')).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()

    // PageUp walks back the same way; the first question's PageUp is a no-op.
    expect(fireEvent.keyDown(screen.getByRole('checkbox', { name: '系统设计' }), { key: 'PageUp' })).toBe(false)
    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(fireEvent.keyDown(screen.getByPlaceholderText('输入你的答案'), { key: 'PageUp' })).toBe(false)
    expect(screen.getByText('1 / 3')).toBeTruthy()
    const firstOption = screen.getByRole('radio', { name: /工程落地型/ })
    expect(fireEvent.keyDown(firstOption, { key: 'PageUp' })).toBe(true)
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()
  })

  it('a busy submission does not turn the page', () => {
    const { carrier, answer } = wait([
      { id: 'one', question: 'First?', intent: approval('A', 'B'), options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'two', question: 'Second?', options: [{ label: 'C' }] },
    ])
    answer.mockReturnValueOnce(new Promise(() => {}))
    const view = render(<QuestionComposer matched={carrier} {...kit} />)
    fireEvent.click(screen.getByRole('radio', { name: 'A' }))
    fireEvent.click(screen.getByRole('radio', { name: 'C' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在提交…' }).disabled).toBe(true)

    const frame = view.container.querySelector('[data-question-key]') as HTMLElement
    expect(fireEvent.keyDown(frame, { key: 'PageUp' })).toBe(true)
    expect(screen.getByText('2 / 2')).toBeTruthy()
    expect(fireEvent.keyDown(frame, { key: 'PageDown' })).toBe(true)
    expect(screen.getByText('2 / 2')).toBeTruthy()
  })

  it('leaves the page keys to the IME and to a folded card', () => {
    const { carrier } = wait()
    const view = render(<QuestionComposer matched={carrier} {...kit} />)
    const frame = view.container.querySelector('[data-question-key]') as HTMLElement

    // IME composition keeps its keys: not claimed, no page turn.
    expect(fireEvent.keyDown(frame, { key: 'PageDown', isComposing: true })).toBe(true)
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(fireEvent.keyDown(frame, { key: 'PageDown', keyCode: 229 })).toBe(true)
    expect(screen.getByText('1 / 3')).toBeTruthy()

    // A folded card has no body to scroll: the keys are a no-op there too.
    fireEvent.pointerDown(view.container.ownerDocument.body, { bubbles: true })
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(fireEvent.keyDown(frame, { key: 'PageDown' })).toBe(true)
    expect(frame.hasAttribute('data-question-folded')).toBe(true)
  })
})

describe('focus follow after a page change', () => {
  it('hands focus to the new question when the auto-advance unmounts the focused option', () => {
    const { carrier } = wait([
      { id: 'one', question: 'First?', intent: approval('One', 'Two'), options: [{ label: 'One' }, { label: 'Two' }] },
      { id: 'two', question: 'Second?', options: [{ label: 'Three' }, { label: 'Four' }] },
    ])
    render(<QuestionComposer matched={carrier} {...kit} />)
    const one = screen.getByRole('radio', { name: 'One' })
    act(() => { one.focus() })
    fireEvent.focusIn(one, { bubbles: true })

    // Bare Enter → the button's native activation → choose(): the
    // single-select steps on and the focused option unmounts with its
    // question, dropping focus to the body. The card held focus, so the new
    // question's first enabled option takes it back — a run of Enter keeps
    // flowing.
    expect(fireEvent.keyDown(one, { key: 'Enter' })).toBe(true)
    fireEvent.click(one)
    expect(screen.getByText('2 / 2')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Three' }))
  })

  it('never steals focus parked on the pager', () => {
    // Both questions carry options, so neither page mounts the optionless
    // answer field that would legitimately autofocus on first presentation.
    const { carrier } = wait([
      { id: 'one', question: 'First?', intent: approval('One', 'Two'), options: [{ label: 'One' }] },
      { id: 'two', question: 'Second?', options: [{ label: 'Two' }] },
    ])
    render(<QuestionComposer matched={carrier} {...kit} />)
    const next = screen.getByLabelText<HTMLButtonElement>('下一题')
    act(() => { next.focus() })
    fireEvent.focusIn(next, { bubbles: true })

    fireEvent.click(next)

    expect(screen.getByText('2 / 2')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText('下一题'))
  })

  it('lands on the already-selected option when paging back (q-pagefocus)', () => {
    // FORK ask-ctrl-arrow-nav-1123 (裁定 q-pagefocus): the drafts keep their
    // selections across a page turn, so returning to a question restores the
    // keyboard to the choice that was already made — not the first row,
    // which read as "my previous choice was forgotten".
    const { carrier } = wait([
      { id: 'one', question: 'First?', intent: approval('One', 'Two'), options: [{ label: 'One' }, { label: 'Two' }] },
      { id: 'two', question: 'Second?', options: [{ label: 'Three' }, { label: 'Four' }] },
    ])
    render(<QuestionComposer matched={carrier} {...kit} />)
    const one = screen.getByRole('radio', { name: 'One' })
    const two = screen.getByRole('radio', { name: 'Two' })
    act(() => { one.focus() })
    fireEvent.focusIn(one, { bubbles: true })

    // Choosing Two (single-select) records the draft and steps to question 2;
    // the focused option unmounts, so focus-follow hands the new page its
    // first option (question 2 has no selection yet).
    fireEvent.click(two)
    expect(screen.getByText('2 / 2')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Three' }))

    // PageUp back: question 1's draft still has Two selected, so the landing
    // is Two — the choice survives the page turn in focus as well as data.
    // The option rows remount with the page, so the references captured on
    // the first page are detached by now: re-query the landing node.
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Three' }), { key: 'PageUp' })
    expect(screen.getByText('1 / 2')).toBeTruthy()
    const landed = screen.getByRole('radio', { name: 'Two' })
    expect(document.activeElement).toBe(landed)
    expect(landed.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'One' }).getAttribute('aria-checked')).toBe('false')
  })

  it('does not grab focus the card never held', () => {
    const { carrier } = wait([
      { id: 'one', question: 'First?', intent: approval('One', 'Two'), options: [{ label: 'One' }] },
      { id: 'two', question: 'Second?', options: [{ label: 'Two' }] },
    ])
    render(<QuestionComposer matched={carrier} {...kit} />)

    // No focus ever entered the card, so a page change must not pull it in
    // from wherever it currently sits (the body here).
    fireEvent.click(screen.getByLabelText('下一题'))

    expect(screen.getByText('2 / 2')).toBeTruthy()
    expect(document.activeElement).not.toBe(screen.getByRole('radio', { name: 'Two' }))
  })
})

describe('arrow keys switch the options', () => {
  it('claims a bare arrow on an option row but never moves focus, choice, or page', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)
    const first = screen.getByRole('radio', { name: /工程落地型/ })
    const second = screen.getByRole('radio', { name: /研究潜力型/ })
    act(() => { first.focus() })

    // FORK ask-ctrl-arrow-nav-1123: the bare-arrow walk is gone (superseded
    // by Ctrl+↑/↓). A bare ↓/↑ on an option row is claimed only so the page
    // does not scroll — focus stays on the same option, the selection does
    // not follow (a single-select arrow must not choose), and the card stays
    // on question 1.
    expect(fireEvent.keyDown(first, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(first)
    expect(fireEvent.keyDown(first, { key: 'ArrowUp' })).toBe(false)
    expect(document.activeElement).toBe(first)
    expect(second.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()
  })

  it('walks the Ctrl+↑/↓ ring across option rows and the answer field with wrap', () => {
    const { carrier, answer } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)
    const first = screen.getByRole('radio', { name: /工程落地型/ })
    const second = screen.getByRole('radio', { name: /研究潜力型/ })
    const field = screen.getByPlaceholderText<HTMLTextAreaElement>('输入你的答案')
    act(() => { first.focus() })

    // Forward: first option → last option → the answer field (focus in the
    // field, caret at the end for typing on), then wraps back to the first
    // option. Backward wraps the other way: first option → field, field →
    // last option. Selection and page never follow the ring.
    expect(fireEvent.keyDown(first, { key: 'ArrowDown', ctrlKey: true })).toBe(false)
    expect(document.activeElement).toBe(second)
    expect(fireEvent.keyDown(second, { key: 'ArrowDown', ctrlKey: true })).toBe(false)
    expect(document.activeElement).toBe(field)
    expect(field.selectionStart).toBe(field.value.length)
    expect(fireEvent.keyDown(field, { key: 'ArrowDown', ctrlKey: true })).toBe(false)
    expect(document.activeElement).toBe(first)
    expect(fireEvent.keyDown(first, { key: 'ArrowUp', ctrlKey: true })).toBe(false)
    expect(document.activeElement).toBe(field)
    expect(fireEvent.keyDown(field, { key: 'ArrowUp', ctrlKey: true })).toBe(false)
    expect(document.activeElement).toBe(second)
    expect(first.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(answer).not.toHaveBeenCalled()
  })

  it('keeps the answer-field bare arrows with the caret — zero hijack', () => {
    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} {...kit} />)
    const field = screen.getByPlaceholderText<HTMLTextAreaElement>('输入你的答案')
    act(() => { field.focus() })

    // The textarea's bare ↑/↓ belong to its own path (caret motion and the
    // '/' menu arbitration): unclaimed here, focus stays in the field — the
    // content layer is never hijacked by the ring.
    expect(fireEvent.keyDown(field, { key: 'ArrowDown' })).toBe(true)
    expect(document.activeElement).toBe(field)
    expect(fireEvent.keyDown(field, { key: 'ArrowUp' })).toBe(true)
    expect(document.activeElement).toBe(field)
  })

  it('moves a multi-select focus with Ctrl+↓ without toggling the choice', () => {
    const { carrier, answer } = wait([{
      id: 'checks', question: 'Which checks?', multiSelect: true,
      intent: approval('Unit', 'Lint'),
      options: [{ label: 'Unit' }, { label: 'Lint' }, { label: 'Types' }],
    }])
    render(<QuestionComposer matched={carrier} {...kit} />)
    const unit = screen.getByRole('checkbox', { name: 'Unit' })
    const lint = screen.getByRole('checkbox', { name: 'Lint' })
    act(() => { unit.focus() })

    expect(fireEvent.keyDown(unit, { key: 'ArrowDown', ctrlKey: true })).toBe(false)
    expect(document.activeElement).toBe(lint)
    expect(unit.getAttribute('aria-checked')).toBe('false')
    expect(lint.getAttribute('aria-checked')).toBe('false')
    expect(answer).not.toHaveBeenCalled()
  })

  it('leaves modified, composing, and locked keys to the browser', () => {
    const { carrier, answer } = wait([{
      id: 'one', question: 'First?',
      intent: approval('A', 'B'),
      options: [{ label: 'A', description: 'A detail' }, { label: 'B' }],
    }])
    answer.mockReturnValueOnce(new Promise(() => {}))
    render(<QuestionComposer matched={carrier} {...kit} />)
    const a = screen.getByRole('radio', { name: 'A' })
    act(() => { a.focus() })

    // Alt/Meta/Shift combos stay the browser's own — only the plain Ctrl
    // pair is the ring — and focus does not move.
    expect(fireEvent.keyDown(a, { key: 'ArrowDown', altKey: true })).toBe(true)
    expect(document.activeElement).toBe(a)
    expect(fireEvent.keyDown(a, { key: 'ArrowDown', metaKey: true })).toBe(true)
    expect(document.activeElement).toBe(a)
    expect(fireEvent.keyDown(a, { key: 'ArrowDown', shiftKey: true })).toBe(true)
    expect(document.activeElement).toBe(a)
    expect(fireEvent.keyDown(a, { key: 'Tab', ctrlKey: true })).toBe(true)
    expect(document.activeElement).toBe(a)

    // IME composition keeps its keys, same as the card's page keys.
    expect(fireEvent.keyDown(a, { key: 'ArrowDown', isComposing: true })).toBe(true)
    expect(fireEvent.keyDown(a, { key: 'ArrowDown', keyCode: 229 })).toBe(true)
    expect(document.activeElement).toBe(a)

    // A busy submission disables every option: the ring has no seat to hand
    // focus to, so Ctrl+↑/↓ stays unclaimed, and a bare arrow on the row's
    // still-enabled description toggle leaves focus parked where it is.
    fireEvent.click(a)
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在提交…' }).disabled).toBe(true)
    const row = a.closest('[data-option-row]') as HTMLElement
    const rowToggle = row.querySelector('button:not([disabled])') as HTMLButtonElement
    act(() => { rowToggle.focus() })
    expect(fireEvent.keyDown(rowToggle, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(rowToggle)
    expect(fireEvent.keyDown(rowToggle, { key: 'ArrowDown', ctrlKey: true })).toBe(true)
    expect(document.activeElement).toBe(rowToggle)
  })
})

describe('Tab leaves the option list in one press', () => {
  it('skips the remaining options forward to the answer field', () => {
    const { carrier } = wait([{
      id: 'one', question: 'First?', intent: approval('A', 'C'), options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
    }])
    render(<QuestionComposer matched={carrier} {...kit} />)
    const a = screen.getByRole('radio', { name: 'A' })
    act(() => { a.focus() })

    // One press past B and C lands in the answer field: the option buttons
    // are no longer a walk of their own.
    expect(fireEvent.keyDown(a, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(screen.getByPlaceholderText('输入你的答案'))
  })

  it('keeps the description toggles in the Tab path and walks back out of the list', () => {
    const { carrier } = wait([{
      id: 'one', question: 'First?',
      intent: approval('A', 'B'),
      options: [{ label: 'A', description: 'A detail' }, { label: 'B', description: 'B detail' }],
    }])
    render(<QuestionComposer matched={carrier} {...kit} />)
    const a = screen.getByRole('radio', { name: 'A' })
    const b = screen.getByRole('radio', { name: 'B' })
    const rowToggles = screen.getAllByRole('button', { name: '展开' })
      .filter(element => element.closest('[data-option-row]') !== null)
    expect(rowToggles).toHaveLength(2)
    const toggleA = rowToggles[0] as HTMLElement
    const toggleB = rowToggles[1] as HTMLElement

    // Tab first visits its own row's description toggle — disclosure stays
    // reachable — then skips option B to B's toggle, then the field.
    act(() => { a.focus() })
    expect(fireEvent.keyDown(a, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(toggleA)
    expect(fireEvent.keyDown(toggleA, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(toggleB)
    expect(fireEvent.keyDown(toggleB, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(screen.getByPlaceholderText('输入你的答案'))

    // Shift+Tab walks back over the skipped options to the first row's
    // toggle; from the first option it leaves the list for the header's
    // own toggle (the one outside every option row).
    act(() => { b.focus() })
    expect(fireEvent.keyDown(b, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(toggleA)
    const questionToggle = screen.getAllByRole('button', { name: '展开' })
      .find(element => element.closest('[data-option-row]') === null) as HTMLElement
    act(() => { a.focus() })
    expect(fireEvent.keyDown(a, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(questionToggle)
  })
})

describe('parseRecommendedLabel', () => {
  it('recognizes English and Chinese suffixes without changing ordinary labels', () => {
    expect(parseRecommendedLabel('Fast (Recommended)')).toEqual({ label: 'Fast', recommended: true })
    expect(parseRecommendedLabel('稳妥（推荐）')).toEqual({ label: '稳妥', recommended: true })
    expect(parseRecommendedLabel('稳妥 (推荐)')).toEqual({ label: '稳妥', recommended: true })
    expect(parseRecommendedLabel('Plain')).toEqual({ label: 'Plain', recommended: false })
  })
})

const TIMED: PendingQuestion['questions'] = [{
  id: 'scope', question: '选择范围', options: [{ label: '仅工具' }, { label: '全部' }],
}]

/** A timed card as the Remote Event listener builds it: waterfall channel with a Client-decided deadline. */
function timedCard(deadline: number, callId = ToolCallId('ask-timed')) {
  const carrier = new PendingQuestion(SID, TIMED, callId)
  const request = createWaterfallRequest(deadline, undefined, (channel) => { carrier.detachWaterfall(channel) })
  carrier.attachWaterfall(request.channel)
  void request.result.catch(() => {})
  return { carrier, request }
}

describe('timed card', () => {
  it('does not autofocus before claiming and never adopts the named deadline as a Client clock', async () => {
    vi.useFakeTimers()
    const carrier = new PendingQuestion(SID, [{ id: 'free', question: '补充说明' }], ToolCallId('claiming'))
    const request = createWaterfallRequest(Date.now() + 2_000, undefined,
      (channel) => { carrier.detachWaterfall(channel) })
    try {
      render(<QuestionComposer matched={carrier} {...kit} />)
      const field = screen.getByPlaceholderText(zh['custom.placeholder'])
      expect(document.activeElement).not.toBe(field)

      fireEvent.focus(field)
      act(() => { carrier.attachWaterfall(request.channel) })
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      // ask-native-input-1128: the wait is unlimited — no local clock, no
      // local settlement, whatever deadline the Host named.
      expect(carrier.snapshot()).toMatchObject({ state: 'open', channel: 'waterfall', closed: false })
      expect(screen.queryByText(/秒后继续工作/)).toBeNull()
    } finally {
      act(() => { request.channel.resolve({ answers: [{ id: 'free', selected: [] }] }) })
      await request.result
      cleanup()
      carrier.close()
      vi.useRealTimers()
    }
  })

  it('keeps the first edited draft and restores it after remount', async () => {
    vi.useFakeTimers()
    try {
      const first = timedCard(Date.now() + 1_000)
      let firstSettled = false
      void first.request.result.then(() => { firstSettled = true }, () => { firstSettled = true })
      const view = render(<QuestionComposer matched={first.carrier} {...kit} />)

      fireEvent.change(screen.getByPlaceholderText(zh['custom.placeholder']), { target: { value: '仅工具' } })
      expect(draftInstance.getSnapshot().progressByRequest[first.carrier.key]?.drafts[0]?.custom).toBe('仅工具')
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(firstSettled).toBe(false)

      view.unmount()
      const restored = timedCard(Date.now() + 1_000)
      let restoredSettled = false
      void restored.request.result.then(() => { restoredSettled = true }, () => { restoredSettled = true })
      render(<QuestionComposer matched={restored.carrier} {...kit} />)
      await act(async () => { await Promise.resolve() })
      expect(screen.getByPlaceholderText<HTMLTextAreaElement>(zh['custom.placeholder']).value).toBe('仅工具')
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(restoredSettled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never settles a timed waterfall locally and takes the RPC path once continued', async () => {
    vi.useFakeTimers()
    try {
      const { carrier, request } = timedCard(Date.now() + 1_500)
      let settled = false
      void request.result.then(() => { settled = true }, () => { settled = true })
      render(<QuestionComposer matched={carrier} {...kit} />)
      expect(screen.queryByText(/秒后继续工作/)).toBeNull()
      expect(screen.queryByRole('button', { name: '慢慢回答' })).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })

      expect(settled).toBe(false)
      expect(carrier.snapshot()).toEqual({
        state: 'open',
        channel: 'waterfall', closed: false,
      })

      const answer = vi.fn(async () => true)
      act(() => {
        // The waterfall settles out first: a continued card answers over the
        // Remote path, which is the one this assertion watches.
        carrier.detachWaterfall(request.channel)
        carrier.attachRpc({ answer })
        carrier.setState('continued')
      })
      expect(screen.getByText('已继续工作，仍可回答')).toBeTruthy()
      fireEvent.change(screen.getByPlaceholderText(zh['custom.placeholder']), { target: { value: '仅工具' } })
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '提交' }).disabled).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: '提交' }))
      await act(async () => { await Promise.resolve() })
      expect(answer).toHaveBeenCalledWith({ answers: [{ id: 'scope', selected: [], custom: '仅工具' }] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-arms the controls with a resubmit hint when a sent answer is dropped', async () => {
    const { carrier, request } = timedCard(Date.now() + 60_000)
    render(<QuestionComposer matched={carrier} {...kit} />)
    fireEvent.change(screen.getByPlaceholderText(zh['custom.placeholder']), { target: { value: '仅工具' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    await expect(request.result).resolves.toEqual({ answers: [{ id: 'scope', selected: [], custom: '仅工具' }] })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在提交…' }).disabled).toBe(true)
    expect(draftInstance.getSnapshot().progressByRequest[carrier.key]).toBeDefined()

    act(() => { carrier.setState('continued') })

    expect(screen.getByText('回答未送达，工作已继续，请再提交一次。')).toBeTruthy()
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>(zh['custom.placeholder']).value).toBe('仅工具')
    const answer = vi.fn(async () => true)
    act(() => { carrier.attachRpc({ answer }) })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await vi.waitFor(() => { expect(answer).toHaveBeenCalledWith({ answers: [{ id: 'scope', selected: [], custom: '仅工具' }] }) })
  })

  it('steers an RPC reply, hides the panel, and rejects a duplicate before discard', async () => {
    const carrier = new PendingQuestion(SID, TIMED, ToolCallId('ask-retry'))
    const answer = vi.fn(async () => true)
    const hide = vi.fn()
    answer.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('a reply is already queued for this question'))
    carrier.attachRpc({ answer })
    carrier.attachSeat({ hide })
    carrier.setState('continued')
    render(<QuestionComposer matched={carrier} {...kit} />)

    fireEvent.change(screen.getByPlaceholderText(zh['custom.placeholder']), { target: { value: '仅工具' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await vi.waitFor(() => { expect(hide).toHaveBeenCalledOnce() })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '提交' }).disabled).toBe(false)
    expect(screen.queryByText(zh['status.sent'])).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    expect(await screen.findByText('a reply is already queued for this question')).toBeTruthy()
    expect(answer).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await vi.waitFor(() => { expect(answer).toHaveBeenCalledTimes(3) })
    await vi.waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '提交' }).disabled).toBe(false)
    })
  })

  it('unlocks an older reply when the rendered channel lags its continued state', async () => {
    const carrier = new PendingQuestion(SID, TIMED, ToolCallId('ask-stale-channel'))
    const hide = vi.fn()
    carrier.attachRpc({ answer: vi.fn(async () => true) })
    carrier.attachSeat({ hide })
    carrier.setState('continued')
    const rendered = { ...carrier.snapshot(), state: 'open' as const, channel: 'waterfall' as const }
    const useQuestionCard = ((_key: string, selector?: (value: QuestionCardSnapshot | undefined) => unknown) =>
      selector === undefined ? rendered : selector(rendered)) as QuestionComposerProps['useQuestionCard']
    render(<Composer matched={carrier} {...kit} useQuestionCard={useQuestionCard} />)

    fireEvent.change(screen.getByPlaceholderText(zh['custom.placeholder']), { target: { value: '仅工具' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    await vi.waitFor(() => { expect(hide).toHaveBeenCalledOnce() })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '提交' }).disabled).toBe(false)
  })

  it('offers no close affordance on a continued panel — closing is a pseudo-problem', () => {
    const carrier = new PendingQuestion(SID, TIMED, ToolCallId('ask-continued'))
    const answer = vi.fn(async () => true)
    const hide = vi.fn()
    carrier.attachRpc({ answer })
    carrier.attachSeat({ hide })
    carrier.setState('continued')
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByText('已继续工作，仍可回答')).toBeTruthy()
    expect(screen.queryByText(/秒后继续工作/)).toBeNull()
    // The three pseudo-problem affordances are gone (ask-native-input-1128):
    // skip, close and the countdown leave the card with no dismissal at all.
    expect(screen.queryByLabelText('放弃整组问题')).toBeNull()
    expect(screen.queryByLabelText('收起问题面板，可从工具调用重新打开')).toBeNull()
    expect(document.querySelector('[class*="headerActions"] button')).toBeNull()
    expect(hide).not.toHaveBeenCalled()
    expect(answer).not.toHaveBeenCalled()
    expect(carrier.snapshot()).toMatchObject({ state: 'continued', channel: 'rpc', closed: false })
  })

  it('prunes drafts no card owns on mount and clears its own draft when the card closes', () => {
    kit.actions.replace('question:stale', { index: 0, drafts: [{ selected: [], custom: 'old', skipped: false }] })
    const { carrier } = timedCard(Date.now() + 60_000)
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(draftInstance.getSnapshot().progressByRequest['question:stale']).toBeUndefined()
    fireEvent.change(screen.getByPlaceholderText(zh['custom.placeholder']), { target: { value: '全部' } })
    expect(draftInstance.getSnapshot().progressByRequest[carrier.key]?.drafts[0]?.custom).toBe('全部')

    act(() => { carrier.close() })

    expect(draftInstance.getSnapshot().progressByRequest[carrier.key]).toBeUndefined()
  })
})

/** Controllable answer-surface face: every pipeline verb is observable. */
function triggerFace() {
  const track = vi.fn<(draft: string, caret: number, tier: 'plain' | 'frozen', draftRev: number) => void>()
  const arbitrate = vi.fn<(key: ArbitrateKey, composing: boolean) => ArbitrateOutcome>(() => 'pass')
  const detach = vi.fn()
  let target: AnswerSurfaceInsert | null = null
  const attach = vi.fn<(insert: AnswerSurfaceInsert) => (() => void)>((insert) => {
    target = insert
    return () => {
      target = null
      detach()
    }
  })
  return {
    face: { attach, track, arbitrate } satisfies QuestionComposerProps['answerTriggers'],
    attach, detach, track, arbitrate,
    /** The mounted field's insert target, or null while detached. */
    target: (): AnswerSurfaceInsert | null => target,
    /** Revision of the most recent track call. */
    rev: (): number => track.mock.calls.at(-1)?.[3] ?? 0,
  }
}

const answerField = (): HTMLTextAreaElement =>
  screen.getByPlaceholderText<HTMLTextAreaElement>('输入你的答案')

describe('QuestionComposer answer-surface wiring', () => {
  it('attaches while the field is mounted; collapse and unmount detach through the leased surface', () => {
    const { carrier } = wait()
    const harness = triggerFace()
    const view = render(<QuestionComposer matched={carrier} {...kit} answerTriggers={harness.face} />)
    expect(harness.attach).toHaveBeenCalledTimes(1)
    expect(harness.target()).not.toBeNull()
    // The takeover seats the menu anchor outside the clipping card.
    expect(view.container.querySelector('[class*="triggerAnchor"]')).toBeTruthy()

    // Folding unmounts the field: the surface lease releases with it.
    fireEvent.pointerDown(view.container.ownerDocument.body, { bubbles: true })
    expect(harness.detach).toHaveBeenCalledTimes(1)
    expect(harness.target()).toBeNull()
    expect(view.container.querySelector('[class*="triggerAnchor"]')).toBeNull()

    fireEvent.click(screen.getByText('选择候选人类型'))
    expect(harness.attach).toHaveBeenCalledTimes(2)

    view.unmount()
    expect(harness.detach).toHaveBeenCalledTimes(2)
    expect(harness.target()).toBeNull()
  })

  it('feeds edits to the pipeline with a content revision, and focus re-tracks without bumping it', () => {
    const { carrier } = wait()
    const harness = triggerFace()
    render(<QuestionComposer matched={carrier} {...kit} answerTriggers={harness.face} />)
    // Mount tracks the empty draft once.
    expect(harness.track.mock.calls.at(-1)).toEqual(['', expect.any(Number), 'plain', 1])

    const custom = answerField()
    fireEvent.change(custom, { target: { value: '/g' } })
    expect(harness.track.mock.calls.at(-1)).toEqual(['/g', expect.any(Number), 'plain', 2])

    // Caret/focus motion re-tracks the same content revision (CAS survives it).
    fireEvent.focus(custom)
    const afterFocus = harness.track.mock.calls.at(-1)!
    expect(afterFocus[0]).toBe('/g')
    expect(afterFocus[2]).toBe('plain')
    expect(afterFocus[3]).toBe(2)
  })

  it('arbitrates menu keys first: claimed keys are prevented, passed keys keep the field behavior', () => {
    const { carrier, answer } = wait()
    const harness = triggerFace()
    harness.arbitrate.mockReturnValue('consumed')
    render(<QuestionComposer matched={carrier} {...kit} answerTriggers={harness.face} />)
    const custom = answerField()

    expect(fireEvent.keyDown(custom, { key: 'ArrowDown' })).toBe(false)
    expect(harness.arbitrate).toHaveBeenLastCalledWith('down', false)
    fireEvent.keyDown(custom, { key: 'Tab', shiftKey: true })
    expect(harness.arbitrate).toHaveBeenLastCalledWith('tabBack', false)

    // A highlighted Enter settles the pick through the menu and never advances the flow.
    harness.arbitrate.mockReturnValue('pick-highlighted')
    fireEvent.change(custom, { target: { value: '/g' } })
    expect(fireEvent.keyDown(custom, { key: 'Enter' })).toBe(false)
    expect(harness.arbitrate).toHaveBeenLastCalledWith('enter', false)
    expect(answer).not.toHaveBeenCalled()

    // A passing Escape reaches the field untouched (no menu open).
    harness.arbitrate.mockReturnValue('pass')
    expect(fireEvent.keyDown(custom, { key: 'Escape' })).toBe(true)
    expect(harness.arbitrate).toHaveBeenLastCalledWith('escape', false)
  })

  it('applies a picked text over the pick-time span, restores the caret behind it, and refuses a stale revision', () => {
    const { carrier } = wait()
    const harness = triggerFace()
    render(<QuestionComposer matched={carrier} {...kit} answerTriggers={harness.face} />)
    const custom = answerField()
    fireEvent.change(custom, { target: { value: '/g' } })
    const rev = harness.rev()
    const insert = harness.target()
    expect(insert).not.toBeNull()

    let applied = false
    act(() => {
      applied = insert!('/go-run ', { start: 0, end: 2, draftRev: rev }, false)
    })
    expect(applied).toBe(true)
    const field = answerField()
    expect(field.value).toBe('/go-run ')
    expect(field.selectionStart).toBe('/go-run '.length)

    // Content moved on: the pick-time revision is stale and must be refused.
    act(() => {
      applied = insert!('/stale ', { start: 0, end: 3, draftRev: rev }, false)
    })
    expect(applied).toBe(false)
    expect(answerField().value).toBe('/go-run ')
  })

  it('tracks a locked field frozen so a submission in flight cannot leave a menu open', () => {
    const { carrier, answer } = wait([{
      id: 'only', question: '最后一题', intent: approval('Alpha', 'Reject'), options: [{ label: 'Alpha' }],
    }])
    const harness = triggerFace()
    render(<QuestionComposer matched={carrier} {...kit} answerTriggers={harness.face} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Alpha' }))
    fireEvent.keyDown(answerField(), { key: 'Enter', shiftKey: true })

    expect(answer).toHaveBeenCalledOnce()
    expect(harness.track).toHaveBeenLastCalledWith(expect.any(String), expect.any(Number), 'frozen', expect.any(Number))
  })
})

describe('intent routing at the composer fork', () => {
  it('a plan-review intent renders the plan decision card', () => {
    const carrier = new PendingQuestion(SID, [{
      id: 'plan',
      question: '批准这个计划吗？',
      detail: '# 计划\n\n先做 A，再做 B。',
      intent: { kind: 'plan-review', approve: '批准' },
      options: [{ label: '批准' }, { label: '拒绝' }],
    }])
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(document.querySelector('[data-plan-review-key]')).toBeTruthy()
    expect(document.querySelector('[data-question-native]')).toBeNull()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('an approval intent keeps the option decision card', () => {
    const carrier = new PendingQuestion(SID, [{
      id: 'grant',
      question: '允许这个操作吗？',
      intent: approval('允许', '拒绝'),
      options: [{ label: '允许' }, { label: '拒绝' }],
    }])
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByRole('radiogroup')).toBeTruthy()
    expect(document.querySelector('[data-question-native]')).toBeNull()
    expect(document.querySelector('[data-plan-review-key]')).toBeNull()
  })

  it('one approval intent in a mixed batch routes the whole batch to the option card', () => {
    const { carrier } = wait([
      { id: 'first', question: 'First?', intent: approval('One', 'Two'), options: [{ label: 'One' }] },
      { id: 'second', question: 'Second?' },
    ])
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.getByRole('radiogroup')).toBeTruthy()
    expect(document.querySelector('[data-question-native]')).toBeNull()
  })

  it('routes an intent-less request to the resident composer instead of a card', () => {
    const carrier = new PendingQuestion(SID, [{ id: 'plain', question: '一个普通问题' }])
    // The chain selector reads this same decision (ask-native-input-1128):
    // `native` declines the takeover, so the ordinary chat input keeps the
    // seat and no card is drawn for the request.
    expect(intentSurfaceOf(carrier.questions)).toEqual({ kind: 'native' })
  })
})

describe('folded long-content attachment row', () => {
  const FOLDED: PendingQuestion['questions'] = [{
    id: 'report',
    question: '长呈报收到？',
    detail: '（首屏摘要）以下内容已折叠。',
    attachment: { path: 'C:/Users/dev/.dsh/ask-reports/s1/report.md', chars: 4_200 },
    options: [{ label: '收到' }],
  }]

  it('offers the sidebar preview opener wired by the seat', () => {
    const { carrier } = wait(FOLDED)
    const openAttachment = vi.fn()
    render(<QuestionComposer matched={carrier} {...kit} openAttachment={openAttachment} />)

    expect(screen.getByText(/超长内容已折叠/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '在侧栏预览中打开' }))
    expect(openAttachment).toHaveBeenCalledWith('C:/Users/dev/.dsh/ask-reports/s1/report.md')
  })

  it('shows the file path when no opener is reachable', () => {
    const { carrier } = wait(FOLDED)
    render(<QuestionComposer matched={carrier} {...kit} />)

    expect(screen.queryByRole('button', { name: '在侧栏预览中打开' })).toBeNull()
    expect(screen.getByText('C:/Users/dev/.dsh/ask-reports/s1/report.md')).toBeTruthy()
  })

  it('renders no attachment row for a question without one', () => {
    const { carrier } = wait()
    render(<QuestionComposer matched={carrier} {...kit} openAttachment={() => {}} />)

    expect(screen.queryByText(/超长内容已折叠/)).toBeNull()
  })
})

it('retains custom-answer focus across Shift+Enter navigation between option questions', () => {
  const { carrier } = wait([
    { id: 'one', question: 'First?', intent: approval('One', 'Two'), options: [{ label: 'One', description: 'First description' }] },
    { id: 'two', question: 'Second?', options: [{ label: 'Two' }] },
  ])
  render(<QuestionComposer matched={carrier} {...kit} />)
  const choice = screen.getByRole('radio', { name: 'One' })
  expect(choice.getAttribute('aria-describedby')).toBeTruthy()
  expect(document.getElementById(choice.getAttribute('aria-describedby') as string)?.textContent).toBe('First description')
  const first = screen.getByRole('textbox')
  act(() => { first.focus() })
  fireEvent.change(first, { target: { value: 'first answer' } })
  fireEvent.keyDown(first, { key: 'Enter', shiftKey: true })
  expect(screen.getByRole('heading', { name: 'Second?' })).toBeTruthy()
  const second = screen.getByRole('textbox')
  expect(second).toBe(first)
  expect(document.activeElement).toBe(second)
  fireEvent.change(second, { target: { value: 'second answer' } })
  expect((second as HTMLTextAreaElement).value).toBe('second answer')
  expect(screen.getByRole('radio', { name: 'Two' }).getAttribute('aria-describedby')).toBeNull()
})
