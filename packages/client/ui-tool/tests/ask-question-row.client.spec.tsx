// @vitest-environment jsdom
/**
 * ask_user_question toolview acceptance: `waiting` summary while running,
 * answered-count from the result JSON once settled (skipped answers
 * excluded), the same reading for a call a late reply answered, the
 * cancelled/interrupted verdicts, the still-answerable row's reopen action
 * and its closed counterpart, shared ToolRow state semantics for
 * interrupted/failed calls, and generic fallbacks on malformed results.
 *
 * ask-panel-retire-1127: the transcript/record card is retired — the row
 * keeps its summary/state, expands to the raw input/output sections, and
 * only an answerable call keeps the reopen (panel) action.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
// Export discipline: packages/client/AGENTS.md.
import { AskQuestionRow, askQuestionToolview } from '../src/client/tool/toolviews/ask-question-row.tsx'
import type { UserQuestionPanels } from '../src/client/contract/slots.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'

afterEach(cleanup)

const ARGS = JSON.stringify({ questions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
const READABLE_ARGS = JSON.stringify({ questions: [
  { id: 'goal', question: 'What do you want to accomplish?' },
  { id: 'scope', question: 'Which project should this apply to?' },
  { id: 'notes', question: 'Anything else?' },
] })
const PENDING_RESULT = JSON.stringify({ pending: true, callId: 'c1' })

const resultNode = (argsRaw: string, resultText: string | null, over?: Partial<ToolResultNode>): ToolResultNode => {
  const call = over?.call === undefined ? { name: 'ask_user_question', argsRaw } : over.call
  return {
    kind: 'tool-result', seq: 10, time: 2_000, callTime: 1_000, callId: 'c1',
    name: call?.name ?? '', args: call === null ? PartialArguments.EMPTY : PartialArguments.fromText(call.argsRaw),
    call,
    content: resultText === null ? [] : [{ type: 'text', text: resultText }],
    isError: false, subCalls: [], ...over,
  }
}

const runningCall = (argsRaw: string): ToolCallBlock =>
  ({ phase: 'start', args: PartialArguments.fromText(argsRaw), callId: 'c1', name: 'ask_user_question', argsRaw, turn: 1, step: 1, time: 1_000, subCalls: [] })

const t = makeTranslate(zh, commonZh)

/** What the row's environment says about the call, beyond the recorded block. */
interface RowEnvironment {
  /** Call ids the `userQuestions` projection still lists as answerable; absent = none. */
  answerable?: readonly string[]
  /** Answer batches the projection settled a late reply with, by call id; absent = none. */
  settled?: Readonly<Record<string, readonly unknown[]>>
  /** Pending steers mirrored by the durable Inbox projection. */
  inbox?: { readonly 'next-turn': readonly unknown[]; readonly 'next-step': readonly unknown[] }
  /** The injected reopen verb; absent = a panel is always there to show. */
  revealPanel?: (callId: string) => boolean
}

function rowProps(block: ToolCallBlock, env: RowEnvironment = {}): Parameters<typeof AskQuestionRow>[0] {
  const view = {
    active: (env.answerable ?? []).map(callId => ({ callId })),
    settled: Object.entries(env.settled ?? {}).map(([callId, answers]) => ({ callId, answers })),
  }
  const useProjection = (key: string, select: (value: unknown) => unknown) =>
    select(key === 'inbox' ? env.inbox : view)
  const props = {
    useDisclosure, callId: 'c1', toolName: 'ask_user_question', t,
    ...('kind' in block ? { phase: 'result', block } : { phase: block.phase, block }),
    openFile: vi.fn(),
    loadImage: vi.fn(async () => ''),
    sessionId: 's1' as SessionId,
    useSession: vi.fn(),
    useSessions: () => undefined,
    useProjection,
    revealPanel: env.revealPanel ?? (() => true),
  } as Parameters<typeof AskQuestionRow>[0]
  return props
}

const answers = (entries: unknown[]): string => JSON.stringify({ answers: entries })

const queuedReply = (callId: string, entries: unknown[]): unknown => ({
  source: { kind: 'user-question-reply', callId, outcome: 'answered' },
  content: [{ type: 'text', text: JSON.stringify({
    kind: 'answer_to_pending_question', tool: 'ask_user_question', callId, answers: entries,
  }) }],
})

/** Every pill the row can offer, by its visible copy. */
const PILL = { reopen: '回答' } as const

