import type { ProcessIdentity } from '../../../tests/tools/windows-codex-native-runtime/process-tree-identity'
import type { ProcessMetrics } from '../../../tests/tools/windows-codex-native-runtime/process-metrics-client'
import type { ResourceWindowSnapshot } from '../../../tests/tools/windows-codex-native-runtime/runtime-resource-window'

export function identity(pid: number, creationTimeMs: number): ProcessIdentity {
  return { pid, creationTimeMs }
}

export function snapshot(
  helpers: ProcessIdentity | ProcessIdentity[] | null,
  codex = identity(202, 2002),
  marker = 2
): ResourceWindowSnapshot {
  const helperProcesses = helpers === null ? [] : Array.isArray(helpers) ? helpers : [helpers]
  const processes = [
    { name: 'bash.exe', identity: identity(101, 1001) },
    { name: 'codex.exe', identity: codex }
  ]
  for (const helper of helperProcesses) {
    processes.push({ name: 'conhost.exe', identity: helper })
  }
  const criticalProcesses = processes.slice(0, 2).map((process) => ({
    name: process.name,
    identity: { ...process.identity }
  }))
  return {
    shell: 'Git Bash',
    mode: 'native',
    signature: processes
      .map(({ identity: item }) => `${item.pid}:${item.creationTimeMs}`)
      .join(','),
    processes,
    criticalProcesses,
    identities: processes.map(({ identity: item }) => item),
    measure: (metrics) => ({
      privateBytes: marker,
      workingSetBytes: marker,
      handleCount: marker,
      nodeCount: 0,
      cmdCount: 0,
      cpu100ns: metrics.reduce((total, row) => total + row.kernel100ns + row.user100ns, 0)
    })
  }
}

export function metricsFor(identities: ProcessIdentity[], cpu100ns: number): ProcessMetrics[] {
  return identities.map((item, index) => ({
    ...item,
    imagePath: 'codex.exe',
    privateBytes: 1,
    workingSetBytes: 1,
    handleCount: 1,
    kernel100ns: index === 0 ? cpu100ns : 0,
    user100ns: 0
  }))
}
