import { copyFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInstalledCodexFamily } from '../../packages/process-host/src/__fixtures__/codex-native-launch-fixture'
import { mergeCommandEnvironment } from '../../../src/shared/command-environment'
import {
  createRuntimeEnvironment,
  toBashPath,
  type RuntimeSettings,
  type RuntimeShell
} from '../../../tests/tools/windows-codex-native-runtime/runtime-environment'
import { shellScript as runtimeShellScript } from '../../../tests/tools/windows-codex-native-runtime/runtime-shell-session'

export type StreamingLaunchFixture = {
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
  diagnosticLog: string
}

type PreparedStreamingLaunch = {
  env: NodeJS.ProcessEnv
  script: string
  expectedShim: string | null
}

export type StreamingLaunchCase =
  | 'runtime'
  | 'powershell-isolated'
  | 'cmd-isolated'
  | 'powershell-inherited'
  | 'powershell-cache-nul'
  | 'powershell-module-path'

export function writeStreamingResponderScript(path: string): void {
  writeFileSync(
    path,
    [
      "import fs from 'node:fs'",
      "import { createInterface } from 'node:readline'",
      'if (process.env.ORCA_TEST_DIAGNOSTIC_LOG) {',
      "  const kind = process.argv[2] === '--help' ? 'help' : 'server'",
      "  const route = process.env.ORCA_TEST_APP_SERVER_ROUTE || 'unset'",
      "  fs.appendFileSync(process.env.ORCA_TEST_DIAGNOSTIC_LOG, kind + ':' + route + '\\n')",
      '  const homeMatches = process.env.CODEX_HOME === process.env.ORCA_TEST_EXPECTED_CODEX_HOME',
      "  fs.appendFileSync(process.env.ORCA_TEST_DIAGNOSTIC_LOG, homeMatches ? 'codex-home:ok\\n' : 'codex-home:mismatch\\n')",
      '}',
      "if (process.argv[2] === '--help') {",
      "  process.stdout.write('  --no-daemon\\n')",
      '} else {',
      '  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })',
      "  lines.on('line', line => {",
      '    const frame = JSON.parse(line)',
      '    const value = { route: process.env.ORCA_TEST_APP_SERVER_ROUTE, selectedShim: process.env.ORCA_TEST_SELECTED_SHIM?.toLowerCase() || null, args: process.argv.slice(2), phase: "server", method: frame.method, id: frame.id ?? null }',
      '    fs.appendFileSync(process.env.ORCA_TEST_APP_SERVER_LOG, JSON.stringify(value) + "\\n")',
      "    if (frame.method === 'initialize') process.stdout.write(JSON.stringify({ id: frame.id, result: { ok: true } }) + '\\n')",
      '  })',
      '}'
    ].join('\n'),
    'utf8'
  )
}

export function streamingLogCounts(fixture: StreamingLaunchFixture): {
  resolverCalls: number
  helpCalls: number
  serverStarts: number
  appServerFrames: number
  codexHomeChecks: number
  codexHomeMismatches: number
} {
  const countLines = (path: string): string[] =>
    readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)
  const diagnosticEvents = countLines(fixture.diagnosticLog)
  return {
    resolverCalls: countLines(fixture.resolverLog).length,
    helpCalls: diagnosticEvents.filter((line) => line.startsWith('help:')).length,
    serverStarts: diagnosticEvents.filter((line) => line.startsWith('server:')).length,
    appServerFrames: countLines(fixture.appServerLog).length,
    codexHomeChecks: diagnosticEvents.filter((line) => line.startsWith('codex-home:')).length,
    codexHomeMismatches: diagnosticEvents.filter((line) => line === 'codex-home:mismatch').length
  }
}

export function prepareStreamingLaunch(
  fixture: StreamingLaunchFixture,
  runtimeShell: RuntimeShell,
  mode: 'native' | 'optout',
  launchCase: StreamingLaunchCase
): PreparedStreamingLaunch {
  let npmBin = fixture.bin
  let appServerScript = fixture.appServerScript
  let expectedShim: string | null = null
  if (runtimeShell.kind === 'powershell') {
    // ExternalScriptInfo expands 8.3 aliases before the runtime prefix guard compares paths.
    const installed = createInstalledCodexFamily({
      tempRoot: join(realpathSync.native(fixture.root), 'official npm prefix'),
      launcherKind: launchCase === 'cmd-isolated' ? 'cmd' : 'powershell',
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
  const runtimeEnv = createRuntimeEnvironment(runtimeSettings, runtimeShell, mode, fixture.root)
  const envBase = launchCase === 'powershell-inherited' ? process.env : runtimeEnv
  const envOverrides: Record<string, string> = {
    PATH: runtimeEnv.PATH ?? '',
    CODEX_HOME: runtimeEnv.CODEX_HOME ?? '',
    ORCA_BACKGROUND_LAUNCH: runtimeEnv.ORCA_BACKGROUND_LAUNCH ?? '',
    ORCA_CODEX_ISOLATE: runtimeEnv.ORCA_CODEX_ISOLATE ?? '',
    OS: runtimeEnv.OS ?? '',
    ORCA_CODEX_NATIVE_RESOLVER: runtimeEnv.ORCA_CODEX_NATIVE_RESOLVER ?? '',
    ORCA_CODEX_RUNTIME_NPM_BIN: runtimeEnv.ORCA_CODEX_RUNTIME_NPM_BIN ?? '',
    ORCA_DISABLE_CODEX_NATIVE_LAUNCH: mode === 'optout' ? '1' : '',
    ORCA_CODEX_LAUNCH_PREFLIGHT: '',
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
    ORCA_TEST_DIAGNOSTIC_LOG: fixture.diagnosticLog,
    ORCA_TEST_EXPECTED_CODEX_HOME: join(fixture.root, 'codex-home'),
    ...(launchCase === 'powershell-cache-nul' ? { PSModuleAnalysisCachePath: 'NUL' } : {}),
    NODE_OPTIONS: '',
    NODE_PATH: '',
    ORCA_NODE_OPTIONS: '',
    ORCA_DISABLE_CMD_SHIM_RESOLUTION: ''
  }
  const env: NodeJS.ProcessEnv =
    mergeCommandEnvironment(envBase, envOverrides, process.platform) ?? {}
  const generatedScript = runtimeShellScript(runtimeShell, npmBin, false, true, true)
  const selectedLauncherLine =
    '$orcaSelectedCodex = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1'
  const selectedLauncherBlock = [
    ...(launchCase === 'powershell-module-path'
      ? ["$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')"]
      : []),
    selectedLauncherLine,
    '$env:ORCA_TEST_SELECTED_SHIM = $orcaSelectedCodex.Source'
  ].join('\n')
  const script =
    runtimeShell.kind === 'powershell'
      ? generatedScript.replace(selectedLauncherLine, selectedLauncherBlock)
      : generatedScript

  return { env, script, expectedShim }
}
