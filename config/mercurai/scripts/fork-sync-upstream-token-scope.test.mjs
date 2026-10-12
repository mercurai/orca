// fork-sync-upstream holds FORK_BOT_TOKEN, which can push this repo's workflows. The token reaches
// only the steps that write, as a per-step extraheader for git and GH_TOKEN for gh, never as the
// checkout's persisted credential or a workflow-level variable (claude-code-config#1125, SEC-201).
// Run with `node --test "config/mercurai/scripts/*.test.mjs"` from the repo root.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const text = readFileSync(
  resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'fork-sync-upstream.yml'),
  'utf8'
).replaceAll('\r\n', '\n')
const code = text
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')
const header = code.slice(0, code.indexOf('\njobs:\n'))
const steps = code.slice(code.indexOf('\njobs:\n')).split(/^ {6}- /m).slice(1)
const SECRET = /\bsecrets\b/
const stepName = (step) => /^name: (.+)$/m.exec(step)?.[1] ?? step.split('\n')[0]

/** Steps that hold the token, by name: the presence check, then the steps that write. */
const WRITE_STEPS = [
  'Mirror main (fast-forward only)',
  'Mirror new tags',
  'Mirror the owner-allowed tag',
  'Hand the owner-allowed tag to fork-rebase-patches',
  'Hand the newest release tag to fork-rebase-patches',
  'Mirror upstream branches under upstream/*',
  'Open review issues for skipped release tags',
  'Merge main forward into the fork branch',
  'Report a guarded upstream range as an issue',
  'Report a merge conflict as an issue'
]
const GIT_WRITERS = [
  'Mirror main (fast-forward only)',
  'Mirror new tags',
  'Mirror the owner-allowed tag',
  'Mirror upstream branches under upstream/*',
  'Merge main forward into the fork branch'
]
const GH_WRITERS = [
  'Hand the owner-allowed tag to fork-rebase-patches',
  'Hand the newest release tag to fork-rebase-patches',
  'Open review issues for skipped release tags',
  'Report a guarded upstream range as an issue',
  'Report a merge conflict as an issue'
]
const TOKEN_ENV = [
  'GH_TOKEN: ${{ secrets.FORK_BOT_TOKEN }}',
  "GH_TOKEN: ${{ steps.mode.outputs.push == 'true' && secrets.FORK_BOT_TOKEN || '' }}"
]

test('the default token reads only and no secret is workflow-level', () => {
  assert.match(text, /^permissions:\n {2}contents: read\n(?! )/m)
  assert.doesNotMatch(code, /^[ \t]+permissions:/m)
  assert.doesNotMatch(code, /:\s*write\b/)
  assert.doesNotMatch(header, SECRET)
  assert.doesNotMatch(header, /GH_TOKEN/)
})

test('the checkout is pinned by commit and persists no credential', () => {
  const checkouts = steps.filter((step) => /uses: actions\/checkout@/.test(step))
  assert.equal(checkouts.length, 1)
  assert.match(checkouts[0], /^uses: actions\/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\.4\.0$/m)
  assert.match(checkouts[0], /persist-credentials: false/)
  assert.doesNotMatch(checkouts[0], /^\s+token:/m)
  assert.doesNotMatch(code, /git config[^\n]*extraheader|git remote set-url[^\n]*@/)
})

test('every action is pinned by commit', () => {
  for (const [, action] of code.matchAll(/^\s+(?:- )?uses: (\S+)/gm)) {
    assert.match(action, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, action)
  }
})

test('the token reaches only the named write steps', () => {
  const holders = steps.filter((step) => SECRET.test(step)).map(stepName)
  assert.deepEqual(holders, ['Require the bot token', ...WRITE_STEPS])
  for (const step of steps.filter((s) => SECRET.test(s) && stepName(s) !== 'Require the bot token')) {
    const refs = step.match(/^\s+[A-Za-z_]+: .*\bsecrets\b.*$/gm)
    assert.deepEqual(refs?.map((ref) => ref.trim()).filter((ref) => !TOKEN_ENV.includes(ref)), [], stepName(step))
    assert.equal(refs?.length, 1, stepName(step))
  }
  const check = steps.find((step) => stepName(step) === 'Require the bot token')
  assert.deepEqual(check.match(/^\s+[A-Za-z_]+: .*\bsecrets\b.*$/gm).map((l) => l.trim()), [
    "HAS_TOKEN: ${{ secrets.FORK_BOT_TOKEN != '' }}"
  ])
})

test('every step that pushes sets the extraheader, and gh gets GH_TOKEN, only in those steps', () => {
  for (const step of steps) {
    const name = stepName(step)
    if (GIT_WRITERS.includes(name)) {
      assert.match(step, /export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http\.https:\/\/github\.com\/\.extraheader/, name)
      assert.match(step, /export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic \$auth"/, name)
      assert.match(step, /::add-mask::\$auth/, name)
    } else {
      assert.doesNotMatch(step, /GIT_CONFIG_|\bgit push\b/, name)
    }
    if (!GH_WRITERS.includes(name)) {
      assert.doesNotMatch(step, /^\s+gh /m, name)
    }
  }
})

test('a report-only run gives the merge and issue steps no token', () => {
  for (const name of [
    'Merge main forward into the fork branch',
    'Report a guarded upstream range as an issue',
    'Report a merge conflict as an issue'
  ]) {
    assert.ok(steps.find((step) => stepName(step) === name).includes(TOKEN_ENV[1]), name)
  }
  const merge = steps.find((step) => stepName(step) === 'Merge main forward into the fork branch')
  const reportOnly = merge.indexOf('exit 0\n          fi\n')
  assert.ok(reportOnly > 0 && reportOnly < merge.indexOf('GIT_CONFIG_COUNT'))
})
