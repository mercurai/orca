import type { Page } from '@stablyai/playwright-test'

export type PackagedPtyWorkspaceStage =
  | 'before-worktree-proof'
  | 'after-ps7-settings-change'
  | 'after-worktree-close-before-ps5-settings-change'
  | 'after-ps5-settings-change'
  | 'after-ps5-proof'
  | 'activation-failure'

type WorkspaceSnapshot = {
  available: boolean
  rowCurrent: boolean
  renderedWorkspaceMatch: boolean
  tabExpected: boolean
  tabDomCount: number
  tabVisibleCount: number
  tabActiveCount: number
  surfaceDomCount: number
  surfaceVisibleCount: number
  persistedTabPresent: boolean
  persistedPtyBound: boolean
  ptyExpected: boolean
  livePtyPresent: boolean
}

const UNAVAILABLE: WorkspaceSnapshot = {
  available: false,
  rowCurrent: false,
  renderedWorkspaceMatch: false,
  tabExpected: false,
  tabDomCount: 0,
  tabVisibleCount: 0,
  tabActiveCount: 0,
  surfaceDomCount: 0,
  surfaceVisibleCount: 0,
  persistedTabPresent: false,
  persistedPtyBound: false,
  ptyExpected: false,
  livePtyPresent: false
}

export async function reportPackagedPtyWorkspaceSnapshot(
  page: Page,
  stage: PackagedPtyWorkspaceStage,
  workspaceId: string,
  tabId?: string,
  ptyId?: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const unavailable = {
    ...UNAVAILABLE,
    tabExpected: Boolean(tabId),
    ptyExpected: Boolean(ptyId)
  }
  const timeout = new Promise<WorkspaceSnapshot>((resolve) => {
    timer = setTimeout(() => resolve(unavailable), 1_000)
  })
  try {
    const snapshot = await Promise.race([
      page
        .evaluate(
          async ({ workspaceId: targetWorkspaceId, tabId: targetTabId, ptyId: targetPtyId }) => {
            const isVisible = (element: HTMLElement): boolean =>
              element.getClientRects().length > 0 &&
              getComputedStyle(element).visibility !== 'hidden'
            const rows = Array.from(
              document.querySelectorAll<HTMLElement>('[role="option"][data-worktree-id]')
            ).filter((row) => row.dataset.worktreeId === targetWorkspaceId)
            const renderedWorkspaceMatch = Array.from(
              document.querySelectorAll<HTMLElement>('[data-rendered-active-worktree-id]')
            ).some((surface) => surface.dataset.renderedActiveWorktreeId === targetWorkspaceId)
            const tabs = targetTabId
              ? Array.from(
                  document.querySelectorAll<HTMLElement>('[data-testid="sortable-tab"]')
                ).filter((tab) => tab.dataset.tabId === targetTabId)
              : []
            const surfaces = targetTabId
              ? Array.from(
                  document.querySelectorAll<HTMLElement>(
                    '[data-terminal-tab-id]:not([data-pane-prevent-terminal-focus])'
                  )
                ).filter((surface) => surface.dataset.terminalTabId === targetTabId)
              : []
            const [persisted, sessions] = await Promise.all([
              window.api.session.get(),
              targetPtyId
                ? window.api.pty.listSessions({ connectionId: null })
                : Promise.resolve([])
            ])
            const persistedTab = targetTabId
              ? persisted.tabsByWorktree?.[targetWorkspaceId]?.find((tab) => tab.id === targetTabId)
              : undefined
            const persistedPtyIds = targetTabId
              ? Object.values(persisted.terminalLayoutsByTabId?.[targetTabId]?.ptyIdsByLeafId ?? {})
              : []
            return {
              available: true,
              rowCurrent: rows.some((row) => row.getAttribute('aria-current') === 'page'),
              renderedWorkspaceMatch,
              tabExpected: Boolean(targetTabId),
              tabDomCount: tabs.length,
              tabVisibleCount: tabs.filter(isVisible).length,
              tabActiveCount: tabs.filter((tab) => tab.dataset.active === 'true').length,
              surfaceDomCount: surfaces.length,
              surfaceVisibleCount: surfaces.filter(isVisible).length,
              persistedTabPresent: Boolean(persistedTab),
              persistedPtyBound: Boolean(
                targetPtyId &&
                (persistedTab?.ptyId === targetPtyId || persistedPtyIds.includes(targetPtyId))
              ),
              ptyExpected: Boolean(targetPtyId),
              livePtyPresent: Boolean(
                targetPtyId && sessions.some((session) => session.id === targetPtyId)
              )
            }
          },
          { workspaceId, tabId, ptyId }
        )
        .catch(() => unavailable),
      timeout
    ])
    console.log(`[packaged-pty-workspace] ${JSON.stringify({ stage, ...snapshot })}`)
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
