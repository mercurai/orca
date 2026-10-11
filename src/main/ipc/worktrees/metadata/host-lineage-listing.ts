import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { Store } from '../../../persistence/loading-store/store'
import type {
  ListDesktopLineageForHostArgs,
  HostLineageSnapshot
} from '../../../../shared/host-lineage-contract'
import { parseExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { isCurrentSshProviderAuthority } from '../../../ssh/ssh-provider-authority'
import { hasValidLineageSshAuthority } from '../listing/detected-provider-listing'
import { filterLineageForHost } from './workspace-lineage-filtering'

export const LINEAGE_HYDRATION_TIMEOUT_MS = 5_000

export async function hydrateLineageWithinDeadline(runtime: OrcaRuntimeService): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const hydration = Promise.resolve()
    .then(() => runtime.hydrateInferredWorktreeLineage())
    .then(
      () => true,
      () => false
    )
  const deadline = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), LINEAGE_HYDRATION_TIMEOUT_MS)
  })
  try {
    return await Promise.race([hydration, deadline])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

export async function listDesktopLineageForHost(
  store: Store,
  runtime: OrcaRuntimeService,
  args: ListDesktopLineageForHostArgs
): Promise<HostLineageSnapshot> {
  const parsedHost = parseExecutionHostId(args?.executionHostId)
  const rejected = (
    reason: Extract<HostLineageSnapshot, { authoritative: false }>['reason']
  ): HostLineageSnapshot => ({
    authoritative: false,
    executionHostId: args.executionHostId,
    reason
  })
  if (!parsedHost || parsedHost.kind === 'runtime') {
    return rejected('rejected')
  }
  if (parsedHost.kind === 'ssh') {
    if (
      !hasValidLineageSshAuthority(args) ||
      args.expectedAuthority.targetId !== parsedHost.targetId
    ) {
      return rejected('rejected')
    }
    // An `ssh:` host is not served here, so its lineage is never answered from this machine.
    return rejected(
      isCurrentSshProviderAuthority({ ...args.expectedAuthority }) ? 'unavailable' : 'stale'
    )
  }
  if ('expectedAuthority' in args) {
    return rejected('rejected')
  }
  if (!(await hydrateLineageWithinDeadline(runtime))) {
    return rejected('unavailable')
  }
  const lineage = filterLineageForHost(store, parsedHost.id)
  if (!lineage) {
    return rejected('ambiguous-owner')
  }
  return {
    authoritative: true,
    authority: { kind: 'local', executionHostId: LOCAL_EXECUTION_HOST_ID },
    ...lineage
  }
}
