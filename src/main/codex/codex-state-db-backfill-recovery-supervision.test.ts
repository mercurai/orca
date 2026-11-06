import { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import {
  PROVIDER_STDIN_END_GRACE_MS,
  PROVIDER_SUPERVISOR_MAX_STOP_MS
} from '../provider-process/provider-process-supervisor'
import type { CodexAppServerSpawn } from './codex-app-server-process-tree-kill'
import type { CodexStateDbBackfillStatus } from './codex-state-db'
import { runCodexStateDbBackfillRecovery } from './codex-state-db-backfill-recovery'
import {
  alive,
  createSupervisedProbeRig,
  waitFor,
  type SupervisedProbeRig
} from './supervised-probe-owner.test-fixture'

const INCOMPLETE: CodexStateDbBackfillStatus = {
  kind: 'incomplete',
  stateDbPath: '/state.sqlite',
  status: 'running'
}

const temporaryRoots: string[] = []

const OWNER = String.raw`
import { runCodexStateDbBackfillRecovery } from './codex-state-db-backfill-recovery'
void runCodexStateDbBackfillRecovery(process.env.ORCA_TEST_CODEX_HOME!, new AbortController().signal, {
  resolveCommand: () => process.env.ORCA_TEST_STAND_IN!,
  readStatus: () => ({ kind: 'incomplete', stateDbPath: '/state.sqlite', status: 'running' })
}).catch(() => {})
setInterval(() => {}, 60_000)
`

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
let rig: SupervisedProbeRig | null = null

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  vi.unstubAllEnvs()
  rig?.cleanup()
  rig = null
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function decodedSupervisorSpec(env: unknown): unknown {
  const encoded =
    typeof env === 'object' && env !== null && 'ORCA_PROVIDER_SUPERVISOR_SPEC' in env
      ? String(env.ORCA_PROVIDER_SUPERVISOR_SPEC)
      : ''
  return JSON.parse(Buffer.from(encoded, 'base64').toString() || 'null')
}

describe('Codex backfill recovery app-server supervision', () => {
  it('runs the POSIX recovery app-server under a session-lifetime supervisor', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    // Never signalled: terminate is a stub here, and a handle-less ChildProcess must not be killed.
    const child = new ChildProcess()
    const calls: { program: string; args: string[]; options: Record<string, unknown> }[] = []
    const spawnProcess: CodexAppServerSpawn = (program, args, options) => {
      calls.push({ program, args, options })
      return child
    }
    const terminate = vi.fn(async () => {})
    const readStatus = vi
      .fn()
      .mockReturnValueOnce(INCOMPLETE)
      .mockReturnValue({ kind: 'complete', stateDbPath: '/state.sqlite' })

    await expect(
      runCodexStateDbBackfillRecovery('/managed-home', new AbortController().signal, {
        spawnProcess,
        resolveCommand: () => '/bin/codex',
        readStatus,
        terminate,
        sleep: vi.fn(async () => {}),
        now: vi.fn(() => 1_000)
      })
    ).resolves.toEqual({ outcome: 'completed', spawnCount: 1 })

    const [{ program, args, options }] = calls
    expect(program).toBe(process.execPath)
    expect(args.slice(args.indexOf('--') + 1)).toEqual([
      '/bin/codex',
      ...CODEX_READ_ONLY_APP_SERVER_ARGS
    ])
    expect(options).toMatchObject({ cwd: '/managed-home', detached: true })
    expect(options.env).toMatchObject({ CODEX_HOME: '/managed-home' })
    expect(decodedSupervisorSpec(options.env)).toMatchObject({
      lifetime: 'session',
      cwd: '/managed-home'
    })
    expect(terminate).toHaveBeenCalledWith(child, true)
  })

  it('keeps Windows recovery on its selected install, managed home, and stdin-close stop path', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const install = mkdtempSync(join(tmpdir(), 'orca-codex-recovery-win32-'))
    temporaryRoots.push(install)
    const launcher = join(install, 'codex.cmd')
    writeFileSync(launcher, '')
    writeFileSync(join(install, 'node.exe'), '')
    const accountHome = join(install, 'accounts', 'recovery-account', 'home')
    const child = new ChildProcess()
    const stdinEnd = vi.fn(() => {
      Object.defineProperty(child, 'exitCode', { configurable: true, value: 0 })
    })
    Object.defineProperty(child, 'stdin', {
      configurable: true,
      value: { end: stdinEnd }
    })
    const calls: { program: string; args: string[]; options: Record<string, unknown> }[] = []
    const spawnProcess: CodexAppServerSpawn = (program, args, options) => {
      calls.push({ program, args, options })
      return child
    }
    const readStatus = vi
      .fn()
      .mockReturnValueOnce(INCOMPLETE)
      .mockReturnValue({ kind: 'complete', stateDbPath: '/state.sqlite' })

    vi.stubEnv('ORCA_AGENT_SESSION_ID', 'recovery-session-fixture')
    await expect(
      runCodexStateDbBackfillRecovery(accountHome, new AbortController().signal, {
        spawnProcess,
        resolveCommand: () => launcher,
        readStatus,
        sleep: vi.fn(async () => {}),
        now: vi.fn(() => 1_000)
      })
    ).resolves.toEqual({ outcome: 'completed', spawnCount: 1 })

    const [{ program, args, options }] = calls
    expect(program).toBe(launcher)
    expect(args).toEqual([...CODEX_READ_ONLY_APP_SERVER_ARGS])
    expect(options).toMatchObject({
      cwd: accountHome,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      env: { CODEX_HOME: accountHome, ORCA_AGENT_SESSION_ID: 'recovery-session-fixture' }
    })
    expect(options.detached).toBeUndefined()
    expect(stdinEnd).toHaveBeenCalledOnce()

    const spawnEnv = options.env
    if (typeof spawnEnv !== 'object' || spawnEnv === null) {
      throw new Error('Windows recovery did not receive a child environment')
    }
    const pathValue = Object.entries(spawnEnv).find(([key]) => key.toLowerCase() === 'path')?.[1]
    expect(typeof pathValue).toBe('string')
    if (typeof pathValue !== 'string') {
      throw new Error('Windows recovery did not receive PATH')
    }
    expect(pathValue.split(';')[0]).toBe(install)
  })
})

