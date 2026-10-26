import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../shared/agent-session-caller-env'
import { ORCA_AGENT_SESSION_CALLER_ENV_KEYS } from '../ipc/pty/host-env/spawn-env-keys'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../runtime/structured-session-child-env'
import { isAbsolute, relative, sep } from 'node:path'
import type { PiWorkerPackageBinding } from './worker-package-binding'

export type PiRpcLaunchOptions = {
  /** Binary and paths are resolved by the execution host before building the launch. */
  command: string
  cwd: string
  fullAccess: boolean
  extraArgs?: readonly string[]
  env?: Record<string, string>
  envToDelete?: readonly string[]
  sessionFile?: string
  forkFile?: string
  /** Supplied only by the runtime's current Dispatch admission resolver. */
  workerPackage?: PiWorkerPackageBinding
}

const CALLER_ENV_TO_DELETE = [
  ...ORCA_AGENT_SESSION_CALLER_ENV_KEYS,
  'ORCA_TERMINAL_HANDLE',
  ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV
]

/** What a structured Pi session strips from its inheritance; the seal keeps a worker's handle. */
export const PI_RPC_SESSION_ENV_TO_DELETE: readonly string[] = [
  ...STRUCTURED_CHILD_ENV_TO_DELETE,
  'ORCA_TERMINAL_HANDLE'
]

/** `env` naming no caller: a structured session's seal names its own. */
export function withoutPiCallerEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const next = { ...env }
  for (const key of CALLER_ENV_TO_DELETE) {
    delete next[key]
  }
  return next
}

/** A Pi child that is no structured session (a catalog listing) names no caller at all. */
export function piRpcSessionlessEnvironment(env: Readonly<Record<string, string>>): {
  env: Record<string, string>
  envToDelete: readonly string[]
} {
  return {
    env: withoutPiCallerEnv(env),
    envToDelete: [...STRUCTURED_CHILD_ENV_TO_DELETE, ...CALLER_ENV_TO_DELETE]
  }
}

/** Pi stores its own sessions; an explicit session file is shared with terminal resumes. */
export function buildPiRpcLaunch(options: PiRpcLaunchOptions): ProviderProcessLaunch {
  if (!options.fullAccess) {
    throw new Error('Pi structured chat supports full access only')
  }
  if (options.sessionFile !== undefined && !options.sessionFile.trim()) {
    throw new Error('Pi resume requires a session file')
  }
  if (
    options.forkFile !== undefined &&
    (!options.forkFile.trim() || options.sessionFile !== undefined)
  ) {
    throw new Error('Pi fork requires one source session file')
  }
  const args = [...(options.extraArgs ?? [])]
  let provider = false
  let model = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const flag = arg.split('=')[0]
    if (flag === '--provider' || flag === '--model' || flag === '-m') {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++index]
      if (!value || value.startsWith('-')) {
        throw new Error(`Pi ${flag} requires a value`)
      }
      if (flag === '--provider') {
        provider = true
      } else {
        model = true
      }
    } else if (
      [
        '--mode',
        '--print',
        '-p',
        '--no-session',
        '--session',
        '-r',
        '--resume',
        '-c',
        '--continue',
        '--fork'
      ].includes(flag)
    ) {
      throw new Error(`Pi ${flag} conflicts with the structured chat launch`)
    }
  }
  if (provider && !model) {
    throw new Error('Pi --provider requires --model')
  }
  const worker = options.workerPackage
  if (worker) {
    if (args.length > 0) {
      throw new Error('Pi worker package does not permit launch argument overrides')
    }
    for (const file of [options.sessionFile, options.forkFile]) {
      if (!file) continue
      const location = relative(worker.sessionDirectory, file)
      if (!isAbsolute(file) || !location || isAbsolute(location) || location === '..' ||
        location.startsWith(`..${sep}`)) {
        throw new Error('Pi worker session is outside its admitted package session directory')
      }
    }
    args.push(
      '--no-builtin-tools', '--no-extensions', '--no-mcp', '--no-skills',
      '--no-prompt-templates', '--no-themes', '--no-context-files',
      '--extension', worker.extensionPath,
      '--skill', worker.skillsDirectory,
      '--system-prompt', '',
      '--append-system-prompt', worker.agentsPath,
      '--session-dir', worker.sessionDirectory,
      '--model', `${worker.provider}/${worker.model}`
    )
  }
  return {
    command: options.command,
    cwd: worker?.snapshotPath ?? options.cwd,
    args: [
      '--mode',
      'rpc',
      ...args,
      ...(options.sessionFile ? ['--session', options.sessionFile] : []),
      ...(options.forkFile ? ['--fork', options.forkFile] : [])
    ],
    env: {
      ...options.env,
      ...(worker ? {
        HOME: worker.agentHomeDirectory,
        USERPROFILE: worker.agentHomeDirectory,
        PI_CODING_AGENT_DIR: worker.agentHomeDirectory,
        HARNESS_PI_PROFILE: worker.profilePath,
        HARNESS_PI_BROKER: worker.broker.path,
        HARNESS_PI_BINDING: worker.bindingPath
      } : {})
    },
    ...(worker ? { environmentPolicy: 'pi-worker' as const } : {}),
    envToDelete: [...(options.envToDelete ?? [])]
  }
}
