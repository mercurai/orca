import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { readActiveScreen } from './alt-screen-frame'
import { getActiveTabId } from './store'
import {
  activateTab,
  readTabStripScrollLeft,
  waitForUnoccludedTabIndicator
} from './terminal-tab-selection-oracle'
import { compareTerminalScreenshots } from '../terminal-screenshot-diff'
import { captureStableTabScreenshot } from '../terminal-tab-screenshot'
import { waitForPtyFrame } from './terminal-webgl-pty-fixture'
import {
  capturedFrame,
  foregroundPixelCount,
  observeGraphics,
  prepareTerminalGraphics,
  terminalFrame,
  type GraphicsObservation
} from './terminal-webgl-retention-graphics'
import {
  attachCompositorDiagnostics,
  captureCompositorFrames,
  cropCompositorFrame,
  firstCompositorFrame,
  firstRecordedCompositorFrames,
  startCompositorRecording,
  type CompositorDiagnostics,
  type CompositorRecording
} from './terminal-webgl-retention-compositor'

type RetentionJourney = {
  page: Page
  worktreeId: string
  firstTabId: string
  createTab: () => Promise<string>
  startIdleTerminal: (tabId: string, marker: string) => Promise<void>
  writeFrame: (tabId: string, data: string, marker: string) => Promise<void>
}

