import { existsSync, readFileSync } from 'node:fs'
import type { WindowsProcessIdentityRow } from '../../../src/main/windows/windows-process-table'
import { readWindowsProcessIdentityTableFresh } from '../../../src/main/windows/windows-process-table'
import { typeLine, sendCtrlC } from '../win-update-e2e/app-driver.mjs'
import type { SessionHandle } from './packaged-pty-app-support'
import { normalizeWindowsPath, delay } from './packaged-pty-app-support'
import {
  waitForNativeCodex,
  type NativeCodexIdentity,
  type ShellIdentity
} from './packaged-pty-native-process'
import { appServerHandshake } from './packaged-pty-app-server-protocol'
import {
  processIdentity,
  processTreeForRoot,
  waitForProcessTreeExit,
  type ProcessIdentity
} from './process-tree-identity'

export type ManagedShell = 'bash' | 'powershell'

export type { NativeCodexIdentity, ShellIdentity }

const MANAGED_ENV_EXPECTED = [
  'present:pty-parent-package-root',
  'present:pty-parent-npm',
  'present:pty-parent-bun',
  'absent',
  'absent'
]
const MANAGED_ENV_NAMES = [
  'CODEX_MANAGED_PACKAGE_ROOT',
  'CODEX_MANAGED_BY_NPM',
  'CODEX_MANAGED_BY_BUN',
  'CODEX_MANAGED_BY_PNPM',
  'CODEX_MANAGED_BY_VITE_PLUS'
]

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function seedManagedEnvironmentCommand(shell: ManagedShell): string {
  if (shell === 'bash') {
    return [
      "export CODEX_MANAGED_PACKAGE_ROOT='pty-parent-package-root'",
      "export CODEX_MANAGED_BY_NPM='pty-parent-npm'",
      "export CODEX_MANAGED_BY_BUN='pty-parent-bun'",
      'unset CODEX_MANAGED_BY_PNPM CODEX_MANAGED_BY_VITE_PLUS'
    ].join('; ')
  }
  return [
    "$env:CODEX_MANAGED_PACKAGE_ROOT = 'pty-parent-package-root'",
    "$env:CODEX_MANAGED_BY_NPM = 'pty-parent-npm'",
    "$env:CODEX_MANAGED_BY_BUN = 'pty-parent-bun'",
    'Remove-Item Env:CODEX_MANAGED_BY_PNPM, Env:CODEX_MANAGED_BY_VITE_PLUS -ErrorAction SilentlyContinue'
  ].join('; ')
}

export function writeManagedEnvironmentReportCommand(
  shell: ManagedShell,
  filePath: string
): string {
  if (shell === 'bash') {
    const lines = MANAGED_ENV_NAMES.map(
      (name) =>
        `if [[ \${${name}+x} ]]; then printf 'present:%s\\n' "$${name}"; else printf 'absent\\n'; fi`
    )
    return `{ ${lines.join('; ')}; } > ${shellQuote(filePath)}`
  }
  const lines = MANAGED_ENV_NAMES.map(
    (name) =>
      `if (Test-Path Env:${name}) { [void]$managed.Add('present:' + [Environment]::GetEnvironmentVariable('${name}', 'Process')) } else { [void]$managed.Add('absent') }`
  )
  return `$managed = New-Object 'System.Collections.Generic.List[string]'; ${lines.join('; ')}; [IO.File]::WriteAllLines(${powershellQuote(filePath)}, $managed.ToArray())`
}

export function assertManagedEnvironmentRestored(filePath: string): void {
  const lines = readFileSync(filePath, 'utf8')
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n$/u, '')
    .split('\n')
  if (
    lines.length !== MANAGED_ENV_EXPECTED.length ||
    lines.some((value, index) => value !== MANAGED_ENV_EXPECTED[index])
  ) {
    throw new Error(
      'The native shell function did not restore all CODEX_MANAGED_* parent values and presence'
    )
  }
}

export function bashProbeCommand(paths: {
  shellPid: string
  resolver: string
  npmPath: string
  codexHome: string
}): string {
  return [
    'export CODEX_HOME="$HOME/.codex"',
    'case "$(type -P codex 2>/dev/null)" in "$ORCA_CODEX_RUNTIME_NPM_BIN_POSIX"/codex*) ;; *) exit 96 ;; esac',
    `printf '%s\\n' "$(type -P codex 2>/dev/null)" > ${shellQuote(paths.npmPath)}`,
    `printf '%s\\n' "$$" > ${shellQuote(paths.shellPid)}`,
    `printf '%s\\n' "$ORCA_CODEX_NATIVE_RESOLVER" > ${shellQuote(paths.resolver)}`,
    `printf '%s\\n' "$CODEX_HOME" > ${shellQuote(paths.codexHome)}`
  ].join('; ')
}

