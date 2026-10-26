import nacl from 'tweetnacl'
import type { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveSharedKey, encrypt, encryptBytes } from '../../../shared/e2ee-crypto'
import { SimulatedMobileE2EEV2Peer } from '../mobile-cloud-relay/simulated-mobile-e2ee-v2-peer'
import { E2EEChannel, type E2EEChannelOptions } from './e2ee-channel'

const channels: E2EEChannel[] = []
afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.destroy()
  }
  vi.useRealTimers()
})

function harness(protocol: 'legacy' | 'v2', beforeReady?: E2EEChannelOptions['beforeReady']) {
  const desktop = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1))
  const client = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2))
  const sent: string[] = []
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (data: string) => sent.push(data) }
  const onReady = vi.fn()
  const onError = vi.fn()
  const text = vi.fn()
  const binary = vi.fn()
  let authorized = true
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the channel reads only OPEN/readyState/bufferedAmount and calls send.
  const channel = new E2EEChannel(ws as unknown as WebSocket, {
    serverSecretKey: desktop.secretKey,
    resolveAuthenticatedDevice: (token) =>
      authorized && token === 'synthetic-token'
        ? {
            deviceId: 'synthetic-device',
            deviceToken: token,
            credentialRevision: 0,
            scope: 'mobile',
            clientId: token,
            callerFingerprint: 'synthetic-fingerprint'
          }
        : null,
    beforeReady,
    onReady,
    onError
  })
  channels.push(channel)
  channel.onMessage(text)
  channel.onBinaryMessage(binary)
  const peer = new SimulatedMobileE2EEV2Peer(client, desktop.publicKey, null)
  const key = deriveSharedKey(client.secretKey, desktop.publicKey)
  const sealText = (value: string) =>
    protocol === 'v2' ? peer.sealText(value) : encrypt(value, key)
  const sealBinary = () =>
    protocol === 'v2'
      ? peer.sealBinary(new Uint8Array([1]))
      : encryptBytes(new Uint8Array([1]), key)
  channel.handleRawMessage(
    JSON.stringify(
      protocol === 'v2'
        ? peer.hello
        : {
            type: 'e2ee_hello',
            publicKeyB64: Buffer.from(client.publicKey).toString('base64')
          }
    )
  )
  if (protocol === 'v2') {
    expect(peer.acceptReady(JSON.parse(sent[0]))).toBe(true)
  }
  const authenticate = () =>
    channel.handleRawMessage(
      sealText(
        JSON.stringify({
          type: 'e2ee_auth',
          deviceToken: 'synthetic-token',
          ...(protocol === 'v2' ? { v: 2, transcriptHashB64: peer.transcriptHashB64 } : {})
        })
      )
    )
  return {
    channel,
    sent,
    onReady,
    onError,
    text,
    binary,
    authenticate,
    sealText,
    sealBinary,
    revoke: () => {
      authorized = false
    }
  }
}

describe.each(['legacy', 'v2'] as const)('%s authentication admission', (protocol) => {
  it('publishes no identity or acknowledgment until the persistence gate resolves', async () => {
    const gate = Promise.withResolvers<void>()
    const h = harness(protocol, () => gate.promise)
    h.authenticate()
    expect(h.sent).toHaveLength(1)
    expect(h.channel.authenticatedDevice).toBeNull()
    expect(h.channel.deviceToken).toBeNull()
    expect(h.onReady).not.toHaveBeenCalled()
    gate.resolve()
    await vi.waitFor(() => expect(h.onReady).toHaveBeenCalledOnce())
    expect(h.sent).toHaveLength(2)
    expect(h.channel.authenticatedDevice?.deviceId).toBe('synthetic-device')
  })

  it.each(['text', 'binary'] as const)(
    'refuses pre-ack %s frames and never accepts a late write',
    async (kind) => {
      const gate = Promise.withResolvers<void>()
      const h = harness(protocol, () => gate.promise)
      h.authenticate()
      h.channel.handleRawMessage(
        kind === 'text' ? h.sealText('{"method":"forbidden"}') : h.sealBinary()
      )
      expect(h.onError).toHaveBeenCalledWith(4001, 'Message before authentication completed')
      gate.resolve()
      await gate.promise
      await Promise.resolve()
      expect(h.text).not.toHaveBeenCalled()
      expect(h.binary).not.toHaveBeenCalled()
      expect(h.onReady).not.toHaveBeenCalled()
      expect(h.sent).toHaveLength(1)
    }
  )

  it('fails closed with a retryable storage failure rather than device revocation', async () => {
    const gate = Promise.withResolvers<void>()
    const h = harness(protocol, () => gate.promise)
    h.authenticate()
    gate.reject(new Error('Synthetic durable write failure'))
    await vi.waitFor(() =>
      expect(h.onError).toHaveBeenCalledWith(4001, 'Device registry unavailable')
    )
    expect(h.onReady).not.toHaveBeenCalled()
    expect(h.channel.authenticatedDevice).toBeNull()
    expect(h.channel.deviceToken).toBeNull()
  })

  it.each(['destroy', 'timeout', 'revoke'] as const)(
    'fences completion after %s without relying on onError cleanup',
    async (edge) => {
      vi.useFakeTimers()
      const gate = Promise.withResolvers<void>()
      const h = harness(protocol, () => gate.promise)
      h.authenticate()
      if (edge === 'destroy') {
        h.channel.destroy()
      } else if (edge === 'revoke') {
        h.revoke()
      } else {
        await vi.advanceTimersByTimeAsync(10_000)
      }
      gate.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.onReady).not.toHaveBeenCalled()
      expect(h.channel.authenticatedDevice).toBeNull()
      if (edge === 'timeout') {
        expect(h.onError).toHaveBeenCalledWith(4002, 'E2EE handshake timeout')
      }
    }
  )

  it('keeps an existing void callback and no-gate acknowledgment synchronous', () => {
    const h = harness(protocol)
    h.authenticate()
    expect(h.onReady).toHaveBeenCalledOnce()
    expect(h.sent).toHaveLength(2)
  })
})
