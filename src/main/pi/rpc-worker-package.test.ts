import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonlRpcAgentConnectionOptions } from '../jsonl-rpc/agent-connection'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { PiRpcConnection } from './rpc-session'
import { PiRpcSessionAdapter } from './rpc-session-adapter'
import { workerPackage } from './rpc-worker-package-test-support'

const sessionId = 'pi-package-session'
const model = { provider: workerPackage.provider, id: workerPackage.model }
const tools = ['harness_create', 'harness_read', 'harness_search', 'harness_write']
const command = {
  name: 'harness-ready',
  source: 'extension',
  sourceInfo: { path: workerPackage.extensionPath, source: 'cli', scope: 'temporary', origin: 'top-level' }
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
  await closeProviderTimelineRigs()
})

function receipt(binding = workerPackage) {
  return {
    schema: 'harness.pi-ready.v1',
    nonce: binding.readinessNonce,
    owner: { run_id: binding.owner.runId, task_id: binding.owner.taskId, dispatch_id: binding.owner.dispatchId },
    readiness: 'ready',
    template_bytes_sha256: binding.templateBytesSha256,
    final_profile_semantic_sha256: binding.finalProfileSemanticSha256,
    manifest_bytes_sha256: binding.manifestBytesSha256,
    broker_sha256: binding.broker.sha256,
    shared_source_commit: binding.canonicalSourceCommit,
    pi_version: binding.piVersion,
    model: { harness: 'pi', gateway: binding.provider, id: binding.model },
    tools,
    tool_exposure: 'model-only',
    mcp_servers: 0
  }
}

async function setup() {
  const rig = await openProviderTimelineRig({ agent: 'pi', sessionId })
  let binding = workerPackage
  const order: string[] = []
  const commands: JsonlRpcRecord[] = [command]
  const promptResult = { disposition: 'handled' }
  const transformReceipt = vi.fn((value: ReturnType<typeof receipt>): unknown => value)
  let acquisitionCount = 0
  const prepareWorkerPackage = vi.fn(async (_sessionId: string, acquisitionId: string) => {
    binding = {
      ...workerPackage,
      acquisitionId,
      readinessNonce: (++acquisitionCount).toString(16).padStart(64, '0'),
      bindingPath: join(workerPackage.packageRoot, '..', 'launch', acquisitionId, 'launch-binding.json')
    }
    return binding
  })
  const sent: JsonlRpcRecord[] = []
  const requests: { command: string; params?: Record<string, unknown> }[] = []
  const openConnection = vi.fn((_launch: unknown, handlers: JsonlRpcAgentConnectionOptions) => {
    const exitListeners: (() => void)[] = []
    const connection: PiRpcConnection = {
      pid: 4123,
      closed: false,
      rootVerdict: 'live',
      processless: false,
      lastCloseResult: null,
      request: async (name, params) => {
        requests.push({ command: name, ...(params ? { params } : {}) })
        if (name === 'get_state') return {
          model, sessionFile: join(binding.sessionDirectory, 'session.jsonl'),
          isStreaming: false, isCompacting: false
        }
        if (name === 'get_available_models') return { models: [model] }
        if (name === 'get_commands') return { commands }
        if (name === 'prompt') {
          order.push('readiness')
          const details = transformReceipt(receipt(binding))
          if (details !== undefined) handlers.onRecord?.({
            type: 'message_end',
            message: { role: 'custom', customType: 'harness.pi-ready.v1', content: [], details, display: false, timestamp: 1 }
          })
          return promptResult
        }
        return {}
      },
      send: async (frame) => { order.push('task'); sent.push(frame) },
      close: async () => {
        Object.assign(connection, { closed: true, rootVerdict: 'exited' })
        for (const listener of exitListeners.splice(0)) listener()
        handlers.onExit?.(new Error('closed'), {
          expected: true, exit: { code: 0, signal: null, processless: false }
        })
        return { root: 'exited', tree: 'exited' }
      },
      onExit: (listener) => { exitListeners.push(listener) },
      pauseReading: () => {},
      resumeReading: () => {}
    }
    return connection
  })
  const adapter = new PiRpcSessionAdapter({
    resolveLaunch: async () => ({ command: '/host/bin/pi', cwd: '/host/folder', fullAccess: true, previous: null }),
    ...{ prepareWorkerPackage },
    openConnection,
    readProcessStartTime: async () => 12345,
    onLifecycle: vi.fn(), onSettled: vi.fn(), onIdle: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn() }
  })
  cleanups.push(async () => {
    await adapter.closeAll()
    await adapter.drainObservedExits()
    adapter.acknowledgeSessionRelease(sessionId)
  })
  const input: StructuredAgentSessionAcquireInput = {
    identity: { sessionId, workspaceId: 'folder-1', hostId: 'local', agent: 'pi', providerHandle: null },
    fence: 7, spawnToken: 'spawn-token', options: { model: `${model.provider}/${model.id}` },
    events: rig.eventSink
  }
  return { adapter, input, prepareWorkerPackage, openConnection, commands, promptResult, transformReceipt, sent, requests, order }
}

