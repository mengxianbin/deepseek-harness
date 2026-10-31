/** The 安康位 shield's style contracts (FORK dsh-local, collab-step4-c5, marker: healthShield). */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/rows/HealthShield.module.css', import.meta.url)), 'utf8')

describe('HealthShield.module.css vocabulary', () => {
  it('mirrors the shared dashed stale ring (step3 §5.1 vocabulary)', () => {
    // The SAME amber dashed overlay the session rows use (ui-workspace
    // Rows.module.css .staleRing): the enforcer's own silence reads exactly
    // like a row gone unreadable (step3 §5.2 自指 fail-closed).
    expect(css).toMatch(/\.staleRing::after\s*\{[^}]*border: 1px dashed var\(--dsw-alias-state-warn-primary\)/)
  })

  it('paints the two verdict states and the fixed detail layer', () => {
    expect(css).toMatch(/\.shield\.ok \.button\s*\{[^}]*--dsw-alias-state-success-primary/)
    expect(css).toMatch(/\.shield\.broken \.button\s*\{[^}]*--dsw-alias-state-error-primary/)
    // The top strip clips its overflow, so the detail floats in the viewport layer.
    expect(css).toMatch(/\.detail\s*\{[^}]*position: fixed/)
  })
})

describe('HealthShield seat vs the actions cluster clip window (件C5 裁切复修1101)', () => {
  const browserCss = readFileSync(
    fileURLToPath(new URL('../src/client/rows/WorkspaceBrowser.module.css', import.meta.url)), 'utf8')
  const browserSource = readFileSync(
    fileURLToPath(new URL('../src/client/rows/WorkspaceBrowser.tsx', import.meta.url)), 'utf8')

  it('documents why the seat must stay outside: the cluster clips at a fixed 60px', () => {
    // The clip window itself is legitimate (two 28px buttons collapse as one
    // unit under an expanded search); what is not legitimate is seating a
    // third occupant inside it — it renders and is clipped away whole.
    expect(browserCss).toMatch(/\.headerActions\s*\{[^}]*max-width: 60px/)
    expect(browserCss).toMatch(/\.headerActions\s*\{[^}]*overflow: hidden/)
  })

  it('renders the shield outside the headerActions cluster in source', () => {
    const clusterMarker = browserSource.indexOf('css.headerActions,')
    expect(clusterMarker).toBeGreaterThan(-1)
    const clusterOpen = browserSource.lastIndexOf('<div', clusterMarker)
    // Walk the literal <div>/<div/> tokens to the cluster's matching close;
    // the seat must not be claimed inside that span.
    let depth = 0
    let clusterClose = -1
    for (let index = clusterOpen; index < browserSource.length;) {
      const nextOpen = browserSource.indexOf('<div', index + 1)
      const nextClose = browserSource.indexOf('</div>', index + 1)
      if (nextClose === -1) break
      if (nextOpen !== -1 && nextOpen < nextClose) { depth += 1; index = nextOpen; continue }
      if (depth === 0) { clusterClose = nextClose; break }
      depth -= 1
      index = nextClose
    }
    expect(clusterClose).toBeGreaterThan(clusterOpen)
    const clusterBody = browserSource.slice(clusterOpen, clusterClose)
    expect(clusterBody).not.toContain('HealthShield')
    expect(browserSource.slice(clusterClose)).toContain('<HealthShield useSessionHealth={useSessionHealth} t={t} />')
  })
})
