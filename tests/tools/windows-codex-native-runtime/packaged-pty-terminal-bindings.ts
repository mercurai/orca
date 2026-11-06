import type { Page } from '@stablyai/playwright-test'
import {
  createTerminalTab,
  listTabIds,
  waitForTerminalReady
} from '../win-update-e2e/app-driver.mjs'
import type { PtySession } from './packaged-pty-app-support'
import { delay, normalizeWindowsPath } from './packaged-pty-app-support'

type VisibleTerminalSurfaceBindings = { surfaceCount: number; ptyIds: string[] }

async function selectedVisibleTabIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-tab"][data-active="true"]:visible')
    .evaluateAll((tabs) =>
      tabs.map((tab) => tab.getAttribute('data-tab-id')).filter((id): id is string => Boolean(id))
    )
}

async function visibleTerminalSurfaceBindings(
  page: Page,
  tabId: string
): Promise<VisibleTerminalSurfaceBindings> {
  // Pane-title overlays also carry the tab id, but they do not own a terminal surface.
  return page
    .locator('[data-terminal-tab-id]:not([data-pane-prevent-terminal-focus]):visible')
    .evaluateAll((surfaces, targetTabId) => {
      const matching = surfaces.filter(
        (surface) => surface.getAttribute('data-terminal-tab-id') === targetTabId
      )
      const ptyIds = matching.flatMap((surface) => [
        ...(surface instanceof HTMLElement && surface.dataset.ptyId ? [surface.dataset.ptyId] : []),
        ...Array.from(surface.querySelectorAll<HTMLElement>('[data-pty-id]'))
          .map((pane) => pane.dataset.ptyId)
          .filter((id): id is string => Boolean(id))
      ])
      return { surfaceCount: matching.length, ptyIds: [...new Set(ptyIds)] }
    }, tabId)
}

async function terminalVisibilityDiagnostic(page: Page, worktreeId: string): Promise<string> {
  const unavailable = 'DOM counts unavailable'
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      readTerminalVisibilityDiagnostic(page, worktreeId).catch(() => unavailable),
      new Promise<string>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(unavailable), 1_000)
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async function readTerminalVisibilityDiagnostic(page: Page, worktreeId: string): Promise<string> {
  const state = await page.evaluate((targetWorktreeId) => {
    const visible = (element: HTMLElement): boolean =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
    const worktreeNodes = Array.from(
      document.querySelectorAll<HTMLElement>('[data-worktree-id]')
    ).filter((element) => element.dataset.worktreeId === targetWorktreeId)
    const strips = worktreeNodes.filter((element) =>
      element.hasAttribute('data-tab-group-strip-id')
    )
    const bodies = worktreeNodes.filter((element) => element.hasAttribute('data-tab-group-body-id'))
    const groupSelectedTabCount = strips
      .flatMap((strip) =>
        Array.from(strip.querySelectorAll<HTMLElement>('[data-testid="sortable-tab"]'))
      )
      .filter((tab) => tab.dataset.active === 'true' && visible(tab)).length
    const selectedTabs = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="sortable-tab"][data-active="true"]')
    )
    const terminalSurfaces = Array.from(
      document.querySelectorAll<HTMLElement>('[data-terminal-tab-id]')
    ).filter((element) => !element.hasAttribute('data-pane-prevent-terminal-focus'))
    return {
      renderedWorkspace: Array.from(
        document.querySelectorAll<HTMLElement>('[data-rendered-active-worktree-id]')
      ).some((element) => element.dataset.renderedActiveWorktreeId === targetWorktreeId),
      groupStrips: strips.length,
      groupBodies: bodies.length,
      groupSelectedTabs: groupSelectedTabCount,
      visibleSelectedTabs: selectedTabs.filter(visible).length,
      visibleLegacySelectedTabs: selectedTabs.filter(
        (tab) => visible(tab) && !tab.closest('[data-tab-group-strip-id]')
      ).length,
      visibleTerminalSurfaces: terminalSurfaces.filter(visible).length
    }
  }, worktreeId)
  return [
    `rendered=${state.renderedWorkspace}`,
    `strips=${state.groupStrips}`,
    `bodies=${state.groupBodies}`,
    `groupSelected=${state.groupSelectedTabs}`,
    `visibleSelected=${state.visibleSelectedTabs}`,
    `legacySelected=${state.visibleLegacySelectedTabs}`,
    `visibleSurfaces=${state.visibleTerminalSurfaces}`
  ].join(',')
}

