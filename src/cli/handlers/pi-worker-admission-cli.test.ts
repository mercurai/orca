import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs, specPaths, validateCommandAndFlags } from '../args'
import { HANDLER_GROUPS } from '../handler-group-manifest'
import { COMMAND_SPECS } from '../specs'

vi.mock('../format', () => ({ printResult: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

const PROFILE = 'a'.repeat(64)
const CONFIG = {
  schema: 'orca.pi-worker-admission.v1',
  maxWorkers: 2,
  ciGateId: 'gate_ci',
  tasks: [{
    taskId: 'task_implementation', reviewTaskId: 'task_review', profileSha256: PROFILE,
    maxTokens: 10000, maxOutputTokens: 1000, maxCostMicrousd: 2000000,
    deadlineUnixMs: Number.MAX_SAFE_INTEGER,
    endpoint: { id: 'qualified-endpoint', inputMicrousdPerMillion: 1000, outputMicrousdPerMillion: 2000 }
  }]
}

describe('Pi admission CLI routing', () => {
  let directory: string
  const call = vi.fn()
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-pi-cli-'))
    call.mockReset().mockResolvedValue({
      result: {
        state: 'ready', configSha256: PROFILE,
        capabilities: ['orchestration_pi_worker_admission_v1']
      }
    })
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  async function invoke(argv: string[]) {
    const parsed = parseArgs(argv, COMMAND_SPECS.flatMap(specPaths), COMMAND_SPECS)
    validateCommandAndFlags(COMMAND_SPECS, parsed)
    const key = parsed.commandPath.join(' ')
    expect(HANDLER_GROUPS.find((group) => group.name === 'orchestration')?.keys).toContain(key)
    await ORCHESTRATION_HANDLERS[key]({
      flags: parsed.flags, client: { call }, cwd: directory, json: true
    } as never)
  }

  it('reads a policy file and sends the exact Run generation and coordinator identity', async () => {
    const path = join(directory, 'policy.json')
    writeFileSync(path, JSON.stringify(CONFIG))
    await invoke([
      'orchestration', 'pi-admission', 'configure', '--run', 'run_pi', '--from', 'term_coord',
      '--generation', '4', '--config', path
    ])
    expect(call).toHaveBeenCalledWith('orchestration.piWorkerAdmissionConfigure', {
      run: 'run_pi', from: 'term_coord', consumerGeneration: 4, config: CONFIG
    })
  })

  it('rejects malformed policy content without an RPC mutation', async () => {
    const path = join(directory, 'invalid.json')
    writeFileSync(path, JSON.stringify({ ...CONFIG, tasks: [{ ...CONFIG.tasks[0], maxTokens: -1 }] }))
    await expect(invoke([
      'orchestration', 'pi-admission', 'configure', '--run', 'run_pi', '--from', 'term_coord',
      '--generation', '4', '--config', path
    ])).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('Pi admission') })
    expect(call).not.toHaveBeenCalled()
  })

  it('passes the approved profile identity through worker-start without worker-controlled budgets', async () => {
    await invoke([
      'orchestration', 'worker-start', '--task', 'task_implementation', '--from', 'term_coord',
      '--agent', 'pi', '--pi-profile-sha256', PROFILE
    ])
    expect(call).toHaveBeenCalledWith('orchestration.workerStart', expect.objectContaining({
      task: 'task_implementation', agent: 'pi', piProfileSha256: PROFILE
    }))
  })

  it('refuses an older home runtime that would discard the Pi profile reference', async () => {
    call.mockImplementation(async (method: string) => ({
      result: method === 'status.get' ? { capabilities: [] } : { state: 'ready' }
    }))
    await expect(invoke([
      'orchestration', 'worker-start', '--task', 'task_implementation', '--from', 'term_coord',
      '--agent', 'pi', '--pi-profile-sha256', PROFILE
    ])).rejects.toMatchObject({ code: 'capability_unsupported', message: expect.stringContaining('Pi admission') })
    expect(call.mock.calls.some(([method]) => method === 'orchestration.workerStart')).toBe(false)
  })
})
