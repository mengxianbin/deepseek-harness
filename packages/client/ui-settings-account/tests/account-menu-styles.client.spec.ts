/** Account-owned sidebar spacing and total control heights. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/AccountMenu.module.css', import.meta.url), 'utf8')

it('insets only the account root without resizing the settings carrier', () => {
  expect(css).toMatch(/\.root\[data-inset='true'\]\s*\{\s*margin-inline: 2px;\s*\}/)
  expect(css).toMatch(/\.root\s*\{[^}]*flex: 1;[^}]*min-width: 0;/)
})

it('includes padding and borders in the 42px gear row and the 36px rail carrier', () => {
  const trigger = css.match(/\.trigger\s*\{([^}]+)\}/)?.[1]
  expect(trigger).toContain('box-sizing: border-box;')
  // FORK settings-launcher: the sidebar launcher is the icon-only gear (no
  // avatar row, no More menu), so the row is 42px to match the same-slot
  // SettingsRoot.trigger carrier rather than upstream's 44px avatar row.
  expect(trigger).toContain('height: 42px;')
  expect(css).toMatch(/\.trigger\.rail\s*\{[^}]*width: 36px;[^}]*height: 36px;/)
  // The avatar-era selectors were removed with the launcher rework and must
  // not come back as rules through a future merge; the surviving comment that
  // names them (why they are gone) is not a rule.
  expect(css).not.toMatch(/\[data-signed-out='true'\]\s*\{/)
  expect(css).not.toMatch(/\[data-collapsed='true'\]\s*\{/)
})
