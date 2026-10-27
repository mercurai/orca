import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAppEnvironment, hasAppEnvironment, setAppEnvironment } from '../../../shared/app-environment'
import { OrchestrationDb } from './db'

async function packageApi() {
  // Resolve only inside the case: an absent first implementation must not abort suite collection.
  return import('./pi-worker-package')
}

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const FINAL_SEMANTIC_HASH = 'b'.repeat(64)
const SOURCE_COMMIT = 'c'.repeat(40)
let directory: string
let db: OrchestrationDb

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-pi-package-'))
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
})

afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const run = db.createRun({
    objective: 'Pi package composition', coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const task = db.createTask({ runId: run.id, spec: 'Bounded implementation' })
  const review = db.createTask({ runId: run.id, spec: 'Independent review', deps: [task.id] })
  const ci = db.createTask({ runId: run.id, spec: 'CI ready' })
  const gate = db.createGate({ taskId: ci.id, question: 'Admit?' })
  db.resolveGate(gate.id, 'approved')
  const templatePath = join(directory, 'template.json')
  const brokerPath = join(directory, 'harness-fixture')
  const template = {
    schema: 'harness.pi-worker.v1',
    owner: { run_id: run.id, task_id: task.id, dispatch_id: 'ctx_template' },
    task: { issue_url: 'https://github.com/fixture/repo/issues/1', repo: directory, commit: SOURCE_COMMIT },
    workspace: join(directory, 'placeholder-snapshot'),
    state_dir: join(directory, 'placeholder-state'),
    claims: [{ path: 'task.ts', access: 'create' }],
    model: { harness: 'pi', gateway: 'openrouter', id: 'deepseek/deepseek-v4.1-flash-1017', context_window: 1048576 },
    pi_version: '1.4.0', reviewer: 'gpt-6.1-sol',
    limits: { max_tokens: 10000, max_output_tokens: 1000, max_cost_microusd: 2000000, deadline_unix_ms: Number.MAX_SAFE_INTEGER },
    endpoint: { id: 'qualified-endpoint', input_microusd_per_million: 1000, output_microusd_per_million: 2000 },
    routing: { only: ['qualified-endpoint'], allow_fallbacks: false, require_parameters: true, sort: 'throughput' }
  }
  writeFileSync(templatePath, JSON.stringify(template))
  writeFileSync(brokerPath, 'pinned fixture executable bytes')
  const templateBytesSha256 = sha(readFileSync(templatePath))
  const brokerBytesSha256 = sha(readFileSync(brokerPath))
  const privateRoot = join(directory, 'private')
  mkdirSync(privateRoot)
  db.configurePiWorkerAdmission({
    runId: run.id, consumerGeneration: run.consumer_generation,
    coordinator: { terminalHandle: 'term_coord', paneKey: run.coordinator_pane_key, orcaSessionId: null },
    config: {
      schema: 'orca.pi-worker-admission.v1', maxWorkers: 2, ciGateId: gate.id,
      artifacts: {
        sharedSource: { repo: directory, commit: SOURCE_COMMIT },
        broker: { path: brokerPath, sha256: brokerBytesSha256 }
      },
      tasks: [{
        taskId: task.id, reviewTaskId: review.id, templatePath,
        profileSha256: templateBytesSha256, maxTokens: 10000, maxOutputTokens: 1000,
        maxCostMicrousd: 2000000, deadlineUnixMs: Number.MAX_SAFE_INTEGER,
        endpoint: { id: 'qualified-endpoint', inputMicrousdPerMillion: 1000, outputMicrousdPerMillion: 2000 }
      }]
    }
  })
  const started = db.createStartingWorkerDispatch({
    taskId: task.id, creator: { kind: 'system' }, maxDepth: 3,
    startOptions: {
      agent: 'pi', piProfileSha256: templateBytesSha256,
      mode: { mode: 'structured', preferred: 'structured', reason: 'user_default', detail: 'Host selected.' }
    }
  })
  const owner = { run_id: run.id, task_id: task.id, dispatch_id: started.dispatch.id }
  const packageRoot = join(privateRoot, started.dispatch.id, 'package')
  const provenance = {
    owner, template_bytes_sha256: templateBytesSha256,
    final_profile_semantic_sha256: FINAL_SEMANTIC_HASH,
    broker_sha256: brokerBytesSha256, shared_source_commit: SOURCE_COMMIT
  }
  let manifestBytesSha256 = ''
  const runBroker = vi.fn(async (command: { args: string[]; input: unknown }) => {
    const operation = command.args[1]
    if (operation === 'bind') {
      mkdirSync(packageRoot, { recursive: true })
      mkdirSync(join(packageRoot, 'snapshot'))
      mkdirSync(join(packageRoot, 'state'))
      const profile = {
        ...template, owner, workspace: join(packageRoot, 'snapshot'), state_dir: join(packageRoot, 'state')
      }
      writeFileSync(join(packageRoot, 'profile.json'), JSON.stringify(profile, null, 2))
      writeFileSync(join(packageRoot, 'binding.json'), JSON.stringify({ schema: 'harness.pi-binding.v1', ...provenance }))
      writeFileSync(join(packageRoot, 'manifest.json'), JSON.stringify({
        schema: 'harness.pi-package.v1', source_commit: SOURCE_COMMIT,
        files: ['profile.json', 'binding.json'].map((path) => ({ path, sha256: sha(readFileSync(join(packageRoot, path))) }))
      }))
      manifestBytesSha256 = sha(readFileSync(join(packageRoot, 'manifest.json')))
    }
    const result = operation === 'provision'
      ? { readiness: 'ready', profile_sha256: FINAL_SEMANTIC_HASH }
      : {
        ...provenance, manifest_bytes_sha256: manifestBytesSha256,
        profile_path: join(packageRoot, 'profile.json'),
        readiness: operation === 'bind' ? 'staged_not_provisioned' : 'ready'
      }
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' }
  })
  const prepare = async () => (await packageApi()).preparePiWorkerPackage({
    db, dispatchId: started.dispatch.id, privateRoot, runBroker
  })
  return { prepare, started, task, run, templatePath, brokerPath, templateBytesSha256, brokerBytesSha256, privateRoot, runBroker, owner }
}

describe('Pi package composition at the reserved Dispatch', () => {
  it('binds and provisions the exact reserved owner with three distinct hash meanings', async () => {
    const f = fixture()
    const prepared = await f.prepare()
    expect(f.runBroker.mock.calls.map(([command]) => command.args[1])).toEqual(['bind', 'provision', 'verify'])
    expect(f.runBroker.mock.calls[0][0].input).toMatchObject({
      owner: f.owner, template_bytes_sha256: f.templateBytesSha256,
      limits: { max_tokens: 10000, max_output_tokens: 1000, max_cost_microusd: 2000000 }
    })
    expect(prepared).toMatchObject({
      templateBytesSha256: f.templateBytesSha256,
      finalProfileSemanticSha256: FINAL_SEMANTIC_HASH,
      manifestBytesSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(JSON.parse(db.getWorkerDispatch(f.started.dispatch.id)!.start_options)).toMatchObject({
      piPackage: { finalProfileSemanticSha256: FINAL_SEMANTIC_HASH }
    })
  })

  it.each(['template', 'broker'])('rejects changed %s bytes before executing the broker', async (changed) => {
    const f = fixture()
    writeFileSync(changed === 'template' ? f.templatePath : f.brokerPath, 'changed after admission')
    await expect(f.prepare()).rejects.toMatchObject({ code: 'pi_package_invalid' })
    expect(f.runBroker).not.toHaveBeenCalled()
  })

  it('refuses broker output bound to a different owner before launch', async () => {
    const f = fixture()
    f.runBroker.mockResolvedValueOnce({
      exitCode: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { owner: { ...f.owner, dispatch_id: 'ctx_other' } } })
    })
    await expect(f.prepare()).rejects.toMatchObject({ code: 'pi_package_invalid' })
    expect(f.runBroker).toHaveBeenCalledTimes(1)
    expect(db.getWorkerDispatch(f.started.dispatch.id)?.state).toBe('starting')
  })

  it('mints a new immutable nonce binding for each real acquisition of the same exact session', async () => {
    const f = fixture()
    await f.prepare()
    const { bindPiWorkerPackageToSession, preparePiWorkerAcquisition } = await packageApi()
    bindPiWorkerPackageToSession(db, f.started.dispatch.id, 'session_fixture')
    const first = await preparePiWorkerAcquisition({
      db, sessionId: 'session_fixture', acquisitionId: 'acquisition_first', privateRoot: f.privateRoot, runBroker: f.runBroker
    })
    const second = await preparePiWorkerAcquisition({
      db, sessionId: 'session_fixture', acquisitionId: 'acquisition_second', privateRoot: f.privateRoot, runBroker: f.runBroker
    })
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first!.readinessNonce).not.toBe(second!.readinessNonce)
    expect(first!.bindingPath).not.toBe(second!.bindingPath)
    expect(JSON.parse(readFileSync(first!.bindingPath, 'utf8'))).toMatchObject({ readinessNonce: first!.readinessNonce })
    expect(JSON.parse(readFileSync(second!.bindingPath, 'utf8'))).toMatchObject({ readinessNonce: second!.readinessNonce })
    db.failDispatch(f.started.dispatch.id, 'process exited', { workerProcessExited: true })
    await expect(preparePiWorkerAcquisition({
      db, sessionId: 'session_fixture', acquisitionId: 'acquisition_after_exit', privateRoot: f.privateRoot, runBroker: f.runBroker
    })).rejects.toMatchObject({ code: 'pi_package_inactive' })
  })

  it('pins the private model catalog generated from verified profile metadata and approved price ceilings', async () => {
    const f = fixture()
    await f.prepare()
    const { bindPiWorkerPackageToSession, preparePiWorkerAcquisition } = await packageApi()
    bindPiWorkerPackageToSession(db, f.started.dispatch.id, 'session_catalog')
    const binding = await preparePiWorkerAcquisition({
      db, sessionId: 'session_catalog', acquisitionId: 'acquisition_catalog',
      privateRoot: f.privateRoot, runBroker: f.runBroker
    })
    expect(binding).toMatchObject({
      contextWindow: 1048576, modelsJsonPath: expect.any(String),
      modelsJsonSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    const bytes = readFileSync(binding!.modelsJsonPath)
    expect(binding!.modelsJsonSha256).toBe(sha(bytes))
    expect(binding!.modelsJsonPath).toBe(join(binding!.agentHomeDirectory, 'models.json'))
    expect(JSON.parse(bytes.toString('utf8'))).toEqual({
      providers: { openrouter: {
        api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '$OPENROUTER_API_KEY',
        models: [{
          id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek implementation worker',
          reasoning: false, input: ['text'], contextWindow: 1048576, maxTokens: 1000,
          cost: { input: 0.001, output: 0.002, cacheRead: 0.001, cacheWrite: 0.001 }
        }]
      } }
    })
    expect(JSON.parse(readFileSync(binding!.bindingPath, 'utf8'))).toMatchObject({
      modelsJsonPath: binding!.modelsJsonPath, modelsJsonSha256: binding!.modelsJsonSha256,
      expectedModel: { context_window: 1048576 }
    })
  })

  it('exposes the exact host-generated launch binding for native handoff without identity or credentials', async () => {
    const f = fixture()
    await f.prepare()
    const { bindPiWorkerPackageToSession, preparePiWorkerAcquisition } = await packageApi()
    bindPiWorkerPackageToSession(db, f.started.dispatch.id, 'session_report_contract')
    const platform = process.platform
    const executable = join(f.privateRoot, platform === 'win32' ? 'orca-ide.exe' : 'orca-ide')
    writeFileSync(executable, 'host-owned CLI fixture')
    const previousEnvironment = hasAppEnvironment() ? getAppEnvironment() : null
    setAppEnvironment({
      getPath: () => f.privateRoot,
      getAppPath: () => directory,
      getVersion: () => '0.0.0-test',
      isPackaged: () => true,
      getCliLauncherPath: () => executable,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
    try {
      const { resolvePiWorkerReportCli } = await import('../../pi/worker-report-bridge')
      vi.stubEnv('ORCA_CLI_COMMAND', '/wrong/runtime --arbitrary-rpc')
      vi.stubEnv('ORCA_AGENT_SESSION_SPAWN_TOKEN', 'test-only-seal')
      vi.stubEnv('OPENROUTER_API_KEY', 'test-only-provider-value')
      const trustedReportCli = resolvePiWorkerReportCli({ platform })
      const binding = await preparePiWorkerAcquisition({
        db, sessionId: 'session_report_contract', acquisitionId: 'acquisition_report_contract',
        privateRoot: f.privateRoot, runBroker: f.runBroker
      })
      expect(binding).toBeDefined()
      const serialized = JSON.parse(readFileSync(binding!.bindingPath, 'utf8')) as Record<string, unknown>
      expect(serialized.reportCli).toEqual(trustedReportCli)
      expect(serialized.reportCli).not.toHaveProperty('command')
      expect(JSON.stringify(serialized)).not.toContain('/wrong/runtime')
      expect(JSON.stringify(serialized)).not.toContain('test-only-seal')
      expect(JSON.stringify(serialized)).not.toContain('test-only-provider-value')

      vi.stubEnv('ORCA_CLI_COMMAND', '/another/runtime --not-trusted')
      expect(JSON.parse(readFileSync(binding!.bindingPath, 'utf8')).reportCli).toEqual(trustedReportCli)
    } finally {
      vi.unstubAllEnvs()
      if (previousEnvironment) setAppEnvironment(previousEnvironment)
    }
  })
})
