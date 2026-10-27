import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { compileAggregateExpression } from './pr-aggregate-gate-context.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const prWorkflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))

const expensiveJobs = [
  'static_analysis',
  'typecheck',
  'git_compatibility',
  'codex_index_heal_contract',
  'xterm_patch_sync',
  'shell_contracts',
  'test',
  'orcad_browser',
  'cross-version-wire',
  'managed_hook_node18',
  'package',
  'package_windows'
]

describe('PR Checks skip wiring', () => {
  it('runs the candidate daemon shutdown Docker oracle in the existing Linux package job', () => {
    const steps = prWorkflow.jobs.package.steps
    const install = steps.findIndex(
      (step) => step.uses === './.github/actions/install-node-dependencies'
    )
    const oracle = steps.findIndex(
      (step) => step.name === 'Verify Linux daemon shutdown descendant cleanup'
    )
    expect(install).toBeGreaterThan(-1)
    expect(oracle).toBeGreaterThan(install)
    expect(steps[oracle].run).toBe('node config/scripts/run-daemon-shutdown-descendants-docker.mjs')
    expect(steps[oracle].env.ORCA_BACKGROUND_LAUNCH).toBe('1')
  })

  it('classifies the PR range with a tested script and expands renames', () => {
    const classify = prWorkflow.jobs.code_paths.steps.find(
      (step) => step.name === 'Classify changed paths'
    )
    expect(classify.run).toContain('--diff-filter=ACDMR')
    expect(classify.run).toContain('--no-renames')
    // Merge HEAD^1 is the base; no merge-base computation permits shallow checkout on critical path.
    expect(classify.run).toContain('node config/scripts/git-pull-request-diff-base.mjs "$BASE_SHA"')
    expect(classify.run).toContain('"$DIFF_BASE" HEAD')
    expect(classify.run).not.toContain('--merge-base "$')
    expect(classify.run).toContain('node config/scripts/pr-code-change-scope.mjs')
    expect(classify.run).toContain('tee -a "$GITHUB_OUTPUT"')
    for (const full_mode of [false, true]) {
      for (const reused of ['false', 'true']) {
        for (const selected of ['false', 'true']) {
          const context = {
            inputs: { full_mode },
            steps: {
              readiness: { outputs: { reused } },
              filter: {
                outputs: {
                  should_run: selected,
                  ...Object.fromEntries(expensiveJobs.map((job) => [job, selected]))
                }
              }
            }
          }
          const overall = compileAggregateExpression(
            prWorkflow.jobs.code_paths.outputs.should_run,
            ['inputs', 'steps']
          )
          expect(overall(context).coerceString()).toBe(full_mode ? 'true' : selected)
          for (const job of expensiveJobs) {
            const output = compileAggregateExpression(prWorkflow.jobs.code_paths.outputs[job], [
              'inputs',
              'steps'
            ])
            expect(output(context).coerceString(), job).toBe(
              String(full_mode || (reused !== 'true' && selected === 'true'))
            )
          }
        }
      }
    }
  })

  it('gives static analysis the mobile types its type-aware pass resolves', () => {
    const mobile = compileAggregateExpression(
      prWorkflow.jobs.code_paths.outputs.mobile_dependencies,
      ['inputs', 'steps']
    )
    for (const full_mode of [false, true]) {
      for (const selected of ['false', 'true']) {
        expect(
          mobile({
            inputs: { full_mode },
            steps: { filter: { outputs: { mobile_dependencies: selected } } }
          }).coerceString()
        ).toBe(full_mode ? 'true' : selected)
      }
    }
    const steps = prWorkflow.jobs.preflight.steps
    const install = steps.findIndex(
      (step) => step.uses === './.github/actions/install-mobile-dependencies'
    )
    const gate = steps.findIndex((step) => step.name === 'Enforce changed-code quality')
    expect(install).toBeGreaterThan(-1)
    expect(install).toBeLessThan(gate)
    expect(steps[install].if).toBe(
      "needs.code_paths.outputs.static_analysis == 'true' && needs.code_paths.outputs.mobile_dependencies == 'true'"
    )
    // Assert install in shared packaging action, or caller can retain a step that installs nothing.
    const action = parse(
      readFileSync(
        join(projectDir, '.github/actions/install-mobile-dependencies/action.yml'),
        'utf8'
      )
    )
    const [installStep] = action.runs.steps
    expect(installStep['working-directory']).toBe('mobile')
    expect(installStep.run).toContain('--frozen-lockfile')
  })

  it('gates each expensive job on its classifier and cache prerequisite', () => {
    for (const jobName of expensiveJobs.filter(
      (jobName) => !['test', 'static_analysis', 'typecheck', 'orcad_browser'].includes(jobName)
    )) {
      expect(prWorkflow.jobs[jobName].needs, jobName).toEqual(['code_paths', 'preflight'])
      expect(prWorkflow.jobs[jobName].if, jobName).toContain(
        `needs.code_paths.outputs.${jobName} == 'true'`
      )
    }
    expect(prWorkflow.jobs.test.if).toContain("needs.preflight.result == 'success'")
    expect(prWorkflow.jobs.test.if).toContain("needs.code_paths.outputs.test == 'true'")
    expect(prWorkflow.jobs.test.with.shards).toBe('${{ needs.preflight.outputs.shards }}')
    expect(prWorkflow.jobs.unit_plan).toBeUndefined()
    expect(prWorkflow.jobs.test_native_cache).toBeUndefined()
  })

  it('skips e2e detection on docs-only PRs without dropping the draft gate', () => {
    const filter = prWorkflow.jobs.code_paths.steps.find((step) => step.id === 'e2e_filter')
    expect(filter.if).toBe(
      "github.event.pull_request.draft != true && steps.filter.outputs.should_run == 'true'"
    )
    expect(prWorkflow.jobs['e2e-paths']).toBeUndefined()
  })

  it('lets verify pass skipped jobs the classifier turned off', () => {
    const verifyStep = prWorkflow.jobs.verify.steps.find(
      (step) => step.name === 'Require successful checks'
    )
    expect(prWorkflow.jobs.verify.needs[0]).toBe('code_paths')
    expect(verifyStep.env.SHOULD_RUN).toBe('${{ needs.code_paths.outputs.should_run }}')
    expect(verifyStep.run).toContain('"$CODE_PATHS" != "success"')
    expect(verifyStep.run).toContain('expected skipped')
    expect(verifyStep.run).toContain('expected success')
    for (const job of prWorkflow.jobs.verify.needs) {
      if (job === 'code_paths' || job === 'preflight') {
        continue
      }
      const envVar = `${job.replaceAll('-', '_').toUpperCase()}_SHOULD_RUN`
      expect(verifyStep.env[envVar]).toBe(`\${{ needs.code_paths.outputs.${job} }}`)
      expect(verifyStep.run).toContain(`"$${envVar}"`)
    }
  })
})
