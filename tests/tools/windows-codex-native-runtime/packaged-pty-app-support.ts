import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { buildFreshProfile, createSeededRepo } from '../win-update-e2e/onboarding-profile.mjs'
import {
  launchInstalledApp,
  typeLine,
  tryClickWithKnownOverlayRetry,
  waitForTerminalReady
} from '../win-update-e2e/app-driver.mjs'
import { readRuntimeSettings } from './runtime-environment'

export { typeLine, waitForTerminalReady }

export type SessionHandle = {
  app: Awaited<ReturnType<typeof launchInstalledApp>>['app']
  page: Awaited<ReturnType<typeof launchInstalledApp>>['page']
}
export type PtySession = { id: string; cwd: string; worktreeId?: string }

export function normalizeWindowsPath(value: string): string {
  const windowsPath = value.replace(/^\/([a-z])\//i, '$1:/').replaceAll('/', '\\')
  return windowsPath
    .replace(/[\\/]+/g, '\\')
    .replace(/\\$/u, '')
    .toLowerCase()
}

export function isPathWithin(parent: string, candidate: string): boolean {
  const normalizedParent = normalizeWindowsPath(realpathSync.native(parent))
  const normalizedCandidate = normalizeWindowsPath(realpathSync.native(candidate))
  return normalizedCandidate.startsWith(`${normalizedParent}\\`)
}

export function assertPrerequisites(): {
  appExe: string
  settings: ReturnType<typeof readRuntimeSettings>
} {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The packaged Codex PTY lifecycle proof requires a Windows x64 runner')
  }
  const settings = readRuntimeSettings()
  const resourcesBin = dirname(settings.resolver)
  const resources = dirname(resourcesBin)
  const winUnpacked = dirname(resources)
  const appExe = join(winUnpacked, 'Orca.exe')
  const expectedResolver = join(resourcesBin, 'orca.exe')
  if (normalizeWindowsPath(settings.resolver) !== normalizeWindowsPath(expectedResolver)) {
    throw new Error(
      'ORCA_CODEX_RUNTIME_RESOLVER must be the packaged win-unpacked resources/bin/orca.exe'
    )
  }
  if (!existsSync(appExe)) {
    throw new Error('The packaged win-unpacked Orca.exe is missing beside the native resolver')
  }
  return { appExe, settings }
}

function sanitizedInheritedEnvironment(): () => void {
  const before = { ...process.env }
  const sensitiveName = /(TOKEN|SECRET|API.?KEY|AUTH|PASSWORD|CREDENTIAL|SESSION)/i
  for (const key of Object.keys(process.env)) {
    if (
      sensitiveName.test(key) ||
      /^(?:CODEX_HOME|ORCA_CODEX_HOME|HOME|USERPROFILE|ORCA_E2E_HOME_DIR|NODE_OPTIONS|NODE_PATH|ORCA_NODE_OPTIONS|ORCA_CODEX_NATIVE_RESOLVER|ORCA_DISABLE_CODEX_NATIVE_LAUNCH|ORCA_DISABLE_CMD_SHIM_RESOLUTION|ORCA_CODEX_RUNTIME_.*)$/i.test(
        key
      )
    ) {
      delete process.env[key]
    }
  }
  return () => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key]
    }
    Object.assign(process.env, before)
  }
}

export async function launchPackaged(
  appExe: string,
  userDataDir: string,
  appDataRoot: string,
  npmBin: string,
  seedProfile?: ReturnType<typeof buildFreshProfile>
): Promise<SessionHandle> {
  for (const name of ['appdata', 'localappdata', 'temp']) {
    mkdirSync(join(appDataRoot, name), { recursive: true })
  }
  const restoreEnvironment = sanitizedInheritedEnvironment()
  try {
    return await launchInstalledApp({
      exePath: appExe,
      userDataDir,
      seedProfile,
      extraEnv: {
        PATH: [npmBin, process.env.PATH].filter(Boolean).join(delimiter),
        APPDATA: join(appDataRoot, 'appdata'),
        LOCALAPPDATA: join(appDataRoot, 'localappdata'),
        TEMP: join(appDataRoot, 'temp'),
        TMP: join(appDataRoot, 'temp'),
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_CODEX_ISOLATE: '1',
        ORCA_CODEX_RUNTIME_NPM_BIN: npmBin,
        ORCA_CODEX_RUNTIME_NPM_BIN_POSIX: npmBin
          .replace(/\\/g, '/')
          .replace(/^([a-z]):\//i, (_match, drive: string) => `/${drive.toLowerCase()}/`)
      }
    })
  } finally {
    restoreEnvironment()
  }
}

export async function setWindowsShell(page: SessionHandle['page'], shell: string): Promise<void> {
  await page.evaluate(async (selectedShell) => {
    await window.api.settings.set({ terminalWindowsShell: selectedShell })
  }, shell)
  const savedShell = await page.evaluate(
    async () => (await window.api.settings.get()).terminalWindowsShell
  )
  if (savedShell !== shell) {
    throw new Error(`The packaged app did not accept its ${shell} terminal setting`)
  }
}

export async function createFolderWorkspace(
  page: SessionHandle['page'],
  folderPath: string
): Promise<string> {
  return page.evaluate(async (path) => {
    const group = await window.api.projectGroups.create({
      name: 'Native Codex PTY proof',
      parentPath: path,
      createdFrom: 'folder-scan'
    })
    const workspace = await window.api.folderWorkspaces.create({
      projectGroupId: group.id,
      name: 'Native Codex folder proof',
      folderPath: path
    })
    return `folder:${workspace.id}`
  }, folderPath)
}

export async function activateWorkspace(
  page: SessionHandle['page'],
  workspaceId: string
): Promise<void> {
  const row = page.locator(`[role="option"][data-worktree-id=${JSON.stringify(workspaceId)}]`)
  await row.waitFor({ state: 'visible', timeout: 30_000 })
  if (!(await tryClickWithKnownOverlayRetry(page, row, 30_000))) {
    await row.click({ timeout: 1 })
  }
}

export function createSeedProfile(repoPath: string): ReturnType<typeof buildFreshProfile> {
  const repo = createSeededRepo(repoPath)
  const profile = buildFreshProfile({ repo })
  profile.settings.telemetry.optedIn = false
  return profile
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
