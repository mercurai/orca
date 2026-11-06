import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import {
  getPosixCodexShellLaunchPreflight,
  getPowerShellCodexShellLaunchPreflight
} from '../../shared/codex-shell-function'

const isWindows = process.platform === 'win32'
const roots: string[] = []
type Shell = { name: string; kind: 'bash' | 'powershell'; command: string | null }
type ResolverCall = { args: string[]; stdinBytes: number }
type Fixture = {
  root: string
  bin: string
  nodeBin: string
  packageRoot: string
  resolverLog: string
  eventLog: string
  helpLog: string
  codexLog: string
  resolverBash: string
  resolverPowerShell: string
  resolverScript: string
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function canRun(command: string | null, args: string[]): boolean {
  return command !== null &&
    runProcessSync({
      program: command,
      args,
      stdio: 'ignore',
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024
    }).code === 0
}

function isGitBash(command: string): boolean {
  const result = runProcessSync({
    program: command,
    args: ['--version'],
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024
  })
  return result.code === 0 && /msys|mingw/i.test(result.stdout)
}

function findGitBash(): string | null {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)']
  const candidates = [
    join(programFiles, 'Git', 'bin', 'bash.exe'),
    join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    ...(programFilesX86
      ? [join(programFilesX86, 'Git', 'bin', 'bash.exe')]
      : [])
  ]
  const installed = candidates.find((candidate) => existsSync(candidate) && isGitBash(candidate))
  if (installed) return installed
  const pathCandidate = onPath('bash.exe')
  return pathCandidate && isGitBash(pathCandidate) ? pathCandidate : null
}

const shells: Shell[] = [
  { name: 'Git Bash', kind: 'bash', command: findGitBash() },
  { name: 'PowerShell 7', kind: 'powershell', command: onPath('pwsh.exe') },
  { name: 'Windows PowerShell', kind: 'powershell', command: onPath('powershell.exe') }
]

