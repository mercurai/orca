import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { scanSourceTree, stripComments } from './source-scan/source-tree-scan'

// Why: the synchronous secure-file sequence blocked the main thread on icacls and fsync, and the
// async lane is now the only writer. `\b` after a name does not match `...Async`, so the twins pass.
const REMOVED_SYNC_WRITERS =
  /\b(?:writeSecureFile|writeSecureJsonFile|writeDurableSecureJsonFile|writeSecureJsonFileWithinLimit|writeEnvironmentStore|restrictWindowsPathSync|getCurrentWindowsUserSid|hardenSecurePath)\b|\bsync:\s*true\b/

const SCANNED_ROOTS = ['main', 'shared', 'cli'].map((name) => resolve(__dirname, '..', name))

function findRemovedSyncWriters(source: string): number[] {
  return stripComments(source)
    .split('\n')
    .flatMap((line, index) => (REMOVED_SYNC_WRITERS.test(line) ? [index + 1] : []))
}

describe('removed synchronous secure-file writers', () => {
  it('flags each removed name and spares the async twins', () => {
    const lines = [
      'writeSecureFile(path, text)',
      'writeSecureJsonFile(path, value)',
      'writeDurableSecureJsonFile(path, value)',
      'writeSecureJsonFileWithinLimit(path, value, 10)',
      'writeEnvironmentStore(store)',
      'restrictWindowsPathSync(path, false)',
      'getCurrentWindowsUserSid()',
      'hardenSecurePath(path, { sync: true })',
      'await writeSecureFileAsync(path, text)',
      'await writeSecureJsonFileAsync(path, value)',
      'await writeDurableSecureJsonFileAsync(path, value)',
      'await getCurrentWindowsUserSidAsync()',
      '// writeSecureFile(path, text) is gone'
    ]
    expect(findRemovedSyncWriters(lines.join('\n'))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('leaves no non-test source under main, shared or cli calling them', () => {
    const offenders = SCANNED_ROOTS.flatMap((root) =>
      scanSourceTree(root).flatMap(({ relativePath, source }) =>
        findRemovedSyncWriters(source).map(
          (line) => `${root.split(/[\/]/).pop()}/${relativePath}:${line}`
        )
      )
    )
    expect(offenders, `removed sync secure-file writers still referenced:\n${offenders.join('\n')}`).toEqual([])
  })
})
