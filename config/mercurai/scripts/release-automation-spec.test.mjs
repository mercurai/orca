import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  RELEASE_PROMPT_PATH,
  buildReleaseAutomationArgs,
  buildReleaseAutomationSpec,
  slotIdFor
} from './release-automation-spec.mjs'

test('builds a disabled, state-gated automation spec that reads its instructions from the repo', () => {
  const spec = buildReleaseAutomationSpec({ statePath: 'state/release-state.json', repo: 'orca' })

  assert.equal(spec.trigger, 'hourly')
  assert.equal(spec.provider, 'pi')
  assert.equal(spec.enabled, false)
  assert.equal(spec.promptPath, RELEASE_PROMPT_PATH)
  assert.match(spec.precheck, /release-precheck\.mjs state\/release-state\.json/)
  assert.match(spec.prompt, /config\/mercurai\/automation\/release-coordinator\.md/)
  assert.match(spec.prompt, /isolated child worktree/)
  assert.match(spec.prompt, /publisher credential/)
  assert.match(spec.prompt, /--spec-file/)
})

test('emits structured CLI args that cannot enable or publish', () => {
  const args = buildReleaseAutomationArgs({ statePath: 'state/release-state.json', repo: 'orca' })

  assert.deepEqual(args.slice(0, 4), ['automations', 'create', '--name', 'Mercurai upstream release coordinator'])
  assert.equal(args.at(-2), '--disabled')
  assert.equal(args.at(-1), '--json')
  assert.equal(args.includes('--enabled'), false)
  assert.equal(args.includes('FORK_BOT_TOKEN'), false)
  assert.equal(args[args.indexOf('--provider') + 1], 'pi')
  assert.equal(args[args.indexOf('--repo') + 1], 'orca')
})

test('a provider override is explicit and never implied', () => {
  assert.equal(buildReleaseAutomationSpec({ provider: 'codex' }).provider, 'codex')
  assert.throws(() => buildReleaseAutomationSpec({ provider: '' }), /provider is required/)
})

test('derives a slot id that floors two fires in the same hour to one id', () => {
  const first = slotIdFor({ host: 'host-a', now: new Date('2026-11-03T17:07:00Z') })
  const second = slotIdFor({ host: 'host-a', now: new Date('2026-11-03T17:59:59Z') })
  const nextHour = slotIdFor({ host: 'host-a', now: new Date('2026-11-03T18:00:00Z') })

  assert.equal(first, 'coord:host-a:20261103T1700')
  assert.equal(second, first)
  assert.notEqual(nextHour, first)
  assert.match(first, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/)
})

test('refuses inputs that would produce an unusable automation', () => {
  assert.throws(() => buildReleaseAutomationSpec({ statePath: '' }), /statePath is required/)
  assert.throws(() => buildReleaseAutomationSpec({ promptPath: '' }), /promptPath is required/)
  assert.throws(() => slotIdFor({ host: '' }), /host is required/)
  assert.throws(() => slotIdFor({ host: 'h', minutes: 0 }), /minutes must be an integer/)
})
