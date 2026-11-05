import { expect, test } from './helpers/orca-app'
import {
  expectPaneText,
  launchManagedWorkspace,
  openTerminalTab,
  ORCAD_TEMPLATE,
  typeInTerminal,
  withManagedHost
} from './helpers/orcad-managed-workspace'
import { exerciseTerminalTabWebglRetention } from './helpers/terminal-webgl-retention-journey'
import { remoteFrameReaderCommand, writePtyFrame } from './helpers/terminal-webgl-pty-fixture'

test('SSH tabs retain bounded WebGL and resume lightly @headful', async ({ browserName }, testInfo) => {
  test.setTimeout(12 * 60_000)
  expect(browserName).toBe('chromium')
  expect(process.env.ORCA_E2E_SSH_DOCKER, 'Required managed SSH Docker fixture').toBe('1')
  expect(ORCAD_TEMPLATE, 'Required managed server template').toBeTruthy()
  expect(process.env.ORCA_BACKGROUND_LAUNCH, 'Custom sessions must remain hidden').toBe('1')
  expect(testInfo.project.metadata.orcaHeadful, 'Required GPU-enabled E2E project').toBe(true)
  await withManagedHost(testInfo, async (fixture) => {
    const { page, seeded, environmentId } = await launchManagedWorkspace(fixture)
    const firstTabId = await openTerminalTab(page, seeded.worktreeId)
    await exerciseTerminalTabWebglRetention({
      page,
      worktreeId: seeded.worktreeId,
      firstTabId,
      createTab: () => openTerminalTab(page, seeded.worktreeId),
      startIdleTerminal: async (tabId, marker) => {
        await typeInTerminal(page, tabId, remoteFrameReaderCommand(marker))
        await expectPaneText(page, tabId, `RETENTION_READY_${marker}`)
      },
      writeFrame: (tabId, data, marker) => writePtyFrame(page, tabId, data, marker, environmentId)
    })
  })
})
