import type { PairingOffer } from '../../shared/pairing'
import { describeRuntimeCompatBlock, evaluateRuntimeCompat } from '../../shared/protocol-compat'
import {
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../shared/protocol-version'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { markEnvironmentUsed } from './environments'
import { RuntimeClientError, RuntimeRpcFailureError, type RuntimeRpcResponse } from './types'
import type {
  sendWebSocketRequest,
  sendWebSocketRequestWithStatusPreflight
} from './websocket-transport'

type WebSocketTransport = {
  sendWebSocketRequest: typeof sendWebSocketRequest
  sendWebSocketRequestWithStatusPreflight: typeof sendWebSocketRequestWithStatusPreflight
}

type ObservedRuntime = { runtimeId: string | null | undefined }

export class RemoteRuntimeCompatGate {
  private checked = false

  constructor(
    private readonly userDataPath: string,
    private readonly environmentSelector: string | null
  ) {}

  async send<TResult>(args: {
    transport: WebSocketTransport
    pairing: PairingOffer
    method: string
    params: unknown
    timeoutMs: number
    envelope?: RuntimeOrchestrationEnvelope
  }): Promise<RuntimeRpcResponse<TResult>> {
    if (this.checked || args.method === 'status.get') {
      return args.transport.sendWebSocketRequest<TResult>(
        args.pairing,
        args.method,
        args.params,
        args.timeoutMs,
        args.envelope
      )
    }
    // Why: the preflight callback is synchronous, so it only records the runtime id to persist.
    let observed: ObservedRuntime | null = null
    let response: RuntimeRpcResponse<TResult>
    try {
      response = await args.transport.sendWebSocketRequestWithStatusPreflight<TResult>(
        args.pairing,
        args.method,
        args.params,
        args.timeoutMs,
        (statusResponse) => {
          if (statusResponse.ok === false) {
            throw new RuntimeRpcFailureError(statusResponse)
          }
          this.noteVerifiedStatus(statusResponse.result)
          if (this.environmentSelector) {
            observed = { runtimeId: statusResponse._meta.runtimeId }
          }
        },
        args.envelope
      )
    } catch (error) {
      // Why: a failed usage write must not replace the request's own error.
      await this.recordUsed(observed).catch((writeError) => {
        console.warn('[runtime] failed to record environment usage:', writeError)
      })
      throw error
    }
    await this.recordUsed(observed)
    return response
  }

  private async recordUsed(observed: ObservedRuntime | null): Promise<void> {
    if (observed && this.environmentSelector) {
      await markEnvironmentUsed(this.userDataPath, this.environmentSelector, {
        runtimeId: observed.runtimeId
      })
    }
  }

  noteVerifiedStatus(status: RuntimeStatus): void {
    const verdict = evaluateRuntimeCompat({
      clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
      serverProtocolVersion: status.runtimeProtocolVersion ?? status.protocolVersion,
      serverMinCompatibleClientProtocolVersion:
        status.minCompatibleRuntimeClientVersion ?? status.minCompatibleMobileVersion
    })
    if (verdict.kind === 'blocked') {
      throw new RuntimeClientError('incompatible_runtime', describeRuntimeCompatBlock(verdict))
    }
    this.checked = true
  }
}
