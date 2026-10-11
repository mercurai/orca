import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyToBase64
} from './e2ee'
import type { DirectE2EEFraming } from './direct-e2ee-framing-policy'
import { MobileE2EEV2ClientSession } from './mobile-e2ee-v2-client-session'
import {
  MobileE2EEAuthenticationError,
  MobileE2EEV2PhysicalChannel
} from './mobile-e2ee-v2-physical-channel'
import type { ConnectionLogEmitter } from './types'
import { websocketPayloadToUint8 } from './websocket-payload-bytes'

export type DirectSocketFramingEvents = {
  onReadyAccepted: () => void
  onAuthenticated: () => void
  onText: (plaintext: string) => void
  onBinary: (plaintext: Uint8Array) => void
  onAuthRejected: () => void
  onProtocolError: (error: Error) => void
}

export type DirectSocketFraming = {
  // Throws when the hello cannot be written.
  start: () => void
  handleInbound: (raw: unknown) => void
  // false = not ready yet; throws when the socket write fails.
  sendText: (plaintext: string) => boolean
  dispose: () => void
}

export function createDirectSocketFraming(args: {
  framing: DirectE2EEFraming
  mayUseLegacy: () => boolean
  socket: WebSocket
  serverPublicKey: Uint8Array
  serverPublicKeyB64: string
  deviceToken: string
  emitLog: ConnectionLogEmitter
  events: DirectSocketFramingEvents
}): DirectSocketFraming {
  return args.framing === 'v2' ? createV2Framing(args) : createLegacyFraming(args)
}

function createV2Framing(args: Parameters<typeof createDirectSocketFraming>[0]) {
  const { events } = args
  let authenticated = false
  const channel = new MobileE2EEV2PhysicalChannel({
    session: MobileE2EEV2ClientSession.create({
      desktopPublicKeyB64: args.serverPublicKeyB64,
      transport: 'direct'
    }),
    socket: args.socket,
    deviceToken: args.deviceToken,
    decodeBinary: websocketPayloadToUint8,
    onReadyAccepted: () => {
      args.emitLog('success', 'Received e2ee_ready (v2)', 'Sending device token')
      events.onReadyAccepted()
    },
    onAuthenticated: () => {
      authenticated = true
      events.onAuthenticated()
    },
    onText: events.onText,
    onBinary: events.onBinary,
    // Why: a handshake failure (a re-keyed host, or a legacy e2ee_ready answering a v2
    // hello) counts against the auth retry budget, as a legacy 4001 did — never a downgrade.
    onError: (error) =>
      error instanceof MobileE2EEAuthenticationError || !authenticated
        ? events.onAuthRejected()
        : events.onProtocolError(error)
  })
  return {
    start: () => {
      channel.start()
      args.emitLog('info', 'Sent e2ee_hello (v2)', 'Awaiting server e2ee_ready')
    },
    handleInbound: (raw: unknown) => void channel.handleMessage(raw),
    sendText: (plaintext: string) => channel.sendText(plaintext),
    dispose: () => channel.dispose()
  }
}

function createLegacyFraming(args: Parameters<typeof createDirectSocketFraming>[0]) {
  const { events, socket } = args
  let sharedKey: Uint8Array | null = null
  let authenticated = false
  let disposed = false

  const sendText = (plaintext: string): boolean => {
    if (!sharedKey) {
      return false
    }
    socket.send(encrypt(plaintext, sharedKey))
    return true
  }

  const handleHandshake = (raw: string): void => {
    try {
      const message = JSON.parse(raw) as { type?: unknown }
      if (message.type === 'e2ee_ready') {
        if (!args.mayUseLegacy()) {
          events.onProtocolError(new Error('host is latched to E2EE v2; refusing legacy auth'))
          return
        }
        args.emitLog('success', 'Received e2ee_ready', 'Sending device token')
        events.onReadyAccepted()
        try {
          sendText(JSON.stringify({ type: 'e2ee_auth', deviceToken: args.deviceToken }))
        } catch (error) {
          events.onProtocolError(error instanceof Error ? error : new Error(String(error)))
        }
        return
      }
    } catch {
      // The authenticated handshake messages are encrypted.
    }
    const plaintext = sharedKey ? decrypt(raw, sharedKey) : null
    if (plaintext === null) {
      return
    }
    try {
      const message = JSON.parse(plaintext) as {
        type?: unknown
        ok?: unknown
        error?: { code?: unknown }
      }
      if (message.type === 'e2ee_authenticated') {
        authenticated = true
        events.onAuthenticated()
      } else if (
        message.type === 'e2ee_error' ||
        (message.ok === false && message.error?.code === 'unauthorized')
      ) {
        console.log('[net] e2ee auth FAILED', { msgType: message.type, error: message.error })
        events.onAuthRejected()
      }
    } catch {
      // Ignore malformed handshake payloads.
    }
  }

  const handleInbound = async (raw: unknown): Promise<void> => {
    if (typeof raw === 'string') {
      if (!authenticated) {
        handleHandshake(raw)
        return
      }
      const plaintext = sharedKey ? decrypt(raw, sharedKey) : null
      if (plaintext !== null) {
        events.onText(plaintext)
      }
      return
    }
    if (!authenticated) {
      return
    }
    const bytes = await websocketPayloadToUint8(raw)
    const key = sharedKey
    if (disposed || !bytes || !key) {
      return
    }
    const plaintext = decryptBytes(bytes, key)
    if (plaintext) {
      events.onBinary(plaintext)
    }
  }

  return {
    start: () => {
      if (!args.mayUseLegacy()) {
        throw new Error('host is latched to E2EE v2; refusing legacy hello')
      }
      const ephemeral = generateKeyPair()
      socket.send(
        JSON.stringify({ type: 'e2ee_hello', publicKeyB64: publicKeyToBase64(ephemeral.publicKey) })
      )
      args.emitLog('info', 'Sent e2ee_hello', 'Awaiting server e2ee_ready')
      sharedKey = deriveSharedKey(ephemeral.secretKey, args.serverPublicKey)
    },
    handleInbound: (raw: unknown) => void handleInbound(raw),
    sendText,
    dispose: () => {
      disposed = true
      sharedKey = null
    }
  }
}
