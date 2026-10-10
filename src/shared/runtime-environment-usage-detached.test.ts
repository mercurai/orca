import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { encodePairingOffer } from './pairing'
import { settlePathWritesForTests } from './path-write-serializer'
import { addEnvironmentFromPairingCode, listEnvironments } from './runtime-environment-store'
import { markEnvironmentUsedDetached } from './runtime-environment-usage-detached'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function seededStore(): { userDataPath: string; id: string } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-env-usage-detached-'))
  directories.push(userDataPath)
  const pairingCode = encodePairingOffer({
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
  const env = addEnvironmentFromPairingCode(userDataPath, { name: 'dev box', pairingCode })
  return { userDataPath, id: env.id }
}

it('persists the runtime id without blocking, once, and throws for an unknown environment', async () => {
  const { userDataPath, id } = seededStore()

  markEnvironmentUsedDetached(userDataPath, id, { runtimeId: 'runtime-1' })
  // A response landing while the first write is still in flight must not queue a second rewrite.
  markEnvironmentUsedDetached(userDataPath, id, { runtimeId: 'runtime-1' })
  await settlePathWritesForTests()

  expect(listEnvironments(userDataPath)[0]).toMatchObject({ runtimeId: 'runtime-1' })
  expect(listEnvironments(userDataPath)[0]!.lastUsedAt).toBeTypeOf('number')
  expect(() => markEnvironmentUsedDetached(userDataPath, 'no-such-env')).toThrow(
    'Unknown environment'
  )
})
