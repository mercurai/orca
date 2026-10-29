import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseAllDocuments, stringify } from 'yaml'
import {
  nativeDependencyClosure,
  nativeDependencyLockDigest,
  nativeWorkspaceSettings
} from './native-dependency-lock-digest.mjs'

const lockfile = ({
  pty = 'node-pty@1.1.0(patch_hash=aa)',
  addon = '7.1.1',
  electron = '43.8.1'
}) => `---
lockfileVersion: '9.0'
importers:
  .:
    packageManagerDependencies:
      pnpm: {specifier: 12.14.0, version: 12.14.0}
---
lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      electron: {specifier: ${electron}, version: ${electron}(supports-color@7.2.0)}
  native/addon:
    dependencies:
      node-addon-api: {specifier: ^8.5.0, version: 8.9.2}
packages:
  node-pty@1.1.0:
    resolution: {integrity: sha512-cHR5, tarball: 'https://example.invalid/node-pty.tgz'}
    peerDependencies: {peer: ^1.0.0}
  node-addon-api@7.1.0:
    resolution: {integrity: sha512-YWRkb24tNw==}
  node-addon-api@7.1.1:
    resolution: {integrity: sha512-YWRkb24tNw==}
  node-addon-api@8.9.2:
    resolution: {integrity: sha512-YWRkb24tOA==}
  electron@${electron}:
    resolution: {integrity: sha512-ZWxlY3Ryb24=}
  got@11.8.6:
    resolution: {integrity: sha512-ZG93bmxvYWRlcg==}
  zustand@5.0.15:
    resolution: {integrity: sha512-dW5yZWxhdGVk}
snapshots:
  ${pty}:
    dependencies:
      node-addon-api: ${addon}
  node-addon-api@7.1.0: {}
  node-addon-api@7.1.1: {}
  node-addon-api@8.9.2: {}
  electron@${electron}(supports-color@7.2.0):
    dependencies:
      got: 11.8.6
  got@11.8.6: {}
  zustand@5.0.15: {}
`
const selection = {
  packages: ['node-pty'],
  versionOnly: ['electron'],
  workspaces: ['native/addon']
}

describe('native dependency lock closure', () => {
  it('pins native closures, workspace addons and the Electron release only', () => {
    expect(nativeDependencyClosure(lockfile({}), selection)).toEqual([
      'electron@43.8.1',
      'node-addon-api@7.1.1',
      'node-addon-api@8.9.2',
      'node-pty@1.1.0(patch_hash=aa)'
    ])
    for (const change of [
      { pty: 'node-pty@1.1.0(patch_hash=bb)' },
      { addon: '7.1.0' },
      { electron: '43.9.0' }
    ]) {
      expect(nativeDependencyClosure(lockfile(change), selection)).not.toEqual(
        nativeDependencyClosure(lockfile({}), selection)
      )
    }
  })

  it('fails closed when a selected package or dependency is not locked', () => {
    expect(() => nativeDependencyClosure(lockfile({}), { packages: ['missing'] })).toThrow(
      /locks none of missing/
    )
    expect(() =>
      nativeDependencyClosure(lockfile({}), { ...selection, packages: ['node-pty', 'node-gyp'] })
    ).toThrow(/locks none of node-gyp$/)
    expect(() =>
      nativeDependencyClosure(lockfile({}), { ...selection, versionOnly: ['electron', 'nw'] })
    ).toThrow(/locks none of nw$/)
    expect(() =>
      nativeDependencyClosure(lockfile({ addon: '9.9.9' }), { packages: ['node-pty'] })
    ).toThrow(/no snapshot for node-addon-api@9.9.9/)
  })

  it('keeps layout settings and native build approvals but drops resolution-only settings', () => {
    const settings = `
shamefullyHoist: true
minimumReleaseAge: 4320
overrides: {a: 1}
patchedDependencies: {x: y}
allowBuilds: {node-pty: true, bun: true}
`
    expect(nativeWorkspaceSettings(settings, ['node-pty@1.1.0(patch_hash=aa)'])).toEqual({
      allowBuilds: { 'node-pty': true },
      shamefullyHoist: true
    })
  })
})

const temporary = []
afterEach(() => {
  for (const repository of temporary.splice(0)) {
    rmSync(repository, { recursive: true, force: true })
  }
})

function digest(contents, workspace = 'allowBuilds: {node-pty: true}\n') {
  const repository = mkdtempSync(join(tmpdir(), 'orca-native-lock-digest-'))
  temporary.push(repository)
  writeFileSync(join(repository, 'pnpm-lock.yaml'), contents)
  writeFileSync(join(repository, 'pnpm-workspace.yaml'), workspace)
  return nativeDependencyLockDigest({ repository, ...selection }).digest
}

function updateLock(contents, update) {
  const documents = parseAllDocuments(contents).map((document) => document.toJS())
  update(documents[1], documents[0])
  return documents.map((document) => `---\n${stringify(document)}`).join('')
}

