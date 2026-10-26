import type { CommandHandler } from '../../dispatch'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { printResult } from '../../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../../flags'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../shared/orchestration-run-pagination'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'
import { PiWorkerAdmissionConfigSchema } from '../../../shared/pi-worker-admission'
import { RuntimeClientError } from '../../runtime-client'

export const ORCHESTRATION_RUN_HANDLERS: Record<string, CommandHandler> = {
  'orchestration pi-admission configure': async ({ flags, client, cwd, json }) => {
    const generation = Number(getRequiredStringFlag(flags, 'generation'))
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new RuntimeClientError('invalid_argument', 'Pi admission --generation must be a positive safe integer.')
    }
    const configPath = resolve(cwd, getRequiredStringFlag(flags, 'config'))
    let input: unknown
    try {
      input = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      throw new RuntimeClientError('invalid_argument', 'Pi admission --config must name a readable JSON policy file.')
    }
    const config = PiWorkerAdmissionConfigSchema.safeParse(input)
    if (!config.success) {
      throw new RuntimeClientError('invalid_argument', 'Pi admission policy has invalid fields or budget limits.')
    }
    const result = await callOrchestrationMutation<{ configSha256: string }>(
      client, flags, 'orchestration.piWorkerAdmissionConfigure', {
        run: getRequiredStringFlag(flags, 'run'),
        from: await resolveCoordinatorTerminalHandle(flags, cwd, client),
        consumerGeneration: generation,
        config: config.data
      }
    )
    printResult(result, json, (receipt) => `Pi admission configured: ${receipt.configSha256}`)
  },
  'orchestration run-create': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<{
      run: { id: string; objective: string; consumer_generation: number }
    }>(client, flags, 'orchestration.runCreate', {
      objective: getRequiredStringFlag(flags, 'objective'),
      from
    })
    printResult(result, json, (r) => `Run ${r.run.id} created and bound: ${r.run.objective}`)
  },

  'orchestration run-use': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<{
      run: { id: string; objective: string; consumer_generation: number }
    }>(client, flags, 'orchestration.runUse', {
      id: getRequiredStringFlag(flags, 'id'),
      from,
      ...(flags.has('takeover-legacy') ? { takeoverLegacy: true } : {})
    })
    printResult(result, json, (r) => `Using Run ${r.run.id}: ${r.run.objective}`)
  },

  'orchestration run-current': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      run: { id: string; objective: string } | null
    }>('orchestration.runCurrent', { from })
    printResult(result, json, (r) =>
      r.run
        ? `${r.run.id} ${r.run.objective}`
        : `No Run is bound to this ${from === undefined ? 'session' : 'terminal'}.`
    )
  },

  'orchestration run-list': async ({ flags, client, json }) => {
    const result = await client.call<{
      runs: { id: string; objective: string; legacy: number }[]
      nextCursor: string | null
    }>('orchestration.runList', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit') ?? ORCHESTRATION_RUN_PAGE_LIMIT,
      cursor: getOptionalStringFlag(flags, 'cursor')
    })
    printResult(result, json, (r) => {
      const rows =
        r.runs.length === 0
          ? 'No Runs found.'
          : r.runs
              .map(
                (run) => `${run.id}${run.legacy ? ' [legacy, inspect only]' : ''} ${run.objective}`
              )
              .join('\n')
      return r.nextCursor ? `${rows}\nMore Runs: --cursor ${r.nextCursor}` : rows
    })
  },

  'orchestration run-show': async ({ flags, client, json }) => {
    const result = await client.call<{
      run: {
        id: string
        objective: string
        consumer_generation: number
        legacy: number
        created_at: string
      }
    }>('orchestration.runShow', { id: getRequiredStringFlag(flags, 'id') })
    printResult(
      result,
      json,
      (r) =>
        `${r.run.id}${r.run.legacy ? ' [legacy, inspect only]' : ''} ${r.run.objective}\n` +
        `consumer generation ${r.run.consumer_generation}; created ${r.run.created_at}`
    )
  }
}
