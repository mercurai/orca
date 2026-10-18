// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DraftStore from './native-chat-composer-draft-store'
import type * as DraftCache from './native-chat-draft-cache'
import {
  createMemoryNativeChatComposerDraftStorage,
  type NativeChatComposerDraftStorage
} from './native-chat-composer-draft-storage'

type Modules = { store: typeof DraftStore; cache: typeof DraftCache }
type Message = { clientMessageId: string; text: string }
const SCOPE = 'agent-session:synthetic-recovery-receipt'
const MESSAGE = { clientMessageId: 'synthetic-message-a', text: 'recovered message' }
const CAPACITY = 256
let storage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>
const loaded: Modules[] = []

/** Independent renderer memory over the same durable backend, as in the existing draft tests. */
async function reload(using: NativeChatComposerDraftStorage = storage, hydrate = true): Promise<Modules> {
  vi.resetModules()
  const backend = await import('./native-chat-composer-draft-storage')
  backend.setNativeChatComposerDraftStorageForTests(using)
  const modules = {
    store: await import('./native-chat-composer-draft-store'),
    cache: await import('./native-chat-draft-cache')
  }
  loaded.push(modules)
  if (hydrate) {
    await modules.store.hydrateNativeChatComposerDrafts()
  }
  return modules
}

/** Missing implementation must fail a behavioral assertion, not module loading. */
function recover(modules: Modules, messages: readonly Message[]) {
  const implementation = 'recoverNativeChatComposerDraftMessages' in modules.store
    ? modules.store.recoverNativeChatComposerDraftMessages : undefined
  return typeof implementation === 'function' ? implementation(SCOPE, messages) : undefined
}
function text(modules: Modules): string {
  return modules.cache.readNativeChatDraftCache(SCOPE)
}
async function settled(modules: Modules): Promise<void> {
  await modules.store.nativeChatComposerDraftWriteSettled(SCOPE)
}

