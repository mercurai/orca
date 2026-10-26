import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  return runInNewContext(value.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), scope)
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
        { UPSTREAM_BASE_SHA: '' }
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
  for (const id of ['e2e', 'terminal_ime_native', 'windows_wsl', 'unit_selection_evidence']) {
    expect(workflow.jobs[id], id).toBeDefined()
    expect(workflow.jobs.verify.needs, id).not.toContain(id)
  }
})