describe('Pi admitted package readiness', () => {
  it.each(['missing', 'duplicate', 'foreign-source'])('refuses a %s command without sending an inference prompt', async (problem) => {
    const h = await setup()
    if (problem === 'missing') h.commands.splice(0)
    if (problem === 'duplicate') h.commands.push(command)
    if (problem === 'foreign-source') h.commands[0] = { ...command, sourceInfo: { ...command.sourceInfo, path: '/outside/extension.mjs' } }
    await expect(h.adapter.acquire(h.input)).rejects.toThrow()
    expect(h.requests.some((request) => request.command === 'prompt')).toBe(false)
    expect(h.sent).toEqual([])
  })

  it('refuses a handled readiness command that emitted no matching receipt', async () => {
    const h = await setup()
    h.transformReceipt.mockReturnValue(undefined)
    await expect(h.adapter.acquire(h.input)).rejects.toThrow()
    expect(h.sent).toEqual([])
  })

  it('requires a handled command response as well as a matching receipt', async () => {
    const h = await setup()
    h.promptResult.disposition = 'started'
    await expect(h.adapter.acquire(h.input)).rejects.toThrow()
    expect(h.sent).toEqual([])
  })

  it.each([
    { nonce: 'f'.repeat(64) },
    { owner: { run_id: 'other', task_id: 'task-1', dispatch_id: 'dispatch-1' } },
    { manifest_bytes_sha256: 'f'.repeat(64) },
    { final_profile_semantic_sha256: 'f'.repeat(64) },
    { template_bytes_sha256: 'f'.repeat(64) },
    { broker_sha256: 'f'.repeat(64) },
    { shared_source_commit: 'f'.repeat(40) },
    { pi_version: '1.3.0' },
    { model: { harness: 'pi', gateway: 'openrouter', id: 'other-model' } },
    { tools: [...tools, 'bash'] },
    { tools: tools.slice(1) },
    { tools: [...tools, tools[0]] },
    { tool_exposure: 'extension-visible' },
    { mcp_servers: 1 }
  ])('refuses a mismatched readiness receipt: %j', async (changed) => {
    const h = await setup()
    h.transformReceipt.mockImplementation((value) => ({ ...value, ...changed }))
    await expect(h.adapter.acquire(h.input)).rejects.toThrow()
    expect(h.sent).toEqual([])
  })

  it('admits the task only after the pinned command and nonce-bound receipt agree', async () => {
    const h = await setup()
    const acquired = await h.adapter.acquire(h.input)
    expect(h.prepareWorkerPackage).toHaveBeenCalledExactlyOnceWith(sessionId, acquired.acquisitionGeneration)
    const prompt = h.requests.find((request) => request.command === 'prompt')
    expect(prompt?.params?.message).toBe('/harness-ready ' + JSON.stringify({
      schema: 'harness.pi-ready.request.v1',
      nonce: '1'.padStart(64, '0'),
      owner: { run_id: 'run-1', task_id: 'task-1', dispatch_id: 'dispatch-1' }
    }))
    await expect(h.adapter.dispatch({
      sessionId, fence: 7, clientMessageId: 'task-preamble',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'implement issue' }] }
    })).resolves.toEqual({ state: 'admitted' })
    expect(h.order).toEqual(['readiness', 'task'])
  })

  it('prepares a fresh binding and nonce for each real provider acquisition', async () => {
    const h = await setup()
    await h.adapter.acquire(h.input)
    await h.adapter.closeSession(sessionId)
    await h.adapter.acquire({ ...h.input, fence: 8 })
    expect(h.prepareWorkerPackage).toHaveBeenCalledTimes(2)
    expect(h.prepareWorkerPackage.mock.calls[0]?.[1]).not.toBe(h.prepareWorkerPackage.mock.calls[1]?.[1])
    const prompts = h.requests.filter((request) => request.command === 'prompt')
    expect(prompts).toHaveLength(2)
    expect(prompts[0]?.params?.message).not.toBe(prompts[1]?.params?.message)
  })

  it('never spawns when the trusted package admission helper refuses the dispatch', async () => {
    const h = await setup()
    h.prepareWorkerPackage.mockRejectedValue(new Error('dispatch package is not current'))
    await expect(h.adapter.acquire(h.input)).rejects.toThrow()
    expect(h.openConnection).not.toHaveBeenCalled()
  })
})
