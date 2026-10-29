import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildConflictInventory, parseMergeTreeOutput } from './release-conflict-inventory.mjs'

const SHA = 'a'.repeat(40)

test('classifies a clean merge-tree result without inventing conflicts', () => {
  const parsed = parseMergeTreeOutput(`${SHA}\nREADME.md\n`, 0)

  assert.deepEqual(parsed, { status: 'clean', tree: SHA, conflicts: [] })
})

test('extracts and sorts unique content and modify/delete conflict paths', () => {
  const parsed = parseMergeTreeOutput(
    [
      `${SHA}`,
      'CONFLICT (content): Merge conflict in z/file.ts',
      'CONFLICT (content): Merge conflict in a/file.ts',
      'CONFLICT (content): Merge conflict in z/file.ts',
      'CONFLICT (modify/delete): src/removed.ts deleted in upstream/main and modified in HEAD.'
    ].join('\n'),
    1
  )

  assert.deepEqual(parsed, {
    status: 'conflict',
    tree: SHA,
    conflicts: [
      { kind: 'content', path: 'a/file.ts' },
      { kind: 'modify/delete', path: 'src/removed.ts' },
      { kind: 'content', path: 'z/file.ts' }
    ]
  })
})

test('binds conflict evidence to the three immutable inputs', () => {
  const inventory = buildConflictInventory({
    baseSha: SHA,
    upstreamSha: 'b'.repeat(40),
    candidateSha: 'c'.repeat(40),
    output: `${SHA}\nCONFLICT (content): Merge conflict in package.json\n`,
    exitCode: 1,
    generatedAt: '2026-10-25T12:00:00.000Z'
  })

  assert.deepEqual(inventory, {
    schemaVersion: 1,
    baseSha: SHA,
    upstreamSha: 'b'.repeat(40),
    candidateSha: 'c'.repeat(40),
    generatedAt: '2026-10-25T12:00:00.000Z',
    status: 'conflict',
    mergeTreeExitCode: 1,
    mergeTree: SHA,
    conflictCount: 1,
    conflicts: [{ kind: 'content', path: 'package.json' }]
  })
})

test('rejects a merge-tree infrastructure failure instead of recording a clean result', () => {
  assert.throws(() => parseMergeTreeOutput('', 2), /failed with exit code 2/)
  assert.throws(() => parseMergeTreeOutput(`${SHA}\n`, 1), /without reporting conflict paths/)
})
