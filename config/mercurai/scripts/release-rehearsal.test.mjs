import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runRehearsal } from './release-rehearsal.mjs'

test('the tokenless rehearsal passes every scenario it claims', async () => {
  const result = await runRehearsal()

  assert.equal(result.total, 9)
  assert.deepEqual(
    result.scenarios.filter((scenario) => !scenario.ok),
    []
  )
  assert.equal(result.ok, true)
})

test('each scenario names its own receipt, not just a verdict', async () => {
  const result = await runRehearsal()

  for (const scenario of result.scenarios) {
    assert.ok(scenario.detail.length > 0, `${scenario.name} has no detail`)
  }
  assert.match(result.scenarios[4].detail, /retry=worker-start/)
})
