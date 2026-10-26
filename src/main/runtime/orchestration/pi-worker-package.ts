import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  PiTaskAdmissionSchema,
  PiWorkerArtifactsSchema
} from '../../../shared/pi-worker-admission'
import type { PiWorkerPackage, PiWorkerPackageBinding } from '../../pi/worker-package-binding'
import { execFileCaptureToTermination } from '../../git/command-runner/exec-file-capture'
import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'

export type PiBrokerCommand = {
  executable: string
  args: string[]
  input: unknown
  cwd: string
  timeoutMs: number
}
export type PiBrokerRunner = (command: PiBrokerCommand) => Promise<{
  exitCode: number
  stdout: string
  stderr: string
}>

type PackageContext = {
  db: OrchestrationDb
  privateRoot: string
  runBroker?: PiBrokerRunner
}

function invalid(message = 'Pi package provenance or artifact validation failed.'): never {
  throw new OrchestrationError('pi_package_invalid', message)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return { ...value }
}

function parseObject(text: string): Record<string, unknown> {
  try {
    return object(JSON.parse(text))
  } catch {
    return invalid()
  }
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid()
  return value
}

function pathIdentifier(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) invalid('Invalid Pi package path identity.')
  return value
}

function currentAttempt(db: OrchestrationDb, dispatchId: string) {
  const dispatch = db.getDispatchContextById(dispatchId)
  const worker = db.getWorkerDispatch(dispatchId)
  const task = dispatch && db.getTask(dispatch.task_id)
  const run = dispatch && db.getRun(dispatch.run_id)
  if (!dispatch || !worker || !task || !run || task.status !== 'dispatched' ||
    !['pending', 'dispatched'].includes(dispatch.status) || !['starting', 'ready'].includes(worker.state) ||
    db.getDispatchContext(task.id)?.id !== dispatchId) {
    throw new OrchestrationError('pi_package_inactive', 'Pi package requires the exact active Dispatch.')
  }
  const options = parseObject(worker.start_options)
  const admission = object(options.piAdmission)
  const stored = db.db.prepare(`
    SELECT consumer_generation, config_sha256 FROM run_pi_worker_admission WHERE run_id = ?
  `).get(run.id) as { consumer_generation: number; config_sha256: string } | undefined
  if (options.agent !== 'pi' || admission.runId !== run.id || admission.taskId !== task.id ||
    admission.dispatchId !== dispatch.id || admission.consumerGeneration !== run.consumer_generation ||
    !stored || stored.consumer_generation !== run.consumer_generation || admission.configSha256 !== stored.config_sha256) {
    throw new OrchestrationError('pi_package_inactive', 'Pi package coordinator or Dispatch grant is stale.')
  }
  const entry = PiTaskAdmissionSchema.safeParse({
    taskId: admission.taskId, profileSha256: admission.profileSha256,
    templatePath: admission.templatePath, reviewTaskId: admission.reviewTaskId,
    maxTokens: admission.maxTokens, maxOutputTokens: admission.maxOutputTokens,
    maxCostMicrousd: admission.maxCostMicrousd, deadlineUnixMs: admission.deadlineUnixMs,
    endpoint: admission.endpoint
  })
  const artifacts = PiWorkerArtifactsSchema.safeParse(admission.artifacts)
  if (!entry.success || !artifacts.success || !entry.data.templatePath || entry.data.deadlineUnixMs <= Date.now()) {
    invalid('Pi package requires current coordinator-owned template, broker, source and budget pins.')
  }
  return { dispatch, worker, run, task, options, entry: entry.data, artifacts: artifacts.data }
}

/** Check the resolved path too, rejecting aliases/junctions before reading or using an artifact. */
async function exactPath(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) invalid('Pi artifacts require normalized absolute paths.')
  const actual = await realpath(path)
  const same = process.platform === 'win32'
    ? actual.toLowerCase() === path.toLowerCase()
    : actual === path
  if (!same) invalid('Pi artifact aliases and reparse paths are not admitted.')
  return actual
}

