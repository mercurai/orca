import { mkdtempSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const fsyncMockState = vi.hoisted(() => ({
  directoryDescriptor: -1,
  directoryErrorCode: 'EINVAL'
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    closeSync: (descriptor: number) => {
      if (descriptor !== fsyncMockState.directoryDescriptor) {
        actual.closeSync(descriptor)
      }
    },
    fsyncSync: (descriptor: number) => {
      if (descriptor === fsyncMockState.directoryDescriptor) {
        throw Object.assign(new Error('directory fsync failed'), {
          code: fsyncMockState.directoryErrorCode
        })
      }
      return actual.fsyncSync(descriptor)
    },
    openSync: (path: string, flags: string | number) =>
      actual.statSync(path).isDirectory()
        ? fsyncMockState.directoryDescriptor
        : actual.openSync(path, flags)
  }
})

import { bestEffortFsyncDirectorySync } from '../../shared/secure-file'
import {
  clearArtifactCreateIntents,
  getOrCreateArtifactCreateIntent
} from './artifact-create-intent-store'

const createdPaths: string[] = []

afterEach(() => {
  fsyncMockState.directoryErrorCode = 'EINVAL'
  for (const path of createdPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

it('skips directory fsync on Windows and propagates I/O failures elsewhere', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-artifact-directory-fsync-eio-'))
  createdPaths.push(directory)
  fsyncMockState.directoryErrorCode = 'EIO'

  const fsyncDirectory = (): void => bestEffortFsyncDirectorySync(directory)
  if (process.platform === 'win32') {
    expect(fsyncDirectory).not.toThrow()
  } else {
    expect(fsyncDirectory).toThrow('directory fsync failed')
  }
})

it('keeps artifact recovery intents usable when directory fsync is unsupported', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-artifact-directory-fsync-'))
  createdPaths.push(userDataPath)

  await expect(
    getOrCreateArtifactCreateIntent(
      'local-profile',
      userDataPath,
      '/repo/report.html',
      {
        cloudUserId: 'user-a',
        cloudProfileId: 'profile-a',
        cloudOrganizationId: 'org-a',
        apiOrigin: 'https://share.onorca.dev'
      },
      'key-a',
      { content: 'hello', contentType: 'text/markdown', fileName: 'report.md' }
    )
  ).resolves.toBeDefined()
  expect(() => clearArtifactCreateIntents('local-profile', userDataPath)).not.toThrow()
})
