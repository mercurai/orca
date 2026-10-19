import { pairedRuntimeConnectionFromOffer } from './paired-runtime-connection'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  removeEnvironment,
  updateEnvironmentFromPairingCode
} from './runtime-environment-store'
import { markEnvironmentUsed } from './runtime-environment-usage'
import { getPreferredPairingOffer, PersistedRuntimeEnvironmentSchema } from './runtime-environments'
import {
  linkVerifiedRuntimeEnvironmentSshAccess,
  prepareRuntimeEnvironmentSshAccessLink,
  prepareRuntimeEnvironmentSshAccessUnlink,
  completeRuntimeEnvironmentSshAccessUnlink,
  cancelRuntimeEnvironmentSshAccessLink
} from './runtime-environment-ssh-access-store'
import { z } from 'zod'

const pairing = {
  v: 2 as const,
  endpoint: 'wss://server.example/runtime',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  deviceToken: 'private-device-token',
  pairedDeviceId: 'paired-client'
}
const tunnel = { sshTargetId: 'target', sshTargetGeneration: 3, localPort: 41000, remotePort: 6768 }
const verifiedPairing = { ...pairing, endpoint: 'ws://127.0.0.1:41000/runtime' }

describe('independent paired runtime SSH access persistence', () => {
  let userDataPath: string
  beforeEach(async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-ssh-access-store-'))
  })
  afterEach(async () => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function seed() {
    return addEnvironmentFromPairingCode(userDataPath, {
      name: 'Independent host',
      pairingCode: encodePairingOffer(pairing),
      now: 100
    })
  }

  async function prepare(
    expectedEnvironment: Awaited<ReturnType<typeof seed>>,
    requestId = 'link-request'
  ) {
    return (await prepareRuntimeEnvironmentSshAccessLink(userDataPath, {
      expectedEnvironment,
      requestId,
      ...tunnel,
      targetFingerprint: 'target-fingerprint'
    }))
  }

  async function link(expectedEnvironment: Awaited<ReturnType<typeof seed>>) {
    return (await linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, {
      expectedEnvironment: (await prepare(expectedEnvironment)),
      requestId: 'link-request',
      verifiedRuntimeId: 'host-runtime',
      verifiedConnection: pairedRuntimeConnectionFromOffer(verifiedPairing),
      tunnel,
      now: 90
    }))
  }

  async function unlink(expectedEnvironment: Awaited<ReturnType<typeof seed>>, now?: number) {
    const prepared = (await prepareRuntimeEnvironmentSshAccessUnlink(userDataPath, {
      expectedEnvironment,
      requestId: 'unlink-request',
      now
    }))
    return (await completeRuntimeEnvironmentSshAccessUnlink(userDataPath, {
      expectedEnvironment: prepared,
      requestId: 'unlink-request'
    }))
  }

  it('adds access to the same host without deployment ownership and restores its original endpoint', async () => {
    const original = await seed()
    const linked = (await link(original))
    expect(listEnvironments(userDataPath)).toEqual([linked])
    expect(linked.id).toBe(original.id)
    expect(linked.name).toBe(original.name)
    expect(linked.createdAt).toBe(original.createdAt)
    expect(linked.runtimeId).toBe('host-runtime')
    expect(linked.pairingRevision).toBe(101)
    expect(linked.endpoints).toHaveLength(2)
    expect(linked.endpoints[0]).toEqual(original.endpoints[0])
    expect(getPreferredPairingOffer(linked)).toEqual(verifiedPairing)

    const unlinked = (await unlink(linked, 80))
    expect(unlinked.id).toBe(original.id)
    expect(unlinked.runtimeId).toBe('host-runtime')
    expect(unlinked.pairingRevision).toBe(102)
    expect(unlinked.endpoints).toEqual(original.endpoints)
    expect(unlinked.preferredEndpointId).toBe(original.preferredEndpointId)
    expect(unlinked.sshAccess).toBeUndefined()
    expect(unlinked.connectionDependency).toBeUndefined()
    expect(listEnvironments(userDataPath)).toEqual([unlinked])
  })

  it('refuses a link whose verification raced with re-pairing', async () => {
    const original = await seed()
    const replaced = await updateEnvironmentFromPairingCode(userDataPath, original.id, {
      pairingCode: encodePairingOffer({ ...pairing, deviceToken: 'replacement-token' }),
      now: 100
    })
    await expect(async () => (await link(original))).rejects.toThrow('changed while SSH access')
    expect(listEnvironments(userDataPath)).toEqual([replaced])
  })

  it('permits unrelated last-used timestamp updates during verification', async () => {
    const original = await seed()
    await markEnvironmentUsed(userDataPath, original.id, { now: 200 })
    expect((await link(original)).lastUsedAt).toBe(200)
  })

  it('keeps orca-environments.json in the shape shipped builds read while SSH access is linked', async () => {
    const original = await seed()
    const shippedEnvelope = z
      .object({
        version: z.literal(1),
        environments: z.array(PersistedRuntimeEnvironmentSchema.strict())
      })
      .strict()
    const readEnvelope = () =>
      JSON.parse(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8'))
    expect(shippedEnvelope.safeParse(readEnvelope()).success).toBe(true)
    const linked = (await link(original))
    expect(shippedEnvelope.safeParse(readEnvelope()).success).toBe(true)
    expect(readEnvelope().environments[0]).toEqual(original)
    await markEnvironmentUsed(userDataPath, linked.id, { now: 500 })
    expect(shippedEnvelope.safeParse(readEnvelope()).success).toBe(true)
    expect(listEnvironments(userDataPath)[0]?.sshAccess).toEqual(linked.sshAccess)
    await unlink(linked)
    expect(shippedEnvelope.safeParse(readEnvelope()).success).toBe(true)
  })

  it.each([
    { ...verifiedPairing, publicKeyB64: Buffer.alloc(32, 2).toString('base64') },
    { ...verifiedPairing, deviceToken: 'another-token' },
    { ...verifiedPairing, pairedDeviceId: 'another-client' }
  ])('refuses a different authenticated host or pairing grant', async (wrongPairing) => {
    const original = await seed()
    const prepared = (await prepare(original))
    await expect(async () =>
      await linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, {
        expectedEnvironment: prepared,
        requestId: 'link-request',
        verifiedRuntimeId: 'host-runtime',
        verifiedConnection: pairedRuntimeConnectionFromOffer(wrongPairing),
        tunnel
      })
    ).rejects.toThrow('did not verify')
    expect(listEnvironments(userDataPath)).toEqual([prepared])
  })

  it('refuses changing a known execution runtime identity', async () => {
    const original = await seed()
    await markEnvironmentUsed(userDataPath, original.id, { runtimeId: 'incumbent-runtime' })
    const current = listEnvironments(userDataPath)[0]
    await expect(async () => (await link(current))).rejects.toThrow('did not verify')
    expect(listEnvironments(userDataPath)[0]).toMatchObject({
      ...current,
      pendingSshAccessOperation: { operation: 'link' }
    })
  })

  it('refuses a second registration of the same execution runtime', async () => {
    const original = await seed()
    const duplicate = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'Duplicate host',
      pairingCode: encodePairingOffer(pairing)
    })
    await markEnvironmentUsed(userDataPath, duplicate.id, { runtimeId: 'host-runtime' })
    const before = listEnvironments(userDataPath)
    await expect(async () => (await link(original))).rejects.toThrow('registered more than once')
    expect(
      listEnvironments(userDataPath).find((entry) => entry.id === original.id)
        ?.pendingSshAccessOperation?.operation
    ).toBe('link')
    expect(listEnvironments(userDataPath).find((entry) => entry.id === duplicate.id)).toEqual(
      before.find((entry) => entry.id === duplicate.id)
    )
  })

  it('prevents ordinary removal or re-pairing from orphaning SSH access', async () => {
    const linked = (await link(await seed()))
    await expect(removeEnvironment(userDataPath, linked.id)).rejects.toThrow('Unlink')
    await expect(
      updateEnvironmentFromPairingCode(userDataPath, linked.id, {
        pairingCode: encodePairingOffer(pairing)
      })
    ).rejects.toThrow('Unlink')
    await expect(async () => (await link(linked))).rejects.toThrow('already has SSH access')
    expect(listEnvironments(userDataPath)).toEqual([linked])
  })

  it('does not let a stale unlink remove a subsequently replaced SSH link', async () => {
    const first = (await link(await seed()))
    const unlinked = (await unlink(first))
    const replacement = (await link(unlinked))
    await expect(async () => (await unlink(first))).rejects.toThrow('changed while SSH access')
    expect(listEnvironments(userDataPath)).toEqual([replacement])
  })

  it('persists retryable link intent before target claim and fences pairing mutations', async () => {
    const original = await seed()
    const prepared = (await prepare(original))
    expect(prepared.endpoints).toEqual(original.endpoints)
    expect(prepared.sshAccess).toBeUndefined()
    expect(listEnvironments(userDataPath)).toEqual([prepared])
    expect(JSON.parse(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8')).version).toBe(1)
    expect((await prepare(original))).toEqual(prepared)
    expect((await prepare(prepared))).toEqual(prepared)
    await expect(async () => (await prepare(prepared, 'other-request'))).rejects.toThrow('Another SSH access')
    await expect(removeEnvironment(userDataPath, prepared.id)).rejects.toThrow('Retry or cancel it')
    await expect(
      updateEnvironmentFromPairingCode(userDataPath, prepared.id, {
        pairingCode: encodePairingOffer(pairing)
      })
    ).rejects.toThrow('Retry or cancel it')
    await expect(
      markEnvironmentUsed(userDataPath, prepared.id, { runtimeId: 'different-runtime' })
    ).rejects.toThrow('cannot change')
  })

  it('completes a matching verified link atomically and handles lost completion responses', async () => {
    const prepared = (await prepare(await seed()))
    const args = {
      expectedEnvironment: prepared,
      requestId: 'link-request',
      verifiedRuntimeId: 'host-runtime',
      verifiedConnection: pairedRuntimeConnectionFromOffer(verifiedPairing),
      tunnel
    }
    await expect(async () =>
      await linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, { ...args, requestId: 'stale-request' })
    ).rejects.toThrow('pending link intent')
    await expect(async () =>
      await linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, {
        ...args,
        tunnel: { ...tunnel, sshTargetGeneration: 4 }
      })
    ).rejects.toThrow('pending link intent')
    const linked = (await linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, args))
    expect(linked.pendingSshAccessOperation).toBeUndefined()
    expect(linked.sshAccess?.requestId).toBe('link-request')
    expect((await linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, args))).toEqual(linked)
    await expect(async () =>
      await linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, {
        ...args,
        verifiedRuntimeId: 'impostor'
      })
    ).rejects.toThrow('completed link')
  })

  it('keeps a durable release intent after restoring the endpoint until exact completion', async () => {
    const linked = (await link(await seed()))
    const prepared = (await prepareRuntimeEnvironmentSshAccessUnlink(userDataPath, {
      expectedEnvironment: linked,
      requestId: 'release-request'
    }))
    expect(prepared.sshAccess).toBeUndefined()
    expect(getPreferredPairingOffer(prepared)).toEqual(pairing)
    expect(prepared.pendingSshAccessOperation).toMatchObject({
      operation: 'unlink',
      requestId: 'release-request',
      sshTargetId: tunnel.sshTargetId,
      sshTargetGeneration: tunnel.sshTargetGeneration
    })
    expect(JSON.parse(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8')).version).toBe(1)
    expect(
      await prepareRuntimeEnvironmentSshAccessUnlink(userDataPath, {
        expectedEnvironment: prepared,
        requestId: 'release-request'
      })
    ).toEqual(prepared)
    await expect(async () =>
      await completeRuntimeEnvironmentSshAccessUnlink(userDataPath, {
        expectedEnvironment: prepared,
        requestId: 'stale-request'
      })
    ).rejects.toThrow('pending unlink intent')
    await expect(removeEnvironment(userDataPath, prepared.id)).rejects.toThrow('Retry or cancel it')
    const finished = (await completeRuntimeEnvironmentSshAccessUnlink(userDataPath, {
      expectedEnvironment: prepared,
      requestId: 'release-request'
    }))
    expect(finished.pendingSshAccessOperation).toBeUndefined()
  })

  it('turns failed verification into durable release intent without ever publishing access', async () => {
    const prepared = (await prepare(await seed()))
    await expect(async () =>
      await cancelRuntimeEnvironmentSshAccessLink(userDataPath, {
        expectedEnvironment: prepared,
        requestId: 'wrong'
      })
    ).rejects.toThrow('pending link intent')
    const cancelling = (await cancelRuntimeEnvironmentSshAccessLink(userDataPath, {
      expectedEnvironment: prepared,
      requestId: 'link-request'
    }))
    expect(cancelling.endpoints).toEqual(prepared.endpoints)
    expect(cancelling.pendingSshAccessOperation?.operation).toBe('unlink')
    expect(cancelling.sshAccess).toBeUndefined()
    expect(
      await cancelRuntimeEnvironmentSshAccessLink(userDataPath, {
        expectedEnvironment: cancelling,
        requestId: 'link-request'
      })
    ).toEqual(cancelling)
    const finished = (await completeRuntimeEnvironmentSshAccessUnlink(userDataPath, {
      expectedEnvironment: cancelling,
      requestId: 'link-request'
    }))
    expect(finished.pendingSshAccessOperation).toBeUndefined()
  })
})
