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

const push = readFileSync(resolve(import.meta.dirname, 'sync-push.sh'), 'utf8').replaceAll('\r\n', '\n')

test('no push is forced and no push sends every tag', () => {
  const lines = [...code.split('\n'), ...push.split('\n')].filter((l) => /\bgit push\b/.test(l))
  assert.ok(lines.length >= 4)
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

test('only new upstream release names are pushed: no fork tag, no name that shadows a branch', () => {
  assert.ok(
    code.includes(
      "| (grep -E ' v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$' || true) | sort -k2 > /tmp/upstream-tags"
    )
  )
  assert.match(code, /join -1 2 -2 2 -v 1 \/tmp\/upstream-tags \/tmp\/origin-tags/)
  assert.ok(push.includes('refspecs+=("refs/upstream-tags/$tag:refs/tags/$tag")'))
  assert.ok(push.includes('done < "$state/tags-new"'))
})
