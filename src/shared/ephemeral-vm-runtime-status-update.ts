import { toCleanupLastErrorFields, type EphemeralVmFailure } from './ephemeral-vm-failure-copy'
import {
  EphemeralVmRuntimeRecordSchema,
  type EphemeralVmCleanupStatus,
  type EphemeralVmRuntimeRecord,
  type EphemeralVmRuntimeStatus
} from './ephemeral-vm-runtimes'

export type EphemeralVmRuntimeStatusUpdate = {
  status?: EphemeralVmRuntimeStatus
  cleanupStatus?: EphemeralVmCleanupStatus
  cleanupLastAttemptAt?: number
  /** A string clears any stored code; null clears both. */
  cleanupLastError?: string | EphemeralVmFailure | null
  workspaceId?: string
  workspaceName?: string
  connectionMode?: EphemeralVmRuntimeRecord['connectionMode'] | null
  runtimeEnvironmentId?: string
  sshTargetId?: string | null
  recipeResult?: EphemeralVmRuntimeRecord['recipeResult']
  updatedAt?: number
}

export function applyEphemeralVmRuntimeStatusUpdate(
  existing: EphemeralVmRuntimeRecord,
  args: EphemeralVmRuntimeStatusUpdate
): EphemeralVmRuntimeRecord {
  return EphemeralVmRuntimeRecordSchema.parse({
    ...existing,
    ...(args.status ? { status: args.status } : {}),
    ...(args.cleanupStatus ? { cleanupStatus: args.cleanupStatus } : {}),
    ...(args.cleanupLastAttemptAt !== undefined
      ? { cleanupLastAttemptAt: args.cleanupLastAttemptAt }
      : {}),
    ...(args.cleanupLastError === null || args.cleanupLastError
      ? toCleanupLastErrorFields(
          typeof args.cleanupLastError === 'string'
            ? { error: args.cleanupLastError }
            : args.cleanupLastError
        )
      : {}),
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
    // null explicitly clears the field (e.g. terminal cleanup); undefined leaves it unchanged.
    ...(args.connectionMode === null
      ? { connectionMode: undefined }
      : args.connectionMode
        ? { connectionMode: args.connectionMode }
        : {}),
    ...(args.runtimeEnvironmentId ? { runtimeEnvironmentId: args.runtimeEnvironmentId } : {}),
    ...(args.sshTargetId === null
      ? { sshTargetId: undefined }
      : args.sshTargetId
        ? { sshTargetId: args.sshTargetId }
        : {}),
    ...(args.recipeResult ? { recipeResult: args.recipeResult } : {}),
    updatedAt: args.updatedAt ?? Date.now()
  })
}