async function fileHash(path: string, maxBytes: number): Promise<string> {
  try {
    await exactPath(path)
    const file = await open(path, 'r')
    try {
      const before = await file.stat()
      if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) invalid()
      const digest = createHash('sha256')
      const buffer = Buffer.alloc(65536)
      let total = 0
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > maxBytes) invalid()
        digest.update(buffer.subarray(0, bytesRead))
      }
      const after = await file.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || total !== before.size) invalid()
      return digest.digest('hex')
    } finally {
      await file.close()
    }
  } catch {
    return invalid('Pi artifact bytes could not be verified.')
  }
}

const defaultBrokerRunner: PiBrokerRunner = async (command) => {
  // Broker requests need Git and OS process plumbing, never inherited provider credentials.
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  const output = await execFileCaptureToTermination(command.executable, command.args, {
    cwd: command.cwd, env, stdin: JSON.stringify(command.input), encoding: 'utf8',
    timeout: command.timeoutMs, maxBuffer: 65536, terminationBarrier: true
  })
  return { exitCode: 0, stdout: String(output.stdout), stderr: String(output.stderr) }
}

async function broker(
  context: PackageContext,
  attempt: ReturnType<typeof currentAttempt>,
  args: string[],
  input: unknown,
  cwd: string
): Promise<Record<string, unknown>> {
  if (await fileHash(attempt.artifacts.broker.path, 256 * 1024 * 1024) !== attempt.artifacts.broker.sha256) invalid()
  const remaining = attempt.entry.deadlineUnixMs - Date.now()
  if (remaining <= 0) invalid('Pi package deadline expired.')
  try {
    const response = await (context.runBroker ?? defaultBrokerRunner)({
      executable: attempt.artifacts.broker.path, args: ['pi-worker', ...args], input, cwd,
      timeoutMs: Math.min(30000, remaining)
    })
    if (response.exitCode !== 0 || Buffer.byteLength(response.stdout) > 65536) invalid()
    const envelope = parseObject(response.stdout)
    if (envelope.ok !== true) invalid()
    return object(envelope.result)
  } catch {
    return invalid('Pi broker verification or provisioning failed; no worker prompt is admitted.')
  }
}

function provenance(pkg: PiWorkerPackage) {
  return {
    owner: { run_id: pkg.owner.runId, task_id: pkg.owner.taskId, dispatch_id: pkg.owner.dispatchId },
    template_bytes_sha256: pkg.templateBytesSha256,
    final_profile_semantic_sha256: pkg.finalProfileSemanticSha256,
    manifest_bytes_sha256: pkg.manifestBytesSha256,
    broker_sha256: pkg.broker.sha256,
    shared_source_commit: pkg.canonicalSourceCommit
  }
}

function requireProvenance(result: Record<string, unknown>, pkg: PiWorkerPackage, readiness: string) {
  const expected = provenance(pkg)
  const owner = object(result.owner)
  if (result.readiness !== readiness || Object.entries(expected.owner).some(([key, value]) => owner[key] !== value) ||
    Object.entries(expected).some(([key, value]) => key !== 'owner' && result[key] !== value)) invalid()
}

function packagePaths(context: PackageContext, attempt: ReturnType<typeof currentAttempt>, pins: {
  finalProfileSemanticSha256: string
  manifestBytesSha256: string
}): PiWorkerPackage {
  const root = join(resolve(context.privateRoot), pathIdentifier(attempt.dispatch.id))
  const packageRoot = join(root, 'package')
  return {
    owner: { runId: attempt.run.id, taskId: attempt.task.id, dispatchId: attempt.dispatch.id },
    templateBytesSha256: attempt.entry.profileSha256,
    finalProfileSemanticSha256: hash(pins.finalProfileSemanticSha256),
    manifestBytesSha256: hash(pins.manifestBytesSha256),
    canonicalSourceCommit: attempt.artifacts.sharedSource.commit,
    packageRoot, profilePath: join(packageRoot, 'profile.json'),
    manifestPath: join(packageRoot, 'manifest.json'), provenancePath: join(packageRoot, 'binding.json'),
    snapshotPath: join(packageRoot, 'snapshot'), stateDirectory: join(packageRoot, 'state'),
    agentHomeDirectory: join(root, 'pi-home'), sessionDirectory: join(root, 'sessions'),
    extensionPath: join(packageRoot, 'extensions', 'extension.mjs'),
    agentsPath: join(packageRoot, 'AGENTS.md'), skillsDirectory: join(packageRoot, 'skills'),
    broker: attempt.artifacts.broker,
    piVersion: '1.4.0', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017'
  }
}

