// Triage then bounded implementers, as one durable pi workflow. The triage step is a command call (no model,
// no slot); each implementer is an agent call in its own worktree, so two of them never write the same tree.
//
// args: { repo?, statePath?, itemsPath?, slot, maxWorkers?, maxTasks? }
// Globals available here: runs.run, runs.all, emit, args, runs.input, now, random. No imports, no Date.

const repo = args.repo || 'mercurai/orca'
const statePath = args.statePath || '.release-state/release-state.json'
const slot = args.slot || 'triage:unslotted'
const maxWorkers = Math.min(Math.max(Number(args.maxWorkers) || 2, 1), 2)
const maxTasks = Math.min(Math.max(Number(args.maxTasks) || 4, 1), 8)

const triageArgs = [
  'node',
  'config/mercurai/scripts/issue-pr-triage.mjs',
  '--repo',
  repo,
  '--state',
  statePath
]
if (args.itemsPath) {
  triageArgs.push('--items', args.itemsPath)
}

const triage = await runs.run('triage', {
  command: triageArgs,
  cwd: args.cwd,
  timeoutMs: 300000
})

if (!triage.ok) {
  emit({ stage: 'triage', ok: false, status: triage.status })
  return { ok: false, reason: 'triage command failed', output: triage.output }
}

let queue = null
try {
  queue = JSON.parse(String(triage.output).trim().split('\n').pop())
} catch {
  return { ok: false, reason: 'triage output was not JSON', output: triage.output }
}

const taskPaths = (queue.tasks || []).slice(0, maxTasks)
emit({ stage: 'triage', counts: queue.counts, dispatched: taskPaths.length, slot })

const dispatched = []
for (let start = 0; start < taskPaths.length; start += maxWorkers) {
  const batch = taskPaths.slice(start, start + maxWorkers)
  const results = await runs.all(
    batch.map((path, index) => ({
      key: `implement-${start + index}`,
      spec: {
        agent: 'worker',
        task: [
          `Read ${path} and do exactly what it specifies.`,
          'Work only in this worktree and only in the paths the task names.',
          'Reproduce the failure with a test before fixing it, and report the files changed and the test result.',
          'Do not commit, push, merge, tag, or touch the release state. Leave the change in the working tree.',
          'If the task needs an unapproved product or scope decision, ask one focused question and stop.'
        ].join(' '),
        cwd: args.cwd,
        isolation: 'worktree',
        timeoutMs: 45 * 60 * 1000
      }
    }))
  )
  for (const result of results) {
    dispatched.push({
      key: result.key,
      ok: result.ok,
      status: result.status,
      output: String(result.output || '').slice(0, 2000)
    })
  }
  emit({ stage: 'implement', completed: dispatched.length, of: taskPaths.length })
}

return {
  ok: dispatched.every((entry) => entry.ok),
  slot,
  counts: queue.counts,
  dispatched
}
