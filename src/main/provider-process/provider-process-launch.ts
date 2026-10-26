import { piWorkerEnvironment } from '../pi/rpc-worker-environment'

export type ProviderProcessLaunch = {
  command: string
  args: string[]
  /** Workspace directory used by the provider process itself. */
  cwd?: string
  /** Overlay on the inherited environment. */
  env?: Record<string, string>
  /** Keys stripped after the overlay. */
  envToDelete?: readonly string[]
  /** Internal admission policy, never taken from public session options. */
  environmentPolicy?: 'pi-worker'
}

/** The one env rule for provider children: inherit, overlay, then strip (so a delete beats an overlay). */
export function resolveProviderChildEnv(
  launch: Pick<ProviderProcessLaunch, 'env' | 'envToDelete' | 'environmentPolicy'>,
  baseEnv: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = launch.environmentPolicy === 'pi-worker'
    ? piWorkerEnvironment(baseEnv, launch.env)
    : { ...baseEnv, ...launch.env }
  for (const key of launch.envToDelete ?? []) {
    delete childEnv[key]
  }
  return childEnv
}
