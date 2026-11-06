import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export type RuntimeMode = 'optout' | 'native'
export type RuntimeShellKind = 'bash' | 'powershell'
export type RuntimeShell = {
  name: 'Git Bash' | 'PowerShell 7' | 'Windows PowerShell'
  kind: RuntimeShellKind
  executable: string
}
export type RuntimeArchitecture = 'x64' | 'arm64'
export type RuntimeSettings = {
  architecture: RuntimeArchitecture
  npmPrefix: string
  npmBin: string
  resolver: string
  nativeExecutable: string
  python: string
  reportPath: string
  shells: RuntimeShell[]
  fleetSize: number
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Required Windows runtime test variable is missing: ${name}`)
  }
  return value
}

function requiredAbsoluteEnv(name: string): string {
  const value = requiredEnv(name)
  if (!isAbsolute(value)) {
    throw new Error(`Required Windows runtime path must be absolute: ${name}`)
  }
  return resolve(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readRuntimeSettings(): RuntimeSettings {
  if (process.platform !== 'win32') {
    throw new Error('The requested Codex runtime gate requires Windows')
  }
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    throw new Error('The requested Codex runtime gate requires a Windows x64 or arm64 Node runtime')
  }
  const architecture: RuntimeArchitecture = process.arch
  const npmPrefix = requiredAbsoluteEnv('ORCA_CODEX_RUNTIME_NPM_PREFIX')
  const npmBin = npmPrefix
  const resolver = requiredAbsoluteEnv('ORCA_CODEX_RUNTIME_RESOLVER')
  const python = requiredAbsoluteEnv('ORCA_CODEX_RUNTIME_PYTHON')
  const reportPath = requiredAbsoluteEnv('ORCA_CODEX_RUNTIME_REPORT_PATH')
  const runnerTemp = requiredAbsoluteEnv('RUNNER_TEMP')
  const reportRelativePath = relative(runnerTemp, reportPath)
  const reportRelativeParts = reportRelativePath.split(/[\\/]/)
  if (!reportRelativePath || reportRelativeParts[0] === '..' || isAbsolute(reportRelativePath)) {
    throw new Error('The sanitized Codex runtime report path must be inside RUNNER_TEMP')
  }
  const fleetSize = Number(requiredEnv('ORCA_CODEX_RUNTIME_FLEET_SIZE'))
  const shells: RuntimeShell[] = [
    {
      name: 'Git Bash',
      kind: 'bash',
      executable: requiredAbsoluteEnv('ORCA_CODEX_RUNTIME_GIT_BASH')
    },
    {
      name: 'PowerShell 7',
      kind: 'powershell',
      executable: requiredAbsoluteEnv('ORCA_CODEX_RUNTIME_PWSH')
    },
    {
      name: 'Windows PowerShell',
      kind: 'powershell',
      executable: requiredAbsoluteEnv('ORCA_CODEX_RUNTIME_POWERSHELL')
    }
  ]

  const packageRoot = join(npmPrefix, 'node_modules', '@openai', 'codex')
  const packageJsonPath = join(packageRoot, 'package.json')
  if (!existsSync(packageJsonPath)) {
    throw new Error('The official Codex npm package is missing from the supplied prefix')
  }
  const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (!isRecord(packageJson) || packageJson.version !== '0.166.0') {
    throw new Error('The runtime gate requires @openai/codex version 0.166.0')
  }
  for (const shim of ['codex', 'codex.cmd', 'codex.ps1']) {
    if (!existsSync(join(npmBin, shim))) {
      throw new Error(`The installed Codex ${shim} shim is missing`)
    }
  }
  const nativePackageName = `codex-win32-${architecture}`
  const optionalDependencies = packageJson.optionalDependencies
  if (!isRecord(optionalDependencies)) {
    throw new Error(
      'The installed Codex package does not declare the selected Windows native alias'
    )
  }
  const nativeAlias = optionalDependencies[`@openai/${nativePackageName}`]
  if (nativeAlias !== `npm:@openai/codex@0.166.0-win32-${architecture}`) {
    throw new Error('The installed Codex package declares an unexpected Windows native alias')
  }
  const nativePackageRoot = join(packageRoot, 'node_modules', '@openai', nativePackageName)
  const nativePackageJsonPath = join(nativePackageRoot, 'package.json')
  if (!existsSync(nativePackageJsonPath)) {
    throw new Error(
      'The official Codex Windows native npm alias is missing from its nested package path'
    )
  }
  const nativePackageJson: unknown = JSON.parse(readFileSync(nativePackageJsonPath, 'utf8'))
  if (
    !isRecord(nativePackageJson) ||
    nativePackageJson.version !== `0.166.0-win32-${architecture}`
  ) {
    throw new Error('The nested Codex Windows native npm alias has an unexpected version')
  }
  const triple = architecture === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc'
  const nativeExecutable = join(nativePackageRoot, 'vendor', triple, 'bin', 'codex.exe')
  if (!existsSync(nativeExecutable)) {
    throw new Error('The nested Codex Windows native executable is missing')
  }
  for (const path of [resolver, python, ...shells.map((shell) => shell.executable)]) {
    if (!isAbsolute(path) || !existsSync(path)) {
      throw new Error('A required Windows runtime executable is missing')
    }
  }
  if (!Number.isSafeInteger(fleetSize) || fleetSize < 2 || fleetSize > 8) {
    throw new Error('ORCA_CODEX_RUNTIME_FLEET_SIZE must be an integer from 2 through 8')
  }
  return {
    architecture,
    npmPrefix,
    npmBin,
    resolver,
    nativeExecutable: resolve(nativeExecutable),
    python,
    reportPath,
    shells,
    fleetSize
  }
}

export function toBashPath(value: string): string {
  const slashed = value.replace(/\\/g, '/')
  return slashed.replace(/^([a-z]):\//i, (_match, drive: string) => `/${drive.toLowerCase()}/`)
}

function safeBaseEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS'
  ]) {
    const value = process.env[key]
    if (value) {
      result[key] = value
    }
  }
  return result
}

function shellPath(shell: RuntimeShell, npmBin: string): string {
  const entries = [
    npmBin,
    dirname(process.execPath),
    ...(process.env.PATH ?? '').split(delimiter)
  ].filter(Boolean)
  return shell.kind === 'bash' ? entries.map(toBashPath).join(':') : entries.join(delimiter)
}

export function createRuntimeEnvironment(
  settings: RuntimeSettings,
  shell: RuntimeShell,
  mode: RuntimeMode,
  homeRoot: string
): NodeJS.ProcessEnv {
  const userProfile = join(homeRoot, 'profile')
  const appData = join(homeRoot, 'appdata')
  const localAppData = join(homeRoot, 'localappdata')
  const temp = join(homeRoot, 'temp')
  const codexHome = join(homeRoot, 'codex-home')
  for (const path of [userProfile, appData, localAppData, temp, codexHome]) {
    mkdirSync(path, { recursive: true })
  }
  const env: NodeJS.ProcessEnv = {
    ...safeBaseEnvironment(),
    PATH: shellPath(shell, settings.npmBin),
    CODEX_HOME: codexHome,
    HOME: userProfile,
    USERPROFILE: userProfile,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_CODEX_ISOLATE: '1',
    OS: 'Windows_NT',
    ORCA_CODEX_NATIVE_RESOLVER:
      shell.kind === 'bash' ? toBashPath(settings.resolver) : settings.resolver,
    ORCA_CODEX_RUNTIME_NPM_BIN: settings.npmBin
  }
  if (mode === 'optout') {
    env.ORCA_DISABLE_CODEX_NATIVE_LAUNCH = '1'
  }
  return env
}