function quoteBash(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

function quotePowerShell(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

function toBashPath(value: string): string {
  const slashed = value.replace(/\\/g, '/')
  return slashed.replace(/^([a-z]):\//i, (_match, drive: string) => '/' + drive.toLowerCase() + '/')
}

function shellPath(shell: Shell, bin: string, nodeBin: string): string {
  const entries = [bin, nodeBin, ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)]
  return shell.kind === 'bash'
    ? entries.map(toBashPath).join(':')
    : entries.join(delimiter)
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'orca codex native launch-'))
  roots.push(root)
  const bin = join(root, 'codex bin')
  const nodeBin = join(root, 'node bin')
  mkdirSync(bin)
  mkdirSync(nodeBin)

  const packageRoot = join(root, 'npm package root')
  const resolverLog = join(root, 'resolver calls.jsonl')
  const eventLog = join(root, 'shell events.log')
  const helpLog = join(root, 'codex help.log')
  const codexLog = join(root, 'codex launches.log')
  for (const path of [resolverLog, eventLog, helpLog, codexLog]) writeFileSync(path, '')
  writeExecutable(join(nodeBin, 'node.exe'), '#!/bin/sh\nexit 0\n')

  writeExecutable(
    join(bin, 'codex'),
    '#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = --help ]; then printf probe >> "$ORCA_TEST_HELP_LOG"; printf "  --no-daemon\\n"; exit 0; fi\nprintf fallback >> "$ORCA_TEST_EVENT_LOG"\nprintf "%s\\n" "$*" >> "$ORCA_TEST_CODEX_LOG"\nprintf "FALLBACK|%s\\n" "$*"\nexit 19\n'
  )
  writeFileSync(
    join(bin, 'codex.cmd'),
    '@echo off\r\nif "%~1"=="--help" (\r\n  >>"%ORCA_TEST_HELP_LOG%" echo probe\r\n  echo   --no-daemon\r\n  exit /b 0\r\n)\r\n>>"%ORCA_TEST_EVENT_LOG%" echo fallback\r\n>>"%ORCA_TEST_CODEX_LOG%" echo %*\r\necho FALLBACK|%*\r\nexit /b 19\r\n'
  )

  const resolverScript = join(root, 'resolver fixture.cjs')
  writeFileSync(
    resolverScript,
    [
      "const fs = require('node:fs')",
      'const args = process.argv.slice(2)',
      'const stdinBytes = fs.readFileSync(0).length',
      "process.on('exit', () => fs.appendFileSync(process.env.ORCA_TEST_EVENT_LOG, 'resolver-exit\\n'))",
      'fs.writeFileSync(process.env.ORCA_TEST_RESOLVER_LOG, JSON.stringify({ args, stdinBytes }))',
      "const format = args[args.indexOf('--format') + 1]",
      "const result = { schemaVersion: 1, outcome: 'native', nativeExecutable: process.env.ORCA_TEST_NATIVE_EXE, environmentDelta: { managedPackageRoot: process.env.ORCA_TEST_PACKAGE_ROOT, manager: 'npm' } }",
      "if (format === 'json') process.stdout.write(JSON.stringify(result))",
      "else process.stdout.write(['ORCA_CODEX_NATIVE_V1', 'native', process.env.ORCA_TEST_NATIVE_EXE, process.env.ORCA_TEST_PACKAGE_ROOT, 'npm', 'END_ORCA_CODEX_NATIVE_V1'].join('\\n') + '\\n')"
    ].join('\n'),
    'utf8'
  )

  const resolverBash = join(root, 'orca native resolver')
  writeExecutable(
    resolverBash,
    '#!/bin/sh\nexec "$ORCA_TEST_NODE_BASH" "$ORCA_TEST_RESOLVER_SCRIPT_BASH" "$@"\n'
  )
  const resolverPowerShell = join(root, 'orca native resolver.ps1')
  writeFileSync(
    resolverPowerShell,
    '& $env:ORCA_TEST_NODE $env:ORCA_TEST_RESOLVER_SCRIPT @args\n'
  )

  return {
    root,
    bin,
    nodeBin,
    packageRoot,
    resolverLog,
    eventLog,
    helpLog,
    codexLog,
    resolverBash,
    resolverPowerShell,
    resolverScript
  }
}

function commonEnv(shell: Shell, fixture: Fixture): NodeJS.ProcessEnv {
  const resolver = shell.kind === 'bash' ? fixture.resolverBash : fixture.resolverPowerShell
  return {
    ...process.env,
    PATH: shellPath(shell, fixture.bin, fixture.nodeBin),
    ORCA_CODEX_NATIVE_RESOLVER: shell.kind === 'bash' ? toBashPath(resolver) : resolver,
    ORCA_TEST_NODE: process.execPath,
    ORCA_TEST_NODE_BASH: toBashPath(process.execPath),
    ORCA_TEST_RESOLVER_SCRIPT: fixture.resolverScript,
    ORCA_TEST_RESOLVER_SCRIPT_BASH: toBashPath(fixture.resolverScript),
    ORCA_TEST_NATIVE_EXE: process.execPath,
    ORCA_TEST_PACKAGE_ROOT: fixture.packageRoot,
    ORCA_TEST_RESOLVER_LOG: fixture.resolverLog,
    ORCA_TEST_EVENT_LOG: fixture.eventLog,
    ORCA_TEST_HELP_LOG: fixture.helpLog,
    ORCA_TEST_CODEX_LOG: fixture.codexLog,
    NODE_OPTIONS: '',
    NODE_PATH: '',
    ORCA_NODE_OPTIONS: '',
    CODEX_MANAGED_PACKAGE_ROOT: 'parent-package-root',
    CODEX_MANAGED_BY_NPM: 'parent-npm',
    CODEX_MANAGED_BY_BUN: 'parent-bun',
    CODEX_MANAGED_BY_PNPM: 'parent-pnpm',
    CODEX_MANAGED_BY_VITE_PLUS: 'parent-vite-plus'
  }
}