async function verify(context: PackageContext, attempt: ReturnType<typeof currentAttempt>, pkg: PiWorkerPackage) {
  if (await fileHash(pkg.manifestPath, 1024 * 1024) !== pkg.manifestBytesSha256) invalid()
  const result = await broker(context, attempt, ['verify', '--profile', pkg.profilePath], provenance(pkg), pkg.snapshotPath)
  requireProvenance(result, pkg, 'ready')
  currentAttempt(context.db, attempt.dispatch.id)
}

export async function preparePiWorkerPackage(
  context: PackageContext & { dispatchId: string }
): Promise<PiWorkerPackage> {
  const attempt = currentAttempt(context.db, context.dispatchId)
  if (attempt.options.piPackage !== undefined) {
    const stored = object(attempt.options.piPackage)
    const pkg = packagePaths(context, attempt, {
      finalProfileSemanticSha256: hash(stored.finalProfileSemanticSha256),
      manifestBytesSha256: hash(stored.manifestBytesSha256)
    })
    await verify(context, attempt, pkg)
    return pkg
  }
  const templatePath = attempt.entry.templatePath
  if (!templatePath || await fileHash(templatePath, 65536) !== attempt.entry.profileSha256 ||
    await fileHash(attempt.artifacts.broker.path, 256 * 1024 * 1024) !== attempt.artifacts.broker.sha256) invalid()
  await mkdir(context.privateRoot, { recursive: true, mode: 0o700 })
  await exactPath(resolve(context.privateRoot))
  const root = join(resolve(context.privateRoot), pathIdentifier(context.dispatchId))
  await mkdir(root, { mode: 0o700 })
  const out = join(root, 'package')
  const owner = { run_id: attempt.run.id, task_id: attempt.task.id, dispatch_id: attempt.dispatch.id }
  const result = await broker(context, attempt, [
    'bind', '--template', templatePath, '--repo', attempt.artifacts.sharedSource.repo,
    '--commit', attempt.artifacts.sharedSource.commit, '--out', out
  ], {
    schema: 'harness.pi-bind.v1', owner,
    template_bytes_sha256: attempt.entry.profileSha256, broker_sha256: attempt.artifacts.broker.sha256,
    limits: {
      max_tokens: attempt.entry.maxTokens, max_output_tokens: attempt.entry.maxOutputTokens,
      max_cost_microusd: attempt.entry.maxCostMicrousd, deadline_unix_ms: attempt.entry.deadlineUnixMs
    },
    endpoint: {
      id: attempt.entry.endpoint.id,
      input_microusd_per_million: attempt.entry.endpoint.inputMicrousdPerMillion,
      output_microusd_per_million: attempt.entry.endpoint.outputMicrousdPerMillion
    }
  }, attempt.artifacts.sharedSource.repo)
  const pkg = packagePaths(context, attempt, {
    finalProfileSemanticSha256: hash(result.final_profile_semantic_sha256),
    manifestBytesSha256: hash(result.manifest_bytes_sha256)
  })
  requireProvenance(result, pkg, 'staged_not_provisioned')
  if (result.profile_path !== pkg.profilePath) invalid()
  const provisioned = await broker(context, attempt, ['provision', '--profile', pkg.profilePath], { owner }, pkg.snapshotPath)
  if (provisioned.readiness !== 'ready' || provisioned.profile_sha256 !== pkg.finalProfileSemanticSha256) invalid()
  await verify(context, attempt, pkg)
  for (const directory of [pkg.agentHomeDirectory, pkg.sessionDirectory]) await mkdir(directory, { mode: 0o700 })
  context.db.db.exec('BEGIN IMMEDIATE')
  try {
    const current = currentAttempt(context.db, context.dispatchId)
    if (current.options.piPackage !== undefined) invalid('Pi package binding already exists.')
    context.db.db.prepare('UPDATE worker_dispatches SET start_options = ? WHERE dispatch_id = ?')
      .run(JSON.stringify({ ...current.options, piPackage: pkg }), context.dispatchId)
    context.db.db.exec('COMMIT')
  } catch (error) {
    context.db.db.exec('ROLLBACK')
    throw error
  }
  return pkg
}

