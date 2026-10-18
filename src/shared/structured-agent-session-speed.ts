import type { AgentSessionOptionsResult } from './agent-session-wire'
import type { AgentSessionOptionCatalog, CatalogModel } from './agent-session-option-catalog'
import type { AgentSessionSpeed } from './agent-session-speed'
import type { SessionOptionDescriptor } from './native-chat-session-options'
import { discoveredModel } from './structured-agent-session-discovered-model'

export function structuredAgentSessionOptionCatalog(
  seed: AgentSessionOptionCatalog,
  result: AgentSessionOptionsResult
): AgentSessionOptionCatalog {
  const models: CatalogModel[] = result.models.map((model) =>
    discoveredModel(model, result.fastModeSupport?.supported === true)
  )
  if (result.current.model && !models.some((model) => model.id === result.current.model)) {
    models.push({
      id: result.current.model,
      label: result.current.model,
      options: seed.unknownModelOptions ?? []
    })
  }
  return {
    ...seed,
    models: withStructuredSpeedCatalog(models, result.speed),
    defaultModelIsCliDefault: true
  }
}

/** A host with speed metadata uses the select even when a row's tier support is unknown. */
export function withStructuredSpeedCatalog(
  models: CatalogModel[],
  speed: AgentSessionSpeed | undefined
): CatalogModel[] {
  if (!speed) {
    return models
  }
  return models.map((model) => {
    const options = model.options.filter((option) => option.id !== 'fastMode')
    if (options.some((option) => option.id === 'serviceTier')) {
      return { ...model, options }
    }
    const standard = discoveredModel(
      {
        id: model.id,
        label: model.label,
        isDefault: model.isDefault === true,
        efforts: [],
        serviceTiers: []
      },
      false
    ).options
    return { ...model, options: [...options, ...standard] }
  })
}

/** A local pick can outlive a failed refresh; the old support verdict is not its admission. */
function speedForSelection(speed: AgentSessionSpeed, tierId: string | undefined): AgentSessionSpeed {
  if (
    tierId === undefined ||
    (speed.requested && 'tierId' in speed.requested && speed.requested.tierId === tierId) ||
    (speed.requested === undefined && tierId === 'default')
  ) {
    return speed
  }
  // Applied/processing remain historical facts, not acceptance of this newly selected tier.
  return { ...speed, requested: { tierId }, support: 'unknown' }
}

/** Never carry the previous model's acceptance or processing facts onto a held model pick. */
export function withStructuredSpeedSnapshot(
  snapshot: SessionOptionDescriptor[],
  speed: AgentSessionSpeed | undefined,
  speedModelId: string | undefined
): SessionOptionDescriptor[] {
  if (!speed) {
    return snapshot
  }
  const model = snapshot.find((descriptor) => descriptor.id === 'model')?.kind
  const matchesModel = model?.type === 'select' && model.currentValue === speedModelId
  return snapshot.map((descriptor) => {
    if (descriptor.id !== 'serviceTier') {
      return descriptor
    }
    const tierId = descriptor.kind.type === 'select' ? descriptor.kind.currentValue : undefined
    const shown: AgentSessionSpeed = matchesModel
      ? speedForSelection(speed, tierId)
      : { support: 'unknown', processing: { status: 'unknown' } }
    return { ...descriptor, speed: shown }
  })
}
