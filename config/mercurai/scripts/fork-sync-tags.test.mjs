// fork-sync-upstream mirrors upstream's tags into the fork, whose release workflow builds by tag.
// A mirrored tag must never rewrite one the fork holds, and the fork's own release tags are never
// taken from upstream (claude-code-config#1125, SEC-103).
// Run with `node --test "config/mercurai/scripts/*.test.mjs"` from the repo root.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const sync = readFileSync(
  resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'fork-sync-upstream.yml'),
  'utf8'
).replaceAll('\r\n', '\n')
const code = sync
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

// Which tags are new, moved or skipped is asserted on what list-new-tags.sh and sync-push.sh produce, in the harness.
const scripts = ['sync-push.sh', 'mirror-allowed-tag.sh']
  .map((name) => readFileSync(resolve(import.meta.dirname, name), 'utf8').replaceAll('\r\n', '\n'))
  .join('\n')

test('no push is forced and no push sends every tag', () => {
  const lines = [...code.split('\n'), ...scripts.split('\n')].filter((l) => /\bgit push\b/.test(l))
  assert.ok(lines.length >= 5)
  for (const line of lines) {
    assert.doesNotMatch(line, /--force|\s-f\b|--tags|--mirror|\s\+/, `forced or bulk push: ${line.trim()}`)
  }
})

test("upstream's tags are fetched into their own namespace, never over the fork's", () => {
  const fetches = code.split('\n').filter((l) => /\bgit fetch\b/.test(l))
  for (const line of fetches) {
    assert.doesNotMatch(line, /--tags\b|refs\/tags\/\*:refs\/tags\//, `fetch over the fork's tags: ${line.trim()}`)
  }
  assert.ok(fetches.some((l) => l.includes("'+refs/tags/*:refs/upstream-tags/*'")))
})
