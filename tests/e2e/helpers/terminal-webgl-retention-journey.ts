import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { readActiveScreen, writeToPaneTerminal } from './alt-screen-frame'
import { getActiveTabId } from './store'
import { compareTerminalScreenshots } from '../terminal-screenshot-diff'
import { captureStableTabScreenshot } from '../terminal-tab-screenshot'
import {
  capturedFrame,
  cropCompositorFrame,
  firstCompositorFrame,
  foregroundPixelCount,
  observeGraphics,
  prepareTerminalGraphics,
  startCompositorRecording,
  terminalFrame,
  type CompositorRecording,
  type GraphicsObservation
} from './terminal-webgl-retention-graphics'

type RetentionJourney = {
  page: Page
  worktreeId: string
  firstTabId: string
  createTab: () => Promise<string>
  startIdleTerminal: (tabId: string, marker: string) => Promise<void>
}

async function activateTab(page: Page, tabId: string): Promise<void> {
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

export async function exerciseTerminalTabWebglRetention({
  page: orcaPage,
  worktreeId,
  firstTabId,
  createTab,
  startIdleTerminal
}: RetentionJourney): Promise<void> {
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  const recording: CompositorRecording = { enabled: false, startedAt: 0, error: null, frames: [] }
  cdp.on('Page.screencastFrame', (frame) => {
    if (recording.enabled) {
      const capturedAt = frame.metadata.timestamp
      if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt)) {
        recording.error = 'Compositor frame lacks a capture timestamp'
      } else if (capturedAt >= recording.startedAt && recording.frames.length < 64) {
        recording.frames.push({
          data: frame.data,
          width: frame.metadata.deviceWidth,
          height: frame.metadata.deviceHeight
        })
      }
    }
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
  })
  await cdp.send('Page.enable')
  // CDP keeps the isolated hidden renderer painting without activating its window.
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
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
    let retainedExpected: Buffer | undefined
    for (let index = 0; index < 8; index += 1) {
      if (index > 0) {
        tabIds.push(await createTab())
      }
      const tabId = tabIds[index]
      await activateTab(orcaPage, tabId)
      const marker = `RETENTION_TAB_${index}`
      await startIdleTerminal(tabId, marker)
      const observation = await prepareTerminalGraphics(orcaPage, tabId, marker)
      observations.push(observation)
      if (index === 0) {
        oldestScreenshot = await captureStableTabScreenshot(orcaPage, tabId)
        expect(foregroundPixelCount(oldestScreenshot, 'red')).toBeGreaterThan(500)
      }
      if (index === 6) {
        const oldFrame = await capturedFrame(observation)
        await observation.evaluate((value) => value.arm())
        await writeToPaneTerminal(orcaPage, tabId, terminalFrame('RETENTION_UPDATED', 'cyan'))
        retainedExpected = await capturedFrame(observation)
        expect(foregroundPixelCount(retainedExpected, 'cyan')).toBeGreaterThan(500)
        expect(compareTerminalScreenshots(oldFrame, retainedExpected).diffPixels).toBeGreaterThan(500)
        await observation.evaluate((value) => value.arm())
        await writeToPaneTerminal(orcaPage, tabId, terminalFrame('RETENTION_TAB_6'))
        await capturedFrame(observation)
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
    await startCompositorRecording(orcaPage, recording)
    await writeToPaneTerminal(orcaPage, tabIds[6], terminalFrame('RETENTION_UPDATED', 'cyan'))
    const destinationCompositor = await firstCompositorFrame(
      recording,
      terminalRegion,
      (frame) => foregroundPixelCount(frame, 'cyan') > 500
    )
    const selectedIndicator = cropCompositorFrame(destinationCompositor.source, indicatorRegion)
    await retained.evaluate((value) => value.arm())
    await writeToPaneTerminal(orcaPage, tabIds[6], terminalFrame('RETENTION_TAB_6'))
    await capturedFrame(retained)
    await activateTab(orcaPage, tabIds[7])
    await expect(targetTab).toHaveAttribute('data-active', 'false')
    expect(await targetTab.boundingBox()).toEqual(targetTabRegion)
    expect(
      await orcaPage
        .locator(`[data-terminal-tab-id="${tabIds[7]}"] .xterm-screen`)
        .first()
        .boundingBox()
    ).toEqual(terminalRegion)
    await startCompositorRecording(orcaPage, recording)
    await writeToPaneTerminal(orcaPage, tabIds[7], terminalFrame('RETENTION_SOURCE', 'magenta'))
    const sourceCompositor = await firstCompositorFrame(
      recording,
      terminalRegion,
      (frame) => foregroundPixelCount(frame, 'magenta') > 500
    )
    const unselectedIndicator = cropCompositorFrame(sourceCompositor.source, indicatorRegion)
    expect(
      compareTerminalScreenshots(selectedIndicator, unselectedIndicator).diffPixels
    ).toBeGreaterThan(32)
    await retained.evaluate((value) => value.arm())
    await writeToPaneTerminal(orcaPage, tabIds[6], terminalFrame('RETENTION_UPDATED', 'cyan'))
    await startCompositorRecording(orcaPage, recording)
    await activateTab(orcaPage, tabIds[6])
    await expect(targetTab).toHaveAttribute('data-active', 'true')
    expect(await targetTab.boundingBox()).toEqual(targetTabRegion)
    expect(await activeIndicator.boundingBox()).toEqual(indicatorRegion)
    // Screencast may coalesce frames; select the first captured reveal by tab chrome, never content.
    const firstSelectedCompositor = await firstCompositorFrame(
      recording,
      terminalRegion,
      (_pixels, source) =>
        compareTerminalScreenshots(
          selectedIndicator,
          cropCompositorFrame(source, indicatorRegion)
        ).diffPixels < 4
    )
    expect(foregroundPixelCount(firstSelectedCompositor.pixels, 'cyan')).toBeGreaterThan(500)
    expect(
      compareTerminalScreenshots(destinationCompositor.pixels, firstSelectedCompositor.pixels).diffPixels
    ).toBeLessThan(32)
    const firstReturnFrame = await capturedFrame(retained)
    if (!retainedExpected) {
      throw new Error('Retained baseline unavailable')
    }
    expect(compareTerminalScreenshots(retainedExpected, firstReturnFrame).diffPixels).toBeLessThan(32)
    expect(await retained.evaluate((value) => value.state())).toMatchObject({
      sameAddon: true,
      lost: false
    })
    expect((await readActiveScreen(orcaPage, tabIds[6]))?.rows.join('\n')).toContain('RETENTION_UPDATED')

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
