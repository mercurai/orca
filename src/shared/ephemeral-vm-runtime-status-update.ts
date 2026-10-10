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
  cleanupLastError?: string | null
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
    ...(args.cleanupLastError === null
      ? { cleanupLastError: undefined }
      : args.cleanupLastError
        ? { cleanupLastError: args.cleanupLastError }
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
