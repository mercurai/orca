// The async store publishes two files (runtimes, then compatibility metadata) with awaits between
// them; the sync store never yielded there. These pin what a reader may see in the gaps.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as BoundedSecureJsonFile from './bounded-secure-json-file'
import type { EphemeralVmRuntimeRecord } from './ephemeral-vm-runtimes'

const afterPublish = vi.hoisted((): { run: (() => void) | null } => ({ run: null }))

// Why: every runtime/metadata publish goes through this writer, so each settled call is a gap.
vi.mock('./bounded-secure-json-file', async (importOriginal) => {
  const actual = await importOriginal<typeof BoundedSecureJsonFile>()
  return {
    writeSecureJsonFileWithinLimitAsync: async (
      ...args: Parameters<typeof actual.writeSecureJsonFileWithinLimitAsync>
    ) => {
      await actual.writeSecureJsonFileWithinLimitAsync(...args)
      afterPublish.run?.()
    }
  }
})

import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus,
  upsertEphemeralVmRuntime
} from './ephemeral-vm-runtime-store'

const dirs: string[] = []

afterEach(() => {
  afterPublish.run = null
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function userDataPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-vm-write-order-'))
  dirs.push(dir)
  return dir
}

function record(id: string, provisionedRoot: boolean): EphemeralVmRuntimeRecord {
  const recipeId = `${id}-recipe`
  const connection = {
    type: 'ssh' as const,
    projectRoot: `/workspace/${id}`,
    target: { label: id, host: `${id}.example.com`, port: 22, username: 'developer' }
  }
  const userData = { resourceId: `${id}-resource` }
  const recipeResult: EphemeralVmRuntimeRecord['recipeResult'] = provisionedRoot
    ? { schemaVersion: 2, checkoutMode: 'provisioned-root', connection, userData }
    : { schemaVersion: 1, connection, userData }
  return {
    id,
    recipeId,
    recipe: {
      id: recipeId,
      name: id,
      create: './create.sh',
      destroy: './destroy.sh',
      ...(provisionedRoot ? { checkoutMode: 'provisioned-root' as const } : {})
    },
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: provisionedRoot ? 2_000 : 1_000,
    updatedAt: provisionedRoot ? 2_000 : 1_000,
    recipeResult
  }
}

it('never shows a reader a provisioned-root runtime without its metadata', async () => {
  const path = userDataPath()
  const provisioned = record('provisioned-runtime', true)
  const seen: (EphemeralVmRuntimeRecord | undefined)[] = []
  afterPublish.run = () => {
    seen.push(listEphemeralVmRuntimes(path).find((entry) => entry.id === provisioned.id))
  }

  await upsertEphemeralVmRuntime(path, provisioned)

  // Absent (not yet published) is fine; present means whole, never an ordinary-looking record.
  for (const entry of seen.filter((value) => value !== undefined)) {
    expect(entry).toEqual(provisioned)
  }
  expect(seen.at(-1)).toEqual(provisioned)
})

it('keeps a status update and an upsert of another runtime when neither is awaited first', async () => {
  const path = userDataPath()
  await upsertEphemeralVmRuntime(path, record('ordinary-runtime', false))

  const update = updateEphemeralVmRuntimeStatus(path, 'ordinary-runtime', {
    status: 'cleanup_failed',
    cleanupStatus: 'failed'
  })
  const upsert = upsertEphemeralVmRuntime(path, record('provisioned-runtime', true))
  await Promise.all([update, upsert])

  const runtimes = listEphemeralVmRuntimes(path)
  expect(runtimes.map((entry) => entry.id).sort()).toEqual([
    'ordinary-runtime',
    'provisioned-runtime'
  ])
  expect(runtimes.find((entry) => entry.id === 'ordinary-runtime')?.status).toBe('cleanup_failed')
})