beforeEach(() => {
  localStorage.clear()
  storage = createMemoryNativeChatComposerDraftStorage()
  // A stale window must remain stale until it writes; broadcasting would hide the storage race.
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  for (const modules of loaded.splice(0)) {
    modules.store.clearNativeChatComposerDraftsForTests()
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('durable composer recovery receipts', () => {
  it('accepts older stored drafts without receipt metadata and appends after existing text', async () => {
    storage.drafts.set(SCOPE, { text: 'older draft', images: [], savedAt: 1 })
    const modules = await reload()
    expect(recover(modules, [MESSAGE])).toBe(true)
    await settled(modules)
    expect(text(modules)).toBe(`older draft\n\n${MESSAGE.text}`)
    expect(text(await reload())).toBe(text(modules))
  })

  it.each(['typing', 'clearing'] as const)(
    'never replays a recovered message after %s and a renderer reload', async (edit) => {
      const modules = await reload()
      expect(recover(modules, [MESSAGE])).toBe(true)
      await settled(modules)
      const changed = edit === 'typing' ? `${text(modules)}\n\nnew user text` : ''
      modules.cache.writeNativeChatDraftCache(SCOPE, changed)
      await settled(modules)
      const restored = await reload()
      expect(text(restored)).toBe(changed)
      expect(recover(restored, [MESSAGE])).toBe(true)
      await settled(restored)
      expect(text(restored)).toBe(changed)
      expect(text(await reload())).toBe(changed)
    }
  )

  it('keeps distinct message IDs even when their text is identical', async () => {
    const modules = await reload()
    const duplicateText = { clientMessageId: 'synthetic-message-b', text: MESSAGE.text }
    expect(recover(modules, [MESSAGE])).toBe(true)
    expect(recover(modules, [duplicateText])).toBe(true)
    await settled(modules)
    expect(text(modules)).toBe(`${MESSAGE.text}\n\n${MESSAGE.text}`)
    const restored = await reload()
    expect(recover(restored, [MESSAGE, duplicateText])).toBe(true)
    expect(text(restored)).toBe(`${MESSAGE.text}\n\n${MESSAGE.text}`)
  })

  it('appends only new IDs in a partially overlapping batch without mutating its input', async () => {
    const modules = await reload()
    expect(recover(modules, [MESSAGE])).toBe(true)
    await settled(modules)
    modules.cache.writeNativeChatDraftCache(SCOPE, `${MESSAGE.text}\n\nuser addition`)
    await settled(modules)
    const batch = [MESSAGE, { clientMessageId: 'synthetic-message-b', text: 'second recovery' }]
    const original = structuredClone(batch)
    expect(recover(modules, batch)).toBe(true)
    await settled(modules)
    expect(text(modules)).toBe(`${MESSAGE.text}\n\nuser addition\n\nsecond recovery`)
    expect(batch).toEqual(original)
    const restored = await reload()
    expect(recover(restored, batch)).toBe(true)
    expect(text(restored)).toBe(text(modules))
  })

  it('refuses receipt capacity overflow before changing memory, storage or the source batch', async () => {
    const modules = await reload()
    for (let start = 0; start < CAPACITY; start += 32) {
      const batch = Array.from({ length: 32 }, (_, offset) => ({
        clientMessageId: `synthetic-capacity-${start + offset}`,
        text: `recovery ${start + offset}`
      }))
      expect(recover(modules, batch)).toBe(true)
      await settled(modules)
    }
    const before = text(modules)
    const persisted = structuredClone(storage.drafts.get(SCOPE))
    const overflow = [{ clientMessageId: 'synthetic-overflow', text: 'must remain in source' }]
    const original = structuredClone(overflow)
    expect(recover(modules, overflow)).toBe(false)
    expect(text(modules)).toBe(before)
    await settled(modules)
    expect(storage.drafts.get(SCOPE)).toEqual(persisted)
    expect(overflow).toEqual(original)
    const restored = await reload()
    expect(recover(restored, [{ clientMessageId: 'synthetic-capacity-0', text: 'recovery 0' }])).toBe(true)
    expect(text(restored)).toBe(before)
  })

  it('journals text and receipt together when the backend refuses and deduplicates after recovery', async () => {
    const modules = await reload()
    storage.refuseWrites = true
    expect(recover(modules, [MESSAGE])).toBe(true)
    await settled(modules)
    modules.store.clearNativeChatComposerDraftsForTests()
    storage.refuseWrites = false
    const restored = await reload()
    expect(text(restored)).toBe(MESSAGE.text)
    restored.cache.writeNativeChatDraftCache(SCOPE, `${MESSAGE.text}\n\ntyped after recovery`)
    await settled(restored)
    expect(recover(restored, [MESSAGE])).toBe(true)
    expect(text(restored)).toBe(`${MESSAGE.text}\n\ntyped after recovery`)
  })

  it('retains the source when both journal and backend refuse, then recovers once after repair', async () => {
    const modules = await reload()
    storage.refuseWrites = true
    const refusal = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Synthetic journal refusal', 'QuotaExceededError')
    })
    const batch = [MESSAGE]
    const original = structuredClone(batch)
    expect(recover(modules, batch)).toBe(false)
    await settled(modules)
    expect(storage.drafts.size).toBe(0)
    expect(batch).toEqual(original)
    refusal.mockRestore()
    storage.refuseWrites = false
    expect(recover(modules, batch)).toBe(true)
    await settled(modules)
    expect(text(await reload())).toBe(MESSAGE.text)
  })

  it('preserves receipts when a stale window overwrites ordinary text without seeing the recovery', async () => {
    const stale = await reload()
    const fresh = await reload()
    expect(recover(fresh, [MESSAGE])).toBe(true)
    await settled(fresh)
    expect(text(stale)).toBe('')
    stale.cache.writeNativeChatDraftCache(SCOPE, 'new text from stale window')
    await settled(stale)
    const restored = await reload()
    expect(text(restored)).toBe('new text from stale window')
    expect(recover(restored, [MESSAGE])).toBe(true)
    await settled(restored)
    expect(text(restored)).toBe('new text from stale window')
  })

  it('keeps stored recovery receipts when ordinary typing happens before hydration finishes', async () => {
    const initial = await reload()
    expect(recover(initial, [MESSAGE])).toBe(true)
    await settled(initial)
    const storedBeforeEdit = new Map(storage.drafts)
    let resolve!: (value: ReadonlyMap<string, unknown>) => void
    const pendingRead = new Promise<ReadonlyMap<string, unknown>>((done) => { resolve = done })
    const delayed = await reload({ ...storage, loadAll: () => pendingRead }, false)
    const loading = delayed.store.hydrateNativeChatComposerDrafts()
    delayed.cache.writeNativeChatDraftCache(SCOPE, 'typed before hydration finished')
    resolve(storedBeforeEdit)
    await loading
    await settled(delayed)
    expect(text(delayed)).toBe('typed before hydration finished')
    const restored = await reload()
    expect(recover(restored, [MESSAGE])).toBe(true)
    await settled(restored)
    expect(text(restored)).toBe('typed before hydration finished')
  })

})
