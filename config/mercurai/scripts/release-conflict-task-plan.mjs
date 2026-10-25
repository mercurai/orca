const FAMILY_RULES = [
  {
    id: 'workflow-package',
    pattern: /^(\.github\/|package\.json$|pnpm-|.*\/pnpm-|config\/scripts\/)/,
    objective:
      'Reconcile workflow, package and lockfile changes against official main without weakening Mercurai release gates.'
  },
  {
    id: 'codex-catalog',
    pattern: /(codex|agent-model-catalog|agent-session-wire)/,
    objective:
      'Reconcile Codex catalog, speed selection and session-wire changes while preserving exact service-tier IDs and no-downgrade admission.'
  },
  {
    id: 'process-git',
    pattern: /(process|git|wsl|ssh|durable-file|pwsh|worktree-runner)/,
    objective:
      'Reconcile process, Git, WSL, SSH and durable-file changes while preserving Mercurai async and termination guarantees.'
  },
  {
    id: 'runtime',
    pattern: /(runtime|e2ee|managed-server|ephemeral-vm|updater|hooks|ipc|moving-wsl)/,
    objective:
      'Reconcile runtime, IPC, managed-server and updater changes without weakening host isolation or remote compatibility.'
  },
  {
    id: 'renderer',
    pattern: /renderer/,
    objective:
      'Reconcile renderer changes while preserving native-chat speed picker state, loading and actionable error surfaces.'
  }
]

function familyFor(path) {
  return FAMILY_RULES.find((family) => family.pattern.test(path)) ?? {
    id: 'other',
    objective: 'Reconcile the remaining upstream conflict with focused tests and no unrelated changes.'
  }
}

function validateInventory(inventory) {
  if (!inventory || typeof inventory !== 'object' || !Array.isArray(inventory.conflicts)) {
    throw new TypeError('conflict inventory must contain a conflicts array')
  }
  for (const conflict of inventory.conflicts) {
    if (!conflict || typeof conflict.path !== 'string' || conflict.path.length === 0) {
      throw new TypeError('every conflict must contain a path')
    }
  }
}

/** Build deterministic, bounded work packages from a trusted conflict inventory. */
export function buildConflictTaskPlan(inventory, { maxPathsPerTask = 12 } = {}) {
  validateInventory(inventory)
  if (!Number.isInteger(maxPathsPerTask) || maxPathsPerTask < 1) {
    throw new TypeError('maxPathsPerTask must be a positive integer')
  }
  const grouped = new Map()
  for (const conflict of inventory.conflicts) {
    const family = familyFor(conflict.path)
    const rows = grouped.get(family.id) ?? []
    rows.push({ kind: conflict.kind ?? 'content', path: conflict.path })
    grouped.set(family.id, rows)
  }
  const tasks = []
  for (const [familyId, conflicts] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    const family = FAMILY_RULES.find((entry) => entry.id === familyId)
    const objective = family?.objective ?? familyFor(conflicts[0].path).objective
    const ordered = conflicts.sort((a, b) => a.path.localeCompare(b.path))
    for (let offset = 0; offset < ordered.length; offset += maxPathsPerTask) {
      const paths = ordered.slice(offset, offset + maxPathsPerTask)
      const index = Math.floor(offset / maxPathsPerTask) + 1
      tasks.push({
        id: `upstream-conflict-${familyId}-${index}`,
        family: familyId,
        owner: 'product-integrator',
        attemptLimit: 3,
        paths,
        writablePaths: paths.map(({ path }) => path),
        objective
      })
    }
  }
  return tasks
}

if (process.argv[1]?.endsWith('release-conflict-task-plan.mjs')) {
  const input = process.argv[2]
  if (!input) {
    console.error('usage: node release-conflict-task-plan.mjs <inventory.json>')
    process.exitCode = 2
  } else {
    try {
      const { readFileSync } = await import('node:fs')
      console.log(JSON.stringify(buildConflictTaskPlan(JSON.parse(readFileSync(input, 'utf8'))), null, 2))
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 2
    }
  }
}
