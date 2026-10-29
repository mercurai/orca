import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..', '..', '..')
const workflow = readFileSync(
  resolve(root, '.github', 'workflows', 'fork-qualify-release.yml'),
  'utf8'
).replaceAll('\r\n', '\n')

function localUses(text) {
  let blockIndent = null
  const references = []
  for (const line of text.split('\n')) {
    const indent = line.search(/\S/)
    if (blockIndent !== null) {
      if (indent === -1 || indent > blockIndent) {
        continue
      }
      blockIndent = null
    }
    const block = /^(\s*)(-\s+)?[\w-]+:\s*[|>][-+]?\s*(?:#.*)?$/.exec(line)
    if (block) {
      blockIndent = block[1].length + (block[2]?.length ?? 0)
      continue
    }
    const reference =
      /^\s*(?:-\s+)?(?:uses|'uses'|"uses"):\s*(['"]?)(\.\/[^\s'"]+)\1\s*(?:#.*)?$/.exec(line)
    if (reference) {
      references.push(reference[2].slice(2))
    }
  }
  return references
}

function missingLocalDependencies(entrypoints, read) {
  const pending = [...entrypoints]
  const visited = new Set()
  const missing = []
  while (pending.length > 0) {
    const document = pending.pop()
    if (visited.has(document)) {
      continue
    }
    visited.add(document)
    for (const reference of localUses(read(document))) {
      const targets = /\.ya?ml$/.test(reference)
        ? [reference]
        : [`${reference}/action.yml`, `${reference}/action.yaml`]
      const target = targets.find((path) => read(path) !== null)
      if (target) {
        pending.push(target)
      } else {
        missing.push(`${document} -> ./${reference}`)
      }
    }
  }
  return missing.toSorted()
}

test('the shared qualification workflows have a complete recursive local-action dependency closure', () => {
  const workflows = readdirSync(resolve(root, '.github/workflows'))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`)
  const read = (path) => {
    assert.match(path, /^\.github\/(actions|workflows)\//)
    assert.equal(
      path.split('/').includes('..'),
      false,
      'local dependency stays inside the repository'
    )
    const absolute = resolve(root, path)
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null
  }
  assert.deepEqual(missingLocalDependencies(workflows, read), [])
})

test('closure catches a missing nested setup action while ignoring script and description examples', () => {
  const files = new Map([
    [
      '.github/workflows/root.yml',
      [
        'jobs:',
        '  check:',
        '    steps:',
        "      - uses: './.github/actions/install' # actual dependency",
        '      - run: |',
        '          uses: ./.github/actions/not-an-action',
        '      - uses: actions/checkout@v6'
      ].join('\n')
    ],
    [
      '.github/actions/install/action.yml',
      [
        'description: >-',
        '  uses: ./.github/actions/description-only',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - uses: ./.github/actions/setup-pnpm'
      ].join('\n')
    ]
  ])
  const read = (path) => files.get(path) ?? null
  assert.deepEqual(missingLocalDependencies(['.github/workflows/root.yml'], read), [
    '.github/actions/install/action.yml -> ./.github/actions/setup-pnpm'
  ])
  files.set(
    '.github/actions/setup-pnpm/action.yml',
    'runs:\n  using: composite\n  steps:\n    - uses: pnpm/setup@v2\n'
  )
  assert.deepEqual(missingLocalDependencies(['.github/workflows/root.yml'], read), [])
})

for (const style of ['|', '>-']) {
  test(`a sequence-first ${style} scalar cannot hide a sibling local-action dependency`, () => {
    const files = new Map([
      [
        '.github/workflows/root.yml',
        [
          'jobs:',
          '  check:',
          '    steps:',
          `      - name: ${style}`,
          '          A caption containing an example:',
          '          uses: ./.github/actions/caption-only',
          '        uses: ./.github/actions/missing-after-caption'
        ].join('\n')
      ]
    ])
    const read = (path) => files.get(path) ?? null
    assert.deepEqual(missingLocalDependencies(['.github/workflows/root.yml'], read), [
      '.github/workflows/root.yml -> ./.github/actions/missing-after-caption'
    ])
    files.set(
      '.github/actions/missing-after-caption/action.yml',
      'runs:\n  using: composite\n  steps:\n    - uses: pnpm/setup@v2\n'
    )
    assert.deepEqual(missingLocalDependencies(['.github/workflows/root.yml'], read), [])
  })
}

for (const key of ["'uses'", '"uses"']) {
  test(`a literal quoted ${key} key cannot hide a missing local action`, () => {
    const files = new Map([
      [
        '.github/workflows/root.yml',
        [
          'jobs:',
          '  check:',
          '    steps:',
          `      - ${key}: './.github/actions/quoted-missing'`
        ].join('\n')
      ]
    ])
    const read = (path) => files.get(path) ?? null
    assert.deepEqual(missingLocalDependencies(['.github/workflows/root.yml'], read), [
      '.github/workflows/root.yml -> ./.github/actions/quoted-missing'
    ])
    files.set(
      '.github/actions/quoted-missing/action.yml',
      'runs:\n  using: composite\n  steps:\n    - uses: pnpm/setup@v2\n'
    )
    assert.deepEqual(missingLocalDependencies(['.github/workflows/root.yml'], read), [])
  })
}

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
