import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  changedFileScope,
  countFindings,
  listChangedFiles
} from './check-flaky-test-pattern-ratchet.mjs'

function git(root, args, input = undefined) {
  return execFileSync('git', args, {
    cwd: root,
    input,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

describe('countFindings', () => {
  it('counts each rule per file, folding TSX twins and Windows separators', () => {
    const counts = countFindings(
      [
        { ruleId: 'test-no-wall-clock', file: 'src/a.test.ts' },
        { ruleId: 'test-no-wall-clock', file: 'src\\a.test.ts' },
        { ruleId: 'test-no-wall-clock-tsx', file: 'src/b.test.tsx' },
        { ruleId: 'test-no-real-time-wait', file: 'src/a.test.ts' },
        { ruleId: 'test-no-real-time-wait', file: 'scratch.test.ts' }
      ],
      (file) => file !== 'scratch.test.ts'
    )

    expect([...counts]).toEqual([
      ['test-no-wall-clock:src/a.test.ts', 2],
      ['test-no-wall-clock:src/b.test.tsx', 1],
      ['test-no-real-time-wait:src/a.test.ts', 1]
    ])
  })
})

describe('changedFileScope', () => {
  it('limits enforcement to findings in changed files', () => {
    const inScope = changedFileScope(new Set(['src/a.test.ts']))

    expect(inScope('test-no-wall-clock:src/a.test.ts')).toBe(true)
    expect(inScope('test-no-wall-clock:src/b.test.ts')).toBe(false)
    expect(changedFileScope(null)).toBeUndefined()
  })
})

describe('listChangedFiles', () => {
  it('preserves the complete changed scope when Git names exceed one MiB', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-ratchet-'))
    vi.stubEnv('ORCA_FLAKY_TEST_RATCHET_ALL', '')
    try {
      git(root, ['init', '--quiet'])
      const blob = git(root, ['hash-object', '-w', '--stdin'], '')
      const names = Array.from(
        { length: 7_000 },
        (_, index) => `changed-${String(index).padStart(5, '0')}-${'x'.repeat(160)}.test.ts`
      )
      const unchanged = 'unchanged.test.ts'
      const tree = git(
        root,
        ['mktree'],
        [...names, unchanged].map((name) => `100644 blob ${blob}\t${name}\n`).join('')
      )
      const base = git(root, [
        '-c',
        'user.name=Ratchet Test',
        '-c',
        'user.email=ratchet-test@example.invalid',
        'commit-tree',
        tree,
        '-m',
        'baseline'
      ])
      git(root, ['update-ref', 'HEAD', base])
      git(root, ['update-ref', 'refs/remotes/origin/main', base])
      // Missing tracked paths are real deletions; only the unchanged control needs a file.
      git(root, ['read-tree', base])
      writeFileSync(join(root, unchanged), '')
      const diff = git(root, ['diff', '--name-only', '--no-renames', base])
      expect(Buffer.byteLength(diff)).toBeGreaterThan(1024 * 1024)

      const changed = listChangedFiles(root)

      expect(changed).toEqual(new Set(names))
      expect(changedFileScope(changed)(`test-no-wall-clock:${unchanged}`)).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
