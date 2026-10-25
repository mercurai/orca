import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..', '..', '..')
const workflow = readFileSync(resolve(root, '.github', 'workflows', 'fork-release-coordinate.yml'), 'utf8').replaceAll('\r\n', '\n')

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
  assert.doesNotMatch(workflow, /FORK_BOT_TOKEN|secrets\./)
  assert.doesNotMatch(workflow, /worker-start[^\n]*--agent\s+claude/)
})
