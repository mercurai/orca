import {
  createTerminalTab,
  listTabIds,
  waitForTerminalReady
} from '../win-update-e2e/app-driver.mjs'
import type { SessionHandle, PtySession } from './packaged-pty-app-support'
import { delay, normalizeWindowsPath } from './packaged-pty-app-support'

export async function visibleTerminalTabId(
  page: SessionHandle['page'],
  worktreeId: string
): Promise<string> {
  const deadline = Date.now() + 30_000
  const workspaceSelector =
    `[data-tab-group-strip-id][data-worktree-id=${JSON.stringify(worktreeId)}] ` +
    '[data-testid="sortable-tab"][data-active="true"]:visible'
  while (Date.now() < deadline) {
    const selectedTabIds = await page
      .locator(workspaceSelector)
      .evaluateAll((tabs) =>
        tabs.map((tab) => tab.getAttribute('data-tab-id')).filter((id): id is string => Boolean(id))
      )
    if (selectedTabIds.length > 1) {
      throw new Error('The packaged workspace has multiple selected terminal tabs')
    }
    const tabId = selectedTabIds[0]
    if (tabId) {
      const surface = page.locator(
        `[data-tab-group-body-id][data-worktree-id=${JSON.stringify(worktreeId)}] ` +
          `[data-terminal-tab-id=${JSON.stringify(tabId)}]:visible`
      )
      if ((await surface.count()) === 1) {
        return tabId
      }
    }
    await delay(100)
  }
  throw new Error('The packaged workspace did not expose its selected terminal tab')
}

async function listPtySessions(page: SessionHandle['page']): Promise<PtySession[]> {
  return page.evaluate(() => window.api.pty.listSessions({ connectionId: null }))
}

async function waitForNewSession(
  page: SessionHandle['page'],
  worktreeId: string,
  previousIds: Set<string>
): Promise<PtySession> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const sessions = await listPtySessions(page)
    const created = sessions.filter(
      (session) => session.worktreeId === worktreeId && !previousIds.has(session.id)
    )
    if (created.length === 1) {
      return created[0]
    }
    if (created.length > 1) {
      throw new Error('Creating one terminal tab produced multiple new PTY sessions')
    }
    await delay(100)
  }
  throw new Error('The new packaged terminal tab never registered a local PTY session')
}

async function waitForNewTerminalTab(
  page: SessionHandle['page'],
  previousTabIds: Set<string>
): Promise<string> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const tabs = await listTabIds(page)
    const created = tabs.filter((tabId) => !previousTabIds.has(tabId))
    if (created.length === 1) {
      return created[0]
    }
    if (created.length > 1) {
      throw new Error('Creating one terminal tab produced multiple new terminal tabs')
    }
    await delay(100)
  }
  throw new Error('The new packaged terminal tab did not register')
}

export async function waitForTerminalTabSession(
  page: SessionHandle['page'],
  worktreeId: string,
  cwd: string,
  tabId: string
): Promise<PtySession> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const surfaces = page.locator(
      `[data-tab-group-body-id][data-worktree-id=${JSON.stringify(worktreeId)}] ` +
        `[data-terminal-tab-id=${JSON.stringify(tabId)}]:visible`
    )
    const surfaceCount = await surfaces.count()
    if (surfaceCount > 1) {
      throw new Error('The packaged terminal tab has multiple visible surfaces')
    }
    if (surfaceCount === 1) {
      const ptyIds = await surfaces.evaluateAll((roots) => [
        ...new Set(
          roots.flatMap((root) =>
            [...root.querySelectorAll<HTMLElement>('[data-pty-id]')]
              .map((pane) => pane.dataset.ptyId)
              .filter((id): id is string => Boolean(id))
          )
        )
      ])
      if (ptyIds.length > 1) {
        throw new Error('The packaged terminal tab is bound to multiple PTY sessions')
      }
      const ptyId = ptyIds[0]
      if (ptyId) {
        const matches = (await listPtySessions(page)).filter((session) => session.id === ptyId)
        if (matches.length > 1) {
          throw new Error('The packaged PTY inventory returned duplicate session identities')
        }
        const session = matches[0]
        if (session) {
          if (
            session.worktreeId !== worktreeId ||
            normalizeWindowsPath(session.cwd) !== normalizeWindowsPath(cwd)
          ) {
            throw new Error('The selected terminal tab is attached to a different workspace or cwd')
          }
          return session
        }
      }
    }
    await delay(100)
  }
  throw new Error('The selected packaged terminal tab did not register its local PTY session')
}

export async function createBoundTerminalTab(
  page: SessionHandle['page'],
  worktreeId: string,
  cwd: string
): Promise<{ tabId: string; session: PtySession }> {
  const existingTabId = await visibleTerminalTabId(page, worktreeId)
  await waitForTerminalReady(page, 30_000, existingTabId)
  await waitForTerminalTabSession(page, worktreeId, cwd, existingTabId)
  const previousPtyIds = new Set((await listPtySessions(page)).map((session) => session.id))
  const previousTabIds = new Set(await listTabIds(page))
  await createTerminalTab(page)
  const tabId = await waitForNewTerminalTab(page, previousTabIds)
  await waitForTerminalReady(page, 30_000, tabId)
  if ((await visibleTerminalTabId(page, worktreeId)) !== tabId) {
    throw new Error('The new packaged terminal tab did not become the selected tab')
  }
  const session = await waitForNewSession(page, worktreeId, previousPtyIds)
  const boundSession = await waitForTerminalTabSession(page, worktreeId, cwd, tabId)
  if (boundSession.id !== session.id) {
    throw new Error('The new packaged terminal tab did not own its only new PTY session')
  }
  return { tabId, session }
}
