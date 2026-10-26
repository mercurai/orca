import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { workerPackage } from './rpc-worker-package-test-support'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'
import { sealStructuredSessionChild } from '../runtime/structured-session-child-env'
import {
  buildPiRpcLaunch,
  PI_RPC_SESSION_ENV_TO_DELETE,
  piRpcSessionlessEnvironment,
  withoutPiCallerEnv
} from './rpc-launch'

const options = { command: 'host-resolved-pi', cwd: '/host/folder', fullAccess: true }
describe('Pi RPC launch', () => {
  it('uses the supplied host binary and folder, and lets Pi choose its own session store', () => {
    expect(buildPiRpcLaunch(options)).toMatchObject({
      command: options.command,
      cwd: options.cwd,
      args: ['--mode', 'rpc']
    })
  })

  it.each([
    '/host/.pi/agent/sessions/session.jsonl',
    'C:\\Users\\dev\\.pi\\agent\\sessions\\session.jsonl'
  ])('passes the native session file unchanged: %s', (sessionFile) => {
    expect(buildPiRpcLaunch({ ...options, sessionFile }).args).toEqual([
      '--mode',
      'rpc',
      '--session',
      sessionFile
    ])
  })

  it('retains selected account and user extension args, but strips inherited pane hook identities after overlays', () => {
    const launch = buildPiRpcLaunch({
      ...options,
      extraArgs: ['--extension', '/host/my extension.ts'],
      ...piRpcSessionlessEnvironment({
        PI_CODING_AGENT_DIR: '/host/account',
        ORCA_PANE_KEY: 'other-pane',
        ORCA_AGENT_PANE: 'alias'
      })
    })
    const env = resolveProviderChildEnv(launch, {
      ORCA_AGENT_HOOK_TOKEN: 'inherited',
      API_KEY: 'retained'
    })
    expect(env).toEqual({ API_KEY: 'retained', PI_CODING_AGENT_DIR: '/host/account' })
    expect(launch.args).toEqual(['--mode', 'rpc', '--extension', '/host/my extension.ts'])
  })

  it.each([
    ['--provider', 'anthropic', '--model', 'model-id'],
    ['--provider=anthropic', '--model=model-id'],
    ['--provider=anthropic', '-m', 'model-id'],
    ['--model', 'anthropic/model-id']
  ])('accepts paired model/provider selections: %j', (...extraArgs) => {
    expect(buildPiRpcLaunch({ ...options, extraArgs }).args).toEqual([
      '--mode',
      'rpc',
      ...extraArgs
    ])
  })

  it.each([['--provider', 'anthropic'], ['--provider=anthropic'], ['--model'], ['--model=']])(
    'rejects incomplete provider/model args: %j',
    (...extraArgs) => {
      expect(() => buildPiRpcLaunch({ ...options, extraArgs })).toThrow(/requires/)
    }
  )

  it.each([
    '--mode=json',
    '--print',
    '-p',
    '--no-session',
    '--session=other',
    '--resume',
    '--continue'
  ])('rejects arguments that bypass the chat mode or its session handle: %s', (arg) => {
    expect(() => buildPiRpcLaunch({ ...options, extraArgs: [arg] })).toThrow('conflicts')
  })

  it('rejects a supervised permissions request instead of silently running in full access', () => {
    expect(() => buildPiRpcLaunch({ ...options, fullAccess: false })).toThrow('full access only')
  })

  it('rejects an empty supplied resume handle', () => {
    expect(() => buildPiRpcLaunch({ ...options, sessionFile: '' })).toThrow(
      'requires a session file'
    )
  })

  it('scrubs inherited structured identity and injects only this acquisition identity', () => {
    const inherited = {
      ORCA_AGENT_SESSION_ID: 'stale',
      ORCA_STRUCTURED_SESSION: '1',
      ORCA_TERMINAL_HANDLE: 'structworker_stale',
      ORCA_AGENT_SESSION_SPAWN_TOKEN: 'old-token'
    }
    expect(
      resolveProviderChildEnv(
        buildPiRpcLaunch({ ...options, ...piRpcSessionlessEnvironment({}) }),
        inherited
      )
    ).toEqual({})
    // As a structured launch seals it: no caller of its own env, then this session's identity.
    const childEnv = resolveProviderChildEnv(
      buildPiRpcLaunch({
        ...options,
        ...sealStructuredSessionChild({
          sessionId: 'this-session',
          spawnToken: 'this-token',
          env: withoutPiCallerEnv(inherited),
          inheritedEnvToDelete: PI_RPC_SESSION_ENV_TO_DELETE
        })
      }),
      inherited
    )
    expect(childEnv).toMatchObject({
      ORCA_AGENT_SESSION_ID: 'this-session',
      ORCA_STRUCTURED_SESSION: '1',
      ORCA_AGENT_SESSION_SPAWN_TOKEN: 'this-token'
    })
    expect(childEnv).not.toHaveProperty('ORCA_TERMINAL_HANDLE')
  })
})

