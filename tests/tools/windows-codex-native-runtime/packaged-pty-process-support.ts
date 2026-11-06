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
import { toBashPath } from './runtime-environment'

export type ManagedShell = 'bash' | 'powershell'

export type { NativeCodexIdentity, ShellIdentity }

export type BashProbeDiagnostic = {
  bashStarted: boolean
  codexLookupPresent: boolean
  npmPrefixMatch: boolean
  windowsPidPresent: boolean
  readEofHandled: boolean
}

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

function bashPathQuote(value: string): string {
  return shellQuote(toBashPath(value))
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
    return `{ ${lines.join('; ')}; } > ${bashPathQuote(filePath)}`
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
  diagnostic: string
}): string {
  return [
    'export CODEX_HOME="$HOME/.codex"',
    '__orca_bash_started=0; if [[ -n "${BASH_VERSION:-}" ]]; then __orca_bash_started=1; fi',
    '__orca_codex_path="$(type -P codex 2>/dev/null || :)"',
    '__orca_codex_lookup_present=0; if [[ -n "$__orca_codex_path" ]]; then __orca_codex_lookup_present=1; fi',
    '__orca_npm_prefix_match=0; case "$__orca_codex_path" in "$ORCA_CODEX_RUNTIME_NPM_BIN_POSIX"/codex*) __orca_npm_prefix_match=1 ;; esac',
    '__orca_windows_pid=""; IFS= read -r __orca_windows_pid < "/proc/$$/winpid" || :',
    '__orca_windows_pid_present=0; if [[ "$__orca_windows_pid" =~ ^[0-9]+$ ]]; then __orca_windows_pid_present=1; fi',
    '__orca_read_with_newline=""; IFS= read -r __orca_read_with_newline <<< "codex-pid"',
    '__orca_read_without_newline=""; IFS= read -r __orca_read_without_newline < <(printf "codex-pid") || :',
    '__orca_read_eof_handled=0; if [[ "$__orca_read_with_newline" == codex-pid && "$__orca_read_without_newline" == codex-pid ]]; then __orca_read_eof_handled=1; fi',
    `printf 'bashStarted=%s\\ncodexLookupPresent=%s\\nnpmPrefixMatch=%s\\nwindowsPidPresent=%s\\nreadEofHandled=%s\\n' "$__orca_bash_started" "$__orca_codex_lookup_present" "$__orca_npm_prefix_match" "$__orca_windows_pid_present" "$__orca_read_eof_handled" > ${bashPathQuote(paths.diagnostic)}`,
    `printf '%s\\n' "$__orca_codex_path" > ${bashPathQuote(paths.npmPath)}`,
    `printf '%s\\n' "$__orca_windows_pid" > ${bashPathQuote(paths.shellPid)}`,
    'case "$__orca_npm_prefix_match" in 1) ;; *) exit 96 ;; esac',
    `printf '%s\\n' "$ORCA_CODEX_NATIVE_RESOLVER" > ${bashPathQuote(paths.resolver)}`,
    `printf '%s\\n' "$CODEX_HOME" > ${bashPathQuote(paths.codexHome)}`
  ].join('; ')
}

export async function waitForBashProbeDiagnostic(paths: {
  shellPid: string
  resolver: string
  npmPath: string
  codexHome: string
  diagnostic: string
}): Promise<BashProbeDiagnostic> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (existsSync(paths.diagnostic) && existsSync(paths.npmPath) && existsSync(paths.shellPid)) {
      const fields: Record<string, string> = {}
      for (const line of readFileSync(paths.diagnostic, 'utf8').trim().split(/\r?\n/u)) {
        const separator = line.indexOf('=')
        if (separator > 0) {
          fields[line.slice(0, separator)] = line.slice(separator + 1)
        }
      }
      return {
        bashStarted: fields.bashStarted === '1',
        codexLookupPresent: fields.codexLookupPresent === '1',
        npmPrefixMatch: fields.npmPrefixMatch === '1',
        windowsPidPresent: fields.windowsPidPresent === '1',
        readEofHandled: fields.readEofHandled === '1'
      }
    }
    await delay(100)
  }
  throw new Error(
    `Bash probe did not complete preguard markers (stage=before-prefix-check; diagnosticWritten=${existsSync(paths.diagnostic)}; npmPathWritten=${existsSync(paths.npmPath)}; shellPidWritten=${existsSync(paths.shellPid)}; resolverWritten=${existsSync(paths.resolver)}; codexHomeWritten=${existsSync(paths.codexHome)})`
  )
}

export function assertBashProbeWindowsPid(diagnostic: BashProbeDiagnostic): void {
  if (!diagnostic.bashStarted || !diagnostic.windowsPidPresent || !diagnostic.readEofHandled) {
    throw new Error(
      `Bash probe did not resolve its Windows PID (stage=winpid-read; bashStarted=${diagnostic.bashStarted}; codexLookupPresent=${diagnostic.codexLookupPresent}; npmPrefixMatch=${diagnostic.npmPrefixMatch}; windowsPidPresent=${diagnostic.windowsPidPresent}; readEofHandled=${diagnostic.readEofHandled})`
    )
  }
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

export function assertNpmShimSentinel(
  filePath: string,
  npmBin: string,
  diagnostic?: BashProbeDiagnostic
): void {
  const shimPath = normalizeWindowsPath(readFileSync(filePath, 'utf8').trim())
  const expectedPrefix = `${normalizeWindowsPath(npmBin)}\\`
  const prefixMatches = shimPath.startsWith(expectedPrefix)
  if (!prefixMatches || (diagnostic && !diagnostic.npmPrefixMatch)) {
    const status = diagnostic
      ? ` (stage=npm-prefix-check; bashStarted=${diagnostic.bashStarted}; codexLookupPresent=${diagnostic.codexLookupPresent}; observedPrefixMatch=${prefixMatches}; bashPrefixMatch=${diagnostic.npmPrefixMatch}; windowsPidPresent=${diagnostic.windowsPidPresent}; readEofHandled=${diagnostic.readEofHandled})`
      : ''
    throw new Error(`The packaged PTY did not select Codex from its isolated npm prefix${status}`)
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
      ? `printf 'returned' > ${bashPathQuote(markerPath)}`
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
