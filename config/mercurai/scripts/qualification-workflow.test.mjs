import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..', '..', '..')
const workflow = readFileSync(resolve(root, '.github', 'workflows', 'fork-qualify-release.yml'), 'utf8').replaceAll('\r\n', '\n')

test('qualification is manual, default-branch controlled, and read-only', () => {
  assert.match(workflow, /^name: fork-qualify-release$/m)
  assert.match(workflow, /^  workflow_dispatch:\n/m)
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule):/m)
  assert.match(workflow, /^permissions:\n(?: {2}actions: read\n)? {2}checks: read\n {2}contents: read\n/m)
  assert.match(workflow, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch \|\| 'mercurai'\)/)
  assert.doesNotMatch(workflow, /\bsecrets\b|GH_TOKEN|actions\/cache|cache:\s*true/)
})

test('qualification checks the exact candidate commit and runs the full suite without a candidate token', () => {
  assert.match(workflow, /candidate_sha:/)
  assert.match(workflow, /^      series:\n/m)
  assert.match(workflow, /env\.SERIES \? env\.SERIES\.split\(','\)/)
  assert.match(workflow, /^    name: test \/ tests node 24 2\/5$/m)
  assert.match(workflow, /ref: \$\{\{ inputs\.candidate_sha \}\}/)
  assert.match(workflow, /head_sha=\$\(git rev-parse HEAD\)/)
  assert.match(workflow, /\[ "\$head_sha" != "\$CANDIDATE_SHA" \]/)
  assert.match(workflow, /pnpm run test:node/)
  assert.match(workflow, /pnpm run lint/)
  assert.match(workflow, /pnpm run typecheck/)
  assert.match(workflow, /package-manager-cache: false/)
  assert.doesNotMatch(workflow, /persist-credentials:\s*true/)
})

test('aggregate qualification cannot pass after the test job fails or is skipped', () => {
  assert.match(workflow, /name: PR checks passed/)
  assert.match(workflow, /needs: test/)
  assert.match(workflow, /needs\.test\.result != 'success'/)
  assert.match(workflow, /exit 1/)
})
