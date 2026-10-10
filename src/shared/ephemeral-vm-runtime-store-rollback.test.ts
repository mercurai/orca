import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getEphemeralVmRuntimeFeatureStorePath,
  featureIdentity,
  restoreRuntimeFeatureList,
  MAX_EPHEMERAL_VM_RUNTIME_FEATURE_STORE_FILE_BYTES
} from './ephemeral-vm-runtime-feature-store'
import {
  EphemeralVmRuntimeStoreError,
  getEphemeralVmRuntimeStorePath,
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus,
  upsertEphemeralVmRuntime
} from './ephemeral-vm-runtime-store'
import {
  EphemeralVmRuntimeStoreSchema,
  RollbackEphemeralVmRuntimeStoreSchema,
  type EphemeralVmRuntimeRecord
} from './ephemeral-vm-runtimes'
import type * as RunProcess from './child-process/run-process'
import { expectNoSyncSpawnOnWin32 } from './windows-spawn-test-harness'

// Why: real spawns stay the default; the win32 case swaps in stubs to count synchronous ones.
vi.mock('./child-process/run-process', async (importOriginal) => {
  const actual = await importOriginal<typeof RunProcess>()
  return {
    ...actual,
    runProcess: vi.fn(actual.runProcess),
    runProcessSync: vi.fn(actual.runProcessSync)
  }
})

function runtimeRecord(
  overrides: Partial<EphemeralVmRuntimeRecord> = {}
): EphemeralVmRuntimeRecord {
  return {
    id: 'ordinary-runtime',
    recipeId: 'ordinary-recipe',
    recipe: {
      id: 'ordinary-recipe',
      name: 'Ordinary VM',
      create: './create.sh',
      destroy: './destroy.sh'
    },
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1_000,
    updatedAt: 1_000,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/ordinary',
        target: {
          label: 'Ordinary VM',
          host: 'ordinary.example.com',
          port: 22,
          username: 'developer'
        }
      },
      userData: { resourceId: 'ordinary-resource' }
    },
    ...overrides
  }
}

function provisionedRootRecord(): EphemeralVmRuntimeRecord {
  return runtimeRecord({
    id: 'provisioned-runtime',
    recipeId: 'provisioned-recipe',
    recipe: {
      id: 'provisioned-recipe',
      name: 'Provisioned VM',
      create: './create.sh',
      destroy: './destroy.sh',
      checkoutMode: 'provisioned-root'
    },
    createdAt: 2_000,
    updatedAt: 2_000,
    recipeResult: {
      schemaVersion: 2,
      checkoutMode: 'provisioned-root',
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/provisioned',
        target: {
          label: 'Provisioned VM',
          host: 'provisioned.example.com',
          port: 22,
          username: 'developer'
        }
      },
      userData: { resourceId: 'provisioned-resource' }
    }
  })
}