export async function exerciseTerminalTabWebglRetention({
  page: orcaPage,
  worktreeId,
  firstTabId,
  createTab,
  startIdleTerminal,
  writeFrame
}: RetentionJourney): Promise<void> {
  const paintFrame = async (
    tabId: string,
    marker: string,
    color: 'red' | 'cyan' | 'magenta' = 'red'
  ) => {
    await writeFrame(tabId, terminalFrame(marker, color), marker)
    await waitForPtyFrame(orcaPage, tabId, marker)
  }
  const recording: CompositorRecording = { enabled: false, startedAt: 0, error: null, frames: [] }
  const diagnostic: CompositorDiagnostics = { baselines: [] }
  const cdp = await captureCompositorFrames(orcaPage, recording)
  const observations: GraphicsObservation[] = []
  try {
    await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      store.setState({ settings: { ...store.getState().settings, terminalGpuAcceleration: 'on' } })
    })
    const tabIds = [firstTabId]
    let oldestScreenshot: Buffer | undefined
    for (let index = 0; index < 8; index += 1) {
      if (index > 0) {
        tabIds.push(await createTab())
      }
      const tabId = tabIds[index]
      await activateTab(orcaPage, tabId)
      const marker = `RETENTION_TAB_${index}`
      await startIdleTerminal(tabId, marker)
      const observation = await prepareTerminalGraphics(orcaPage, tabId, () =>
        paintFrame(tabId, marker)
      )
      observations.push(observation)
      if (index === 0) {
        oldestScreenshot = await captureStableTabScreenshot(orcaPage, tabId)
        expect(foregroundPixelCount(oldestScreenshot, 'red')).toBeGreaterThan(500)
      }
    }
    expect(
      await orcaPage.evaluate((id) => {
        const state = window.__store?.getState()
        const tabs = state?.tabsByWorktree[id] ?? []
        return {
          tabIds: tabs.map((tab) => tab.id),
          paneCounts: tabs.map((tab) => window.__paneManagers?.get(tab.id)?.getPanes().length),
          activeWorktreeId: state?.activeWorktreeId,
          activeTabType: state?.activeTabType
        }
      }, worktreeId)
    ).toEqual({
      tabIds,
      paneCounts: Array.from({ length: 8 }, () => 1),
      activeWorktreeId: worktreeId,
      activeTabType: 'terminal'
    })
    await expect
      .poll(async () => {
        const states = await Promise.all(
          observations.map((entry) => entry.evaluate((value) => value.state()))
        )
        return {
          hidden: states.filter((entry) => !entry.visible).length,
          hiddenLive: states.filter((entry) => !entry.visible && !entry.lost).length,
          hiddenAddons: states.filter((entry) => !entry.visible && entry.diagnostics[0]?.hasWebgl).length,
          oldestReleased: states[0].lost && states[0].width === 0 && states[0].height === 0,
          retained: states.slice(1, 7).every((entry) => entry.sameAddon && !entry.lost),
          active: states[7].visible && !states[7].lost
        }
      })
      .toEqual({
        hidden: 7,
        hiddenLive: 6,
        hiddenAddons: 6,
        oldestReleased: true,
        retained: true,
        active: true
      })

    const retained = observations[6]
    await activateTab(orcaPage, tabIds[6])
    const targetTab = orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabIds[6]}"]`)
    await expect(targetTab).toHaveAttribute('data-active', 'true')
    await waitForUnoccludedTabIndicator(orcaPage, tabIds[6])
    const stripScrollLeft = await readTabStripScrollLeft(orcaPage, tabIds[6])
    const activeIndicator = targetTab.locator(':scope > span[aria-hidden]').first()
    await expect(activeIndicator).toBeInViewport({ ratio: 1 })
    const indicatorRegion = await activeIndicator.boundingBox()
    const targetTabRegion = await targetTab.boundingBox()
    const terminalRegion = await orcaPage
      .locator(`[data-terminal-tab-id="${tabIds[6]}"] .xterm-screen`)
      .first()
      .boundingBox()
    if (!indicatorRegion || !targetTabRegion || !terminalRegion || indicatorRegion.height !== 2) {
      throw new Error('Visible terminal and 2px active-tab indicator required for frame attribution')
    }
    diagnostic.terminalRegion = terminalRegion
    diagnostic.indicatorRegion = indicatorRegion
    const oldFrame = await capturedFrame(retained)
    await retained.evaluate((value) => value.arm())
    await startCompositorRecording(orcaPage, recording)
    await paintFrame(tabIds[6], 'RETENTION_UPDATED', 'cyan')
    const retainedExpected = await capturedFrame(retained)
    expect(foregroundPixelCount(retainedExpected, 'cyan')).toBeGreaterThan(500)
    expect(compareTerminalScreenshots(oldFrame, retainedExpected).diffPixels).toBeGreaterThan(500)
    const destinationCompositor = await firstCompositorFrame(
      recording,
      terminalRegion,
      (frame) => foregroundPixelCount(frame, 'cyan') > 500
    )
    const selectedIndicator = cropCompositorFrame(destinationCompositor.source, indicatorRegion)
    diagnostic.selectedIndicator = selectedIndicator
    diagnostic.baselines.push(
      { name: 'expected-cyan', body: destinationCompositor.pixels },
      { name: 'selected-indicator', body: selectedIndicator }
    )
    await activateTab(orcaPage, tabIds[7])
    await expect(targetTab).toHaveAttribute('data-active', 'false')
    await waitForUnoccludedTabIndicator(orcaPage, tabIds[6])
    expect(await readTabStripScrollLeft(orcaPage, tabIds[6])).toBe(stripScrollLeft)
    expect(await targetTab.boundingBox()).toEqual(targetTabRegion)
    expect(
      await orcaPage
        .locator(`[data-terminal-tab-id="${tabIds[7]}"] .xterm-screen`)
        .first()
        .boundingBox()
    ).toEqual(terminalRegion)
    await startCompositorRecording(orcaPage, recording)
    await paintFrame(tabIds[7], 'RETENTION_SOURCE', 'magenta')
    const sourceCompositor = await firstCompositorFrame(
      recording,
      terminalRegion,
      (frame) => foregroundPixelCount(frame, 'magenta') > 500
    )
    const unselectedIndicator = cropCompositorFrame(sourceCompositor.source, indicatorRegion)
    diagnostic.baselines.push(
      { name: 'source-magenta', body: sourceCompositor.pixels },
      { name: 'unselected-indicator', body: unselectedIndicator }
    )
    expect(
      compareTerminalScreenshots(selectedIndicator, unselectedIndicator).diffPixels
    ).toBeGreaterThan(32)
    await retained.evaluate((value) => value.arm())
    await startCompositorRecording(orcaPage, recording)
    await activateTab(orcaPage, tabIds[6])
    await expect(targetTab).toHaveAttribute('data-active', 'true')
    expect(await readTabStripScrollLeft(orcaPage, tabIds[6])).toBe(stripScrollLeft)
    expect(await targetTab.boundingBox()).toEqual(targetTabRegion)
    expect(await activeIndicator.boundingBox()).toEqual(indicatorRegion)
    await captureStableTabScreenshot(orcaPage, tabIds[6])
    expect(await readTabStripScrollLeft(orcaPage, tabIds[6])).toBe(stripScrollLeft)
    recording.enabled = false
    // CDP may drop/coalesce frames; attribute the earliest observed callback by tab chrome.
    const firstSelectedFrames = firstRecordedCompositorFrames(
      recording,
      terminalRegion,
      (source) =>
        compareTerminalScreenshots(
          selectedIndicator,
          cropCompositorFrame(source, indicatorRegion)
        ).diffPixels < 4
    )
    for (const frame of firstSelectedFrames) {
      expect(foregroundPixelCount(frame, 'cyan')).toBeGreaterThan(500)
      expect(
        compareTerminalScreenshots(destinationCompositor.pixels, frame).diffPixels
      ).toBeLessThan(32)
    }
    const firstReturnFrame = await capturedFrame(retained)
    expect(compareTerminalScreenshots(retainedExpected, firstReturnFrame).diffPixels).toBeLessThan(32)
    expect(await retained.evaluate((value) => value.state())).toMatchObject({
      sameAddon: true,
      lost: false
    })
    expect((await readActiveScreen(orcaPage, tabIds[6]))?.rows.join('\n')).toContain('RETENTION_UPDATED')

    await paintFrame(tabIds[6], 'RETENTION_HIDDEN_UPDATED', 'magenta')
    const hiddenExpected = await captureStableTabScreenshot(orcaPage, tabIds[6])
    await paintFrame(tabIds[6], 'RETENTION_UPDATED', 'cyan')
    await activateTab(orcaPage, tabIds[7])
    await expect.poll(() => retained.evaluate((value) => value.state().visible)).toBe(false)
    await writeFrame(
      tabIds[6],
      terminalFrame('RETENTION_HIDDEN_UPDATED', 'magenta'),
      'RETENTION_HIDDEN_UPDATED'
    )
    expect(await getActiveTabId(orcaPage)).toBe(tabIds[7])
    await activateTab(orcaPage, tabIds[6])
    await waitForPtyFrame(orcaPage, tabIds[6], 'RETENTION_HIDDEN_UPDATED')
    expect(
      compareTerminalScreenshots(
        hiddenExpected,
        await captureStableTabScreenshot(orcaPage, tabIds[6])
      ).matches
    ).toBe(true)
    expect(await retained.evaluate((value) => value.state())).toMatchObject({
      sameAddon: true,
      lost: false
    })

    await activateTab(orcaPage, firstTabId)
    await expect
      .poll(() =>
        orcaPage.evaluate((id) => {
          return window.__paneManagers?.get(id)?.getRenderingDiagnostics()[0]?.hasWebgl
        }, firstTabId)
      )
      .toBe(true)
    const recreated = await observeGraphics(orcaPage, firstTabId)
    observations.push(recreated)
    expect(
      await orcaPage.evaluate(
        ({ previous, current }) => ({
          addonChanged: previous.addon !== current.addon,
          contextChanged: previous.gl !== current.gl,
          active: !current.gl.isContextLost()
        }),
        { previous: observations[0], current: recreated }
      )
    ).toEqual({ addonChanged: true, contextChanged: true, active: true })
    expect((await readActiveScreen(orcaPage, firstTabId))?.rows.join('\n')).toContain('RETENTION_TAB_0')
    if (!oldestScreenshot) {
      throw new Error('Oldest baseline unavailable')
    }
    expect(
      compareTerminalScreenshots(
        oldestScreenshot,
        await captureStableTabScreenshot(orcaPage, firstTabId)
      ).matches
    ).toBe(true)
  } catch (error) {
    await attachCompositorDiagnostics(recording, diagnostic).catch(() => {
      console.warn('Could not attach compositor diagnostics; preserving the original test failure')
    })
    throw error
  } finally {
    recording.enabled = false
    for (const observation of observations) {
      await observation.evaluate((value) => value.restore()).catch(() => {})
      await observation.dispose()
    }
    await cdp.send('Page.stopScreencast').catch(() => {})
    await cdp.detach()
  }
}
