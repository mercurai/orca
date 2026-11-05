import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { getActiveTabId } from './store'

export async function activateTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    state.setActiveTab(id)
    state.setActiveTabType('terminal', state.activeWorktreeId)
  }, tabId)
  await expect.poll(() => getActiveTabId(page)).toBe(tabId)
}

export async function readTabStripScrollLeft(page: Page, tabId: string): Promise<number> {
  return page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`).evaluate((tab) => {
    const strip = tab.closest('.terminal-tab-strip')
    if (!strip) {
      throw new Error('Terminal tab strip unavailable')
    }
    return strip.scrollLeft
  })
}

export async function waitForUnoccludedTabIndicator(page: Page, tabId: string): Promise<void> {
  await page.mouse.move(0, 0)
  await expect
    .poll(
      () =>
        page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`).evaluate((tab) => {
          const strip = tab.closest('.terminal-tab-strip')
          if (!strip) {
            throw new Error('Terminal tab strip unavailable')
          }
          const overlay = strip.parentElement?.querySelector(
            '[data-testid="tab-strip-scroll-indicator"]'
          )
          return !overlay || getComputedStyle(overlay).opacity === '0'
        }),
      { message: 'Tab scrollbar still covers the selected-tab indicator' }
    )
    .toBe(true)
}
