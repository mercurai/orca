import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  removeEnvironment,
  updateEnvironmentFromPairingCode
} from './runtime-environment-store'
import { markEnvironmentUsedDetached } from './runtime-environment-usage-detached'

// Every call into the async lane, so a test can wait for the whole retry chain to finish.
const writes = vi.hoisted(() => [] as Promise<unknown>[])

vi.mock('./secure-file-async-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secure-file-async-write')>()
  return {
    ...actual,
    writeSecureFileAsync: (...args: Parameters<typeof actual.writeSecureFileAsync>) => {
      const write = actual.writeSecureFileAsync(...args)
      writes.push(write)
      return write
    }
  }
})

const directories: string[] = []

afterEach(async () => {
  await idle()
  writes.length = 0
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function idle(): Promise<void> {
  for (;;) {
    const seen = writes.length
    await Promise.allSettled(writes)
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (writes.length === seen) {
      return
    }
  }
}

function pairingCode(endpoint = 'ws://127.0.0.1:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

function seededStore(): { userDataPath: string; id: string } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-env-usage-detached-'))
  directories.push(userDataPath)
  const env = addEnvironmentFromPairingCode(userDataPath, {
    name: 'dev box',
    pairingCode: pairingCode()
  })
  return { userDataPath, id: env.id }
}

it('persists the runtime id off the calling thread and throws for an unknown environment', async () => {
  const { userDataPath, id } = seededStore()

  markEnvironmentUsedDetached(userDataPath, id, { runtimeId: 'runtime-1' })
  await idle()

  expect(listEnvironments(userDataPath)[0]).toMatchObject({ runtimeId: 'runtime-1' })
  expect(listEnvironments(userDataPath)[0]!.lastUsedAt).toBeTypeOf('number')
  expect(() => markEnvironmentUsedDetached(userDataPath, 'no-such-env')).toThrow(
    'Unknown environment'
  )
})

it('turns ten usage stamps in one minute into one write', async () => {
  const { userDataPath, id } = seededStore()

  for (let call = 0; call < 10; call += 1) {
    markEnvironmentUsedDetached(userDataPath, id, { runtimeId: 'runtime-1' })
  }
  await idle()

  expect(writes).toHaveLength(1)
})

it('folds a call that lands mid-write into one follow-up stamp carrying the newest ids', async () => {
  const { userDataPath, id } = seededStore()

  markEnvironmentUsedDetached(userDataPath, id, { runtimeId: 'runtime-1' })
  markEnvironmentUsedDetached(userDataPath, id, { pairedDeviceId: 'device-9' })
  markEnvironmentUsedDetached(userDataPath, id, { runtimeId: 'runtime-2' })
  await idle()

  expect(writes).toHaveLength(2)
  expect(listEnvironments(userDataPath)[0]).toMatchObject({
    runtimeId: 'runtime-2',
    pairedDeviceId: 'device-9'
  })
})

it('does not resurrect an environment removed while the stamp was writing', async () => {
  const { userDataPath, id } = seededStore()

  markEnvironmentUsedDetached(userDataPath, id, { runtimeId: 'runtime-1' })
  removeEnvironment(userDataPath, id)
  await idle()

  expect(listEnvironments(userDataPath)).toEqual([])
})

it('keeps a re-pair made while the stamp was writing, and the stamp lands on the next attempt', async () => {
  const { userDataPath, id } = seededStore()

  markEnvironmentUsedDetached(userDataPath, id, { runtimeId: 'runtime-1' })
  const repaired = updateEnvironmentFromPairingCode(userDataPath, id, {
    pairingCode: pairingCode('ws://192.0.2.10:6768')
  })
  await idle()

  const [stored] = listEnvironments(userDataPath)
  expect(stored).toMatchObject({
    pairingRevision: repaired.pairingRevision,
    runtimeId: 'runtime-1'
  })
  expect(stored!.lastUsedAt).toBeTypeOf('number')
  expect(writes).toHaveLength(2)
})
