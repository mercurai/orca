import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { parse } from 'yaml'

const readWorkflow = (name) => parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'))
const workflow = readWorkflow('pr')
const candidateSha = 'a'.repeat(40)
const candidateTree = 'b'.repeat(40)
const controllerSha = 'c'.repeat(40)
const upstreamBaseSha = 'd'.repeat(40)
const requiredJobs = [
  'code_paths',
  'preflight',
  'git_compatibility',
  'codex_index_heal_contract',
  'xterm_patch_sync',
  'shell_contracts',
  'test',
  'mobile_web_app',
  'cross-version-wire',
  'managed_hook_node18',
  'package',
  'package_windows',
  'layout_oracle',
  'dependency_isolation'
]
const requiredRoutes = [
  'should_run',
  'static_analysis',
  'typecheck',
  'git_compatibility',
  'codex_index_heal_contract',
  'xterm_patch_sync',
  'shell_contracts',
  'test',
  'mobile_web_app',
  'cross-version-wire',
  'managed_hook_node18',
  'package',
  'package_windows',
  'layout_oracle',
  'dependency_isolation',
  'relay_integration',
  'orcad_browser'
]

function context(overrides = {}) {
  return {
    inputs: {
      candidate_sha: candidateSha,
      candidate_tree: candidateTree,
      controller_sha: controllerSha,
      upstream_base_sha: upstreamBaseSha,
      full_mode: true,
      cache_mode: 'off'
    },
    github: {
      sha: controllerSha,
      ref: 'refs/heads/mercurai',
      ref_name: 'mercurai',
      event_name: 'workflow_dispatch',
      event: {
        action: 'ready_for_review',
        pull_request: {
          draft: false,
          number: 42,
          base: { sha: 'e'.repeat(40) },
          head: { sha: 'f'.repeat(40) }
        }
      }
    },
    steps: {
      readiness: { outputs: { reused: 'true' } },
      filter: { outputs: Object.fromEntries(requiredRoutes.map((key) => [key, 'false'])) },
      e2e_filter: { outputs: { should_run: 'false' } }
    },
    vars: { ORCA_UNIT_SELECTION_MODE: 'selected', ORCA_UNIT_FULL_SHARD_COUNT: '5' },
    ...overrides
  }
}

function evaluate(value, scope = context()) {
  if (typeof value !== 'string') {
    return value
  }
  return runInNewContext(
    value.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replaceAll(/inputs\.([\w-]+)/g, 'inputs["$1"]'),
    scope
  )
}

it('makes the existing PR matrix callable with an explicit immutable qualification identity', () => {
  const inputs = workflow.on.workflow_call?.inputs
  for (const key of ['candidate_sha', 'candidate_tree', 'controller_sha', 'upstream_base_sha']) {
    expect(inputs?.[key]?.type, key).toBe('string')
  }
  expect(inputs?.full_mode?.type).toBe('boolean')
  expect(inputs?.full_mode?.default).toBe(false)
  expect(inputs?.cache_mode?.type).toBe('string')
  expect(workflow.on.pull_request.types).toContain('synchronize')
  expect(workflow.jobs.verify.needs).toEqual(requiredJobs)
})

it('forces every required matrix route for qualification despite docs-only routing and readiness reuse', () => {
  for (const route of requiredRoutes) {
    expect(String(evaluate(workflow.jobs.code_paths.outputs[route])), route).toBe('true')
  }
})

it('preserves ordinary PR path routing and readiness-result masking', () => {
  for (const reused of ['true', 'false']) {
    const scope = context()
    scope.inputs = {}
    scope.github.event_name = 'pull_request'
    scope.steps.readiness.outputs.reused = reused
    scope.steps.filter.outputs = Object.fromEntries(requiredRoutes.map((key) => [key, 'true']))
    for (const route of ['static_analysis', 'typecheck', 'test', 'package', 'package_windows']) {
      expect(String(evaluate(workflow.jobs.code_paths.outputs[route], scope)), route).toBe(
        String(reused !== 'true')
      )
    }
    scope.steps.filter.outputs = Object.fromEntries(requiredRoutes.map((key) => [key, 'false']))
    for (const route of ['static_analysis', 'typecheck', 'test', 'package', 'package_windows']) {
      expect(String(evaluate(workflow.jobs.code_paths.outputs[route], scope)), route).toBe('false')
    }
  }
})

