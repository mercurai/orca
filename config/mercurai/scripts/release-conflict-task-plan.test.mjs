import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildConflictTaskPlan } from './release-conflict-task-plan.mjs'

const conflict = (path, kind = 'content') => ({ path, kind })

test('groups conflicts into deterministic bounded, non-overlapping tasks', () => {
  const inventory = {
    conflicts: [
      conflict('src/main/codex/codex-structured-turn-start.ts'),
      conflict('.github/workflows/pr.yml'),
      conflict('src/main/codex/codex-structured-service-tier.ts'),
      conflict('src/main/git/command-runner/git-exec-file.ts')
    ]
  }
  const tasks = buildConflictTaskPlan(inventory, { maxPathsPerTask: 1 })

  assert.deepEqual(tasks.map(({ id }) => id), [
    'upstream-conflict-codex-catalog-1',
    'upstream-conflict-codex-catalog-2',
    'upstream-conflict-process-git-1',
    'upstream-conflict-workflow-package-1'
  ])
  assert.equal(new Set(tasks.flatMap(({ writablePaths }) => writablePaths)).size, 4)
  assert.ok(tasks.every(({ attemptLimit, owner, paths }) => attemptLimit === 3 && owner && paths.length === 1))
})

test('keeps modify-delete conflict kind in the bounded task input', () => {
  const [task] = buildConflictTaskPlan({ conflicts: [conflict('src/main/ipc/hooks/register-worktree-hook-runner-handler.ts', 'modify/delete')] })

  assert.deepEqual(task.paths, [
    { kind: 'modify/delete', path: 'src/main/ipc/hooks/register-worktree-hook-runner-handler.ts' }
  ])
})

test('fails closed for malformed inventories and bounds', () => {
  assert.throws(() => buildConflictTaskPlan({}), /conflicts array/)
  assert.throws(() => buildConflictTaskPlan({ conflicts: [ {} ] }), /contain a path/)
  assert.throws(() => buildConflictTaskPlan({ conflicts: [] }, { maxPathsPerTask: 0 }), /positive integer/)
})