describe('ephemeral VM runtime store rollback projection', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeUserDataPath(): string {
    const path = mkdtempSync(join(tmpdir(), 'orca-vm-rollback-store-'))
    tempDirs.push(path)
    return path
  }

  it('keeps a mixed store readable by the rollback schema and restores new fields', async () => {
    const userDataPath = makeUserDataPath()
    const ordinary = await upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
    const provisioned = await upsertEphemeralVmRuntime(userDataPath, provisionedRootRecord())

    const persisted = JSON.parse(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8'))
    expect(RollbackEphemeralVmRuntimeStoreSchema.parse(persisted).runtimes).toHaveLength(2)
    expect(persisted.runtimes[0].recipe).not.toHaveProperty('checkoutMode')
    expect(persisted.runtimes[0].recipeResult).toMatchObject({ schemaVersion: 1 })
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([provisioned, ordinary])
  })

  it('keeps ordinary v1 bytes and sidecar behavior unchanged', async () => {
    const userDataPath = makeUserDataPath()
    const runtime = runtimeRecord()
    const expected = JSON.stringify(
      EphemeralVmRuntimeStoreSchema.parse({ version: 1, runtimes: [runtime] })
    )

    await upsertEphemeralVmRuntime(userDataPath, runtime)

    expect(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8')).toBe(expected)
    expect(existsSync(getEphemeralVmRuntimeFeatureStorePath(userDataPath))).toBe(false)
  })

  it('projects an explicit ordinary checkout mode without changing its current meaning', async () => {
    const userDataPath = makeUserDataPath()
    const runtime = runtimeRecord({
      recipe: { ...runtimeRecord().recipe!, checkoutMode: 'orca-worktree' }
    })

    await upsertEphemeralVmRuntime(userDataPath, runtime)

    const persisted = JSON.parse(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8'))
    expect(RollbackEphemeralVmRuntimeStoreSchema.safeParse(persisted).success).toBe(true)
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([runtime])
  })

  it('does not rewrite unchanged features when runtime order differs from feature order', async () => {
    const userDataPath = makeUserDataPath()
    const older = {
      ...provisionedRootRecord(),
      id: 'a-runtime',
      recipeId: 'a-recipe',
      createdAt: 1_000
    }
    const newer = {
      ...provisionedRootRecord(),
      id: 'z-runtime',
      recipeId: 'z-recipe',
      createdAt: 2_000
    }
    await upsertEphemeralVmRuntime(userDataPath, older)
    await upsertEphemeralVmRuntime(userDataPath, newer)
    const featurePath = getEphemeralVmRuntimeFeatureStorePath(userDataPath)
    const oldTimestamp = new Date('2020-01-01T00:00:00.000Z')
    utimesSync(featurePath, oldTimestamp, oldTimestamp)
    const beforeBytes = readFileSync(featurePath, 'utf8')
    const beforeMtime = statSync(featurePath).mtimeMs

    await updateEphemeralVmRuntimeStatus(userDataPath, newer.id, { status: 'suspended' })

    expect(readFileSync(featurePath, 'utf8')).toBe(beforeBytes)
    expect(statSync(featurePath).mtimeMs).toBe(beforeMtime)
  })

  it('reads current-main poisoned bytes and migrates them on the next mutation', async () => {
    const userDataPath = makeUserDataPath()
    const poisoned = {
      version: 1 as const,
      runtimes: [provisionedRootRecord(), runtimeRecord()]
    }
    writeFileSync(
      getEphemeralVmRuntimeStorePath(userDataPath),
      JSON.stringify(EphemeralVmRuntimeStoreSchema.parse(poisoned))
    )

    expect(listEphemeralVmRuntimes(userDataPath)).toEqual(poisoned.runtimes)
    await updateEphemeralVmRuntimeStatus(userDataPath, 'ordinary-runtime', { status: 'suspended' })
    expect(
      RollbackEphemeralVmRuntimeStoreSchema.safeParse(
        JSON.parse(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8'))
      ).success
    ).toBe(true)
  })

  it('carries rollback lifecycle mutations through re-upgrade', async () => {
    const userDataPath = makeUserDataPath()
    await upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
    await upsertEphemeralVmRuntime(userDataPath, provisionedRootRecord())
    const path = getEphemeralVmRuntimeStorePath(userDataPath)
    const rollback = RollbackEphemeralVmRuntimeStoreSchema.parse(
      JSON.parse(readFileSync(path, 'utf8'))
    )
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        runtimes: rollback.runtimes.map((runtime) =>
          runtime.id === 'provisioned-runtime'
            ? { ...runtime, status: 'cleaned', cleanupStatus: 'succeeded', updatedAt: 3_000 }
            : { ...runtime, status: 'suspended', updatedAt: 3_000 }
        )
      })
    )

    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([
      expect.objectContaining({
        id: 'provisioned-runtime',
        status: 'cleaned',
        cleanupStatus: 'succeeded',
        recipe: expect.objectContaining({ checkoutMode: 'provisioned-root' }),
        recipeResult: expect.objectContaining({
          schemaVersion: 2,
          checkoutMode: 'provisioned-root'
        })
      }),
      expect.objectContaining({ id: 'ordinary-runtime', status: 'suspended' })
    ])
  })

  it('preserves unknown feature records while valid siblings remain usable', async () => {
    const userDataPath = makeUserDataPath()
    await upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
    await upsertEphemeralVmRuntime(userDataPath, provisionedRootRecord())
    const featurePath = getEphemeralVmRuntimeFeatureStorePath(userDataPath)
    const featureStore = JSON.parse(readFileSync(featurePath, 'utf8'))
    const futureRecord = { kind: 'future-runtime-feature', payload: { version: 3 } }
    writeFileSync(
      featurePath,
      JSON.stringify({ ...featureStore, records: [...featureStore.records, futureRecord] })
    )

    expect(listEphemeralVmRuntimes(userDataPath)).toHaveLength(2)
    await updateEphemeralVmRuntimeStatus(userDataPath, 'ordinary-runtime', { status: 'suspended' })
    expect(JSON.parse(readFileSync(featurePath, 'utf8')).records).toContainEqual(futureRecord)
  })

  it.each([
    ['malformed', '{ nope'],
    ['future-version', JSON.stringify({ version: 2, records: [] })]
  ])(
    'preserves an unreadable %s feature sidecar while keeping v1 records accessible',
    async (_, bytes) => {
      const userDataPath = makeUserDataPath()
      await upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
      await upsertEphemeralVmRuntime(userDataPath, provisionedRootRecord())
      const featurePath = getEphemeralVmRuntimeFeatureStorePath(userDataPath)
      writeFileSync(featurePath, bytes)

      expect(listEphemeralVmRuntimes(userDataPath).map((runtime) => runtime.id)).toEqual([
        'provisioned-runtime',
        'ordinary-runtime'
      ])
      await updateEphemeralVmRuntimeStatus(userDataPath, 'ordinary-runtime', { status: 'suspended' })
      expect(readFileSync(featurePath, 'utf8')).toBe(bytes)
    }
  )

  it('publishes lifecycle authority before an unreadable feature companion', async () => {
    const userDataPath = makeUserDataPath()
    await upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
    const featurePath = getEphemeralVmRuntimeFeatureStorePath(userDataPath)
    writeFileSync(featurePath, '{}')
    truncateSync(featurePath, MAX_EPHEMERAL_VM_RUNTIME_FEATURE_STORE_FILE_BYTES + 1)
    await expect(upsertEphemeralVmRuntime(userDataPath, provisionedRootRecord())).rejects.toThrow(
      EphemeralVmRuntimeStoreError
    )
    const persisted = JSON.parse(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8'))
    expect(RollbackEphemeralVmRuntimeStoreSchema.parse(persisted).runtimes).toHaveLength(2)
    expect(readFileSync(featurePath, 'utf8')).toHaveLength(
      MAX_EPHEMERAL_VM_RUNTIME_FEATURE_STORE_FILE_BYTES + 1
    )
    expect(listEphemeralVmRuntimes(userDataPath).map((runtime) => runtime.id)).toEqual([
      'provisioned-runtime',
      'ordinary-runtime'
    ])
  })

  it('spawns no synchronous process on win32 when writing the feature companion', async () => {
    const userDataPath = makeUserDataPath()

    await expectNoSyncSpawnOnWin32(async () => {
      await upsertEphemeralVmRuntime(userDataPath, provisionedRootRecord())
    })

    expect(existsSync(getEphemeralVmRuntimeFeatureStorePath(userDataPath))).toBe(true)
  })
})

describe('runtime feature restoration scaling', () => {
  it('indexes feature identities once and preserves unmatched runtime references', () => {
    let reads = 0
    const runtimes = Array.from({ length: 1000 }, (_, i) => runtimeRecord({ id: `runtime-${i}` }))
    const features = runtimes.map((runtime) => ({
      get id() {
        reads++
        return runtime.id
      },
      recipeId: runtime.recipeId,
      createdAt: runtime.createdAt,
      recipeCheckoutMode: 'provisioned-root' as const
    }))
    for (const runtime of runtimes) {
      expect(
        features.find((entry) => featureIdentity(entry) === featureIdentity(runtime))
      ).toBeDefined()
    }
    expect(reads).toBe(500_500)
    reads = 0
    const restored = restoreRuntimeFeatureList(runtimes, features)
    expect(reads).toBe(1000)
    expect(restored.map((runtime) => runtime.id)).toEqual(runtimes.map((runtime) => runtime.id))
    expect(restored.every((runtime) => runtime.recipe?.checkoutMode === 'provisioned-root')).toBe(
      true
    )
    expect(restoreRuntimeFeatureList([runtimes[0]], [])[0]).toBe(runtimes[0])
    const first = { ...features[0], recipeCheckoutMode: 'orca-worktree' as const }
    expect(
      restoreRuntimeFeatureList([runtimes[0]], [first, features[0]])[0].recipe?.checkoutMode
    ).toBe('orca-worktree')
  })
})