export function bindPiWorkerPackageToSession(db: OrchestrationDb, dispatchId: string, sessionId: string): void {
  pathIdentifier(sessionId)
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const attempt = currentAttempt(db, dispatchId)
    const pkg = object(attempt.options.piPackage)
    if (pkg.sessionId !== undefined && pkg.sessionId !== sessionId) invalid('Pi package belongs to another session.')
    db.db.prepare('UPDATE worker_dispatches SET start_options = ? WHERE dispatch_id = ?')
      .run(JSON.stringify({ ...attempt.options, piPackage: { ...pkg, sessionId } }), dispatchId)
    db.db.exec('COMMIT')
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}

export async function preparePiWorkerAcquisition(
  context: PackageContext & { sessionId: string; acquisitionId: string }
): Promise<PiWorkerPackageBinding | undefined> {
  pathIdentifier(context.sessionId)
  pathIdentifier(context.acquisitionId)
  const rows = context.db.db.prepare(`
    SELECT dispatch_id FROM worker_dispatches WHERE json_extract(start_options, '$.piPackage.sessionId') = ?
  `).all(context.sessionId) as { dispatch_id: string }[]
  if (rows.length === 0) {
    const existing = context.db.db.prepare(`
      SELECT worker.dispatch_id FROM worker_dispatches worker
      JOIN dispatch_contexts dispatch ON dispatch.id = worker.dispatch_id
      WHERE dispatch.assignee_orca_session_id = ? AND json_extract(worker.start_options, '$.agent') = 'pi'
    `).get(context.sessionId)
    if (existing) invalid('Supervised Pi session has no verified package binding.')
    return undefined
  }
  if (rows.length !== 1) invalid('Pi session has ambiguous Dispatch ownership.')
  const attempt = currentAttempt(context.db, rows[0].dispatch_id)
  const pkg = await preparePiWorkerPackage({ ...context, dispatchId: attempt.dispatch.id })
  const acquisitionDirectory = join(dirname(pkg.packageRoot), 'launch', context.acquisitionId)
  await mkdir(dirname(acquisitionDirectory), { recursive: true, mode: 0o700 })
  await exactPath(dirname(acquisitionDirectory))
  await mkdir(acquisitionDirectory, { mode: 0o700 })
  const bindingPath = join(acquisitionDirectory, 'launch-binding.json')
  const readinessNonce = randomBytes(32).toString('hex')
  const binding = {
    schema: 'harness.pi-launch.v1', owner: provenance(pkg).owner,
    templateBytesSha256: pkg.templateBytesSha256, finalProfileSemanticSha256: pkg.finalProfileSemanticSha256,
    manifestBytesSha256: pkg.manifestBytesSha256, brokerBytesSha256: pkg.broker.sha256,
    canonicalSourceCommit: pkg.canonicalSourceCommit, expectedPiVersion: pkg.piVersion,
    expectedModel: { harness: 'pi', gateway: pkg.provider, id: pkg.model }, readinessNonce
  }
  const file = await open(bindingPath, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(binding))
    await file.sync()
  } finally {
    await file.close()
  }
  currentAttempt(context.db, attempt.dispatch.id)
  return { ...pkg, acquisitionId: context.acquisitionId, bindingPath, readinessNonce }
}