/** The disclosure toggle of either row shape, by its accessible name. */
const TOGGLE = '提问'

/** The panel verbs the registered toolview hands each row of one Session. */
interface PanelFace {
  revealPanel: (callId: string) => boolean
}

/** The keyed toolview declaration, as far as this spec reads it. */
interface ToolviewDeclaration {
  inject?: (sessionId: string) => PanelFace
}

/** The optional panel provider, as far as this spec calls it. */
type PanelProvider = UserQuestionPanels

/**
 * Apply the plugin against a fake root and return the face it injects into a
 * row of Session `s1`.
 * @param get - the root's optional-service lookup.
 * @returns the injected panel verbs.
 */
function injectedFace(get: (name: string) => PanelProvider | undefined): PanelFace {
  let declaration: ToolviewDeclaration | undefined
  askQuestionToolview.apply({
    get,
    slots: {
      inject: (_name: string, callback: () => () => void) => callback(),
      register: (declared: ToolviewDeclaration) => {
        declaration = declared
        return () => undefined
      },
    },
  } as never)
  const face = declaration?.inject?.('s1')
  if (face === undefined) throw new Error('the toolview registered no injected face')
  return face
}

describe('AskQuestionRow', () => {
  it('running call reads waiting (args-independent: the composer takeover shows the questions)', () => {
    const view = render(<AskQuestionRow {...rowProps(runningCall(ARGS))} />)
    expect(screen.getByText('提问')).toBeTruthy()
    expect(screen.getByText('等待回答')).toBeTruthy()
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(view.container.querySelector('[data-tool="ask_user_question"]')).not.toBeNull()
    expect(view.container.querySelector('[class*="panelButton"]')).toBeNull()
  })

  it('a running call the projection still lists offers its panel from the row body', () => {
    const revealPanel = vi.fn(() => true)
    render(<AskQuestionRow {...rowProps(runningCall(ARGS), { answerable: ['c1'], revealPanel })} />)

    fireEvent.click(screen.getByRole('button', { name: PILL.reopen }))
    expect(revealPanel).toHaveBeenCalledWith('c1')
  })

  it('a pending row keeps the disclosure on its leading glyph while the body reopens the panel', () => {
    const revealPanel = vi.fn(() => true)
    const view = render(<AskQuestionRow {...rowProps(
      resultNode(READABLE_ARGS, PENDING_RESULT),
      { answerable: ['c1'], revealPanel },
    )} />)

    // The panel row owns no row-wide disclosure target: only its leading
    // glyph toggles the body, so the pill can never double as a toggle.
    expect(view.container.querySelector('[data-disclosure-row]')?.getAttribute('role')).toBeNull()
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
    expect(revealPanel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: TOGGLE }))
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    expect(view.container.querySelector('[class*="ioCard"]')).not.toBeNull()

    // Reopening is not a disclosure: the body the user opened stays open.
    fireEvent.click(screen.getByRole('button', { name: PILL.reopen }))
    expect(revealPanel).toHaveBeenCalledWith('c1')
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
  })

  it('shows a queued steer as the answered count with no second answer action', () => {
    const revealPanel = vi.fn(() => true)
    const batch = [
      { id: 'goal', selected: ['Develop a feature'] },
      { id: 'scope', selected: [], custom: 'the web app' },
      { id: 'notes', selected: [] },
    ]
    render(<AskQuestionRow {...rowProps(
      resultNode(READABLE_ARGS, PENDING_RESULT),
      {
        answerable: ['c1'],
        inbox: { 'next-step': [queuedReply('other', batch), queuedReply('c1', batch)], 'next-turn': [] },
        revealPanel,
      },
    )} />)

    // A queued reply already owns this call's answer: a second submission
    // would reject with REPLY_QUEUED, so the reopen action is dropped while
    // the summary keeps the batch's answered count accurate.
    expect(screen.getByText('2/3 已回答')).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
    expect(revealPanel).not.toHaveBeenCalled()
  })

  it('returns to the answer action if the pending steer is removed', () => {
    const block = resultNode(READABLE_ARGS, PENDING_RESULT)
    const batch = [
      { id: 'goal', selected: ['Develop a feature'] },
      { id: 'scope', selected: [] },
      { id: 'notes', selected: [] },
    ]
    const view = render(<AskQuestionRow {...rowProps(block, {
      answerable: ['c1'], inbox: { 'next-step': [], 'next-turn': [queuedReply('c1', batch)] },
    })} />)
    expect(screen.getByText('1/3 已回答')).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()

    view.rerender(<AskQuestionRow {...rowProps(block, {
      answerable: ['c1'], inbox: { 'next-step': [], 'next-turn': [] },
    })} />)
    expect(screen.getByText('已继续工作，仍可回答')).toBeTruthy()
    expect(screen.getByRole('button', { name: PILL.reopen })).toBeTruthy()
  })

  it('an unrelated queued reply leaves this row answerable', () => {
    render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, PENDING_RESULT), {
      answerable: ['c1'],
      inbox: { 'next-step': [queuedReply('other', [])], 'next-turn': [] },
    })} />)
    expect(screen.getByRole('button', { name: PILL.reopen })).toBeTruthy()
    expect(screen.getByText('已继续工作，仍可回答')).toBeTruthy()
  })

  it('a queued reply for this call drops the answer action even when its payload is unreadable', () => {
    // The durable Inbox entry is keyed by its source, not its body: it says a
    // reply is already queued for this call, so reopening would hit
    // REPLY_QUEUED. An unreadable payload only costs the count refresh.
    const revealPanel = vi.fn(() => true)
    const bad = { source: { kind: 'user-question-reply', callId: 'c1' }, content: [
      { type: 'text', text: JSON.stringify({ kind: 'wrong', callId: 'c1', answers: [] }) },
    ] }
    render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, PENDING_RESULT), {
      answerable: ['c1'], inbox: { 'next-step': [], 'next-turn': [bad] }, revealPanel,
    })} />)
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
    expect(screen.getByText('已继续工作，仍可回答')).toBeTruthy()
    expect(revealPanel).not.toHaveBeenCalled()
  })

  it('keyboard activation of the pill leaves the row disclosure alone', () => {
    // The pill is a button inside the row's own header: without the keydown
    // guard, one Enter would both reopen the panel and toggle the body.
    const revealPanel = vi.fn(() => true)
    const view = render(<AskQuestionRow {...rowProps(
      resultNode(READABLE_ARGS, PENDING_RESULT),
      { answerable: ['c1'], revealPanel },
    )} />)
    fireEvent.click(screen.getByRole('button', { name: TOGGLE }))
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()

    fireEvent.keyDown(screen.getByRole('button', { name: PILL.reopen }), { key: 'Enter' })
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    expect(revealPanel).not.toHaveBeenCalled()
    expect(view.container.querySelector('[class*="ioCard"]')).not.toBeNull()
  })

  it('a reopen that finds no panel left expands the raw body instead of doing nothing', () => {
    // The projection lists the call but no card answers for it — a resumed
    // Session before its repair pass, or a composition with no question UI.
    const revealPanel = vi.fn(() => false)
    const view = render(<AskQuestionRow {...rowProps(
      resultNode(READABLE_ARGS, PENDING_RESULT),
      { answerable: ['c1'], revealPanel },
    )} />)

    fireEvent.click(screen.getByRole('button', { name: PILL.reopen }))
    expect(revealPanel).toHaveBeenCalledWith('c1')
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    const io = view.container.querySelector('[class*="ioCard"]')
    expect(io).not.toBeNull()
    expect(io?.textContent).toContain('What do you want to accomplish?')
    expect(io?.textContent).toContain('"pending":true')
  })

  it('a pending result the projection dropped reads as closed, with no action on its row', () => {
    // The recorded result stays `pending` after the reply, the skip, or the
    // timeout lands; the projection is what says the question is over.
    const view = render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, PENDING_RESULT))} />)

    expect(screen.getByText('已结束')).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
    expect(view.container.querySelector('[class*="panelButton"]')).toBeNull()
    expect(view.container.querySelector('[data-state="ok"]')).not.toBeNull()
    // Collapsed: the raw sections wait behind the disclosure.
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()
    expect(screen.queryByText(/"pending"/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const io = view.container.querySelector('[class*="ioCard"]')
    expect(io).not.toBeNull()
    expect(io?.textContent).toContain('What do you want to accomplish?')
    expect(io?.textContent).toContain('"pending":true')
  })

  it('reopens a crash-repaired question while the projection still lists it', () => {
    const revealPanel = vi.fn(() => true)
    const repaired = resultNode(READABLE_ARGS, 'The tool call was interrupted after it was recorded.', {
      isError: true, error: { name: 'SessionFormatError', code: 'TOOL_OUTCOME_UNKNOWN' },
    })
    render(<AskQuestionRow {...rowProps(repaired, { answerable: ['c1'], revealPanel })} />)

    expect(screen.getByText('已继续工作，仍可回答')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: PILL.reopen }))
    expect(revealPanel).toHaveBeenCalledWith('c1')
  })

  it('a late answer after crash repair reads as the answered count with no panel action', () => {
    const batch = [
      { id: 'goal', selected: ['Develop a feature'] },
      { id: 'scope', selected: [], custom: 'the web app' },
      { id: 'notes', selected: [] },
    ]
    const repaired = resultNode(READABLE_ARGS, 'The tool call was interrupted after it was recorded.', {
      isError: true, error: { name: 'SessionFormatError', code: 'TOOL_OUTCOME_UNKNOWN' },
    })
    render(<AskQuestionRow {...rowProps(repaired, { settled: { c1: batch } })} />)

    expect(screen.getByText('2/3 已回答')).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
    expect(screen.getByText('提问')).toBeTruthy()
  })

  it('shows an unreadable late reply after crash repair as closed', () => {
    const repaired = resultNode(READABLE_ARGS, 'The tool call was interrupted after it was recorded.', {
      isError: true, error: { name: 'SessionFormatError', code: 'TOOL_OUTCOME_UNKNOWN' },
    })
    render(<AskQuestionRow {...rowProps(repaired, { settled: { c1: [] } })} />)

    expect(screen.getByText('已结束')).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
  })

  it('a late reply makes its row read exactly like one answered in time', () => {
    // The timed call's own result is the timeout, so the answers come from the
    // projection; which one beat the clock is the agent's pacing, not the
    // reader's problem.
    const answered = [
      { id: 'goal', selected: ['Develop a feature'] },
      { id: 'scope', selected: [], custom: 'the web app' },
      { id: 'notes', selected: [] },
    ]
    const view = render(<AskQuestionRow {...rowProps(
      resultNode(READABLE_ARGS, PENDING_RESULT),
      { settled: { c1: answered } },
    )} />)

    expect(screen.getByText('2/3 已回答')).toBeTruthy()
    expect(screen.queryByText('已结束')).toBeNull()
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
    expect(screen.queryByText(/"pending"/)).toBeNull()

    // The readable record is the row's own input/output sections now.
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const io = view.container.querySelector('[class*="ioCard"]')
    expect(io).not.toBeNull()
    expect(io?.textContent).toContain('What do you want to accomplish?')
    expect(io?.textContent).toContain('"pending":true')
  })

  it('a reply that settled the call without answers leaves the row closed', () => {
    render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, PENDING_RESULT), { settled: { c1: [] } })} />)
    expect(screen.getByText('已结束')).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
  })

  it('a still-answerable row keeps its reopen pill even after another call was settled', () => {
    render(<AskQuestionRow {...rowProps(
      resultNode(READABLE_ARGS, PENDING_RESULT),
      { answerable: ['c1'], settled: { other: [{ id: 'goal', selected: ['x'] }] } },
    )} />)
    expect(screen.getByRole('button', { name: PILL.reopen })).toBeTruthy()
  })

  it('another session question being answered leaves this row alone', () => {
    render(<AskQuestionRow {...rowProps(runningCall(ARGS), { answerable: ['other'] })} />)
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
  })

  it('settled result counts answered entries (selected choices or custom text)', () => {
    render(<AskQuestionRow {...rowProps(resultNode(ARGS, answers([
      { id: 'a', selected: ['x'] },
      { id: 'b', selected: [], custom: 'freeform' },
      { id: 'c', selected: ['y', 'z'], custom: '' },
    ])))} />)
    expect(screen.getByText('3/3 已回答')).toBeTruthy()
  })

  it('an answerable row expands to the raw input/output sections, not a record card', () => {
    const view = render(<AskQuestionRow {...rowProps(
      resultNode(READABLE_ARGS, PENDING_RESULT),
      { answerable: ['c1'] },
    )} />)

    expect(screen.getByText('已继续工作，仍可回答')).toBeTruthy()
    expect(screen.getByRole('button', { name: PILL.reopen })).toBeTruthy()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: TOGGLE }))
    const io = view.container.querySelector('[class*="ioCard"]')
    expect(io).not.toBeNull()
    // IN carries the formatted argument JSON verbatim, OUT the result text.
    expect(io?.textContent).toContain('"question": "What do you want to accomplish?"')
    expect(io?.textContent).toContain('"question": "Which project should this apply to?"')
    expect(io?.textContent).toContain(PENDING_RESULT)
    // No record card: the transcript's paired question list is gone.
    expect(view.container.querySelector('[class*="transcript"]')).toBeNull()
    expect(screen.queryByText('未回答')).toBeNull()
  })

  it('only an answerable row offers the panel button', () => {
    const pending = resultNode(READABLE_ARGS, PENDING_RESULT)
    render(<AskQuestionRow {...rowProps(pending, { answerable: ['c1'] })} />)
    expect(screen.getByRole('button', { name: PILL.reopen })).toBeTruthy()
    cleanup()

    render(<AskQuestionRow {...rowProps(pending)} />)
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
    expect(screen.queryByText(/"pending"/)).toBeNull()
  })

  it('both row shapes render the ask tool identity and the collapsed summary', () => {
    const pending = resultNode(READABLE_ARGS, PENDING_RESULT)
    const panel = render(<AskQuestionRow {...rowProps(pending, { answerable: ['c1'] })} />)
    expect(panel.container.querySelector('[data-tool="ask_user_question"]')).not.toBeNull()
    expect(panel.container.querySelector('[data-variant="others"]')).not.toBeNull()
    expect(panel.container.querySelector('[data-state="ok"]')).not.toBeNull()
    cleanup()

    const plain = render(<AskQuestionRow {...rowProps(pending)} />)
    expect(plain.container.querySelector('[data-tool="ask_user_question"]')).not.toBeNull()
    expect(plain.container.querySelector('[data-variant="others"]')).not.toBeNull()
    expect(plain.container.querySelector('[data-state="ok"]')).not.toBeNull()
    expect(plain.container.querySelector('[class*="panelButton"]')).toBeNull()
  })
  it('a running row expands to its raw arguments while the composer waits', () => {
    const args = JSON.stringify({ questions: [{
      id: 'color',
      question: 'Which color do you prefer?',
      options: [{ label: 'Blue' }, { label: 'Green' }],
    }] })
    const view = render(<AskQuestionRow {...rowProps(runningCall(args))} />)

    expect(screen.getByText('等待回答')).toBeTruthy()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const io = view.container.querySelector('[class*="ioCard"]')
    expect(io).not.toBeNull()
    expect(io?.textContent).toContain('"question": "Which color do you prefer?"')
    expect(io?.textContent).toContain('Blue')
    expect(io?.textContent).toContain('Green')
  })

  it('a reader who collapses the raw body keeps it collapsed', () => {
    const view = render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, answers([
      { id: 'goal', selected: ['Develop a feature'] },
      { id: 'scope', selected: [] },
      { id: 'notes', selected: [] },
    ])))} />)
    expect(screen.getByText('1/3 已回答')).toBeTruthy()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(view.container.querySelector('[class*="ioCard"]')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { expanded: true }))
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()
    expect(screen.queryByText('What do you want to accomplish?')).toBeNull()
  })

  it('an answered legacy call reads as its answered count with raw sections, no pill', () => {
    // The projection never lists a call the blocking legacy tool made, so the
    // row has nothing to reopen; the answers read back through the row's own
    // input/output sections.
    const view = render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, answers([
      { id: 'goal', selected: ['Develop a feature'] },
      { id: 'scope', selected: [], custom: 'the web app' },
      { id: 'notes', selected: [] },
    ])))} />)

    expect(screen.getByText('2/3 已回答')).toBeTruthy()
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
    expect(view.container.querySelector('[class*="panelButton"]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const io = view.container.querySelector('[class*="ioCard"]')
    expect(io).not.toBeNull()
    expect(io?.textContent).toContain('What do you want to accomplish?')
    expect(io?.textContent).toContain('"answers"')
    expect(screen.queryByText('未回答')).toBeNull()
  })

  it('a settled call keeps its answered count when its arguments were unparseable', () => {
    const batch = [{ id: 'a', selected: ['x'] }]
    const view = render(<AskQuestionRow {...rowProps(resultNode('oops', answers(batch)), { settled: { c1: batch } })} />)
    expect(screen.getByText('1/1 已回答')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(view.container.querySelector('[class*="ioCard"]')).not.toBeNull()
  })

  it.each([
    { label: 'missing id', value: { selected: ['x'] }, count: '1/1 已回答' },
    { label: 'non-array selection', value: { id: 'a', selected: 'x' }, count: '0/1 已回答' },
    { label: 'non-string selection', value: { id: 'a', selected: [1] }, count: '1/1 已回答' },
    { label: 'non-string custom text', value: { id: 'a', selected: [], custom: 1 }, count: '0/1 已回答' },
  ])('a result with $label still gets its best-effort count ($count)', ({ value, count }) => {
    // Strict batch parsing rejects the entry; the lenient recount still says
    // how many questions carry an answer, so the summary never goes blank.
    const view = render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, answers([value])))} />)
    expect(screen.getByText(count)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(view.container.querySelector('[class*="ioCard"]')).not.toBeNull()
  })

  it('keeps generic diagnostics when a valid answer result includes a non-text block', () => {
    const resultText = answers([
      { id: 'goal', selected: ['Develop a feature'] },
      { id: 'scope', selected: ['deepseek-harness'] },
      { id: 'notes', selected: [] },
    ])
    const view = render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, resultText, {
      content: [
        { type: 'text', text: resultText },
        { type: 'reasoning', text: 'unexpected diagnostic' },
      ],
    }))} />)

    expect(screen.getByText(READABLE_ARGS)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(view.container.querySelector('[class*="ioCard"]')).not.toBeNull()
    expect(view.container.textContent).toContain('"type": "reasoning"')
    expect(view.container.textContent).toContain('"text": "unexpected diagnostic"')
  })

  it('skipped questions (no selection, no custom) stay out of the answered count', () => {
    const view = render(<AskQuestionRow {...rowProps(resultNode(ARGS, answers([
      { id: 'a', selected: ['x'] },
      { id: 'b', selected: [], custom: '' },
      { id: 'c' },
    ])))} />)
    expect(screen.getByText('1/3 已回答')).toBeTruthy()
    expect(view.container.querySelector('[data-state="ok"]')).not.toBeNull()
  })

  it.each([
    { label: 'non-JSON result text', text: 'oops' },
    { label: 'non-object result root', text: '"str"' },
    { label: 'null result root', text: 'null' },
    { label: 'missing answers array', text: '{"other":1}' },
    { label: 'null answer entries', text: '{"answers":[null]}' },
    { label: 'empty result content', text: null },
  ])('settled result falls back to the generic summary on $label', ({ text }) => {
    render(<AskQuestionRow {...rowProps(resultNode(ARGS, text))} />)
    expect(screen.getByText(ARGS)).toBeTruthy()
  })

  it.each([
    { label: 'a cancelled set', code: 'ASK_CANCELLED', summary: '已取消', state: 'ok' },
    { label: 'an aborted turn', code: 'ASK_ABORTED', summary: '已中断', state: 'stopped' },
  ])('$label reads its verdict with no answer action', ({ code, summary, state }) => {
    const view = render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, null,
      { isError: true, error: { name: 'UserQuestionError', code } }))} />)
    expect(screen.getByText(summary)).toBeTruthy()
    expect(view.container.querySelector(`[data-state="${state}"]`)).not.toBeNull()
    expect(screen.queryByRole('button', { name: PILL.reopen })).toBeNull()
    expect(view.container.querySelector('[class*="panelButton"]')).toBeNull()
  })

  it('user cancellation reads as cancelled with its raw diagnostics behind the disclosure', () => {
    // ASK_CANCELLED: the ask_user_question handler's cancel error.
    const view = render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, null,
      { isError: true, error: { name: 'UserQuestionError', code: 'ASK_CANCELLED' } }))} />)
    expect(screen.getByText('已取消')).toBeTruthy()
    expect(view.container.querySelector('[data-state="ok"]')).not.toBeNull()
    expect(view.container.querySelector('[class*="panelButton"]')).toBeNull()
    // Collapsed: no raw JSON or error body on screen yet.
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()
    expect(screen.queryByText(/"questions"/)).toBeNull()
    expect(screen.queryByText(/the user cancelled ask_user_question/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const io = view.container.querySelector('[class*="ioCard"]')
    expect(io).not.toBeNull()
    expect(io?.textContent).toContain('What do you want to accomplish?')
    expect(io?.textContent).toContain('UserQuestionError: ASK_CANCELLED')
  })

  it('a turn abort reads as stopped with its raw arguments behind the disclosure', () => {
    // ASK_ABORTED: the ask handler's turn-abort settlement.
    const view = render(<AskQuestionRow {...rowProps(resultNode(READABLE_ARGS, null,
      { isError: true, error: { name: 'UserQuestionError', code: 'ASK_ABORTED' } }))} />)
    expect(screen.getByText('已中断')).toBeTruthy()
    expect(view.container.querySelector('[data-state="stopped"]')).not.toBeNull()
    expect(view.container.querySelector('[class*="panelButton"]')).toBeNull()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const io = view.container.querySelector('[class*="ioCard"]')
    expect(io).not.toBeNull()
    expect(io?.textContent).toContain('What do you want to accomplish?')
  })

  it.each([
    { label: 'non-JSON args', args: 'oops' },
    { label: 'an empty question set', args: '{"questions":[]}' },
    { label: 'a question without visible text', args: '{"questions":[{"id":"a"}]}' },
  ])('cancelled result keeps raw diagnostics for $label', ({ args }) => {
    const view = render(<AskQuestionRow {...rowProps(resultNode(args, null,
      { isError: true, error: { name: 'UserQuestionError', code: 'ASK_CANCELLED' } }))} />)
    expect(screen.getByText('已取消')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(view.container.querySelector('[class*="ioCard"]')).not.toBeNull()
  })

  it('an interrupted turn reads as stopped, not cancelled', () => {
    const view = render(<AskQuestionRow {...rowProps(resultNode(ARGS, null,
      { isError: true, error: { name: 'Interrupted', code: 'interrupted' } }))} />)
    expect(view.container.querySelector('[data-state="stopped"]')).not.toBeNull()
    expect(view.container.querySelector('[data-state="stopped"] svg')).not.toBeNull()
    expect(screen.queryByText('已取消')).toBeNull()
    expect(screen.getByText(ARGS)).toBeTruthy()
  })

  it('other tool errors keep the generic summary with the error state', () => {
    const view = render(<AskQuestionRow {...rowProps(resultNode(ARGS, null, { isError: true }))} />)
    expect(view.container.querySelector('[data-state="error"]')).not.toBeNull()
    expect(view.container.querySelector('[data-state="error"] svg')).not.toBeNull()
    expect(screen.getByText(ARGS)).toBeTruthy()
  })

  it('window-truncated result (call head lost) falls back to the callId summary', () => {
    render(<AskQuestionRow {...rowProps(resultNode('', null, { call: null }))} />)
    expect(screen.getByText('c1')).toBeTruthy()
  })

  it('leading toggle expands the raw args body', () => {
    render(<AskQuestionRow {...rowProps(resultNode(ARGS, answers([])))} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
  })

  it('askQuestionToolview injects the toolview declaration directly', () => {
    expect(askQuestionToolview.name).toBe('ask-question-toolview')
    expect(askQuestionToolview.inject).toEqual(['slots'])
    const register = vi.fn((_declaration: ToolviewDeclaration, _view: unknown) => () => undefined)
    const inject = vi.fn((_name: string, callback: () => () => void) => callback())
    askQuestionToolview.apply({ slots: { inject, register }, get: () => undefined } as never)
    expect(inject).toHaveBeenCalledWith('tool.call.toolview', expect.any(Function))
    expect(register).toHaveBeenCalledWith(
      {
        name: 'tool.call.toolview', key: 'ask_user_question', locale: 'conversation',
        inject: expect.any(Function) as ToolviewDeclaration['inject'],
      },
      AskQuestionRow,
    )
  })

  it('the injected reveal verb asks the optional panel provider for the row own session', () => {
    const reveal = vi.fn<UserQuestionPanels['reveal']>(() => true)
    const get = vi.fn((_name: string): PanelProvider => ({
      reveal: (_sessionId, callId) => reveal(_sessionId, callId),
    }))
    expect(injectedFace(get).revealPanel('c1')).toBe(true)
    expect(get).toHaveBeenCalledWith('userQuestionPanels')
    expect(reveal).toHaveBeenCalledWith('s1', 'c1')
  })

  it('a composition with no question UI exposes only revealPanel, and it reports no panel', () => {
    const face = injectedFace(() => undefined)
    // ask-panel-retire-1127: the read-only review verb is retired with the
    // record card — the injected face is revealPanel alone.
    expect(Object.keys(face)).toEqual(['revealPanel'])
    expect(face.revealPanel('c1')).toBe(false)
  })
})