function runShell(
  shell: Shell,
  fixture: Fixture,
  body: string
): { status: number | null; stdout: string; stderr: string } {
  if (!shell.command) throw new Error('Shell executable was not resolved')
  const codexPath = join(fixture.bin, shell.kind === 'bash' ? 'codex' : 'codex.cmd')
  const template = shell.kind === 'bash'
    ? getPosixCodexShellLaunchPreflight()
    : getPowerShellCodexShellLaunchPreflight()
  const guard = shell.kind === 'bash'
    ? 'command -v codex >/dev/null 2>&1 || exit 97'
    : 'if ((Get-Command codex -CommandType Application | Select-Object -First 1).Source -ne ' + quotePowerShell(codexPath) + ') { exit 97 }'
  const script = [guard, template, body].join('\n')
  const args = shell.kind === 'bash'
    ? ['--noprofile', '--norc', '-c', script]
    : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]
  const result = runProcessSync({
    program: shell.command,
    args,
    cwd: fixture.root,
    timeoutMs: 30_000,
    maxOutputBytes: 256 * 1024,
    env: commonEnv(shell, fixture)
  })
  return { status: result.code, stdout: result.stdout, stderr: result.stderr }
}

function resolverCall(fixture: Fixture): ResolverCall {
  const line = readFileSync(fixture.resolverLog, 'utf8').trim()
  const value: unknown = JSON.parse(line)
  if (typeof value !== 'object' || value === null || !('args' in value) || !('stdinBytes' in value)) {
    throw new Error('Resolver fixture log has an invalid shape')
  }
  if (!Array.isArray(value.args)) {
    throw new Error('Resolver fixture args are invalid')
  }
  const args = value.args.filter((arg: unknown): arg is string => typeof arg === 'string')
  if (args.length !== value.args.length) throw new Error('Resolver fixture args are invalid')
  if (typeof value.stdinBytes !== 'number') throw new Error('Resolver fixture stdin length is invalid')
  return { args, stdinBytes: value.stdinBytes }
}

