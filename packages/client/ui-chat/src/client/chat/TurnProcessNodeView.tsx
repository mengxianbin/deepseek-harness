import { Fragment, memo } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { turnProcessAlwaysOpen } from '../contract/turn-process.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { formatMessageClock, formatRunDuration } from './message-chrome.ts'
import { useCalendarDay } from './use-calendar-day.ts'
import a11yCss from './accessibility.module.css'
import css from './TurnProcessNodeView.module.css'

/** Settled Turn duration and process disclosure above its content. */
export const TurnProcessNodeView = memo(function TurnProcessNodeView({
  node, turnProcess, t, useChat,
}: ChatNodeViewProps<'turn-process'>) {
  const day = useCalendarDay()
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  // The window's ending instant follows the footer clock: this Turn's last
  // content-bearing reply, so the two views can never disagree; a Turn that
  // closed without a reply (stop, failure) falls back to its recorded end.
  const replyTime = useChat((snapshot) => {
    if (turn === undefined) return null
    for (const key of snapshot.locations.getTurn(turn.turn)) {
      const tail = snapshot.nodes.get(key) as ChatNode | undefined
      if (tail?.kind === 'turn-tail') return tail.data.closing?.time ?? null
    }
    return null
  })
  if (turnProcess === undefined) throw new Error('turn-process node requires Turn process owner state')
  const open = !turnProcess.foldable || turnProcess.open
  if (turn?.status !== 'closed') return null
  const canCollapse = turnProcess.foldable && turnProcess.hasContent && !turnProcessAlwaysOpen(node)
  const reason = turn.end?.data.reason.kind
  const stopped = reason === 'aborted' || reason === 'interrupted'
  const elapsedMs = turn.start === undefined || turn.end === undefined ? undefined
    : Math.max(1000, turn.end.time - turn.start.time)
  const duration = elapsedMs === undefined || stopped || reason === 'error' ? undefined
    : formatRunDuration(elapsedMs, t)
  // Other end reasons retain elapsed time; only stops and failure replace it.
  const label = stopped ? t('message.stopped')
    : reason === 'error' ? t('message.turnProcess.failed')
      : duration === undefined ? t('message.turnProcess.worked')
        : t('message.turnProcess.took')
  const announcement = stopped ? t('message.stopped')
    : reason === 'error' ? t('message.turnProcess.failed')
      : t('message.turnProcess.worked')
  // Recorded Turn window as shared message-clock times: start when loaded,
  // then the ending instant chosen above; each side prints alone when the
  // other side sits outside the loaded window (no substitute start times).
  const windowClock: { iso: string; label: string }[] = []
  if (turn.start !== undefined) {
    windowClock.push({
      iso: new Date(turn.start.time).toISOString(),
      label: formatMessageClock(turn.start.time, t, day),
    })
  }
  const windowEnd = replyTime ?? turn.end?.time
  if (windowEnd !== undefined) {
    windowClock.push({ iso: new Date(windowEnd).toISOString(), label: formatMessageClock(windowEnd, t, day) })
  }
  return (
    <>
      <span className={a11yCss.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
      <button
        type="button"
        className={css.root}
        data-open={open || undefined}
        data-turn-process={node.data.turn}
        data-turn-process-messages={node.data.messageCount}
        data-turn-process-tool-calls={node.data.toolCallCount}
        data-turn-process-subagents={node.data.subagentCount}
        disabled={!canCollapse}
        aria-expanded={turnProcess.hasContent ? open : undefined}
        onClick={(event) => {
          event.currentTarget.focus()
          turnProcess.setOpen(!open)
        }}
      >
        <span className={css.label}>
          {label}
          {duration?.map((part, index) => (
            <span key={index} className={part.numeric ? css.durationNumber : undefined}>{part.text}</span>
          ))}
        </span>
        {windowClock.length > 0 && (
          <span className={css.clock} data-turn-process-window="">
            {windowClock.map((entry, index) => (
              <Fragment key={index}>
                {index > 0 ? ' → ' : ' '}
                <time dateTime={entry.iso}>{entry.label}</time>
              </Fragment>
            ))}
          </span>
        )}
        {canCollapse && <IconChevronDownOutlineRegular className={css.chevron} />}
      </button>
    </>
  )
})
