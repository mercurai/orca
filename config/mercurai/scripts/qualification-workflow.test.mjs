import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..', '..', '..')
const workflow = readFileSync(
  resolve(root, '.github', 'workflows', 'fork-qualify-release.yml'),
  'utf8'
).replaceAll('\r\n', '\n')

test('qualification is manual, default-branch controlled, and read-only', () => {
  assert.match(workflow, /^name: fork-qualify-release$/m)
  assert.match(workflow, /^  workflow_dispatch:\n/m)
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule):/m)
  assert.match(
    workflow,
    /^permissions:\n {2}actions: read\n {2}checks: read\n {2}contents: read\n/m
  )
  assert.match(
    workflow,
    /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch \|\| 'mercurai'\)/
  )
  assert.doesNotMatch(workflow, /\bsecrets\b|FORK_BOT_TOKEN|actions\/cache|cache:\s*true/)
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/)
  assert.doesNotMatch(workflow, /persist-credentials:\s*true/)
})

test('qualification delegates exact cacheless source coverage to the shared required matrix', () => {
  assert.match(
    workflow,
    /^  matrix:\n    needs: admission\n    uses: \.\/\.github\/workflows\/pr.yml$/m
  )
  for (const field of ['candidate_sha', 'candidate_tree', 'controller_sha']) {
    assert.ok(workflow.includes(`${field}: \${{ inputs.${field} }}`))
  }
  assert.match(
    workflow,
    /upstream_base_sha: \$\{\{ needs\.admission\.outputs\.upstream_base_sha \}\}/
  )
  assert.match(workflow, /^      full_mode: true$/m)
  assert.match(workflow, /^      cache_mode: 'off'$/m)
  assert.doesNotMatch(
    workflow,
    /name: PR checks passed|test \/ tests node 24 2\/5|pnpm run test:node/
  )
})

test('qualification authenticates owner acceptance before candidate execution and again before recording', () => {
  const matrix = workflow.indexOf('\n  matrix:')
  const firstReview = workflow.indexOf('bash config/mercurai/scripts/fetch-release-review.sh')
  const lastReview = workflow.lastIndexOf('bash config/mercurai/scripts/fetch-release-review.sh')
  assert.ok(firstReview > 0 && firstReview < matrix)
  assert.ok(lastReview > matrix)
  assert.match(workflow, /^      review_run_id:\n(?: {8}.+\n)*? {8}required: true$/m)
  assert.doesNotMatch(workflow, /REVIEWER|REVIEWED_SHA|reviewedSha|verdict: 'approved'/)
  assert.match(workflow, /manifest\.upstream_release_tag/)
  assert.match(workflow, /manifest\.upstream_release_sha/)
})

test('receipt requires real complete matrix results and current-attempt API and unit-plan evidence', () => {
  assert.match(workflow, /needs: \[admission, matrix\]/)
  assert.match(
    workflow,
    /\[ "\$ADMISSION_RESULT" = success \] && \[ "\$MATRIX_RESULT" = success \]/
  )
  assert.match(workflow, /collectQualificationEvidence\(\{/)
  assert.match(workflow, /--paginate --slurp/)
  assert.match(workflow, /attempts\/\$GITHUB_RUN_ATTEMPT\/jobs\?per_page=100/)
  assert.match(workflow, /unit-selection-attempt-\$GITHUB_RUN_ATTEMPT/)
  assert.match(workflow, /unitPlan: read\('qualification-unit-plan\/unit-selection.json'\)/)
  assert.match(workflow, /jobPages: read\('qualification-jobs.json'\)/)
  assert.match(
    workflow,
    /verifyPromotion\(receipt, policy, read\('qualification-review\/review-context.json'\)\)/
  )
  assert.doesNotMatch(workflow, /checks:\s*\[|conclusion: 'success'/)
})

test('qualification exposes its dispatch identity in the run title and trusted receipt', () => {
  assert.match(workflow, /^run-name: qualify \$\{\{ inputs\.dispatch_id \}\}$/m)
  assert.match(workflow, /^      dispatch_id:\n(?: {8}.+\n)*? {8}required: true$/m)
  assert.match(workflow, /DISPATCH_ID: \$\{\{ inputs\.dispatch_id \}\}/)
  assert.match(workflow, /\[\[ "\$DISPATCH_ID" =~/)
  assert.match(workflow, /dispatchId: env\.DISPATCH_ID/)
})
