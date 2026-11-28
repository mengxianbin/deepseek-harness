/** Card and waterfall settlement edges the composer and plugin specs do not reach. */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createWaterfallRequest, PendingQuestion } from '../src/client/contract/slots.ts'

const SID = 's1' as SessionId
const CALL = ToolCallId('call-1')
const QUESTIONS = [{ id: 'mode', question: 'Choose a mode' }]
const ANSWER = { answers: [{ id: 'mode', selected: ['Fast'] }] }

function attached(card: PendingQuestion, deadline?: number) {
  const request = createWaterfallRequest(deadline, undefined, (channel) => { card.detachWaterfall(channel) })
  card.attachWaterfall(request.channel)
  return { card, request }
}

describe('createWaterfallRequest', () => {
  it('settles once: later resolutions, rejections and delegations are ignored', async () => {
    const onSettle = vi.fn()
    const request = createWaterfallRequest(1_000, undefined, onSettle)
    request.channel.resolve(ANSWER)
    request.channel.reject('ASK_CANCELLED')
    request.channel.delegate()
    await expect(request.result).resolves.toBe(ANSWER)
    expect(onSettle).toHaveBeenCalledOnce()
    expect(request.channel.deadline).toBe(1_000)
  })

  it('rejects immediately when the request arrives already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const onSettle = vi.fn()
    const request = createWaterfallRequest(undefined, controller.signal, onSettle)
    await expect(request.result).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
    expect(onSettle).toHaveBeenCalledOnce()
  })
})

describe('PendingQuestion', () => {
  it('never adopts the request deadline as a Client clock', () => {
    vi.useFakeTimers()
    const card = new PendingQuestion(SID, QUESTIONS, CALL)
    try {
      attached(card, Date.now() + 60_000)
      expect(vi.getTimerCount()).toBe(0)
      expect(card.snapshot()).toMatchObject({ state: 'open', channel: 'waterfall', closed: false })
    } finally {
      card.close()
      vi.useRealTimers()
    }
  })

  it('never starts a local timer for an indefinite question', () => {
    vi.useFakeTimers()
    const card = new PendingQuestion(SID, QUESTIONS)
    try {
      attached(card)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      card.close()
      vi.useRealTimers()
    }
  })

  it('publishes only real state changes', () => {
    const card = new PendingQuestion(SID, QUESTIONS, CALL)
    const listener = vi.fn()
    card.subscribe(listener)

    card.setState('open')
    card.setState('continued')
    card.close()
    card.close()

    expect(listener).toHaveBeenCalledTimes(2)
    expect(card.snapshot()).toMatchObject({ state: 'continued', channel: 'none', closed: true })
    expect(card.liveKeys()).toEqual([card.key])
  })

  it('refuses to end an unnamed request that has no live channel', async () => {
    const card = new PendingQuestion(SID, QUESTIONS)
    expect(card.dismissal).toBe('cancel')
    await expect(card.dismiss()).rejects.toThrow(/no channel accepts a cancellation/)
  })

  it('turns a throwing settlement into the rejected submission', async () => {
    const boom = new Error('subscriber failed')
    const first = attached(new PendingQuestion(SID, QUESTIONS, CALL))
    first.card.subscribe(() => { throw boom })
    await expect(first.card.answer(ANSWER)).rejects.toBe(boom)

    const second = attached(new PendingQuestion(SID, QUESTIONS))
    const cancelled = expect(second.request.result).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    second.card.subscribe(() => { throw 'not an error' })
    await expect(second.card.dismiss()).rejects.toMatchObject({
      message: 'pending question cancellation failed', cause: 'not an error',
    })
    await cancelled
  })
})