export async function visibleTerminalTabId(
  page: Page,
  worktreeId: string,
  cwd: string
): Promise<string> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const candidates: string[] = []
    const sessions = await listPtySessions(page)
    for (const tabId of await selectedVisibleTabIds(page)) {
      const bindings = await visibleTerminalSurfaceBindings(page, tabId)
      if (bindings.surfaceCount === 0 || bindings.ptyIds.length === 0) {
        continue
      }
      const boundSessions = sessions.filter((session) => bindings.ptyIds.includes(session.id))
      const workspaceSessions = boundSessions.filter((session) => session.worktreeId === worktreeId)
      const targetSessions = workspaceSessions.filter(
        (session) => normalizeWindowsPath(session.cwd) === normalizeWindowsPath(cwd)
      )
      if (workspaceSessions.length > 0 && targetSessions.length === 0) {
        throw new Error(
          'A selected packaged terminal tab is attached to the target workspace at a different cwd'
        )
      }
      if (targetSessions.length === 0) {
        continue
      }
      if (
        bindings.surfaceCount !== 1 ||
        bindings.ptyIds.length !== 1 ||
        boundSessions.length !== 1 ||
        targetSessions.length !== 1
      ) {
        throw new Error(
          'A selected packaged terminal tab has duplicate visible surfaces or PTY bindings'
        )
      }
      candidates.push(tabId)
    }
    if (candidates.length > 1) {
      throw new Error('The packaged workspace has multiple selected terminal tabs')
    }
    if (candidates.length === 1) {
      const candidate = candidates[0]
      if (candidate) {
        return candidate
      }
    }
    await delay(100)
  }
  throw new Error(
    'The packaged workspace did not expose its selected terminal tab ' +
      `(${await terminalVisibilityDiagnostic(page, worktreeId)})`
  )
}

async function listPtySessions(page: Page): Promise<PtySession[]> {
  return page.evaluate(() => window.api.pty.listSessions({ connectionId: null }))
}

async function waitForNewSession(
  page: Page,
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

async function waitForNewTerminalTab(page: Page, previousTabIds: Set<string>): Promise<string> {
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
  page: Page,
  worktreeId: string,
  cwd: string,
  tabId: string
): Promise<PtySession> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const bindings = await visibleTerminalSurfaceBindings(page, tabId)
    if (bindings.surfaceCount > 0 && bindings.ptyIds.length > 0) {
      const boundSessions = (await listPtySessions(page)).filter((session) =>
        bindings.ptyIds.includes(session.id)
      )
      if (boundSessions.length === 0) {
        await delay(100)
        continue
      }
      const workspaceSessions = boundSessions.filter((session) => session.worktreeId === worktreeId)
      const targetSessions = workspaceSessions.filter(
        (session) => normalizeWindowsPath(session.cwd) === normalizeWindowsPath(cwd)
      )
      if (targetSessions.length === 0) {
        throw new Error('The selected terminal tab is attached to a different workspace or cwd')
      }
      if (
        bindings.surfaceCount !== 1 ||
        bindings.ptyIds.length !== 1 ||
        boundSessions.length !== 1 ||
        targetSessions.length !== 1
      ) {
        throw new Error('The selected terminal tab has duplicate visible surfaces or PTY bindings')
      }
      const targetSession = targetSessions[0]
      if (targetSession) {
        return targetSession
      }
    }
    await delay(100)
  }
  throw new Error(
    'The selected packaged terminal tab did not register its local PTY session ' +
      `(${await terminalVisibilityDiagnostic(page, worktreeId)})`
  )
}

export async function createBoundTerminalTab(
  page: Page,
  worktreeId: string,
  cwd: string
): Promise<{ tabId: string; session: PtySession }> {
  const existingTabId = await visibleTerminalTabId(page, worktreeId, cwd)
  await waitForTerminalReady(page, 30_000, existingTabId)
  await waitForTerminalTabSession(page, worktreeId, cwd, existingTabId)
  const previousPtyIds = new Set((await listPtySessions(page)).map((session) => session.id))
  const previousTabIds = new Set<string>(await listTabIds(page))
  await createTerminalTab(page)
  const tabId = await waitForNewTerminalTab(page, previousTabIds)
  await waitForTerminalReady(page, 30_000, tabId)
  if ((await visibleTerminalTabId(page, worktreeId, cwd)) !== tabId) {
    throw new Error('The new packaged terminal tab did not become the selected tab')
  }
  const session = await waitForNewSession(page, worktreeId, previousPtyIds)
  const boundSession = await waitForTerminalTabSession(page, worktreeId, cwd, tabId)
  if (boundSession.id !== session.id) {
    throw new Error('The new packaged terminal tab did not own its only new PTY session')
  }
  return { tabId, session }
}
