import { describe, expect, it } from 'vitest'
import { StopGate } from '../src/client/stop-gate.ts'

const windows = { sendWindowMs: 300, stopWindowMs: 500 }

/** A gate reading the fixture windows so every assertion below injects `now`. */
function gate(): StopGate {
  return new StopGate(() => windows)
}

describe('StopGate', () => {
  it('opens on a cold gate so neither the first send nor the first stop is suppressed', () => {
    expect(gate().allowSend(0)).toBe(true)
    expect(gate().allowStop(0)).toBe(true)
  })

  it('suppresses a send landing inside the send window and releases once it elapses', () => {
    const subject = gate()
    expect(subject.allowSend(1_000)).toBe(true)
    expect(subject.allowSend(1_150)).toBe(false)
    expect(subject.allowSend(1_300)).toBe(true)
  })

  it('suppresses a stop landing right after the Send-to-Stop flip, whatever the send window', () => {
    // The flip can trail the send by more than the send window on a slow
    // network, which is exactly the gap a send-only anchor leaves open.
    const subject = gate()
    expect(subject.allowSend(1_000)).toBe(true)
    subject.noteStopFlip(1_400)
    expect(subject.allowStop(1_500)).toBe(false)
    expect(subject.allowStop(1_899)).toBe(false)
    expect(subject.allowStop(1_900)).toBe(true)
  })

  it('suppresses a stop that trails an accepted send inside the stop window', () => {
    const subject = gate()
    expect(subject.allowSend(5_000)).toBe(true)
    expect(subject.allowStop(5_200)).toBe(false)
    expect(subject.allowStop(5_500)).toBe(true)
  })

  it('keeps a stop eligible when the flip never happened in this mount', () => {
    // A bar that mounts already showing Stop records no flip, so a deliberate
    // stop is never swallowed by a window this mount never opened.
    const subject = gate()
    expect(subject.allowStop(10)).toBe(true)
  })

  it('reports each refused send to subscribers, once per attempt', () => {
    const subject = gate()
    const kinds: string[] = []
    const unsubscribe = subject.subscribeSwallow((kind) => { kinds.push(kind) })
    expect(subject.allowSend(1_000)).toBe(true)
    expect(subject.allowSend(1_100)).toBe(false)
    expect(subject.allowSend(1_200)).toBe(false)
    expect(kinds).toEqual(['send', 'send'])
    unsubscribe()
    expect(subject.allowSend(1_250)).toBe(false)
    expect(kinds).toEqual(['send', 'send'])
  })

  it('reports a refused stop once per attempt while an accepted one stays silent', () => {
    const subject = gate()
    const kinds: string[] = []
    subject.subscribeSwallow((kind) => { kinds.push(kind) })
    subject.noteStopFlip(1_000)
    expect(subject.allowStop(1_100)).toBe(false)
    expect(subject.allowStop(1_400)).toBe(false)
    expect(kinds).toEqual(['stop', 'stop'])
    expect(subject.allowStop(1_500)).toBe(true)
    expect(kinds).toEqual(['stop', 'stop'])
  })

  it('stays silent while every check passes', () => {
    const subject = gate()
    const kinds: string[] = []
    subject.subscribeSwallow((kind) => { kinds.push(kind) })
    expect(subject.allowSend(0)).toBe(true)
    // Past both windows from the accepted send — outside them, the stop is deliberate.
    expect(subject.allowStop(600)).toBe(true)
    expect(kinds).toEqual([])
  })
})
