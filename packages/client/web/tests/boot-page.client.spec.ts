// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { BootPage } from '../src/boot-page.ts'

afterEach(() => { document.body.innerHTML = '' })

function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  return { el, page: new BootPage(el) }
}

describe('BootPage', () => {
  it('draws the loading skeleton before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-dsh-boot')).toBe('')
    expect(el.textContent).toContain('HARNESS')
    expect(el.textContent).toContain('Loading plugins…')
  })

  it('keeps loading while entries are active or loading', () => {
    const { el, page } = mount()
    page.setTotal(2)
    const spinner = el.querySelector<HTMLElement>('[data-dsh-boot-spinner]')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('72deg')
    page.setState('a', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('180deg')
    page.setState('b', 'loading')
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBe(spinner)
    page.setState('b', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('288deg')
    expect(el.textContent).toContain('Loading plugins…')
    expect(el.textContent).not.toContain('Failed to load plugins')
  })

  it('lists failed entries', () => {
    const { el, page } = mount()
    page.setState('@deepseek-ai/dsh-client-ui-layout', 'failed')
    page.setState('ok', 'active')
    page.setState('@deepseek-ai/dsh-client-ui-tool', 'failed')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-tool')
    expect(el.textContent).not.toContain('ok')
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('shows the complete sweep report', () => {
    const { el, page } = mount()
    const report = 'web boot: 1 entry did not activate\nx: pending (waiting for service: y)'
    page.fail(report)
    page.setState('a', 'active')
    expect(el.textContent).toContain(report)
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('detaches on disposal', () => {
    const { el, page } = mount()
    page.dispose()
    expect(el.childNodes).toHaveLength(0)
  })
})

// FORK dsh-local (f5-shell-skeleton, marker: data-dsh-shell-skeleton): the
// first-screen list placeholder must ride the boot root (so the hydration
// handoff swaps it out with the boot page instead of leaving it to double
// render against ui-workspace's own skeleton), carry the shared
// data-list-state="loading" probe semantics, and leave with a failure report.
describe('BootPage shell list skeleton', () => {
  it('renders six fixed-height rows with the shared loading marker inside the boot root', () => {
    const { el } = mount()
    const bootRoot = el.querySelector<HTMLElement>('[data-dsh-boot]')
    const column = bootRoot?.querySelector<HTMLElement>('[data-dsh-shell-skeleton]')
    expect(column).not.toBeNull()
    const list = column!.querySelector<HTMLElement>('[data-list-state="loading"]')
    expect(list).not.toBeNull()
    expect(list!.getAttribute('role')).toBe('status')
    const rows = list!.querySelectorAll('[aria-hidden="true"]')
    expect(rows).toHaveLength(6)
    for (const row of rows) {
      expect(row.children).toHaveLength(2)
    }
  })

  it('keeps the placeholder up while plugin states stay non-fatal', () => {
    const { el, page } = mount()
    page.setTotal(2)
    page.setState('a', 'active')
    page.setState('b', 'loading')
    expect(el.querySelector('[data-dsh-shell-skeleton]')).not.toBeNull()
  })

  it('removes the placeholder when a failure report replaces the card', () => {
    const { el, page } = mount()
    page.setState('broken', 'failed')
    expect(el.querySelector('[data-dsh-shell-skeleton]')).toBeNull()
    expect(el.textContent).toContain('Failed to load plugins')
  })

  it('removes the placeholder on a terminal boot failure', () => {
    const { el, page } = mount()
    page.fail('web boot: module loader missing')
    expect(el.querySelector('[data-dsh-shell-skeleton]')).toBeNull()
  })
})
