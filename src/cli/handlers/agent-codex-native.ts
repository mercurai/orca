import { isAbsolute } from 'node:path'
import { resolveWindowsCodexNativeLaunch } from '@orca/process-host/windows-codex-native-resolution'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import {
  hasProtocolControlCharacters,
  serializeCodexNativeResolution,
  type CodexNativeOutputFormat
} from '../agent-codex-native-protocol'

function invalidArgument(message: string): never {
  throw new RuntimeClientError('invalid_argument', message)
}

function requirePathFlag(
  flags: ReadonlyMap<string, string | boolean>,
  name: string,
  required: true
): string
function requirePathFlag(
  flags: ReadonlyMap<string, string | boolean>,
  name: string,
  required: false
): string | undefined
function requirePathFlag(
  flags: ReadonlyMap<string, string | boolean>,
  name: string,
  required: boolean
): string | undefined {
  const value = flags.get(name)
  if (value === undefined && !required) {
    return undefined
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !isAbsolute(value) ||
    hasProtocolControlCharacters(value)
  ) {
    return invalidArgument(`--${name} requires an absolute path.`)
  }
  return value
}

function requireFormat(flags: ReadonlyMap<string, string | boolean>): CodexNativeOutputFormat {
  const format = flags.get('format')
  if (format === 'json' || format === 'records') {
    return format
  }
  return invalidArgument('--format must be json or records.')
}

function hasCustomNodeEnvironment(flags: ReadonlyMap<string, string | boolean>): boolean {
  const value = flags.get('custom-node-env')
  if (value === undefined) {
    return false
  }
  if (value === true) {
    return true
  }
  return invalidArgument('--custom-node-env does not take a value.')
}

async function resolveCodexNative(ctx: HandlerContext): Promise<void> {
  rejectRemoteSelectionFlags(
    ctx.flags,
    'the local Codex resolver; it runs on this machine and cannot target another runtime.'
  )

  const launcher = requirePathFlag(ctx.flags, 'launcher', true)
  const node = requirePathFlag(ctx.flags, 'node', false)
  const format = requireFormat(ctx.flags)
  const customNodeEnv = hasCustomNodeEnvironment(ctx.flags)
  const resolution = resolveWindowsCodexNativeLaunch({
    launcher,
    ...(node === undefined ? {} : { node }),
    env: process.env,
    platform: process.platform,
    customNodeEnv
  })

  process.stdout.write(serializeCodexNativeResolution(resolution, format))
}

export const AGENT_CODEX_NATIVE_HANDLERS: Record<string, CommandHandler> = {
  'agent resolve-codex-native': resolveCodexNative
}
