import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..', '..', '..')
const source = readFileSync(resolve(root, 'config', 'mercurai', 'workflows', 'issue-pr-triage.js'), 'utf8')

test('the triage workflow is a single durable script with no module loading', () => {
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /\brequire\(/)
  // Replay determinism: the documented clock and randomness only.
  assert.doesNotMatch(source, /new Date\(|Date\.now\(|Math\.random\(/)
  assert.match(source, /runs\.run\(/)
  assert.match(source, /runs\.all\(/)
})

test('the triage workflow bounds concurrency and isolation', () => {
  assert.match(source, /Math\.min\(Math\.max\(Number\(args\.maxWorkers\) \|\| 2, 1\), 2\)/)
  assert.match(source, /isolation: 'worktree'/)
  assert.match(source, /maxTasks/)
  assert.match(source, /timeoutMs/)
})

test('the triage workflow never merges, publishes, or writes the release state', () => {
  assert.doesNotMatch(source, /git push|git tag|gh pr merge|gh release|FORK_BOT_TOKEN/)
  assert.match(source, /Do not commit, push, merge, tag/)
})

test('the implementer prompt names the task spec file and the writable scope', () => {
  assert.match(source, /Read \$\{path\} and do exactly what it specifies/)
  assert.match(source, /only in the paths the task names/)
  assert.match(source, /ask one focused question/)
})

test('the workflow script is valid module syntax', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-workflow-'))
  const file = join(dir, 'workflow.mjs')
  // The orchestrator runs a workflow script inside an async function, which is why a top-level return is legal.
  writeFileSync(file, `async function workflow() {
${source}
}
`, 'utf8')
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr)
})
