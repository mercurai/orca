import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInstalledCodexFamily } from '../packages/process-host/src/__fixtures__/codex-native-launch-fixture'
import { hasProtocolControlCharacters } from './agent-codex-native-protocol'
import {
  findCommandSpec,
  GLOBAL_FLAGS,
  normalizeCommandPositionals,
  parseArgs,
  specPaths,
  validateCommandAndFlags
} from './args'
import { dispatch, HANDLER_COMMAND_KEYS, type HandlerContext } from './dispatch'
import { COMMAND_SPECS } from './specs'

const COMMAND_PATH = ['agent', 'resolve-codex-native']
const FALLBACK_REASONS =
  /^(?:unsupported_context|unrecognized_launcher|unverified_install|native_unavailable|resolver_failure)$/u

let fixtureRoot: string
let previousExitCode: number | undefined

function launcherPath(): string {
  return join(fixtureRoot, 'codex.cmd')
}

function offlineContext(flags: Map<string, string | boolean>): HandlerContext {
  return {
    flags,
    cwd: fixtureRoot,
    json: false,
    rawArgs: ['--prompt', 'must-not-appear-in-the-protocol'],
    get client() {
      throw new Error('resolve-codex-native must not access HandlerContext.client')
    }
  }
}

function stdoutText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call) => String(call[0])).join('')
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'orca-codex-native-cli-'))
  previousExitCode = process.exitCode
  process.exitCode = undefined
})

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
  process.exitCode = previousExitCode
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('orca agent resolve-codex-native command contract', () => {
  it('is present in the command spec and the live dispatcher', () => {
    const spec = findCommandSpec(COMMAND_SPECS, COMMAND_PATH)

    expect(spec).toBeDefined()
    expect(spec?.path).toEqual(COMMAND_PATH)
    expect(spec?.allowedFlags.slice().sort()).toEqual(
      [...GLOBAL_FLAGS, 'launcher', 'node', 'format', 'custom-node-env'].sort()
    )
    expect(HANDLER_COMMAND_KEYS.has(COMMAND_PATH.join(' '))).toBe(true)
  })

  it('parses the launcher, optional Node, output format, and custom-Node boolean', () => {
    const args = [
      ...COMMAND_PATH,
      '--launcher',
      launcherPath(),
      '--node',
      join(fixtureRoot, 'node.exe'),
      '--format',
      'records',
      '--custom-node-env'
    ]
    const parsed = normalizeCommandPositionals(
      COMMAND_SPECS,
      parseArgs(args, COMMAND_SPECS.flatMap(specPaths), COMMAND_SPECS)
    )

    expect(parsed.commandPath).toEqual(COMMAND_PATH)
    expect(parsed.flags).toEqual(
      new Map<string, string | boolean>([
        ['launcher', launcherPath()],
        ['node', join(fixtureRoot, 'node.exe')],
        ['format', 'records'],
        ['custom-node-env', true]
      ])
    )
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
  })

  it('dispatches a bounded JSON fallback without reading the lazy client', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await dispatch(
      COMMAND_PATH,
      offlineContext(
        new Map<string, string | boolean>([
          ['launcher', launcherPath()],
          ['format', 'json']
        ])
      )
    )

    const output = stdoutText(stdout)
    const result = JSON.parse(output)
    expect(Object.keys(result).sort()).toEqual(['outcome', 'reason', 'schemaVersion'])
    expect(result).toEqual({
      schemaVersion: 1,
      outcome: 'fallback',
      reason: expect.stringMatching(FALLBACK_REASONS)
    })
    expect(output).toBe(`${JSON.stringify(result)}\n`)
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(16 * 1024)
    expect(output).not.toContain('must-not-appear-in-the-protocol')
  })

  it('emits only the fixed fallback records and a final newline', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await dispatch(
      COMMAND_PATH,
      offlineContext(
        new Map<string, string | boolean>([
          ['launcher', launcherPath()],
          ['format', 'records']
        ])
      )
    )

    const output = stdoutText(stdout)
    const lines = output.split('\n')
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe('ORCA_CODEX_NATIVE_V1')
    expect(lines[1]).toBe('fallback')
    expect(lines[2]).toMatch(FALLBACK_REASONS)
    expect(lines[3]).toBe('END_ORCA_CODEX_NATIVE_V1')
    expect(lines[4]).toBe('')
    expect(lines.slice(0, -1).every((line) => !hasProtocolControlCharacters(line))).toBe(true)
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(16 * 1024)
  })

  it.skipIf(process.platform !== 'win32')(
    'serializes a native resolution from the shared installed-Codex fixture',
    async () => {
      const family = createInstalledCodexFamily({ tempRoot: fixtureRoot })
      vi.stubEnv('PATH', family.env.PATH ?? '')
      vi.stubEnv('npm_config_user_agent', family.env.npm_config_user_agent ?? '')
      vi.stubEnv('NODE_OPTIONS', '')
      vi.stubEnv('NODE_PATH', '')
      vi.stubEnv('ORCA_NODE_OPTIONS', '')
      vi.stubEnv('npm_execpath', '')
      vi.stubEnv('npm_node_execpath', '')
      vi.stubEnv('BUN_INSTALL', '')
      vi.stubEnv('PNPM_HOME', '')
      vi.stubEnv('ORCA_DISABLE_CODEX_NATIVE_LAUNCH', '')
      vi.stubEnv('ORCA_DISABLE_CMD_SHIM_RESOLUTION', '')

      const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const jsonFlags = new Map<string, string | boolean>([
        ['launcher', family.launcher],
        ['node', family.node],
        ['format', 'json']
      ])
      await dispatch(COMMAND_PATH, offlineContext(jsonFlags))
      expect(stdoutText(output)).toBe(
        `${JSON.stringify({
          schemaVersion: 1,
          outcome: 'native',
          nativeExecutable: family.nativeExecutable,
          environmentDelta: { managedPackageRoot: family.packageRoot, manager: 'npm' }
        })}\n`
      )

      output.mockClear()
      await dispatch(
        COMMAND_PATH,
        offlineContext(
          new Map<string, string | boolean>([
            ['launcher', family.launcher],
            ['node', family.node],
            ['format', 'records']
          ])
        )
      )
      expect(stdoutText(output)).toBe(
        [
          'ORCA_CODEX_NATIVE_V1',
          'native',
          family.nativeExecutable,
          family.packageRoot,
          'npm',
          'END_ORCA_CODEX_NATIVE_V1',
          ''
        ].join('\n')
      )

      output.mockClear()
      await dispatch(
        COMMAND_PATH,
        offlineContext(
          new Map<string, string | boolean>([
            ['launcher', family.launcher],
            ['node', family.node],
            ['format', 'json'],
            ['custom-node-env', true]
          ])
        )
      )
      const customEnvironmentResult = JSON.parse(stdoutText(output))
      expect(customEnvironmentResult).toEqual({
        schemaVersion: 1,
        outcome: 'fallback',
        reason: expect.stringMatching(FALLBACK_REASONS)
      })
    }
  )

  it.each([
    ['environment', 'build-box'],
    ['pairing-code', 'orca://pair?code=test-only']
  ])('rejects explicit --%s targeting before resolution', async (flag, value) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await expect(
      dispatch(
        COMMAND_PATH,
        offlineContext(
          new Map<string, string | boolean>([
            ['launcher', launcherPath()],
            ['format', 'json'],
            [flag, value]
          ])
        )
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('does not retarget')
    })

    expect(stdout).not.toHaveBeenCalled()
  })

  it.each([
    ['launcher', 'relative/codex.js'],
    ['node', 'relative/node.exe']
  ])('rejects a relative --%s path before resolution', async (flag, value) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const flags = new Map<string, string | boolean>([
      ['launcher', launcherPath()],
      ['format', 'json'],
      [flag, value]
    ])

    await expect(dispatch(COMMAND_PATH, offlineContext(flags))).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(stdout).not.toHaveBeenCalled()
  })

  it('rejects formats outside json and records before resolution', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await expect(
      dispatch(
        COMMAND_PATH,
        offlineContext(
          new Map<string, string | boolean>([
            ['launcher', launcherPath()],
            ['format', 'shell']
          ])
        )
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(stdout).not.toHaveBeenCalled()
  })

  it('rejects a value attached to --custom-node-env', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await expect(
      dispatch(
        COMMAND_PATH,
        offlineContext(
          new Map<string, string | boolean>([
            ['launcher', launcherPath()],
            ['format', 'json'],
            ['custom-node-env', 'true']
          ])
        )
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(stdout).not.toHaveBeenCalled()
  })
})
