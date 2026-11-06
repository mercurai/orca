import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getPosixCodexShellLaunchPreflight,
  getPowerShellCodexShellLaunchPreflight
} from '../../../src/shared/codex-shell-function'
import { runtimeShellJobGate } from './runtime-shell-job'
import { shellScriptWithRuntimeMilestones } from './runtime-shell-milestones'
import { toBashPath, type RuntimeShell } from './runtime-environment'

export function shellScript(
  shell: RuntimeShell,
  npmBin: string,
  invalidEnum = false,
  waitForJob = false,
  milestoneDiagnostics = false
): string {
  const template =
    shell.kind === 'bash'
      ? getPosixCodexShellLaunchPreflight()
      : getPowerShellCodexShellLaunchPreflight()
  const invalid = '__orca_native_runtime_invalid_sandbox__'
  const body = invalidEnum
    ? shell.kind === 'bash'
      ? `codex --sandbox ${invalid} app-server\nexit $?`
      : `codex --sandbox '${invalid}' app-server\nexit $LASTEXITCODE`
    : 'codex app-server'
  const guard =
    shell.kind === 'bash'
      ? `case "$(command -v codex 2>/dev/null)" in "${toBashPath(npmBin)}"/codex*) ;; *) exit 96 ;; esac`
      : [
          // Cold PS5 test homes must not scan unrelated installed modules during command discovery.
          ...(shell.name === 'Windows PowerShell'
            ? ["$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')"]
            : []),
          '$orcaSelectedCodex = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1',
          'if (-not $orcaSelectedCodex -or',
          '    -not $orcaSelectedCodex.Source.StartsWith($env:ORCA_CODEX_RUNTIME_NPM_BIN,',
          '        [System.StringComparison]::OrdinalIgnoreCase)) { exit 96 }'
        ].join('\n')
  const gate = waitForJob ? runtimeShellJobGate(shell) : ''
  return shellScriptWithRuntimeMilestones(
    shell.kind,
    gate,
    guard,
    template,
    body,
    milestoneDiagnostics
  )
}

export function shellArgs(shell: RuntimeShell, script: string, homeRoot: string): string[] {
  return shell.kind === 'bash'
    ? ['--noprofile', '--norc', writeBashScript(homeRoot, script)]
    : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]
}

function writeBashScript(homeRoot: string, script: string): string {
  const scriptDirectory = mkdtempSync(join(homeRoot, 'bash-script-'))
  const scriptPath = join(scriptDirectory, 'runtime.sh')
  writeFileSync(scriptPath, script, { encoding: 'utf8', flag: 'wx' })
  return toBashPath(scriptPath)
}
