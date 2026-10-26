import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { PiTaskAdmission } from '../../../shared/pi-worker-admission'
import type { PiWorkerPackage } from '../../pi/worker-package-binding'
import { pinnedObject, writeExclusive } from './pi-worker-artifacts'
import { OrchestrationError } from './orchestration-error'

function invalid(): never {
  throw new OrchestrationError('pi_package_invalid', 'Pi model metadata does not match the verified admission.')
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return { ...value }
}

export async function prepareModelCatalog(pkg: PiWorkerPackage, entry: PiTaskAdmission, acquisitionDirectory: string) {
  const manifest = await pinnedObject(pkg.manifestPath, pkg.manifestBytesSha256)
  if (!Array.isArray(manifest.files)) invalid()
  const profileEntries = manifest.files.map(object).filter((entry) => entry.path === 'profile.json')
  if (profileEntries.length !== 1) invalid()
  const profile = await pinnedObject(pkg.profilePath, String(profileEntries[0].sha256))
  const model = object(profile.model)
  const limits = object(profile.limits)
  const endpoint = object(profile.endpoint)
  if (model.harness !== 'pi' || model.gateway !== pkg.provider || model.id !== pkg.model ||
    typeof model.context_window !== 'number' || !Number.isSafeInteger(model.context_window) || model.context_window <= 0 ||
    limits.max_output_tokens !== entry.maxOutputTokens || endpoint.id !== entry.endpoint.id ||
    endpoint.input_microusd_per_million !== entry.endpoint.inputMicrousdPerMillion ||
    endpoint.output_microusd_per_million !== entry.endpoint.outputMicrousdPerMillion) invalid()
  const contextWindow = model.context_window
  const input = entry.endpoint.inputMicrousdPerMillion / 1000000
  const output = entry.endpoint.outputMicrousdPerMillion / 1000000
  const bytes = JSON.stringify({ providers: { openrouter: {
    api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '$OPENROUTER_API_KEY',
    models: [{ id: pkg.model, name: 'DeepSeek implementation worker', reasoning: false, input: ['text'],
      contextWindow, maxTokens: entry.maxOutputTokens,
      // Cache rates are the approved input ceiling, not an asserted vendor discount.
      cost: { input, output, cacheRead: input, cacheWrite: input } }]
  } } })
  const agentHomeDirectory = join(acquisitionDirectory, 'pi-home')
  await mkdir(agentHomeDirectory, { mode: 0o700 })
  const modelsJsonPath = join(agentHomeDirectory, 'models.json')
  await writeExclusive(modelsJsonPath, bytes)
  return { agentHomeDirectory, contextWindow, modelsJsonPath,
    modelsJsonSha256: createHash('sha256').update(bytes).digest('hex') }
}