describe('Pi admitted worker package launch', () => {
  it('isolates the snapshot, home and session store and loads only pinned package resources', () => {
    const launch = buildPiRpcLaunch({ ...options, ...{ workerPackage } })
    expect(launch.cwd).toBe(workerPackage.snapshotPath)
    expect(launch.env).toMatchObject({
      HOME: workerPackage.agentHomeDirectory,
      USERPROFILE: workerPackage.agentHomeDirectory,
      PI_CODING_AGENT_DIR: workerPackage.agentHomeDirectory,
      HARNESS_PI_PROFILE: workerPackage.profilePath,
      HARNESS_PI_BROKER: workerPackage.broker.path,
      HARNESS_PI_BINDING: workerPackage.bindingPath
    })
    for (const flag of [
      '--no-builtin-tools', '--no-extensions', '--no-mcp', '--no-skills',
      '--no-prompt-templates', '--no-themes', '--no-context-files'
    ]) expect(launch.args).toContain(flag)
    for (const [flag, path] of [
      ['--extension', workerPackage.extensionPath],
      ['--skill', workerPackage.skillsDirectory],
      ['--system-prompt', ''],
      ['--append-system-prompt', workerPackage.agentsPath],
      ['--session-dir', workerPackage.sessionDirectory]
    ]) {
      expect(launch.args.filter((arg) => arg === flag)).toHaveLength(1)
      expect(launch.args[launch.args.indexOf(flag) + 1]).toBe(path)
    }
    expect(launch.args).not.toContain('--no-tools')
  })

  it('strips late inherited credentials and runtime injection while retaining inference credentials', () => {
    const launch = buildPiRpcLaunch({ ...options, ...{ workerPackage } })
    const env = resolveProviderChildEnv(launch, {
      PATH: '/host/bin',
      SystemRoot: 'C:\\Windows',
      OPENROUTER_API_KEY: 'synthetic-inference-sentinel',
      GH_TOKEN: 'synthetic-github-sentinel',
      CUSTOM_SECRET: 'synthetic-unknown-sentinel',
      ANTHROPIC_API_KEY: 'synthetic-unrelated-sentinel',
      NODE_OPTIONS: '--require /untrusted/injection.js',
      PI_CODING_AGENT_DIR: '/inherited/agent',
      HOME: '/inherited/home'
    })
    expect(env).toMatchObject({
      PATH: '/host/bin',
      SystemRoot: 'C:\\Windows',
      OPENROUTER_API_KEY: 'synthetic-inference-sentinel',
      HOME: workerPackage.agentHomeDirectory,
      PI_CODING_AGENT_DIR: workerPackage.agentHomeDirectory
    })
    for (const key of ['GH_TOKEN', 'CUSTOM_SECRET', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']) {
      expect(env).not.toHaveProperty(key)
    }
  })

  it.each([
    ['--extension', '/outside/untrusted.mjs'],
    ['--skill', '/outside/skills'],
    ['--tools', 'bash,codemode'],
    ['--append-system-prompt', '/outside/AGENTS.md'],
    ['--session-dir', '/outside/sessions'],
    ['--model', 'anthropic/other-model']
  ])('refuses package launch overrides: %j', (...extraArgs) => {
    expect(() => buildPiRpcLaunch({ ...options, extraArgs, ...{ workerPackage } })).toThrow()
  })

  it('refuses a resumed session outside the admitted package session directory', () => {
    expect(() => buildPiRpcLaunch({
      ...options,
      sessionFile: join('/outside', 'session.jsonl'),
      ...{ workerPackage }
    })).toThrow()
  })
})