it('cannot reuse a prior PR success instead of executing the qualification matrix', () => {
  const readiness = workflow.jobs.code_paths.steps.find((step) => step.id === 'readiness')
  expect(evaluate(readiness.if)).toBe(false)
  const scope = context()
  scope.inputs = {}
  scope.github.event_name = 'pull_request'
  expect(evaluate(readiness.if, scope)).toBe(true)
})

it('checks out the candidate rather than the controller in every source-testing job', () => {
  for (const [id, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('actions/checkout@')) {
        expect(evaluate(step.with?.ref), id).toBe(candidateSha)
        expect(step.with?.['persist-credentials'], id).toBe(false)
      }
    }
  }
  for (const id of ['test', 'e2e', 'layout_oracle', 'windows_wsl', 'terminal_ime_native']) {
    expect(evaluate(workflow.jobs[id].with?.ref), id).toBe(candidateSha)
  }
  const units = readWorkflow('unit-tests')
  for (const id of ['test', 'relay_integration']) {
    const checkout = units.jobs[id].steps.find((step) => step.uses?.startsWith('actions/checkout@'))
    expect(evaluate(checkout.with?.ref, context({ inputs: { ref: candidateSha } })), id).toBe(
      candidateSha
    )
  }
})

it('uses the supplied official base for shared diff and compatibility checks', () => {
  const baseSteps = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).filter((step) => step.env?.BASE_SHA !== undefined)
  )
  expect(baseSteps.length).toBeGreaterThan(0)
  for (const step of baseSteps) {
    expect(evaluate(step.env.BASE_SHA), step.name).toBe(upstreamBaseSha)
  }
})

