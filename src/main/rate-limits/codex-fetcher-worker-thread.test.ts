import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as WorkerThreadChildProcessModule from '../worker-thread-child-process/worker-thread-child-process'
import type { WorkerThreadChildProcessHost } from '../worker-thread-child-process/worker-thread-child-process'
import type { WorkerThreadChildSpec } from '../worker-thread-child-process/worker-thread-child-process-protocol'
import { createInstalledCodexFamily } from '../../packages/process-host/src/__fixtures__/codex-native-launch-fixture'
import {
  WINDOWS_ARGUMENT_CORPUS,
  WINDOWS_ARGUMENT_CORPUS_ENV
} from '../../packages/process-host/src/__fixtures__/windows-argument-corpus'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'

const { spawnWorkerThreadMock } = vi.hoisted(() => ({ spawnWorkerThreadMock: vi.fn() }))

// The fetcher calls this seam, but the test delegates to the real worker host
// and a real Worker so the child crosses the same structured-clone boundary.
vi.mock('../worker-thread-child-process/worker-thread-child-process', () => ({
  spawnProcessOnWorkerThread: spawnWorkerThreadMock
}))
vi.mock('../codex/codex-state-db', () => ({ isCodexStateDbBackfillPending: vi.fn(() => false) }))
vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: vi.fn(() => Promise.resolve(null))
}))
vi.mock('./codex-auth-presence', () => ({ probeCodexAuthPresence: vi.fn(() => 'present') }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import { fetchCodexRateLimits } from './codex-fetcher'
import { resolveCodexCommand } from '../codex-cli/command'

const STAND_IN_APP_SERVER = `
import { writeFileSync } from 'node:fs'

const recordPath = process.env.ORCA_TEST_RECORD_FILE
if (!recordPath) process.exit(90)
writeFileSync(recordPath, JSON.stringify({
  executable: process.execPath,
  script: process.argv[1],
  args: process.argv.slice(2),
  home: process.env.CODEX_HOME,
  sessionId: process.env.ORCA_AGENT_SESSION_ID,
  path: process.env.Path ?? process.env.PATH
}))

let buffer = ''
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newlineIndex
  while ((newlineIndex = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      send({ id: message.id, result: { userAgent: 'codex-worker-contract/0.166.0' } })
    } else if (message.method === 'account/rateLimits/read') {
      send({
        id: message.id,
        result: {
          rateLimits: {
            primary: { usedPercent: 17, windowDurationMins: 300 },
            secondary: { usedPercent: 29, windowDurationMins: 10080 }
          }
        }
      })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`

type RuntimeFixture = ReturnType<typeof createInstalledCodexFamily> & { root: string }

const fixtureRoots: string[] = []
let workerEntryDir = ''
let workerEntryPath = ''
let worker: Worker | undefined
let workerHost: WorkerThreadChildProcessHost

function makeInstallFixture(): RuntimeFixture {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-worker-install-'))
  fixtureRoots.push(root)
  const family = createInstalledCodexFamily({ tempRoot: root })
  const manifestPath = join(family.packageRoot, 'package.json')
  const manifest = readFileSync(manifestPath, 'utf8').replace(
    '"version": "0.166.0"',
    '"version": "0.167.0"'
  )
  // The fixture launches a Node stand-in, so mark its package version
  // unreviewed and keep process-host on the existing Node-shim fallback.
  writeFileSync(manifestPath, manifest)
  copyFileSync(process.execPath, family.node)
  writeFileSync(join(family.packageRoot, 'bin', 'codex.js'), STAND_IN_APP_SERVER)
  return { ...family, root }
}

function makeApprovedInstallFixture(): RuntimeFixture {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-worker-native-'))
  fixtureRoots.push(root)
  const family = createInstalledCodexFamily({
    tempRoot: root,
    nodeMachine: process.arch === 'arm64' ? 'arm64' : 'x64'
  })
  return { ...family, root }
}

function parseRecord(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The Codex stand-in did not write an object record')
  }
  return Object.fromEntries(Object.entries(value))
}

function readRecord(path: string): Record<string, unknown> {
  return parseRecord(readFileSync(path, 'utf8'))
}

function expectWindowsPath(actual: unknown, expected: string): void {
  if (typeof actual !== 'string') {
    throw new Error('The Codex stand-in did not report an executable path')
  }
  expect(actual.toLowerCase()).toBe(expected.toLowerCase())
}

describe.skipIf(process.platform !== 'win32')('Codex rate-limit worker-thread transport', () => {
  beforeAll(async () => {
    workerEntryDir = mkdtempSync(join(tmpdir(), 'orca-codex-worker-entry-'))
    workerEntryPath = join(workerEntryDir, 'worker-thread-child-process-entry.cjs')
    copyFileSync(
      join(__dirname, '../../packages/process-host/src/windows-pe-machine.cjs'),
      join(workerEntryDir, 'windows-pe-machine.cjs')
    )
    await build({
      entryPoints: [
        join(__dirname, '../worker-thread-child-process/worker-thread-child-process-entry.ts')
      ],
      outfile: workerEntryPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
    const { WorkerThreadChildProcessHost: ActualHost } = await vi.importActual<
      typeof WorkerThreadChildProcessModule
    >('../worker-thread-child-process/worker-thread-child-process')
    workerHost = new ActualHost(() => {
      const nextWorker = new Worker(workerEntryPath)
      worker = nextWorker
      return nextWorker
    })
    spawnWorkerThreadMock.mockImplementation((spec: WorkerThreadChildSpec) =>
      workerHost.spawn(spec)
    )
  }, 60_000)

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    for (const root of fixtureRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  afterAll(async () => {
    await worker?.terminate()
    if (workerEntryDir) {
      rmSync(workerEntryDir, { recursive: true, force: true })
    }
  })

  it('uses the host-selected install and preserves account home, session identity, and final PATH through a real worker', async () => {
    const client = makeInstallFixture()
    const server = makeInstallFixture()
    const accountHome = join(server.root, 'accounts', 'server-account', 'home')
    const recordPath = join(server.root, 'worker-child.json')
    mkdirSync(accountHome, { recursive: true })

    // Both installations are on PATH, but this host resolves its own first.
    const clientBin = dirname(client.launcher)
    const serverBin = dirname(server.launcher)
    const inheritedPath = process.env.Path ?? process.env.PATH ?? ''
    vi.stubEnv('PATH', [serverBin, clientBin, inheritedPath].filter(Boolean).join(';'))
    vi.stubEnv('npm_config_user_agent', server.env.npm_config_user_agent ?? '')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', 'rate-limit-worker-session-fixture')
    vi.stubEnv('ORCA_TEST_RECORD_FILE', recordPath)
    expectWindowsPath(resolveCodexCommand(), server.launcher)

    await expect(fetchCodexRateLimits({ codexHomePath: accountHome })).resolves.toMatchObject({
      provider: 'codex',
      session: { usedPercent: 17, windowMinutes: 300 },
      weekly: { usedPercent: 29, windowMinutes: 10080 },
      status: 'ok',
      error: null
    })

    const child = readRecord(recordPath)
    expect(child).toMatchObject({
      args: [...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
      home: accountHome,
      sessionId: 'rate-limit-worker-session-fixture'
    })
    expectWindowsPath(child.executable, server.node)
    expectWindowsPath(child.script, join(server.packageRoot, 'bin', 'codex.js'))
    const finalPath = child.path
    expect(typeof finalPath).toBe('string')
    if (typeof finalPath !== 'string') {
      throw new Error('The worker child did not receive PATH')
    }
    const pathEntries = finalPath.split(';')
    expectWindowsPath(pathEntries[0], serverBin)
    expect(pathEntries.some((entry) => entry.toLowerCase() === clientBin.toLowerCase())).toBe(true)
    expect(String(child.script).toLowerCase()).not.toContain(client.root.toLowerCase())
  }, 30_000)

  it('takes the approved native route through the real worker and preserves argv and child identity', async () => {
    const install = makeApprovedInstallFixture()
    copyFileSync(process.execPath, install.nativeExecutable)
    const accountHome = join(install.packageRoot, 'account-home')
    const values = [...WINDOWS_ARGUMENT_CORPUS.map(({ value }) => value), 'line one\nline two']
    const childProgram = [
      'process.stdin.resume()',
      'process.stdin.once("end", () => {',
      '  process.stdout.write(JSON.stringify({',
      '    argv: process.argv.slice(1),',
      '    childPid: process.pid,',
      '    parentPid: process.ppid,',
      '    executable: process.execPath,',
      '    cwd: process.cwd(),',
      '    home: process.env.CODEX_HOME,',
      '    sessionId: process.env.ORCA_AGENT_SESSION_ID,',
      '    packageRoot: process.env.CODEX_MANAGED_PACKAGE_ROOT,',
      '    npm: process.env.CODEX_MANAGED_BY_NPM,',
      '    bun: process.env.CODEX_MANAGED_BY_BUN ?? null,',
      '    path: process.env.Path ?? process.env.PATH',
      '  }))',
      '  process.exitCode = 23',
      '})'
    ].join('\n')
    const systemRoot = process.env.SystemRoot
    if (!systemRoot) {
      throw new Error('Windows runtime did not provide SystemRoot')
    }
    const env = {
      ...install.env,
      ...WINDOWS_ARGUMENT_CORPUS_ENV,
      SystemRoot: systemRoot,
      CODEX_HOME: accountHome,
      ORCA_AGENT_SESSION_ID: 'native-worker-session-fixture',
      CODEX_MANAGED_BY_BUN: '1'
    }
    const child = workerHost.spawn({
      program: install.launcher,
      args: ['-e', childProgram, '--', ...values],
      cwd: install.packageRoot,
      env
    })
    const stdout: string[] = []
    const stderr: string[] = []
    const errors: Error[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
    child.on('error', (error: Error) => errors.push(error))
    const closed = new Promise<number | null>((resolve) =>
      child.once('close', (code) => resolve(code))
    )
    child.stdin.end()

    await expect(closed).resolves.toBe(23)
    expect(errors).toEqual([])
    expect(stderr.join('')).toBe('')
    const result = parseRecord(stdout.join(''))
    expect(result).toMatchObject({
      argv: values,
      childPid: child.pid,
      parentPid: process.pid,
      cwd: install.packageRoot,
      home: accountHome,
      sessionId: 'native-worker-session-fixture',
      packageRoot: install.packageRoot,
      npm: '1',
      bun: null,
      path: install.env.PATH
    })
    expectWindowsPath(result.executable, install.nativeExecutable)
    expectWindowsPath(result.path, install.env.PATH ?? '')
    expect(result.argv).not.toContain(join(install.packageRoot, 'bin', 'codex.js'))
  }, 30_000)
})
