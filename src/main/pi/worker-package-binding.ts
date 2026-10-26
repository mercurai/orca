/** Runtime-owned Pi launch data. Never accepted from public session options or worker flags. */
export type PiWorkerPackage = {
  owner: { runId: string; taskId: string; dispatchId: string }
  templateBytesSha256: string
  finalProfileSemanticSha256: string
  manifestBytesSha256: string
  canonicalSourceCommit: string
  packageRoot: string
  profilePath: string
  manifestPath: string
  provenancePath: string
  snapshotPath: string
  stateDirectory: string
  agentHomeDirectory: string
  sessionDirectory: string
  extensionPath: string
  agentsPath: string
  skillsDirectory: string
  broker: { path: string; sha256: string }
  piVersion: '1.4.0'
  provider: 'openrouter'
  model: 'deepseek/deepseek-v4.1-flash-1017'
}

export type PiWorkerPackageBinding = PiWorkerPackage & {
  acquisitionId: string
  bindingPath: string
  readinessNonce: string
}
