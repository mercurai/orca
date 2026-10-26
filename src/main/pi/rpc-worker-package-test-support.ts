import { join } from 'node:path'

const privateRoot = join('/host', 'private', 'pi-workers', 'dispatch-1')
const packageRoot = join(privateRoot, 'package')
export const workerPackage = {
  owner: { runId: 'run-1', taskId: 'task-1', dispatchId: 'dispatch-1' },
  templateBytesSha256: '1'.repeat(64),
  finalProfileSemanticSha256: '2'.repeat(64),
  manifestBytesSha256: '3'.repeat(64),
  canonicalSourceCommit: '4'.repeat(40),
  piVersion: '1.4.0' as const,
  provider: 'openrouter' as const,
  model: 'deepseek/deepseek-v4.1-flash-1017' as const,
  acquisitionId: 'acquisition-1',
  packageRoot,
  profilePath: join(packageRoot, 'profile.json'),
  manifestPath: join(packageRoot, 'manifest.json'),
  provenancePath: join(packageRoot, 'binding.json'),
  bindingPath: join(privateRoot, 'launch', 'acquisition-1', 'launch-binding.json'),
  snapshotPath: join(packageRoot, 'snapshot'),
  stateDirectory: join(packageRoot, 'state'),
  agentHomeDirectory: join(privateRoot, 'pi-home'),
  sessionDirectory: join(privateRoot, 'sessions'),
  extensionPath: join(packageRoot, 'extensions', 'extension.mjs'),
  agentsPath: join(packageRoot, 'AGENTS.md'),
  skillsDirectory: join(packageRoot, 'skills'),
  broker: { path: join('/host', 'bin', 'harness'), sha256: '5'.repeat(64) },
  readinessNonce: '6'.repeat(64)
}
