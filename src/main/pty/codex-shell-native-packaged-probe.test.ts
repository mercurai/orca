import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { findGitBash } from '../agent-hooks/windows-git-bash-path.test-fixture'
import {
  bashInputSentinelCommand,
  bashProbeSourceCommand,
  type BashProbePaths,
  writeBashProbeScript
} from '../../../tests/tools/windows-codex-native-runtime/packaged-pty-bash-probe'
import { toBashPath } from '../../../tests/tools/windows-codex-native-runtime/runtime-environment'

const isWindows = process.platform === 'win32'
const gitBash = isWindows ? findGitBash() : null

function requireGitBash(): string {
  if (!gitBash) {
    throw new Error('Git Bash is required for this Windows regression test')
  }
  return gitBash
}

function writeExecutable(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, 'utf8')
  chmodSync(path, 0o755)
}

function readMarker(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/gu, '\n').replace(/\n$/u, '')
}

describe.skipIf(!isWindows)('packaged Windows Git Bash Codex probe', () => {
  it('sources the complete probe from a path with spaces and an apostrophe', async () => {
    const bash = requireGitBash()
    const root = mkdtempSync(join(tmpdir(), "orca codex's packaged bash probe-"))
    try {
      const home = join(root, 'isolated home')
      const npmBin = join(root, 'npm prefix with spaces', 'bin')
      const resolver = join(root, 'resolver path', 'codex-native-resolver.exe')
      const paths: BashProbePaths & { script: string } = {
        script: join(root, 'probe script.sh'),
        shellPid: join(root, 'markers', 'shell pid.txt'),
        resolver: join(root, 'markers', 'resolver.txt'),
        npmPath: join(root, 'markers', 'npm path.txt'),
        codexHome: join(root, 'markers', 'codex home.txt'),
        diagnostic: join(root, 'markers', 'probe diagnostic.txt')
      }
      const inputMarker = join(root, 'markers', 'input sentinel.txt')
      mkdirSync(join(root, 'markers'))
      writeExecutable(join(npmBin, 'codex'), '#!/bin/sh\nexit 0\n')
      writeBashProbeScript(paths.script, paths)

      const gitRoot = dirname(dirname(bash))
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
      const windowsDir = process.env.WINDIR
      const env: NodeJS.ProcessEnv = {
        ...(systemRoot ? { SystemRoot: systemRoot } : {}),
        ...(windowsDir ? { WINDIR: windowsDir } : {}),
        HOME: toBashPath(home),
        PATH: [npmBin, join(gitRoot, 'usr', 'bin'), dirname(bash)].map(toBashPath).join(':'),
        ORCA_CODEX_RUNTIME_NPM_BIN_POSIX: toBashPath(npmBin),
        ORCA_CODEX_NATIVE_RESOLVER: toBashPath(resolver),
        ORCA_BACKGROUND_LAUNCH: '1'
      }
      const result = await runProcess({
        program: bash,
        args: [
          '--noprofile',
          '--norc',
          '-c',
          `${bashProbeSourceCommand(paths.script)} && test "$CODEX_HOME" = "$HOME/.codex" && ${bashInputSentinelCommand(inputMarker, 'input-ok')}`
        ],
        cwd: root,
        env,
        stdio: 'pipe',
        timeoutMs: 10_000,
        maxOutputBytes: 16 * 1024
      })

      expect(result.timedOut).toBe(false)
      expect(result.signal).toBeNull()
      expect(result.code).toBe(0)
      expect(readMarker(inputMarker)).toBe('input-ok')
      expect(readMarker(paths.diagnostic)).toBe(
        [
          'bashStarted=1',
          'codexLookupPresent=1',
          'npmPrefixMatch=1',
          'windowsPidPresent=1',
          'readEofHandled=1'
        ].join('\n')
      )
      expect(/^\d+$/u.test(readMarker(paths.shellPid))).toBe(true)
      expect(readMarker(paths.resolver)).toBe(toBashPath(resolver))
      expect(readMarker(paths.codexHome)).toBe(`${toBashPath(home)}/.codex`)
      expect(readMarker(paths.npmPath).startsWith(`${toBashPath(npmBin)}/codex`)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})
