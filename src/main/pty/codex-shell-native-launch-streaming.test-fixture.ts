import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInstalledCodexFamily } from '../../packages/process-host/src/__fixtures__/codex-native-launch-fixture'
import {
  createRuntimeEnvironment,
  toBashPath,
  type RuntimeSettings,
  type RuntimeShell
} from '../../../tests/tools/windows-codex-native-runtime/runtime-environment'
import { shellScript as runtimeShellScript } from '../../../tests/tools/windows-codex-native-runtime/runtime-shell-session'

type StreamingLaunchFixture = {
  root: string
  bin: string
  packageRoot: string
  resolverBash: string
  resolverPowerShell: string
  nativeTarget: string
  appServerScript: string
  appServerLog: string
  resolverScript: string
  resolverLog: string
  eventLog: string
  helpLog: string
  codexLog: string
  nativeLog: string
}

type PreparedStreamingLaunch = {
  env: NodeJS.ProcessEnv
  script: string
  expectedShim: string | null
}

export function prepareStreamingLaunch(
  fixture: StreamingLaunchFixture,
  runtimeShell: RuntimeShell,
  mode: 'native' | 'optout'
): PreparedStreamingLaunch {
  let npmBin = fixture.bin
  let appServerScript = fixture.appServerScript
  let expectedShim: string | null = null
  if (runtimeShell.kind === 'powershell') {
    const installed = createInstalledCodexFamily({
      tempRoot: join(fixture.root, 'official npm prefix'),
      launcherKind: 'powershell',
      includeSiblingNodeExe: false
    })
    npmBin = dirname(installed.launcher)
    expectedShim = installed.launcher
    appServerScript = join(installed.packageRoot, 'bin', 'codex.js')
    copyFileSync(fixture.appServerScript, appServerScript)
  }
  const runtimeSettings: RuntimeSettings = {
    architecture: process.arch === 'arm64' ? 'arm64' : 'x64',
    npmPrefix: npmBin,
    npmBin,
    resolver: runtimeShell.kind === 'bash' ? fixture.resolverBash : fixture.resolverPowerShell,
    nativeExecutable: fixture.nativeTarget,
    python: process.execPath,
    reportPath: join(fixture.root, 'runtime-report.json'),
    shells: [runtimeShell],
    fleetSize: 2
  }
  const env: NodeJS.ProcessEnv = {
    ...createRuntimeEnvironment(runtimeSettings, runtimeShell, mode, fixture.root),
    ORCA_TEST_NODE: process.execPath,
    ORCA_TEST_NODE_BASH: toBashPath(process.execPath),
    ORCA_TEST_RESOLVER_SCRIPT: fixture.resolverScript,
    ORCA_TEST_NATIVE_STATE_FILE: '',
    ORCA_TEST_APP_SERVER_SCRIPT: appServerScript,
    ORCA_TEST_APP_SERVER_ROUTE: mode === 'optout' ? 'fallback' : '',
    ORCA_TEST_APP_SERVER_LOG: fixture.appServerLog,
    ORCA_TEST_SELECTED_SHIM: '',
    ORCA_TEST_NATIVE_EXE: fixture.nativeTarget,
    ORCA_TEST_RESOLVER_MODE: 'native',
    ORCA_TEST_PACKAGE_ROOT: fixture.packageRoot,
    ORCA_TEST_RESOLVER_LOG: fixture.resolverLog,
    ORCA_TEST_EVENT_LOG: fixture.eventLog,
    ORCA_TEST_HELP_LOG: fixture.helpLog,
    ORCA_TEST_CODEX_LOG: fixture.codexLog,
    ORCA_TEST_NATIVE_LOG: fixture.nativeLog,
    NODE_OPTIONS: '',
    NODE_PATH: '',
    ORCA_NODE_OPTIONS: '',
    ORCA_DISABLE_CMD_SHIM_RESOLUTION: ''
  }
  const generatedScript = runtimeShellScript(runtimeShell, npmBin, false, true)
  const selectedLauncherLine =
    '$orcaSelectedCodex = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1'
  const script =
    runtimeShell.kind === 'powershell'
      ? generatedScript.replace(
          selectedLauncherLine,
          `${selectedLauncherLine}\n$env:ORCA_TEST_SELECTED_SHIM = $orcaSelectedCodex.Source`
        )
      : generatedScript

  return { env, script, expectedShim }
}
