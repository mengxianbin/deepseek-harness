/** The 安康位 shield's style contracts (FORK dsh-local, collab-step4-c5, marker: healthShield). */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/HealthShield.module.css', import.meta.url)), 'utf8')

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
