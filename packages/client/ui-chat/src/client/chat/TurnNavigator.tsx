/**
 * Fixed-pitch virtual rail of every known mark — Turn boundaries and the
 * human interventions inside them — with independent activation, stepping,
 * and scroll controls.
 */
import {
  forwardRef, memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ForwardedRef,
} from 'react'
import { defaultRangeExtractor, elementScroll, observeElementOffset, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { IconChevronDownOutlineRegular, IconChevronUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { RailMark, TurnRailIntervention } from './turn-rail-items.ts'
import css from './TurnNavigator.module.css'

interface TurnNavigatorProps {
  /** Every mark in reading order: each Turn first, then its interventions. */
  readonly marks: readonly RailMark[]
  readonly activeTurn: number | null
  /** Turn whose jump is still paging history in; its mark pulses. */
  readonly busyTurn: number | null
  readonly onNavigate: (mark: RailMark) => void
  /** Step to the neighbouring human-intervention mark. */
  readonly onStep: (delta: 1 | -1) => void
  readonly t: ChatViewSlotProps['t']
}

/** Imperative controls for known marks; unknown turn numbers are ignored. */
export interface TurnNavigatorHandle {
  /** @param turn - turn to activate through the navigation callback. */
  activateTurn(turn: number): void
  /** @param turn - turn to center in the rail without navigating the transcript. */
  scrollToTurn(turn: number): void
  /** @param delta - `1` for the next mark, `-1` for the previous one. */
  stepIntervention(delta: 1 | -1): void
  /** Keep the last explicit navigation target lit until the next landing. */
  highlightMark(key: string): void
}

/** Fixed pitch between neighbouring marks; overflow scrolls inside the frame. */
const TURN_SPACING_PX = 10
/** Rail padding above the first mark and below the last one, per end. */
const RAIL_INSET_PX = 6
/** Fade band the mask reserves at a scrollable end. */
const FADE_PX = 24

function preferredScrollBehavior(): 'auto' | 'smooth' {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth'
}

/** The localized name of one intervention, numbered within its Turn and kind. */
function interventionLabel(intervention: TurnRailIntervention, t: ChatViewSlotProps['t']): string {
  return t(
    intervention.kind === 'question'
      ? 'chat.turnNavigation.interventionQuestion'
      : 'chat.turnNavigation.interventionInput',
    { ordinal: intervention.ordinal },
  )
}

interface TurnMarkProps extends Pick<TurnNavigatorProps, 'onNavigate' | 't'> {
  readonly mark: RailMark
  readonly index: number
  readonly active: boolean
  readonly busy: boolean
  /** Last explicit navigation target: keeps the ring until the next landing. */
  readonly landed: boolean
  readonly previewId: string | undefined
  readonly registerElement: (element: HTMLButtonElement | null) => void
  readonly onPreview: (key: string) => void
  readonly onFocusChange: (key: string | null) => void
}

const TurnMark = memo(function TurnMark({
  mark, index, active, busy, landed, previewId, registerElement, onNavigate, onPreview, onFocusChange, t,
}: TurnMarkProps) {
  const classes = [css.mark]
  // An intervention is a sub-mark of its Turn: a shorter tick indented from
  // the rail edge, so the ladder reads as Turns with decisions inside them.
  if (mark.kind === 'intervention') classes.push(css.markIntervention)
  else if (mark.item.anchor.kind === 'unloaded') classes.push(css.markUnloaded)
  if (active) classes.push(css.markActive)
  else if (previewId !== undefined) classes.push(css.markPreview)
  if (busy) classes.push(css.markBusy)
  if (landed) classes.push(css.markLanded)
  const label = mark.kind === 'turn'
    ? t(
      mark.item.anchor.kind === 'loaded' ? 'chat.turnNavigation.jump' : 'chat.turnNavigation.jumpLoad',
      { turn: mark.item.turn },
    )
    : t('chat.turnNavigation.jumpIntervention', {
      turn: mark.item.turn,
      label: interventionLabel(mark.item, t),
    })
  return (
    <button
      ref={registerElement}
      data-index={index}
      type="button"
      className={classes.join(' ')}
      aria-label={label}
      aria-current={active ? 'true' : undefined}
      aria-busy={busy ? 'true' : undefined}
      aria-describedby={previewId}
      onPointerMove={() => { onPreview(mark.key) }}
      onClick={() => { onNavigate(mark) }}
      onFocus={() => { onFocusChange(mark.key) }}
      onBlur={() => { onFocusChange(null) }}
    />
  )
})

function TurnNavigatorRail(
  { marks, activeTurn, busyTurn, onNavigate, onStep, t }: TurnNavigatorProps,
  ref: ForwardedRef<TurnNavigatorHandle>,
) {
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  /** Last explicit navigation target: click or step, lit until the next one. */
  const [landedKey, setLandedKey] = useState<string | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const initialization = useRef({
    placed: false,
    index: 0,
    follow: null as { index: number; count: number; height: number } | null,
    publishOffset: null as ((offset: number, scrolling: boolean) => void) | null,
  })
  /** While the pointer works the rail, follow must not move it under the hand. */
  const pointerInsideRef = useRef(false)
  const previewId = useId()
  const markIndexes = useMemo(() => {
    const indexes = new Map<string, number>()
    marks.forEach((mark, index) => { indexes.set(mark.key, index) })
    return indexes
  }, [marks])
  const turnIndex = useCallback(
    (turn: number | null) => turn === null ? undefined : markIndexes.get(`turn:${String(turn)}`),
    [markIndexes],
  )
  const activeIndex = turnIndex(activeTurn)
  useLayoutEffect(() => { initialization.current.index = activeIndex ?? 0 }, [activeIndex])
  const focusedIndex = focusedKey === null ? undefined : markIndexes.get(focusedKey)
  const previewIndex = previewKey === null ? undefined : markIndexes.get(previewKey)
  const onFocusChange = useCallback((key: string | null) => {
    setFocusedKey(key)
    setPreviewKey(key)
  }, [])
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLButtonElement>({
    count: marks.length,
    enabled: marks.length >= 2,
    directDomUpdates: true,
    directDomUpdatesMode: 'transform',
    useScrollendEvent: true,
    getScrollElement: useCallback(() => scrollerRef.current, []),
    getItemKey: useCallback((index: number) => marks[index]?.key ?? index, [marks]),
    estimateSize: () => TURN_SPACING_PX,
    measureElement: () => TURN_SPACING_PX,
    initialRect: { width: 0, height: 0 },
    initialOffset: 0,
    scrollToFn: (offset, options, instance) => {
      if (initialization.current.placed) elementScroll(offset, options, instance)
    },
    observeElementOffset: (instance, notify) => {
      initialization.current.publishOffset = notify
      const dispose = observeElementOffset(instance, notify)
      return () => {
        dispose?.()
        initialization.current.placed = false
        initialization.current.follow = null
        initialization.current.publishOffset = null
      }
    },
    observeElementRect: (instance, notify) => {
      const element = instance.scrollElement
      const Observer = instance.targetWindow?.ResizeObserver
      if (element === null || Observer === undefined) return
      const observer = new Observer(([entry]) => {
        if (entry === undefined) return
        const box = entry.borderBoxSize[0]
        const rect = {
          width: Math.round(box?.inlineSize ?? entry.contentRect.width),
          height: Math.round(box?.blockSize ?? entry.contentRect.height),
        }
        const initial = initialization.current
        if (!initial.placed && rect.height > 0) {
          const max = Math.max(0, instance.getTotalSize() - rect.height)
          const center = initial.index * TURN_SPACING_PX + RAIL_INSET_PX
          const target = Math.max(0, Math.min(max, center - rect.height / 2))
          initial.placed = true
          initial.follow = { index: initial.index, count: instance.options.count, height: rect.height }
          element.scrollTop = target
          initial.publishOffset?.(target, false)
        }
        notify(rect)
      })
      observer.observe(element, { box: 'border-box' })
      return () => { observer.disconnect() }
    },
    paddingStart: RAIL_INSET_PX - TURN_SPACING_PX / 2,
    paddingEnd: RAIL_INSET_PX - TURN_SPACING_PX / 2,
    scrollPaddingStart: FADE_PX,
    scrollPaddingEnd: FADE_PX,
    overscan: 3,
    rangeExtractor: useCallback((range: Range) => {
      const indexes = defaultRangeExtractor(range)
      if (focusedIndex !== undefined) {
        const last = Math.min(range.count - 1, focusedIndex + 1)
        for (let index = Math.max(0, focusedIndex - 1); index <= last; index++) {
          if (!indexes.includes(index)) indexes.push(index)
        }
        indexes.sort((left, right) => left - right)
      }
      return indexes
    }, [focusedIndex]),
  })
  const scrollTop = virtualizer.scrollOffset ?? 0
  const viewHeight = virtualizer.scrollRect?.height ?? 0
  const virtualItems = virtualizer.getVirtualItems()

  const handleNavigate = useCallback((mark: RailMark) => {
    setLandedKey(mark.key)
    onNavigate(mark)
  }, [onNavigate])
  const scrollToIndex = useCallback((
    index: number, reveal: 'if-needed' | 'always', behavior: 'auto' | 'smooth' | 'instant' = preferredScrollBehavior(),
  ): void => {
    const item = virtualizer.measurementsCache[index]
    const height = virtualizer.scrollRect?.height ?? 0
    if (item === undefined || height <= 0) return
    const current = virtualizer.scrollOffset ?? 0
    const center = item.start + item.size / 2
    if (reveal === 'if-needed') {
      const { scrollPaddingStart, scrollPaddingEnd } = virtualizer.options
      if (center >= current + scrollPaddingStart && center <= current + height - scrollPaddingEnd) return
    }
    const target = center - height / 2
    const max = Math.max(0, virtualizer.getTotalSize() - height)
    const delta = Math.max(0, Math.min(max, target)) - current
    if (delta !== 0) virtualizer.scrollBy(delta, { behavior })
  }, [virtualizer])

  useImperativeHandle(ref, (): TurnNavigatorHandle => ({
    activateTurn(turn) {
      const index = turnIndex(turn)
      const mark = index === undefined ? undefined : marks[index]
      if (mark !== undefined) onNavigate(mark)
    },
    scrollToTurn(turn) {
      const index = turnIndex(turn)
      if (index !== undefined) scrollToIndex(index, 'always')
    },
    stepIntervention(delta) { onStep(delta) },
    highlightMark(key) {
      setLandedKey(key)
      const index = markIndexes.get(key)
      if (index !== undefined) scrollToIndex(index, 'if-needed')
    },
  }), [marks, turnIndex, markIndexes, onNavigate, onStep, scrollToIndex])

  useEffect(() => {
    if (viewHeight <= 0) {
      initialization.current.follow = null
      return
    }
    if (activeIndex === undefined || pointerInsideRef.current) return
    const previous = initialization.current.follow
    if (previous?.index === activeIndex && previous.count === marks.length && previous.height === viewHeight) return
    initialization.current.follow = { index: activeIndex, count: marks.length, height: viewHeight }
    const behavior = previous?.count === marks.length && previous.height === viewHeight
      ? preferredScrollBehavior()
      : 'instant'
    scrollToIndex(activeIndex, 'if-needed', behavior)
  }, [activeIndex, marks.length, viewHeight, scrollToIndex])

  if (marks.length < 2) return null
  const preview = previewIndex === undefined ? undefined : marks[previewIndex]
  const previewPosition = virtualItems.find(item => item.index === previewIndex)
  const fadeClasses = [css.scroller]
  if (scrollTop > 1) fadeClasses.push(css.fadeTop)
  if (scrollTop < virtualizer.getTotalSize() - viewHeight - 1) fadeClasses.push(css.fadeBottom)
  const stepDisabled = marks.length < 2
  return (
    <div className={css.slot}>
      <div className={css.rail}>
        <button
          type="button"
          className={css.step}
          aria-label={t('chat.turnNavigation.previous')}
          disabled={stepDisabled}
          onClick={() => { onStep(-1) }}
        >
          <IconChevronUpOutlineRegular size={14} />
        </button>
        <nav
          className={css.frame}
          aria-label={t('chat.turnNavigation.label')}
          onPointerEnter={() => { pointerInsideRef.current = true }}
          onPointerLeave={() => {
            pointerInsideRef.current = false
            setPreviewKey(null)
          }}
        >
          <div ref={scrollerRef} className={fadeClasses.join(' ')}>
            <div ref={virtualizer.containerRef} className={css.marks}>
              {virtualItems.map(({ index, key }) => {
                const mark = marks[index]
                if (mark === undefined) return null
                return (
                  <TurnMark
                    key={key}
                    mark={mark}
                    index={index}
                    active={mark.kind === 'turn' && mark.item.turn === activeTurn}
                    busy={mark.kind === 'turn' && mark.item.turn === busyTurn}
                    landed={mark.key === landedKey}
                    previewId={previewKey === mark.key ? previewId : undefined}
                    registerElement={virtualizer.measureElement}
                    onNavigate={handleNavigate}
                    onPreview={setPreviewKey}
                    onFocusChange={onFocusChange}
                    t={t}
                  />
                )
              })}
            </div>
          </div>
          {preview !== undefined && previewPosition !== undefined && (
            <div
              id={previewId}
              role="tooltip"
              className={css.preview}
              style={{
                '--turn-preview-center': `${String(previewPosition.start + previewPosition.size / 2 - scrollTop)}px`,
              } as CSSProperties}
            >
              {preview.kind === 'turn' ? (
                <>
                  <div className={css.previewPrompt}>
                    {preview.item.prompt || t('chat.turnNavigation.turn', { turn: preview.item.turn })}
                  </div>
                  {preview.item.response !== ''
                    && <div className={css.previewResponse}>{preview.item.response}</div>}
                </>
              ) : (
                <>
                  <div className={css.previewPrompt}>{interventionLabel(preview.item, t)}</div>
                  {preview.item.preview !== ''
                    && <div className={css.previewResponse}>{preview.item.preview}</div>}
                </>
              )}
            </div>
          )}
        </nav>
        <button
          type="button"
          className={css.step}
          aria-label={t('chat.turnNavigation.next')}
          disabled={stepDisabled}
          onClick={() => { onStep(1) }}
        >
          <IconChevronDownOutlineRegular size={14} />
        </button>
      </div>
    </div>
  )
}

/**
 * Fixed-pitch rail of every known mark — a Turn boundary scrolls to its row,
 * an unloaded one pages history in first, an intervention aligns the row that
 * recorded it — with hover and focus previews and prev/next stepping through
 * the human decisions. Overflow scrolls inside the frame, gradient fades
 * marking each scrollable end, and the active mark centers only outside the
 * fade-free band while the pointer is elsewhere. Previews follow pointer
 * movement or focus, not scrolling under a stationary pointer.
 */
export const TurnNavigator = memo(forwardRef(TurnNavigatorRail))
