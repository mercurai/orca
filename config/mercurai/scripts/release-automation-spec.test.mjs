import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildReleaseAutomationArgs,
  buildReleaseAutomationSpec,
  RELEASE_AUTOMATION_NAME
} from './release-automation-spec.mjs'

test('builds a disabled, state-gated Codex automation spec', () => {
  const spec = buildReleaseAutomationSpec({ statePath: 'state/release-state.json', repo: 'orca' })

  assert.equal(spec.name, RELEASE_AUTOMATION_NAME)
  assert.equal(spec.trigger, 'hourly')
  assert.equal(spec.provider, 'codex')
  assert.equal(spec.enabled, false)
  assert.match(spec.precheck, /release-precheck\.mjs state\/release-state\.json/)
  assert.match(spec.prompt, /isolated child worktree/)
  assert.match(spec.prompt, /publisher credential/)
})

test('emits structured CLI args that cannot enable or publish', () => {
  const args = buildReleaseAutomationArgs({ statePath: 'state/release-state.json', repo: 'orca' })

  assert.deepEqual(args.slice(0, 4), ['automations', 'create', '--name', RELEASE_AUTOMATION_NAME])
  assert.equal(args.at(-2), '--disabled')
  assert.equal(args.at(-1), '--json')
  assert.equal(args.includes('--enabled'), false)
  assert.equal(args.includes('FORK_BOT_TOKEN'), false)
  assert.equal(args[args.indexOf('--repo') + 1], 'orca')
})

test('rejects an empty state path', () => {
  assert.throws(() => buildReleaseAutomationSpec({ statePath: '' }), /statePath is required/)
})
