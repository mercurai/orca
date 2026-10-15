// fork-scripts-test lints config/mercurai with the repo's own oxlint config before upstream's lane
// does, at the oxlint version pnpm-lock pins; it restores no cache (claude-code-config#1152).
// Run with `node --test "config/mercurai/scripts/*.test.mjs"` from the repo root.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..', '..', '..')
const read = (...parts) => readFileSync(resolve(root, ...parts), 'utf8').replaceAll('\r\n', '\n')
const workflow = read('.github', 'workflows', 'fork-scripts-test.yml')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

const lintStep = workflow.split(/^ {6}- /m).find((step) => step.startsWith('name: Lint config/mercurai\n'))

test('the lint step runs oxlint over config/mercurai with the repo config', () => {
  assert.ok(lintStep, 'no lint step')
  assert.match(
    lintStep,
    /^ {8}run: npx --yes oxlint@\d+\.\d+\.\d+ -c "\$GITHUB_WORKSPACE\/\.oxlintrc\.json" --format github "\$GITHUB_WORKSPACE\/config\/mercurai"$/m
  )
})

test('npx runs outside the checkout, on the public registry, with no user config', () => {
  assert.match(lintStep, /^ {8}working-directory: \$\{\{ runner\.temp \}\}$/m)
  assert.match(lintStep, /^ {10}NPM_CONFIG_REGISTRY: https:\/\/registry\.npmjs\.org\/$/m)
  assert.match(lintStep, /^ {10}NPM_CONFIG_USERCONFIG: \/dev\/null$/m)
  // No other step may run npx: it would read the checkout's .npmrc.
  assert.equal(workflow.split(/\bnpx\b/).length - 1, 1)
})

test('the oxlint version is the one pnpm-lock pins', () => {
  const pinned = /^ {2}oxlint@(\d+\.\d+\.\d+):$/m.exec(read('pnpm-lock.yaml'))?.[1]
  assert.ok(pinned, 'pnpm-lock.yaml has no oxlint entry')
  assert.ok(lintStep.includes(`npx --yes oxlint@${pinned} `), `the lint step does not run oxlint@${pinned}`)
})

test('the job restores no cache', () => {
  assert.doesNotMatch(workflow, /\bcache(-dependency-path)?:|actions\/cache|pnpm install/)
})

test('every action is pinned by commit', () => {
  for (const [, action] of workflow.matchAll(/^\s+(?:- )?uses: (\S+)/gm)) {
    assert.match(action, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, action)
  }
})
