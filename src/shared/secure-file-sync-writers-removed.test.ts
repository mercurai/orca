import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { scanSourceTree, stripComments } from './source-scan/source-tree-scan'

// Why: the synchronous secure-file sequence blocked the main thread on fsync, and the async lane is
// the writer for every store that answers IPC. `\b` after a name does not match `...Async`, so the
// twins pass.
const REMOVED_SYNC_WRITERS =
  /\b(?:writeSecureFile|writeSecureJsonFile|writeDurableSecureJsonFile|writeSecureJsonFileWithinLimit|writeEnvironmentStore|restrictWindowsPathSync|getCurrentWindowsUserSid|hardenSecurePath)\b|\bsync:\s*true\b/

const SCANNED_ROOTS = ['main', 'shared', 'cli'].map((name) => resolve(__dirname, '..', name))

// Why: these own the synchronous primitives or run where a write must finish before the next
// protocol step (orcad stop records, fence tokens). Converting one means making that protocol
// async; add a file here only with that reasoning, never to silence a main-process caller.
const SYNC_WRITER_OWNERS = new Set([
  'shared/secure-file.ts',
  'shared/secure-path-windows-acl.ts',
  'main/orcad/orcad-data-root-privacy.ts',
  'main/orcad/orcad-completed-stop-receipt.ts',
  'main/orcad/orcad-idle-stop-record.ts',
  'main/orcad/orcad-managed-stop-completion.ts',
  'main/orcad/orcad-managed-stop-decision.ts',
  'main/ssh/orcad-held-fence-tokens.ts'
])

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

  it('leaves no other non-test source under main, shared or cli calling them', () => {
    const offenders = SCANNED_ROOTS.flatMap((root) => {
      const rootName = root.split(/[/\\]/).pop()
      return scanSourceTree(root).flatMap(({ relativePath, source }) =>
        SYNC_WRITER_OWNERS.has(`${rootName}/${relativePath}`)
          ? []
          : findRemovedSyncWriters(source).map((line) => `${rootName}/${relativePath}:${line}`)
      )
    })
    expect(
      offenders,
      `removed sync secure-file writers still referenced:\n${offenders.join('\n')}`
    ).toEqual([])
  })
})
