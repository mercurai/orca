import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { addFolderWorkspace } from './helpers/terminal-layout-journeys'
import { exerciseTerminalTabWebglRetention } from './helpers/terminal-webgl-retention-journey'

test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

async function startIdleTerminal(page: Page, marker: string): Promise<void> {
  await waitForActiveTerminalManager(page)
  const ptyId = await waitForActivePanePtyId(page)
  const ready = `RETENTION_READY_${marker}`
  const script = await runNodeScriptInTerminal(
    page,
    ptyId,
    `process.stdout.write(${JSON.stringify(`${ready}\n`)}); setInterval(() => {}, 1000)`
  )
  try {
    await expect.poll(() => getTerminalContent(page)).toContain(ready)
  } finally {
    script.cleanup()
  }
}

for (const workspaceKind of ['git', 'folder'] as const) {
  test(`${workspaceKind} tabs retain bounded WebGL and resume lightly @headful`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    const folder = workspaceKind === 'folder' ? await addFolderWorkspace(orcaPage) : null
    if (folder) {
      registerPostElectronShutdownCleanup(async () => folder.cleanup())
    }
    const worktreeId = folder?.worktreeId ?? (await waitForActiveWorktree(orcaPage))
    await ensureTerminalVisible(orcaPage)
    const firstTabId = await getActiveTabId(orcaPage)
    if (!firstTabId) {
      throw new Error('Initial terminal tab unavailable')
    }
    await exerciseTerminalTabWebglRetention({
      page: orcaPage,
      worktreeId,
      firstTabId,
      createTab: () =>
        orcaPage.evaluate((id) => {
          const state = window.__store?.getState()
          if (!state) {
            throw new Error('Store unavailable')
          }
          return state.createTab(id, undefined, undefined, { activate: true }).id
        }, worktreeId),
      startIdleTerminal: (_tabId, marker) => startIdleTerminal(orcaPage, marker)
    })
  })
}
