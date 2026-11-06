import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_CODEX_NATIVE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'resolve-codex-native'],
    summary: 'Resolve a verified local Windows Codex installation for a shell launch',
    usage:
      'orca agent resolve-codex-native --launcher <absolute-path> [--node <absolute-path>] ' +
      '--format <json|records> [--custom-node-env]',
    allowedFlags: [...GLOBAL_FLAGS, 'launcher', 'node', 'format', 'custom-node-env'],
    notes: [
      'Runs locally and offline. The launcher and optional Node path must be ' +
        'absolute paths selected by the calling shell.',
      'Rejects --environment and --pairing-code; ambient remote selection does not change ' +
        'the machine being resolved.',
      '--custom-node-env says the shell had custom Node startup settings before Orca moved them ' +
        'out of NODE_OPTIONS; it takes no value.',
      '--format json prints the versioned JSON contract. --format records prints the fixed LF-separated shell contract.'
    ],
    examples: [
      'orca agent resolve-codex-native --launcher "C:\\Tools\\codex.cmd" --format records',
      'orca agent resolve-codex-native --launcher "C:\\Tools\\codex.cmd" --node "C:\\Tools\\node.exe" --format json'
    ]
  }
]
