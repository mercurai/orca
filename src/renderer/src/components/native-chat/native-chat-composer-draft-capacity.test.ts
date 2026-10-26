// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { MAX_PROMPT_BYTES } from '../../../../shared/rpc-contract/structured-agent-session-params'
import {
  createMemoryNativeChatComposerDraftStorage,
  type NativeChatComposerDraftStorage
} from './native-chat-composer-draft-storage'
import type * as DraftStore from './native-chat-composer-draft-store'

const loaded: (typeof DraftStore)[] = []

/** A fresh renderer over the same durable backend. */
async function reload(storage: NativeChatComposerDraftStorage) {
  vi.resetModules()
  const backend = await import('./native-chat-composer-draft-storage')
  backend.setNativeChatComposerDraftStorageForTests(storage)
  const store = await import('./native-chat-composer-draft-store')
  loaded.push(store)
  await store.hydrateNativeChatComposerDrafts()
  return { store, drafts: await import('./native-chat-draft-cache') }
}

afterEach(async () => {
  for (const store of loaded.splice(0)) {
    await store.nativeChatComposerDraftWritesSettled()
    store.clearNativeChatComposerDraftsForTests()
  }
  localStorage.clear()
})

it('loses nothing past the old budget: 200 drafts and over 5M characters all come back', async () => {
  localStorage.clear()
  const storage = createMemoryNativeChatComposerDraftStorage()
  const modules = await reload(storage)
  for (let index = 0; index < 200; index += 1) {
    modules.drafts.writeNativeChatDraftCache(`tab-${index}:pane`, `${index}`.padEnd(26_000, 'd'))
  }
  modules.store.flushNativeChatComposerDrafts()
  const returned = 'r'.repeat(MAX_PROMPT_BYTES)
  modules.drafts.appendNativeChatDraftCache('tab-0:pane', returned)

  await modules.store.nativeChatComposerDraftWritesSettled()
  const reloaded = await reload(storage)
  for (let index = 0; index < 200; index += 1) {
    expect(reloaded.drafts.readNativeChatDraftCache(`tab-${index}:pane`)).toHaveLength(
      index === 0 ? 26_000 + 2 + returned.length : 26_000
    )
  }
  const total = [...storage.drafts.values()].reduce((sum, draft) => sum + draft.text.length, 0)
  expect(total).toBeGreaterThan(5_000_000)
})