it.skipIf(process.platform === 'win32')(
  'admits only the requested candidate tree, controller and available official base',
  () => {
    const admission = workflow.jobs.code_paths.steps.find(
      (step) => step.id === 'qualification-identity'
    )
    expect(
      admission,
      'full qualification needs an identity check before source execution'
    ).toBeDefined()
    expect(admission.run).toBeTypeOf('string')
    const root = mkdtempSync(join(tmpdir(), 'orca-qualification-identity-'))
    const git = (args) => {
      const result = runProcessSync({ program: 'git', args, cwd: root })
      expect(result.code, result.stderr).toBe(0)
      return result.stdout.trim()
    }
    try {
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src/value.ts'), 'export const value = 1')
      git(['init', '--quiet'])
      git(['add', 'src'])
      const commit = [
        '-c',
        'user.name=CI Test',
        '-c',
        'user.email=ci-test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'fixture'
      ]
      git(commit)
      const base = git(['rev-parse', 'HEAD'])
      writeFileSync(join(root, 'src/value.ts'), 'export const value = 2')
      git(['add', 'src'])
      git(commit)
      const sha = git(['rev-parse', 'HEAD'])
      const tree = git(['rev-parse', 'HEAD^{tree}'])
      const inputs = {
        candidate_sha: sha,
        candidate_tree: tree,
        controller_sha: controllerSha,
        upstream_base_sha: base,
        full_mode: true,
        cache_mode: 'off'
      }
      const environment = Object.fromEntries(
        Object.entries(admission.env).map(([name, value]) => [
          name,
          String(evaluate(value, context({ inputs })))
        ])
      )
      for (const [field, value] of Object.entries({
        CANDIDATE_SHA: sha,
        CANDIDATE_TREE: tree,
        CONTROLLER_SHA: controllerSha,
        UPSTREAM_BASE_SHA: base
      })) {
        expect(environment[field], field).toBe(value)
      }
      for (const overrides of [
        {},
        { CANDIDATE_SHA: base },
        { CANDIDATE_TREE: 'e'.repeat(40) },
        { CONTROLLER_SHA: 'f'.repeat(40) },
        { UPSTREAM_BASE_SHA: '0'.repeat(40) },
        { UPSTREAM_BASE_SHA: '' },
        { CACHE_MODE: 'auto' },
        { CACHE_MODE: '' }
      ]) {
        const result = runProcessSync({
          program: 'bash',
          args: ['-e', '-c', admission.run],
          cwd: root,
          env: {
            ...process.env,
            ...environment,
            ...overrides,
            ORCA_BACKGROUND_LAUNCH: '1',
            GITHUB_SHA: controllerSha,
            GITHUB_OUTPUT: join(root, 'outputs')
          },
          timeoutMs: 10_000
        })
        if (Object.keys(overrides).length === 0) {
          expect(result.code, result.stderr).toBe(0)
        } else {
          expect(result.code, JSON.stringify(overrides)).not.toBe(0)
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

it('propagates explicit full-unit mode and cache isolation into the existing reusable suite', () => {
  const plan = workflow.jobs.preflight.steps.find((step) => step.id === 'unit-plan')
  expect(String(evaluate(plan.env.ORCA_UNIT_FULL_MODE))).toBe('true')
  expect(evaluate(workflow.jobs.test.with.cache_mode)).toBe('off')
  expect(evaluate(workflow.jobs.e2e.with.cache_mode)).toBe('off')
  expect(evaluate(workflow.jobs.layout_oracle.with.cache_mode)).toBe('off')
  for (const [id, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses === './.github/actions/install-node-dependencies') {
        expect(evaluate(step.with?.['cache-mode']), id).toBe('off')
      }
    }
  }
})

it('retains advisory exclusions instead of representing them as required successful checks', () => {
  const admitted = context({ cancelled: () => false })
  for (const id of ['e2e', 'terminal_ime_native', 'windows_wsl', 'unit_selection_evidence']) {
    expect(workflow.jobs[id], id).toBeDefined()
    expect(workflow.jobs.verify.needs, id).not.toContain(id)
    expect(evaluate(workflow.jobs[id].if, admitted), id).toBe(false)
  }
  expect(evaluate(workflow.on.workflow_call.outputs.advisory_exclusions.value)).toBe(
    JSON.stringify(['e2e', 'terminal_ime_native', 'windows_wsl', 'unit_selection_evidence'])
  )
})
it('disables every persistent cache step in the shared workflows and preparation helpers', () => {
  const workflows = ['pr', 'unit-tests', 'e2e', 'unit-plan', 'terminal-ime-e2e', 'windows-wsl-e2e']
  for (const name of workflows) {
    const current = readWorkflow(name)
    for (const [id, job] of Object.entries(current.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('actions/cache')) {
          expect(evaluate(step.if), `${name}:${id}:${step.name ?? step.id}`).toBe(false)
        }
      }
    }
  }
  const actions = [
    'install-node-dependencies',
    'prepare-native-runtime',
    'prepare-git-compatibility',
    'prepare-xterm-dependencies',
    'prepare-linux-package-fixture',
    'prepare-wayland-clipboard',
    'prepare-windows-cli-launcher',
    'prepare-orcad-prebuilds'
  ]
  for (const name of actions) {
    const action = parse(readFileSync(`.github/actions/${name}/action.yml`, 'utf8'))
    expect(action.inputs['cache-mode'].default, name).toBe('auto')
    for (const step of action.runs.steps) {
      if (step.uses?.startsWith('actions/cache')) {
        expect(
          evaluate(step.if, context({ inputs: { 'cache-mode': 'off' } })),
          `${name}:${step.name ?? step.id}`
        ).toBe(false)
      }
    }
  }
})

it('publishes the admitted cache policy and existing layout allocation without inventing successes', () => {
  const outputs = workflow.on.workflow_call.outputs
  expect(outputs.cache_mode.value).toBe('${{ jobs.code_paths.outputs.cache_mode }}')
  const identity = workflow.jobs.code_paths.steps.find(
    (step) => step.id === 'qualification-identity'
  )
  expect(identity.run).toContain('echo "cache_mode=$CACHE_MODE"')
  expect(outputs.layout_oracle_shards.value).toBe(
    '${{ jobs.layout_oracle.outputs.changed_e2e_shards }}'
  )
  expect(readWorkflow('e2e').on.workflow_call.outputs.changed_e2e_shards.value).toBe(
    '${{ jobs.build.outputs.changed_e2e_shards }}'
  )
  expect(workflow.jobs.verify.outputs.required_results).toBe(
    '${{ steps.qualification-evidence.outputs.required_results }}'
  )
})

it('routes Mercurai required jobs to hosted runners while preserving platform coverage', () => {
  const armJobs = new Set([
    'codex_index_heal_contract',
    'xterm_patch_sync',
    'shell_contracts',
    'cross-version-wire'
  ])
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (typeof job['runs-on'] !== 'string' || !job['runs-on'].includes('blacksmith-')) {
      continue
    }
    for (const repository of ['mercurai/orca', 'stablyai/orca']) {
      const runner = evaluate(job['runs-on'], context({ github: { repository } }))
      expect(runner, `${repository}:${id}`).toBe(
        repository === 'mercurai/orca'
          ? armJobs.has(id)
            ? 'ubuntu-24.04-arm'
            : 'ubuntu-latest'
          : job['runs-on'].match(/'([^']*blacksmith[^']*)'/)[1]
      )
    }
  }
})

it.skipIf(process.platform === 'win32').each(['pr', 'unit-plan'])(
  '%s binds the actual unit-plan artifact to checked-out source when the controller SHA differs',
  (workflowName) => {
    const planStep =
      workflowName === 'pr'
        ? workflow.jobs.preflight.steps.find((step) => step.id === 'unit-plan')
        : readWorkflow('unit-plan').jobs.plan.steps.find((step) => step.id === 'plan')
    const root = mkdtempSync(join(tmpdir(), 'orca-unit-plan-source-'))
    const git = (args) => {
      const result = runProcessSync({ program: 'git', args, cwd: root })
      expect(result.code, result.stderr).toBe(0)
      return result.stdout.trim()
    }
    try {
      mkdirSync(join(root, 'src'))
      mkdirSync(join(root, 'config/scripts'), { recursive: true })
      writeFileSync(join(root, 'src/retained.test.ts'), 'export const retained = true')
      git(['init', '--quiet'])
      git(['add', 'src'])
      git([
        '-c',
        'user.name=CI Test',
        '-c',
        'user.email=ci-test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'fixture'
      ])
      const sourceSha = git(['rev-parse', 'HEAD'])
      expect(sourceSha).not.toBe(controllerSha)
      writeFileSync(
        join(root, 'config/scripts/ci-unit-plan.mjs'),
        `import { prepareUnitPlan } from ${JSON.stringify(new URL('./ci-unit-plan.mjs', import.meta.url).href)}; prepareUnitPlan()\n`
      )
      const planPath = join(root, 'ci-shards/unit-selection.json')
      for (const requestedSource of [sourceSha, '0'.repeat(40)]) {
        rmSync(planPath, { force: true })
        const scope = context({
          inputs: {
            ...context().inputs,
            candidate_sha: requestedSource,
            ref: requestedSource,
            selection_mode: 'selected'
          },
          needs: { code_paths: { outputs: { typecheck: 'true' } } },
          job: { status: 'success' }
        })
        const environment = Object.fromEntries(
          Object.entries(planStep.env).map(([name, value]) => [
            name,
            String(evaluate(value, scope))
          ])
        )
        const result = runProcessSync({
          program: 'bash',
          args: ['-e', '-c', planStep.run],
          cwd: root,
          env: {
            ...process.env,
            ...environment,
            ORCA_BACKGROUND_LAUNCH: '1',
            GITHUB_SHA: controllerSha,
            ORCA_SHARD_SOURCE_SHA: controllerSha,
            ORCA_UNIT_FULL_SHARD_COUNT: '5',
            GITHUB_OUTPUT: join(root, 'outputs'),
            GITHUB_STEP_SUMMARY: join(root, 'summary')
          },
          timeoutMs: 10_000
        })
        if (requestedSource === sourceSha) {
          expect(result.code, result.stderr).toBe(0)
          const plan = JSON.parse(readFileSync(planPath, 'utf8'))
          expect(plan.sourceSha).toBe(sourceSha)
          expect(plan.sourceSha).not.toBe(controllerSha)
          expect(plan.mode).toBe('full')
          expect(plan.executionFiles).toEqual(['src/retained.test.ts'])
        } else {
          expect(result.code).not.toBe(0)
          expect(result.stderr).toContain('qualification unit-plan source changed')
          expect(existsSync(planPath)).toBe(false)
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
