import type { RuntimeMode } from './runtime-environment'

export type DirectRunEvidence = {
  mode: RuntimeMode
  api: 'connection-close' | 'session-stop'
  startupMs: number
  cleanupMs: number
  processTreeSize: number
  rootKind: 'node.exe' | 'codex.exe'
}
