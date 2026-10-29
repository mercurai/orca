import { vi } from 'vitest'
import {
  adapterFor as baseAdapterFor,
  type fakeCodex,
  type Route
} from './codex-structured-session-adapter-fixture'
import type { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'

export const discoveryRequests = new WeakMap<
  ReturnType<typeof fakeCodex>,
  ReturnType<typeof vi.fn<Route>>
>()
export const discoveryWork = new WeakMap<ReturnType<typeof fakeCodex>, Promise<unknown>[]>()

export function adapterWithIndependentCatalog(
  ...args: Parameters<typeof baseAdapterFor>
): CodexStructuredSessionAdapter {
  const [codex, launch = {}, events = [], deps = {}] = args
  const modelCatalog = deps.modelCatalog ?? new AgentModelCatalogStore()
  const home = launch.codexHome ?? '/codex/home'
  const access = agentModelCatalogSessionAccess(modelCatalog, CODEX_STRUCTURED_AGENT, home)!
  const request = vi.fn<Route>((params) => codex.routes['model/list']?.(params) ?? {})
  discoveryRequests.set(codex, request)
  const work: Promise<unknown>[] = []
  discoveryWork.set(codex, work)
  const probe = async () => {
    const answer = await fetchCodexModelCatalogListing({
      connection: {
        request: async (method, params) => (method === 'model/list' ? request(params) : {})
      }
    })
    return { models: answer.models, origin: 'probe' as const, complete: true }
  }
  const demand = async () => {
    if (modelCatalog.shouldRefresh(access.fingerprint)) {
      work.push(modelCatalog.refresh(access.fingerprint, 'codex', probe, probe))
    }
  }
  const adapter = baseAdapterFor(codex, { ...launch, codexHome: home }, events, {
    ...deps,
    modelCatalog,
    demandModelCatalog: demand
  })
  const open = adapter.open.bind(adapter)
  adapter.open = async (input) => {
    const answer = await open(input)
    await demand()
    return answer
  }
  return adapter
}
