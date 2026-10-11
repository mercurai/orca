import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { isKeepaliveFrame } from '../../../shared/runtime-rpc-envelope'
import type { PairedE2EEClientHandshake } from '../../../shared/paired-e2ee-client-handshake'
import { WEB_RUNTIME_CLIENT_CAPABILITIES } from './web-runtime-client-capabilities'
import { createWebRuntimeUnauthorizedError } from './web-runtime-client-error'
import type { WebRuntimeTransportSubscription } from './web-runtime-subscription-contract'

export type WebRuntimeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'auth-failed'

export type WebRuntimePendingRequest = {
  method: string
  resolve: (response: RuntimeRpcResponse<unknown>) => void
  reject: (error: Error) => void
  timeout: number
}

type WebRuntimeConnectionFrameContext = {
  getState: () => WebRuntimeConnectionState
  getHandshake: () => PairedE2EEClientHandshake | null
  getSocket: () => WebSocket | null
  pending: Map<string, WebRuntimePendingRequest>
  subscriptions: Map<string, WebRuntimeTransportSubscription>
  sendAuth: (handshake: PairedE2EEClientHandshake) => void
  setConnected: () => void
  setAuthFailed: () => void
  rejectUnauthorized: (error: Error) => void
  notifyUnauthorized: () => void
}

export function sealWebRuntimeAuth(
  handshake: PairedE2EEClientHandshake,
  deviceToken: string
): Promise<string> {
  return handshake.sealAuth(
    { kind: 'token', deviceToken },
    { clientCapabilities: WEB_RUNTIME_CLIENT_CAPABILITIES }
  )
}

export async function routeWebRuntimeConnectionFrame(
  rawData: unknown,
  sourceWs: WebSocket | undefined,
  context: WebRuntimeConnectionFrameContext
): Promise<void> {
  const raw = typeof rawData === 'string' ? rawData : null
  const handshake = context.getHandshake()
  if (context.getState() === 'handshaking') {
    if (raw === null || !handshake) {
      return
    }
    // The authenticated control frame is encrypted, so anything but a ready is decrypted below.
    if (handshake.acceptReadyText(raw) === 'accepted') {
      context.sendAuth(handshake)
      return
    }
    const plaintext = handshake.channel.openText(raw)
    if (plaintext === null) {
      return
    }
    // Malformed handshake payloads are ignored; the server closes on timeout.
    const reply = handshake.classifyAuthReply(plaintext)
    if (reply.kind === 'authenticated') {
      context.setConnected()
    } else if (
      reply.kind === 'rejected' &&
      (reply.type === 'e2ee_error' || reply.errorCode === 'unauthorized')
    ) {
      const error = createWebRuntimeUnauthorizedError()
      context.setAuthFailed()
      context.rejectUnauthorized(error)
      context.notifyUnauthorized()
      context.getSocket()?.close()
    }
    return
  }

  if (context.getState() !== 'connected' || !handshake) {
    return
  }
  if (raw === null) {
    const encrypted = await websocketPayloadToUint8(rawData)
    if (sourceWs && context.getSocket() !== sourceWs) {
      return
    }
    if (!encrypted) {
      return
    }
    const plaintext = handshake.channel.openBinary(encrypted)
    if (!plaintext) {
      return
    }
    for (const subscription of context.subscriptions.values()) {
      subscription.callbacks.onBinary?.(plaintext)
    }
    return
  }

  const plaintext = handshake.channel.openText(raw)
  if (plaintext === null) {
    return
  }
  let response: RuntimeRpcResponse<unknown> | Record<string, unknown>
  try {
    response = JSON.parse(plaintext) as RuntimeRpcResponse<unknown> | Record<string, unknown>
  } catch {
    return
  }
  if (isKeepaliveFrame(response) || !('id' in response) || typeof response.id !== 'string') {
    return
  }
  if (isRuntimeFailureResponse(response) && response.error.code === 'unauthorized') {
    const error = createWebRuntimeUnauthorizedError()
    context.setAuthFailed()
    context.rejectUnauthorized(error)
    context.notifyUnauthorized()
    context.getSocket()?.close()
    return
  }

  const subscription = context.subscriptions.get(response.id)
  if (subscription) {
    const subscriptionResponse = response as RuntimeRpcResponse<unknown>
    if (subscriptionResponse.ok === false) {
      context.subscriptions.delete(response.id)
    }
    subscription.callbacks.onResponse(subscriptionResponse)
    if (subscriptionResponse.ok && isEndResult(subscriptionResponse.result)) {
      context.subscriptions.delete(response.id)
      subscription.callbacks.onClose?.()
    }
    return
  }
  const pending = context.pending.get(response.id)
  if (!pending) {
    return
  }
  context.pending.delete(response.id)
  window.clearTimeout(pending.timeout)
  pending.resolve(response as RuntimeRpcResponse<unknown>)
}

function isRuntimeFailureResponse(
  response: RuntimeRpcResponse<unknown> | Record<string, unknown>
): response is RuntimeRpcResponse<unknown> & { ok: false } {
  return (
    'ok' in response &&
    response.ok === false &&
    'error' in response &&
    !!response.error &&
    typeof response.error === 'object' &&
    'code' in response.error
  )
}

function isEndResult(value: unknown): value is { type: 'end' } {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'end'
}

async function websocketPayloadToUint8(
  value: unknown
): Promise<Uint8Array<ArrayBufferLike> | null> {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer())
  }
  return null
}