export function powershellStartupCommand(paths: {
  shellPid: string
  resolver: string
  npmPath: string
  codexHome: string
}): string {
  return [
    "$env:CODEX_HOME = Join-Path $HOME '.codex'",
    '$selected = Get-Command codex -CommandType ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1',
    '$selectedPath = if ($selected.Source) { [string]$selected.Source } else { [string]$selected.Path }',
    'if (-not $selected -or -not $selectedPath.StartsWith($env:ORCA_CODEX_RUNTIME_NPM_BIN, [System.StringComparison]::OrdinalIgnoreCase)) { exit 96 }',
    `[System.IO.File]::WriteAllText(${powershellQuote(paths.npmPath)}, $selectedPath)`,
    `[System.IO.File]::WriteAllText(${powershellQuote(paths.shellPid)}, [string]$PID)`,
    `[System.IO.File]::WriteAllText(${powershellQuote(paths.resolver)}, [string]$env:ORCA_CODEX_NATIVE_RESOLVER)`,
    `[System.IO.File]::WriteAllText(${powershellQuote(paths.codexHome)}, [string]$env:CODEX_HOME)`,
    seedManagedEnvironmentCommand('powershell'),
    'codex app-server'
  ].join('; ')
}

export function assertCodexHomeSentinel(filePath: string, expectedHome: string): void {
  if (
    normalizeWindowsPath(readFileSync(filePath, 'utf8').trim()) !==
    normalizeWindowsPath(expectedHome)
  ) {
    throw new Error('The packaged PTY did not use the isolated empty Codex home')
  }
}

export async function waitForFile(filePath: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return readFileSync(filePath, 'utf8').trim()
    }
    await delay(100)
  }
  throw new Error('A terminal lifecycle sentinel was not written')
}

export function readShellIdentity(
  filePath: string,
  rows: WindowsProcessIdentityRow[],
  expectedName: string
): ShellIdentity {
  const pid = Number(readFileSync(filePath, 'utf8').trim())
  const row = rows.find((candidate) => candidate.pid === pid)
  if (!Number.isSafeInteger(pid) || pid <= 0 || !row || row.name.toLowerCase() !== expectedName) {
    throw new Error('The terminal shell identity did not match its pane sentinel')
  }
  return { ...processIdentity(row), name: row.name }
}

export function assertResolverSentinel(filePath: string, resolverPath: string): void {
  if (
    normalizeWindowsPath(readFileSync(filePath, 'utf8').trim()) !==
    normalizeWindowsPath(resolverPath)
  ) {
    throw new Error('The packaged PTY did not receive its resources/bin native resolver')
  }
}

export function assertNpmShimSentinel(filePath: string, npmBin: string): void {
  const shimPath = normalizeWindowsPath(readFileSync(filePath, 'utf8').trim())
  const expectedPrefix = `${normalizeWindowsPath(npmBin)}\\`
  if (!shimPath.startsWith(expectedPrefix)) {
    throw new Error('The packaged PTY did not select Codex from its isolated npm prefix')
  }
}

export async function assertIdentityAlive(identity: ProcessIdentity, label: string): Promise<void> {
  const rows = await readWindowsProcessIdentityTableFresh()
  if (
    !rows.some((row) => row.pid === identity.pid && row.creationTimeMs === identity.creationTimeMs)
  ) {
    throw new Error(`${label} did not survive the warm packaged-app reattach`)
  }
}

export async function writeShellReturnMarker(
  page: SessionHandle['page'],
  shell: 'bash' | 'powershell',
  tabId: string,
  markerPath: string
): Promise<void> {
  const command =
    shell === 'bash'
      ? `printf 'returned' > ${shellQuote(markerPath)}`
      : `[System.IO.File]::WriteAllText(${powershellQuote(markerPath)}, 'returned')`
  await typeLine(page, command, tabId)
  if ((await waitForFile(markerPath)) !== 'returned') {
    throw new Error('Ctrl+C did not return input to the owning shell')
  }
}

export async function clickCloseTab(
  page: SessionHandle['page'],
  tabId: string,
  expectPrompt: boolean
): Promise<void> {
  const tab = page
    .locator(`[data-testid="sortable-tab"][data-tab-id=${JSON.stringify(tabId)}]`)
    .first()
  await tab.getByRole('button', { name: /^Close tab /i }).click({ force: true })
  if (expectPrompt) {
    await page
      .getByText(/Stop running command\?|Stop this agent\?/)
      .waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByRole('button', { name: 'Stop and Close' }).click()
  }
  await tab.waitFor({ state: 'hidden', timeout: 20_000 })
}

export async function waitForPackagedAppServer(
  page: SessionHandle['page'],
  ptyId: string,
  tabId: string,
  shell: ShellIdentity,
  requestId: number
): Promise<{ codex: NativeCodexIdentity; tree: ProcessIdentity[] }> {
  const runtime = await waitForNativeCodex(shell)
  await appServerHandshake(page, ptyId, tabId, requestId)
  return runtime
}

export {
  appServerHandshake,
  sendCtrlC,
  waitForNativeCodex,
  waitForProcessTreeExit,
  processIdentity,
  processTreeForRoot
}
