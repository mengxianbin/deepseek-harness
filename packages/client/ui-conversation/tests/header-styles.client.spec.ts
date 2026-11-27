/** Conversation navigation spacing preserves the right-pane header alignment. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url), 'utf8')

describe('conversation header geometry', () => {
  // The narrow-Web tab-inset test (upstream `.tabs` strip) is deliberately gone:
  // the fork replaced the header tab strip with the labeled View dropdown
  // (view-dropdown-chat-1119), so no `.tabs` row exists to inset.

  it('keeps the single-line header at the shared 76px height', () => {
    expect(css.match(/\.header\s*\{([^}]*)\}/)?.[1]).toContain('min-height: 76px')
  })

  it('clips overflowing title actions and fades them inside the gap before the next control', () => {
    const cluster = css.match(/\.titleCluster\s*\{([^}]*)\}/)?.[1]
    expect(cluster).toContain('overflow: clip')
    expect(cluster).toContain('--title-cluster-fade: 20px')
    expect(cluster).toContain('margin: -4px calc(-1 * var(--title-cluster-fade)) -4px -4px')
    expect(cluster).toContain('padding: 4px var(--title-cluster-fade) 4px 4px')
    expect(cluster).toContain('mask-image: linear-gradient(to left, transparent calc(0.3 * var(--title-cluster-fade)), #000 var(--title-cluster-fade))')
    expect(css.match(/^\.headerUtilities\s*\{([^}]*)\}/m)?.[1]).toContain('margin-left: 20px')
    expect(css.match(/\.titleCluster:has\(\+ \.headerUtilities:empty\)\s*\{([^}]*)\}/)?.[1]).toContain('--title-cluster-fade: 8px')
    expect(css.match(/^\.headerCorner\s*\{([^}]*)\}/m)?.[1]).toContain('margin-left: 8px')
  })

  it('sizes the view dropdown trigger, its caret, and its menu on the header row', () => {
    // The trigger keeps the header's single-row rhythm; the caret rotates with
    // the menu's open state and the menu stays anchored to the trigger width.
    const trigger = css.match(/^\.viewSelect\s*\{([^}]*)\}/m)?.[1]
    expect(trigger).toContain('gap: 4px')
    expect(trigger).toContain('font-size: 13px')
    expect(css.match(/^\.viewSelectCaret\s*\{([^}]*)\}/m)?.[1]).toContain('transition: transform 120ms ease')
    expect(css.match(/^\.viewSelect\[aria-expanded='true'\] \.viewSelectCaret\s*\{([^}]*)\}/m)?.[1])
      .toContain('transform: rotate(180deg)')
    expect(css.match(/^\.viewSelectMenu\s*\{([^}]*)\}/m)?.[1]).toContain('width: 288px')
    expect(css.match(/^\.viewSelectCheck\s*\{([^}]*)\}/m)?.[1]).toContain('margin-left: auto')
  })
})
