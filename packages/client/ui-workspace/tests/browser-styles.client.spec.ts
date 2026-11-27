/**
 * WorkspaceBrowser spacing contract, asserted against the CSS text on disk:
 * row fills share the shell's trailing inset, the stable scrollbar counts
 * inside it, and flat, grouped, and search views keep their intended rhythm.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/rows/WorkspaceBrowser.module.css', import.meta.url)), 'utf8')
const rowsCss = readFileSync(fileURLToPath(new URL('../src/client/rows/Rows.module.css', import.meta.url)), 'utf8')

/**
 * Declarations of one selector rule, keyed by property with whitespace collapsed.
 * Declaration order and trailing semicolons are normalized away.
 * @param selector - one exact selector, including a leading dot for local classes.
 * @returns the rule's declarations, or undefined when no such rule exists.
 */
function declarationsFrom(source: string, selector: string): Map<string, string> | undefined {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const found = new Map<string, string>()
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
  }
  return found.size === 0 ? undefined : found
}

const declarations = (selector: string): Map<string, string> | undefined => declarationsFrom(css, selector)
const rowDeclarations = (selector: string): Map<string, string> | undefined => declarationsFrom(rowsCss, selector)

describe('WorkspaceBrowser.module.css list', () => {
  it('hides touch timestamps without hiding pending-interaction labels', () => {
    const touch = /@media \(hover: none\) \{([\s\S]*?)\n\}/.exec(rowsCss)?.[1]
    expect(touch).toContain('.sessionRow .timestamp')
    expect(touch).not.toMatch(/\.sessionRow(?:\.selected)? \.time[\s,{]/)
    expect(rowDeclarations('.sessionRow .pinnedAction')?.get('order')).toBe('-1')
  })

  const root = declarations('.root')
  const listArea = declarations('.listArea')
  const list = declarations('.list')

  // The scroll-state rule repeats the expanded list-area selector, so ordinary rules are read before it.
  const [ordinaryCss = '', scrollStateCss = ''] = css.split('@container scroll-state(scrollable: bottom)')
  const expandedListArea = declarationsFrom(ordinaryCss, '.root:not(.rail) .listArea')

  it('scrolls the expanded list area as the section\'s own scroller while rows keep natural height', () => {
    expect(list?.get('overflow')).toBe('visible')
    expect(list?.get('overflow-y')).toBeUndefined()
    expect(list?.get('scrollbar-gutter')).toBeUndefined()
    expect(list?.get('padding-bottom')).toBe('16px')
    expect(listArea?.get('overflow')).toBe('visible')
    expect(expandedListArea?.get('display')).toBe('block')
    expect(expandedListArea?.get('overflow-x')).toBe('hidden')
    expect(expandedListArea?.get('overflow-y')).toBe('auto')
    expect(expandedListArea?.get('scrollbar-gutter')).toBe('stable')
    expect(expandedListArea?.get('margin-left')).toBe('-4px')
    expect(expandedListArea?.get('padding-left')).toBe('4px')
    expect(expandedListArea?.get('margin-right')).toBe('calc(2px - var(--dsh-sidebar-inline-padding))')
    expect(expandedListArea?.get('padding-right'))
      .toBe('calc(var(--dsh-sidebar-inline-padding) - var(--dsh-scrollbar-width) - 2px)')
    expect(root?.get('padding-right')).toBeUndefined()
    expect(declarations('.rail .listArea')).toBeUndefined()
    expect(declarations('.list::-webkit-scrollbar')).toBeUndefined()
  })

  it('leaves user scrolling to the sidebar viewport until it reaches its end', () => {
    const block = /^ \{([\s\S]*?)\n\}/.exec(scrollStateCss)?.[1] ?? ''
    expect(declarationsFrom(block, '.root:not(.rail) .listArea')?.get('overflow-y')).toBe('hidden')
  })

  it('keeps the expanded section at most one viewport tall, and exactly that tall while searching', () => {
    const expanded = declarations('.root:not(.rail)')
    expect(root?.get('position')).toBe('relative')
    expect(expanded?.get('flex')).toBe('none')
    expect(expanded?.get('max-height')).toBe('100cqh')
    expect(expanded?.get('height')).toBeUndefined()
    expect(declarations('.root:not(.rail):has(.searchExpanded)')?.get('height')).toBe('100cqh')
    expect(declarations('.sectionHeader')?.get('background')).toBeUndefined()
    expect(root?.get('--workspace-toolbar-height')).toBe('36px')
    expect(root?.get('--workspace-toolbar-gap')).toBe('0px')
    expect(declarations('.sectionHeader')?.get('height')).toBe('var(--workspace-toolbar-height)')
    expect(declarations('.sectionHeader')?.get('margin-bottom')).toBe('var(--workspace-toolbar-gap)')
    expect(declarations('.searchExpanded')?.get('width')).toBe('100%')
    expect(declarations('.searchExpanded')?.get('margin-inline')).toBe('0')
  })

  it('keeps 2px between rows and 4px between workspace groups', () => {
    expect(declarations('.flatList > * + *')?.get('margin-top')).toBe('2px')
    expect(declarations(".searchTree > [role='treeitem'] + [role='treeitem']")?.get('margin-top')).toBe('2px')
    expect(declarations('.groupSection > * + *')?.get('margin-top')).toBe('2px')
    expect(declarations('.groupSection + .groupSection')?.get('margin-top')).toBe('4px')
  })

  it('draws drag targets as a leading chevron joined to the insertion line', () => {
    const listTopMarker = declarations('.listTopDropIndicator')
    const workspaceMarker = declarations('.workspaceDropBefore::before')
    const sessionMarker = rowDeclarations('.sessionRow.dropBefore::before')
    expect(listTopMarker?.get('top')).toBe('-8px')
    expect(listTopMarker?.get('left')).toBe('0')
    expect(listTopMarker?.get('right')).toBe('0')
    expect(workspaceMarker?.get('left')).toBe('0')
    expect(sessionMarker?.get('left')).toBe('calc(-1 * var(--dsh-sidebar-paint-inset))')
    expect(sessionMarker?.get('right')).toBe('calc(4px - var(--dsh-sidebar-paint-inset))')
    for (const marker of [listTopMarker, workspaceMarker, sessionMarker]) {
      expect(marker?.get('height')).toBe('12px')
      expect(marker?.get('background')).not.toContain('radial-gradient')
      expect(marker?.get('background')).toContain('55deg')
      expect(marker?.get('background')).toContain('125deg')
      expect(marker?.get('background')).toContain('calc(50% - 1px) calc(50% + 1px)')
      expect(marker?.get('background')).toContain('0 0 / 5px 7px')
      expect(marker?.get('background')).toContain('0 5px / 5px 7px')
      expect(marker?.get('background')).toContain('4px 5px / calc(100% - 4px) 2px')
    }
  })

  it('keeps the overflow control, search field, and row heights', () => {
    expect(declarations('.sessionOverflowButton')?.get('height')).toBe('28px')
    expect(declarations('.searchExpanded')?.get('height')).toBe('32px')
    expect(rowDeclarations('.projectRow')?.get('height')).toBe('32px')
    expect(rowDeclarations('.sessionRow')?.get('height')).toBe('32px')
    // One leading status cell for every session row, grouped or flat: the cell
    // hosts either the row's status dot or the leading seat, and it reserves its
    // own box, so the title's one shared margin below needs no per-view override.
    expect(rowDeclarations('.slot')?.get('width')).toBe('16px')
    expect(rowDeclarations('.slot')?.get('height')).toBe('20px')
    expect(rowDeclarations('.sessionRow .title')?.get('margin')).toBe('0 12px 0 var(--dsh-sidebar-label-gap)')
    expect(rowDeclarations('.searchResultRow')?.get('min-height')).toBe('48px')
    expect(rowDeclarations('.searchResultTitle')?.get('margin')).toBe('0 var(--dsh-sidebar-label-gap)')
    expect(rowDeclarations('.sessionRow.selected')?.get('background-color'))
      .toBe('var(--dsw-alias-interactive-bg-hover)')
  })

  it('shares action spacing and inset backgrounds without moving the title column', () => {
    for (const selector of ['.projectRow', '.sessionRow']) {
      expect(rowDeclarations(selector)?.get('padding')).toBe('0 8px')
      expect(rowDeclarations(selector)?.get('background-clip')).toBe('padding-box')
      expect(rowDeclarations(selector)?.get('border-inline')).toBe('var(--dsh-sidebar-paint-inset) solid transparent')
    }
    expect(rowDeclarations('.rowActions')?.get('gap')).toBe('12px')
    expect(rowDeclarations('.iconButton')?.get('width')).toBe('24px')
    expect(rowDeclarations('.time')?.get('margin-inline-end')).toBe('-1px')
  })

  it('left-aligns the whole header row now that the title label is gone (2026-11-26)', () => {
    // No 工作区 / 会话 label leads the row any more, so the search control and
    // every icon after it pack against the left edge instead of floating right.
    expect(declarations('.sectionHeader')?.get('justify-content')).toBe('flex-start')
    expect(declarations('.searchSlot')?.get('margin-left')).toBeUndefined()
    expect(declarations('.sectionLabel')).toBeUndefined()
    expect(declarations('.sectionLabelHidden')).toBeUndefined()
    // The clipped action window still holds exactly the two cluster buttons;
    // the 安康位 shield and alert inbox stay their siblings AFTER it.
    expect(declarations('.headerActions')?.get('max-width')).toBe('60px')
  })

  it('extends native row action targets while retaining the compact layout footprint', () => {
    const button = rowDeclarations('.iconButton')
    expect(button?.get('width')).toBe('24px')
    expect(button?.get('height')).toBe('24px')
    expect(button?.get('margin')).toBe('-4px')
    expect(button?.get('background')).toBe('transparent')
    expect(rowDeclarations('.iconButton::after')).toBeUndefined()
    expect(rowDeclarations('.iconButton:focus-visible')?.get('outline-offset')).toBe('-2px')
  })

  it('enables header spacing transitions only for search gestures in wide layout', () => {
    expect(declarations('.root:not(.rail) .sectionHeader')?.get('transition')).toBeUndefined()
    const selector = '.root:not(.rail) .sectionHeader.searchSpacingMotion'
    const [ordinary = '', reduced = ''] = css.split('@media (prefers-reduced-motion: reduce)')
    expect(declarationsFrom(ordinary, selector)?.get('transition'))
      .toBe('margin-right 180ms var(--ds-ease-in-out), padding-inline 180ms var(--ds-ease-in-out), gap 180ms var(--ds-ease-in-out)')
    expect(declarationsFrom(reduced, selector)?.get('transition')).toBe('none')
  })

  it('aligns the expanded search field without changing list scroll ownership', () => {
    const header = declarations('.root:not(.rail) .sectionHeader:has(.searchExpanded)')
    expect(header?.get('margin-right')).toBe('0')
    expect(header?.get('padding-inline')).toBe('calc(var(--dsh-sidebar-paint-inset) + 1px)')
    expect(header?.get('gap')).toBe('0')
    expect(declarations('.root:not(.rail) .sectionHeader:not(:has(.searchExpanded))')?.get('padding-right')).toBe('1px')
    expect(declarations('.root:not(.rail) .sectionHeader:not(:has(.searchExpanded))')?.get('margin-right')).toBe('-4px')
    expect(declarations('.searchExpanded')?.get('width')).toBe('100%')
    expect(declarations('.searchExpanded')?.get('margin-inline')).toBe('0')
    expect(declarations('.searchExpanded .searchButton')?.get('height')).toBe('32px')
    expect(declarations('.sectionHeader .wide.sectionLabelHidden')?.get('margin-right')).toBe('0')
    expect(declarations('.list')?.get('overflow')).toBe('visible')
    expect(declarations('.listArea')?.get('min-height')).toBe('0')
  })

  it('marquees a clipped session title on row hover', () => {
    // The shared MarqueeText animates the travel and fades the clipping
    // edges; the row's stylesheet sizes the cell and keeps it unclipped on hover.
    expect(rowDeclarations('.sessionRow .title')?.get('flex')).toBe('1')
    expect(rowDeclarations('.sessionRow:hover .title')?.get('text-overflow')).toBe('clip')
  })

  it('pins both rail controls to the shared left anchor during the column slide', () => {
    expect(declarations('.rail .sectionHeader')?.get('justify-content')).toBe('flex-start')
    expect(declarations('.rail .iconButton')?.get('width')).toBe('36px')
    expect(declarations('.rail .search')?.get('width')).toBe('36px')
  })

  it('drops the removed queue segment and alarm line styles (queue-zone-1113)', () => {
    // The global segment (section, count bar, rows clip, empty line, fold
    // chevron) went away with the ruling — no rule may survive for it.
    for (const removed of [
      '.queueSection', '.queueToggle', '.queueRows', '.queueEmpty', '.queueChevron', '.queueChevronOpen',
    ]) expect(declarations(removed), removed).toBeUndefined()
    expect(css).not.toContain('[data-queue-scroll]')
    // 2026-11-26: the 安康位 alarm line is gone from the list head too, so its
    // box, button and expansion body all lose their rules with it.
    for (const removed of ['.queueHealth', '.queueHealthButton', '.queueHealthDetail']) {
      expect(declarations(removed), removed).toBeUndefined()
    }
    expect(css).not.toContain('queue-health')
    // The group header badge rides the title's line a notch under the title's
    // size, spaced clear of the name, on a dot sized to the smaller type.
    expect(rowDeclarations('.attentionBadges')?.get('font-size')).toBe('12px')
    expect(rowDeclarations('.attentionBadges')?.get('line-height')).toBe('20px')
    expect(rowDeclarations('.attentionBadges')?.get('margin-inline-start')).toBe('14px')
    expect(rowDeclarations('.attentionDot')?.get('width')).toBe('7px')
    expect(rowDeclarations('.attentionDot')?.get('background')).toBe('currentColor')
    expect(rowDeclarations(".attentionCount[data-attention='failed']")?.get('color'))
      .toBe('var(--dsw-alias-state-error-primary)')
    expect(rowDeclarations(".attentionCount[data-attention='pending']")?.get('color'))
      .toBe('var(--dsw-alias-state-warn-primary)')
  })

  it('sizes the group session total with the attention pair, one weight notch lighter and grey (session-count-badge-1122)', () => {
    // The total rides the same 12px/20px line as the pair it precedes, at
    // weight 500 (reference information, not an attention target) in the
    // secondary label grey, tabular so the number never jitters. Its dot is
    // the pair's own geometry — no second circle rule may exist.
    const total = rowDeclarations('.sessionCount')
    expect(total?.get('font-size')).toBe(rowDeclarations('.attentionBadges')?.get('font-size'))
    expect(total?.get('font-size')).toBe('12px')
    expect(total?.get('line-height')).toBe('20px')
    expect(total?.get('font-weight')).toBe('500')
    expect(total?.get('font-variant-numeric')).toBe('tabular-nums')
    expect(total?.get('color')).toBe('var(--dsw-alias-label-secondary)')
    expect(total?.get('margin-inline-start')).toBe('14px')
    // Dot geometry rides .attentionDot (7px, currentColor inherits the grey).
    expect(total?.get('width')).toBeUndefined()
    expect(total?.get('border-radius')).toBeUndefined()
    expect(rowDeclarations('.attentionDot')?.get('width')).toBe('7px')
  })
})