function pathKey(value: string): string {
  return value
    .replace(/^\/([a-z])\//i, (_match, drive: string) => drive + ':\\')
    .replace(/\//g, '\\')
    .toLowerCase()
}

function argumentAfter(args: string[], name: string): string | null {
  const index = args.indexOf(name)
  return index < 0 ? null : args[index + 1] ?? null
}

function lines(output: string): string[] {
  return output.trimEnd().split(/\r?\n/)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!isWindows)('Codex native shell launch', () => {
  it('has Git Bash and PowerShell when their Windows lanes are required', () => {
    const bash = shells.find((shell) => shell.kind === 'bash')
    const powershell = shells.find((shell) => shell.name === 'PowerShell 7')
    const windowsPowerShell = shells.find((shell) => shell.name === 'Windows PowerShell')
    const ciRequiresShells = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'
    expect(
      (!(ciRequiresShells || process.env.ORCA_REQUIRE_GIT_BASH === '1')) ||
        canRun(bash?.command ?? null, ['--version'])
    ).toBe(true)
    expect(
      (!(ciRequiresShells || process.env.ORCA_REQUIRE_PWSH === '1')) ||
        canRun(powershell?.command ?? null, ['-NoLogo', '-NoProfile', '-Command', 'exit 0'])
    ).toBe(true)
    expect(
      (!(ciRequiresShells || process.env.ORCA_REQUIRE_WINDOWS_POWERSHELL === '1')) ||
        canRun(windowsPowerShell?.command ?? null, ['-NoLogo', '-NoProfile', '-Command', 'exit 0'])
    ).toBe(true)
  })

  const availableShells = shells.filter((shell) => shell.kind === 'bash'
    ? canRun(shell.command, ['--version'])
    : canRun(shell.command, ['-NoLogo', '-NoProfile', '-Command', 'exit 0']))

  describe.each(availableShells)('$name', (shell) => {
    it('keeps argv, piped input, exit status, and managed metadata scoped to the native child', () => {
      const fixture = makeFixture()
      const program = [
        "const fs = require('node:fs')",
        "fs.appendFileSync(process.env.ORCA_TEST_EVENT_LOG, 'native-start\\n')",
        "const result = { argv: process.argv.slice(1), stdin: fs.readFileSync(0, 'utf8').trim(), packageRoot: process.env.CODEX_MANAGED_PACKAGE_ROOT ?? null, npm: process.env.CODEX_MANAGED_BY_NPM ?? null, bun: process.env.CODEX_MANAGED_BY_BUN ?? null, pnpm: process.env.CODEX_MANAGED_BY_PNPM ?? null, vitePlus: process.env.CODEX_MANAGED_BY_VITE_PLUS ?? null }",
        "process.stdout.write(JSON.stringify(result) + '\\n')",
        'process.exitCode = 23'
      ].join(';')
      const quoteArg = shell.kind === 'bash' ? quoteBash : quotePowerShell
      const invocation = 'codex -e ' + quoteArg(program) + ' alpha ' + quoteArg('two words') + ' ' + quoteArg('$HOME')
      const body = shell.kind === 'bash'
        ? invocation + " <<< 'piped'\nstatus=$?\nprintf \"STATUS=%s\\n\" \"$status\"\nprintf \"PARENT_ROOT=%s\\n\" \"$CODEX_MANAGED_PACKAGE_ROOT\"\nprintf \"PARENT_FLAGS=%s,%s,%s,%s\\n\" \"$CODEX_MANAGED_BY_NPM\" \"$CODEX_MANAGED_BY_BUN\" \"$CODEX_MANAGED_BY_PNPM\" \"$CODEX_MANAGED_BY_VITE_PLUS\""
        : "'piped' | " + invocation + "\n$status = $LASTEXITCODE\nWrite-Output ('STATUS=' + $status)\nWrite-Output ('PARENT_ROOT=' + $env:CODEX_MANAGED_PACKAGE_ROOT)\nWrite-Output ('PARENT_FLAGS=' + $env:CODEX_MANAGED_BY_NPM + ',' + $env:CODEX_MANAGED_BY_BUN + ',' + $env:CODEX_MANAGED_BY_PNPM + ',' + $env:CODEX_MANAGED_BY_VITE_PLUS)"
      const result = runShell(shell, fixture, body)

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(lines(result.stdout)).toEqual([
        JSON.stringify({
          argv: ['alpha', 'two words', '$HOME'],
          stdin: 'piped',
          packageRoot: fixture.packageRoot,
          npm: '1',
          bun: null,
          pnpm: null,
          vitePlus: null
        }),
        'STATUS=23',
        'PARENT_ROOT=parent-package-root',
        'PARENT_FLAGS=parent-npm,parent-bun,parent-pnpm,parent-vite-plus'
      ])
      expect(readFileSync(fixture.helpLog, 'utf8')).toBe('')
      expect(readFileSync(fixture.codexLog, 'utf8')).toBe('')
      expect(readFileSync(fixture.eventLog, 'utf8').trim().split(/\r?\n/)).toEqual([
        'resolver-exit',
        'native-start'
      ])

      const call = resolverCall(fixture)
      expect(call.stdinBytes).toBe(0)
      expect(call.args.slice(0, 2)).toEqual(['agent', 'resolve-codex-native'])
      expect(call.args).toContain('--format')
      expect(call.args).toContain(shell.kind === 'bash' ? 'records' : 'json')
      expect(call.args).not.toContain('--custom-node-env')
      expect(call.args).not.toContain('two words')
      expect(call.args).not.toContain('$HOME')
      expect(pathKey(argumentAfter(call.args, '--launcher') ?? '')).toBe(
        pathKey(join(fixture.bin, shell.kind === 'bash' ? 'codex' : 'codex.cmd'))
      )
      expect(pathKey(argumentAfter(call.args, '--node') ?? '')).toBe(
        pathKey(join(fixture.nodeBin, 'node.exe'))
      )
    })
  })
})
