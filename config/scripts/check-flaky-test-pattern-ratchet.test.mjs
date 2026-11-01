import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  changedFileScope,
  countFindings,
  listChangedFiles,
  main
} from './check-flaky-test-pattern-ratchet.mjs'

function gitLargeScope(root, args, input = undefined) {
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
  let fixture
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args
      ],
      { cwd: fixture, encoding: 'utf8' }
    ).trim()
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(fixture, { recursive: true, force: true })
  })

  it('enforces findings in tracked files whose names Git quotes', () => {
    fixture = mkdtempSync(join(tmpdir(), 'flaky-ratchet-path-'))
    git('init', '-q')
    git('config', 'core.quotePath', 'true')
    git('commit', '--allow-empty', '-qm', 'base')
    vi.stubEnv('ORCA_CODE_QUALITY_BASE', git('rev-parse', 'HEAD'))
    vi.stubEnv('ORCA_FLAKY_TEST_RATCHET_ALL', '')
    const file = '測試.test.ts'
    writeFileSync(join(fixture, file), 'Date.now()\n')
    git('add', '--', file)
    mkdirSync(join(fixture, 'config'))
    writeFileSync(join(fixture, 'config/flaky-test-pattern-baseline.txt'), '')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(main(fixture, undefined, [{ file, ruleId: 'test-no-wall-clock' }])).toBe(1)
    expect(error.mock.calls.join('\n')).toContain(file)
  })

  it('scopes to the base check:changed forwards instead of a stale origin/main', () => {
    fixture = mkdtempSync(join(tmpdir(), 'flaky-ratchet-base-'))
    const commit = (file) => {
      writeFileSync(join(fixture, file), file)
      git('add', file)
      git('commit', '-qm', file)
      return git('rev-parse', 'HEAD')
    }
    git('init', '-q')
    git('update-ref', 'refs/remotes/origin/main', commit('fork-base.txt'))
    const upstream = commit('upstream-drift.txt')
    commit('contribution.txt')
    vi.stubEnv('ORCA_FLAKY_TEST_RATCHET_ALL', '')
    vi.stubEnv('ORCA_CODE_QUALITY_BASE', '')

    expect([...listChangedFiles(fixture)].sort()).toEqual([
      'contribution.txt',
      'upstream-drift.txt'
    ])
    vi.stubEnv('ORCA_CODE_QUALITY_BASE', upstream)
    expect([...listChangedFiles(fixture)]).toEqual(['contribution.txt'])
  })
})

describe('listChangedFiles large scopes', () => {
  it('preserves the complete changed scope when Git names exceed one MiB', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-ratchet-'))
    vi.stubEnv('ORCA_FLAKY_TEST_RATCHET_ALL', '')
    vi.stubEnv('ORCA_CODE_QUALITY_BASE', '')
    try {
      gitLargeScope(root, ['init', '--quiet'])
      const blob = gitLargeScope(root, ['hash-object', '-w', '--stdin'], '')
      const names = Array.from(
        { length: 7_000 },
        (_, index) => `changed-${String(index).padStart(5, '0')}-${'x'.repeat(160)}.test.ts`
      )
      const unchanged = 'unchanged.test.ts'
      const tree = gitLargeScope(
        root,
        ['mktree'],
        [...names, unchanged].map((name) => `100644 blob ${blob}\t${name}\n`).join('')
      )
      const base = gitLargeScope(root, [
        '-c',
        'user.name=Ratchet Test',
        '-c',
        'user.email=ratchet-test@example.invalid',
        'commit-tree',
        tree,
        '-m',
        'baseline'
      ])
      gitLargeScope(root, ['update-ref', 'HEAD', base])
      gitLargeScope(root, ['update-ref', 'refs/remotes/origin/main', base])
      // Missing tracked paths are real deletions; only the unchanged control needs a file.
      gitLargeScope(root, ['read-tree', base])
      writeFileSync(join(root, unchanged), '')
      const diff = gitLargeScope(root, ['diff', '--name-only', '--no-renames', base])
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