describe.runIf(process.platform !== 'win32')('supervised Codex backfill recovery processes', () => {
  it('stops the whole recovery group when the recovery is aborted', async () => {
    rig = createSupervisedProbeRig()
    for (const [key, value] of Object.entries(rig.env)) {
      vi.stubEnv(key, value)
    }
    const standIn = rig.writeStandIn('codex')
    const controller = new AbortController()

    const recovery = runCodexStateDbBackfillRecovery(rig.dir, controller.signal, {
      resolveCommand: () => standIn,
      readStatus: () => INCOMPLETE
    })
    const pids = await rig.readPids()
    controller.abort()

    await expect(recovery).resolves.toEqual({ outcome: 'stopped', spawnCount: 1 })
    // Its stdin end comes first; the supervisor then SIGTERMs, and SIGKILLs the group after.
    expect(existsSync(rig.signalFile) && readFileSync(rig.signalFile, 'utf8')).toBe('SIGTERM')
    expect(alive(pids.provider)).toBe(false)
    // A SIGTERM to the root alone left this descendant running for good.
    expect(alive(pids.grandchild)).toBe(false)
  })

  it('drains, then stops the recovery group, when its owner is SIGKILLed', async () => {
    rig = createSupervisedProbeRig()
    const standIn = rig.writeStandIn('codex')
    const bundle = await rig.bundleOwner(OWNER, __dirname)
    const owner = rig.launchOwner(bundle, {
      ORCA_TEST_STAND_IN: standIn,
      ORCA_TEST_CODEX_HOME: rig.dir
    })
    const pids = await rig.readPids()

    owner.kill('SIGKILL')

    expect(
      await waitFor(
        () => !alive(pids.provider) && !alive(pids.grandchild),
        PROVIDER_SUPERVISOR_MAX_STOP_MS + 1_000
      )
    ).toBe(true)
    // A gone owner gets the close its owner makes: the stdin end, its grace, and only then SIGTERM.
    const events = rig.readEvents()
    expect(events['stdin-end']).toBeDefined()
    expect((events.SIGTERM ?? 0) - (events['stdin-end'] ?? 0)).toBeGreaterThanOrEqual(
      PROVIDER_STDIN_END_GRACE_MS - 50
    )
  })
})
