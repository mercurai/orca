import type { KnownRuntimeEnvironment, PersistedRuntimeEnvironment } from './runtime-environments'
import {
  readEnvironmentStore,
  readPersistedEnvironmentStore
} from './runtime-environment-store-file'
import {
  overlayRuntimeEnvironmentSidecar,
  readCurrentRuntimeEnvironmentSidecarEntry,
  runtimeEnvironmentSidecarBinding,
  writeRuntimeEnvironmentSidecarEntryWithinMutation,
  type RuntimeEnvironmentSidecarEntry
} from './runtime-environment-sidecar'
import {
  requireUnchangedRuntimeEnvironmentSshAccess as requireUnchangedEnvironment,
  runtimeEnvironmentSshAccessError as invalid
} from './runtime-environment-authority-binding'

type SidecarState = Omit<RuntimeEnvironmentSidecarEntry, 'binding'>

type AccessContext = {
  environments: PersistedRuntimeEnvironment[]
  persisted: PersistedRuntimeEnvironment
  entry: SidecarState
  view: KnownRuntimeEnvironment
}

export function readRuntimeEnvironmentSshAccessContext(
  userDataPath: string,
  expected: KnownRuntimeEnvironment,
  ignoreIntent = false
): AccessContext {
  const { environments } = readPersistedEnvironmentStore(userDataPath)
  const views = readEnvironmentStore(userDataPath).environments
  const view = requireUnchangedEnvironment(views, expected, ignoreIntent)
  const persisted = environments.find((entry) => entry.id === view.id)!
  const current = readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, persisted)
  const { binding: _binding, ...entry } = current ?? { binding: undefined }
  return { environments, persisted, entry, view }
}

/** Writes only after the overlay proves every requested field survives validation. */
export async function commitRuntimeEnvironmentSshAccessContext(
  userDataPath: string,
  context: AccessContext,
  next: SidecarState
): Promise<KnownRuntimeEnvironment> {
  const view = overlayRuntimeEnvironmentSidecar(context.persisted, {
    ...next,
    binding: runtimeEnvironmentSidecarBinding(context.persisted)
  })
  if (
    (next.sshAccess !== undefined) !== (view.sshAccess !== undefined) ||
    (next.pendingSshAccessOperation !== undefined) !==
      (view.pendingSshAccessOperation !== undefined)
  ) {
    throw invalid('The SSH access state is inconsistent with this paired server.')
  }
  await writeRuntimeEnvironmentSidecarEntryWithinMutation(
    userDataPath,
    context.environments,
    context.persisted,
    next
  )
  return view
}