describe('native dependency locked-source identity', () => {
  it.each(['integrity', 'tarball'])(
    'changes the digest when same-version selected %s metadata changes',
    (field) => {
      const before = lockfile({})
      const after = updateLock(before, (project) => {
        project.packages['node-pty@1.1.0'].resolution[field] =
          field === 'integrity' ? 'sha512-Y2hhbmdlZA==' : 'https://example.invalid/changed.tgz'
      })
      expect(nativeDependencyClosure(after, selection)).toEqual(
        nativeDependencyClosure(before, selection)
      )
      expect(digest(after)).not.toBe(digest(before))
    }
  )

  it('keeps metadata for peer-qualified and optional transitive native dependencies', () => {
    const before = updateLock(
      lockfile({ pty: 'node-pty@1.1.0(patch_hash=aa)(peer@1.0.0)' }),
      (project) => {
        const pty = project.snapshots['node-pty@1.1.0(patch_hash=aa)(peer@1.0.0)']
        pty.optionalDependencies = { 'node-addon-api': '7.1.0' }
        pty.dependencies.peer = '1.0.0'
        project.snapshots['peer@1.0.0'] = {}
        project.packages['peer@1.0.0'] = { resolution: { integrity: 'sha512-cGVlcg==' } }
      }
    )
    expect(nativeDependencyClosure(before, selection)).toContain('node-addon-api@7.1.0')
    expect(nativeDependencyClosure(before, selection)).toContain('peer@1.0.0')
    expect(nativeDependencyClosure(before, selection)).toContain(
      'node-pty@1.1.0(patch_hash=aa)(peer@1.0.0)'
    )
    for (const id of ['node-addon-api@7.1.0', 'peer@1.0.0']) {
      const after = updateLock(before, (project) => {
        project.packages[id].resolution.integrity = 'sha512-Y2hhbmdlZA=='
      })
      expect(digest(after)).not.toBe(digest(before))
    }
  })

  it('ignores unrelated and Electron-downloader metadata and canonicalizes map ordering', () => {
    const before = lockfile({})
    const after = updateLock(before, (project, manager) => {
      manager.packages = {
        'zustand@5.0.15': { resolution: { integrity: 'sha512-dW5yZWxhdGVkLWNvbmZsaWN0' } }
      }
      project.packages['zustand@5.0.15'].resolution.integrity = 'sha512-dW5yZWxhdGVkLTI='
      project.packages['got@11.8.6'].resolution.integrity = 'sha512-ZG93bmxvYWRlci0y'
      project.packages = Object.fromEntries(Object.entries(project.packages).reverse())
      const pty = project.packages['node-pty@1.1.0']
      pty.resolution = Object.fromEntries(Object.entries(pty.resolution).reverse())
      project.packages['node-pty@1.1.0'] = Object.fromEntries(Object.entries(pty).reverse())
      project.snapshots = Object.fromEntries(Object.entries(project.snapshots).reverse())
    })
    expect(digest(after, 'allowBuilds: {unrelated: true, node-pty: true}\n')).toBe(digest(before))
  })

  it('accepts equal selected records across documents but rejects conflicts', () => {
    const before = lockfile({})
    const duplicate = updateLock(before, (project, manager) => {
      manager.packages = {
        'node-pty@1.1.0': Object.fromEntries(
          Object.entries(project.packages['node-pty@1.1.0']).reverse()
        )
      }
    })
    expect(digest(duplicate)).toBe(digest(before))
    const conflict = updateLock(duplicate, (_project, manager) => {
      manager.packages['node-pty@1.1.0'].resolution.integrity = 'sha512-Y29uZmxpY3Q='
    })
    expect(() => digest(conflict)).toThrow(/conflicting.*node-pty/)
  })

  it.each([
    [
      'missing package',
      (project) => {
        delete project.packages['node-pty@1.1.0']
      }
    ],
    [
      'array package',
      (project) => {
        project.packages['node-pty@1.1.0'] = []
      }
    ],
    [
      'missing resolution',
      (project) => {
        delete project.packages['node-pty@1.1.0'].resolution
      }
    ],
    [
      'null integrity',
      (project) => {
        project.packages['node-pty@1.1.0'].resolution.integrity = null
      }
    ],
    [
      'empty integrity',
      (project) => {
        project.packages['node-pty@1.1.0'].resolution.integrity = ''
      }
    ],
    [
      'empty tarball',
      (project) => {
        project.packages['node-pty@1.1.0'].resolution.tarball = ' '
      }
    ],
    [
      'nonfinite metadata',
      (project) => {
        project.packages['node-pty@1.1.0'].unsupported = Number.NaN
      }
    ],
    [
      'infinite metadata',
      (project) => {
        project.packages['node-pty@1.1.0'].unsupported = Number.POSITIVE_INFINITY
      }
    ],
    [
      'local directory source',
      (project) => {
        project.packages['node-pty@1.1.0'].resolution = { type: 'directory', directory: '../mutable' }
      }
    ],
    [
      'local tarball source',
      (project) => {
        project.packages['node-pty@1.1.0'].resolution.tarball = 'file:../mutable.tgz'
      }
    ]
  ])('refuses selected %s without producing a cache identity', (_name, change) => {
    expect(() => digest(updateLock(lockfile({}), change))).toThrow(/metadata|resolution|package/)
  })
})
