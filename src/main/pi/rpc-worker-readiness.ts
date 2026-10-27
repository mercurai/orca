import { isAbsolute, normalize } from 'node:path'
import { z } from 'zod'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import type { PiRpcRequester } from './rpc-options'
import type { PiWorkerPackageBinding } from './worker-package-binding'

const commandList = z.object({
  commands: z.array(z.object({
    name: z.string(),
    source: z.string().optional(),
    sourceInfo: z.object({ path: z.string() }).optional()
  }))
})
const customMessage = z.object({
  type: z.literal('message_end'),
  message: z.object({
    role: z.literal('custom'),
    customType: z.literal('harness.pi-ready.v1'),
    details: z.unknown()
  })
})
const readyTools = ['harness_create', 'harness_read', 'harness_search', 'harness_write', 'harness_report']

function sameHostPath(actual: string, expected: string): boolean {
  if (!isAbsolute(actual) || !isAbsolute(expected)) return false
  const key = (path: string) => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path)
  return key(actual) === key(expected)
}

/** An extension command is safe only after its registration and its live receipt agree. */
export class PiRpcWorkerReadiness {
  private awaiting = false
  private receipts: unknown[] = []
  constructor(private readonly binding: PiWorkerPackageBinding) {}

  receive(frame: JsonlRpcRecord): boolean {
    const parsed = customMessage.safeParse(frame)
    if (!parsed.success) return false
    if (this.awaiting && this.receipts.length < 2) this.receipts.push(parsed.data.message.details)
    return true
  }

  async verify(rpc: PiRpcRequester): Promise<void> {
    const { commands } = commandList.parse(await rpc.request('get_commands'))
    const matches = commands.filter((command) => command.name === 'harness-ready')
    const command = matches[0]
    if (matches.length !== 1 || command?.source !== 'extension' ||
      !command.sourceInfo || !sameHostPath(command.sourceInfo.path, this.binding.extensionPath)) {
      throw new Error('Pi worker readiness command is not the pinned extension')
    }
    const { binding } = this
    const owner = {
      run_id: binding.owner.runId,
      task_id: binding.owner.taskId,
      dispatch_id: binding.owner.dispatchId
    }
    this.receipts = []
    this.awaiting = true
    let reply: unknown
    try {
      reply = await rpc.request('prompt', {
        message: '/harness-ready ' + JSON.stringify({
          schema: 'harness.pi-ready.request.v1', nonce: binding.readinessNonce, owner
        })
      })
    } finally {
      this.awaiting = false
    }
    const receipt = z.object({
      schema: z.literal('harness.pi-ready.v1'),
      nonce: z.literal(binding.readinessNonce),
      owner: z.object({
        run_id: z.literal(owner.run_id), task_id: z.literal(owner.task_id), dispatch_id: z.literal(owner.dispatch_id)
      }),
      readiness: z.literal('ready'),
      template_bytes_sha256: z.literal(binding.templateBytesSha256),
      final_profile_semantic_sha256: z.literal(binding.finalProfileSemanticSha256),
      manifest_bytes_sha256: z.literal(binding.manifestBytesSha256),
      broker_sha256: z.literal(binding.broker.sha256),
      shared_source_commit: z.literal(binding.canonicalSourceCommit),
      models_json_sha256: z.literal(binding.modelsJsonSha256),
      pi_version: z.literal(binding.piVersion),
      model: z.object({
        harness: z.literal('pi'),
        gateway: z.literal(binding.provider),
        id: z.literal(binding.model),
        context_window: z.literal(binding.contextWindow)
      }),
      tools: z.array(z.string()).refine((names) => names.length === readyTools.length &&
        new Set(names).size === readyTools.length && readyTools.every((name) => names.includes(name))),
      tool_exposure: z.literal('model-only'),
      mcp_servers: z.literal(0)
    })
    if (!z.object({ disposition: z.literal('handled') }).safeParse(reply).success ||
      this.receipts.length !== 1 || !receipt.safeParse(this.receipts[0]).success) {
      throw new Error('Pi worker readiness receipt did not match this acquisition')
    }
  }
}
