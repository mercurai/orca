import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..', '..', '..')
const workflow = readFileSync(
  resolve(root, '.github', 'workflows', 'fork-release-coordinate.yml'),
  'utf8'
).replaceAll('\r\n', '\n')

test('coordinator runs on a durable schedule and has a manual reconciliation path', () => {
  assert.match(workflow, /^name: fork-release-coordinate$/m)
  assert.match(workflow, /^  schedule:\n/m)
  assert.match(workflow, /cron: ['"]7 \* \* \* \*['"]?/)
  assert.match(workflow, /^  workflow_dispatch:\n/m)
  assert.match(workflow, /group: fork-release-coordinate/)
  assert.match(workflow, /cancel-in-progress: false/)
})

test('coordinator uses controller code, state CAS, and bounded Orca dispatch without publisher secrets', () => {
  assert.match(workflow, /automation\/release-state/)
  assert.match(workflow, /release-precheck\.mjs/)
  assert.match(workflow, /release-conflict-inventory\.mjs/)
  assert.match(workflow, /release-conflict-task-plan\.mjs/)
  assert.match(workflow, /release-agent-dispatch\.mjs/)
  assert.match(workflow, /patchHeadsChanged/)
  assert.match(workflow, /stableTagSha/)
  assert.match(workflow, /state\.candidate\.controllerSha !== target\.controllerSha/)
  assert.match(workflow, /activateQueuedTarget/)
  assert.match(workflow, /conflictInventory/)
  assert.match(workflow, /conflictTaskPlan/)
  assert.match(workflow, /upstream patch replay has/)
  assert.match(workflow, /--json/)
  assert.match(workflow, /git -C \.state push origin "HEAD:refs\/heads\/\$STATE_BRANCH"/)
  assert.match(workflow, /GIT_CONFIG_VALUE_0=.*AUTHORIZATION: basic/)
  assert.doesNotMatch(workflow, /git push --force-with-lease/)
  assert.match(workflow, /actions: read/)
  assert.match(workflow, /contents: write/)
  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' \|\| vars\.MERCURAI_RELEASE_COORDINATOR_ENABLED == 'true'/
  )
  assert.doesNotMatch(workflow, /FORK_BOT_TOKEN|secrets\./)
  assert.doesNotMatch(workflow, /worker-start[^\n]*--agent\s+claude/)
})

test('coordinator parks tag approvals, records the wake gate, and stores the audit', () => {
  assert.match(workflow, /fork-sync-tag&per_page=100/)
  assert.match(workflow, /select\(\.pull_request == null\)/)
  assert.match(workflow, /PARKED_TAGS_FILE/)
  assert.match(workflow, /parkItem\(/)
  assert.match(workflow, /clearParked\(/)
  assert.match(workflow, /computeTargetDigest\(state\.candidate\)/)
  assert.match(workflow, /recordEvaluation\(/)
  assert.match(workflow, /auditCandidate\(state\)/)
  assert.match(workflow, /evidence: \{ \.\.\.state\.evidence, audit \}/)
})

test('coordinator may read issues but never writes them, and still holds no secret', () => {
  assert.match(workflow, /^  issues: read$/m)
  assert.doesNotMatch(workflow, /issues: write/)
  assert.doesNotMatch(workflow, /gh issue (comment|create|edit|close)/)
  assert.doesNotMatch(workflow, /FORK_BOT_TOKEN|secrets\./)
})

test('the embedded reconcile script is valid JavaScript', async () => {
  const { spawnSync } = await import('node:child_process')
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const blocks = [...workflow.matchAll(/node --input-type=module - "\$GITHUB_WORKSPACE\/\.state\/release-state\.json" <<'NODE'\n([\s\S]*?)\n\s*NODE\n/g)]
  assert.equal(blocks.length, 1)
  const dir = mkdtempSync(join(tmpdir(), 'coordinator-'))
  const file = join(dir, 'reconcile.mjs')
  writeFileSync(file, blocks[0][1].replace(/^ {10}/gm, ''), 'utf8')
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr)
})
