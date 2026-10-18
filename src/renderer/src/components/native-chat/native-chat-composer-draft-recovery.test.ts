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
async function recover(modules: Modules, messages: readonly Message[]) {
  const implementation = 'recoverNativeChatComposerDraftMessages' in modules.store
    ? modules.store.recoverNativeChatComposerDraftMessages : undefined
  return typeof implementation === 'function' ? await implementation(SCOPE, messages) : undefined
}
function text(modules: Modules): string {
  return modules.cache.readNativeChatDraftCache(SCOPE)
}
const settled = (modules: Modules) => modules.store.nativeChatComposerDraftWriteSettled(SCOPE)

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
    expect(await recover(modules, [MESSAGE])).toBe(true)
    await settled(modules)
    expect(text(modules)).toBe(`older draft\n\n${MESSAGE.text}`)
    expect(text(await reload())).toBe(text(modules))
  })

  it.each(['typing', 'clearing'] as const)(
    'never replays a recovered message after %s and a renderer reload', async (edit) => {
      const modules = await reload()
      expect(await recover(modules, [MESSAGE])).toBe(true)
      await settled(modules)
      const changed = edit === 'typing' ? `${text(modules)}\n\nnew user text` : ''
      modules.cache.writeNativeChatDraftCache(SCOPE, changed)
      await settled(modules)
      const restored = await reload()
      expect(text(restored)).toBe(changed)
      expect(await recover(restored, [MESSAGE])).toBe(true)
      await settled(restored)
      expect(text(restored)).toBe(changed)
      expect(text(await reload())).toBe(changed)
    }
  )

  it('keeps distinct message IDs even when their text is identical', async () => {
    const modules = await reload()
    const duplicateText = { clientMessageId: 'synthetic-message-b', text: MESSAGE.text }
    expect(await recover(modules, [MESSAGE])).toBe(true)
    expect(await recover(modules, [duplicateText])).toBe(true)
    await settled(modules)
    expect(text(modules)).toBe(`${MESSAGE.text}\n\n${MESSAGE.text}`)
    const restored = await reload()
    expect(await recover(restored, [MESSAGE, duplicateText])).toBe(true)
    expect(text(restored)).toBe(`${MESSAGE.text}\n\n${MESSAGE.text}`)
  })

  it('appends only new IDs in a partially overlapping batch without mutating its input', async () => {
    const modules = await reload()
    expect(await recover(modules, [MESSAGE])).toBe(true)
    await settled(modules)
    modules.cache.writeNativeChatDraftCache(SCOPE, `${MESSAGE.text}\n\nuser addition`)
    await settled(modules)
    const batch = [MESSAGE, { clientMessageId: 'synthetic-message-b', text: 'second recovery' }]
    const original = structuredClone(batch)
    expect(await recover(modules, batch)).toBe(true)
    await settled(modules)
    expect(text(modules)).toBe(`${MESSAGE.text}\n\nuser addition\n\nsecond recovery`)
    expect(batch).toEqual(original)
    const restored = await reload()
    expect(await recover(restored, batch)).toBe(true)
    expect(text(restored)).toBe(text(modules))
  })

  it('refuses receipt capacity overflow before changing memory, storage or the source batch', async () => {
    const modules = await reload()
    for (let start = 0; start < CAPACITY; start += 32) {
      const batch = Array.from({ length: 32 }, (_, offset) => ({
        clientMessageId: `synthetic-capacity-${start + offset}`,
        text: `recovery ${start + offset}`
      }))
      expect(await recover(modules, batch)).toBe(true)
      await settled(modules)
    }
    const before = text(modules)
    const persisted = structuredClone(storage.drafts.get(SCOPE))
    const overflow = [{ clientMessageId: 'synthetic-overflow', text: 'must remain in source' }]
    const original = structuredClone(overflow)
    expect(await recover(modules, overflow)).toBe(false)
    expect(text(modules)).toBe(before)
    await settled(modules)
    expect(storage.drafts.get(SCOPE)).toEqual(persisted)
    expect(overflow).toEqual(original)
    const restored = await reload()
    expect(await recover(restored, [{ clientMessageId: 'synthetic-capacity-0', text: 'recovery 0' }])).toBe(true)
    expect(text(restored)).toBe(before)
  })

  it('retains the source when the backend refuses even if the local journal is writable', async () => {
    const modules = await reload()
    storage.refuseWrites = true
    const source = [MESSAGE]
    const original = structuredClone(source)
    expect(await recover(modules, source)).toBe(false)
    expect(source).toEqual(original)
    expect(storage.drafts.size).toBe(0)
    storage.refuseWrites = false
    expect(await recover(modules, source)).toBe(true)
    await settled(modules)
    const restored = await reload()
    expect(text(restored)).toBe(MESSAGE.text)
    expect(await recover(restored, source)).toBe(true)
    expect(text(restored)).toBe(MESSAGE.text)
  })

  it('retains the source when both journal and backend refuse, then recovers once after repair', async () => {
    const modules = await reload()
    storage.refuseWrites = true
    const refusal = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Synthetic journal refusal', 'QuotaExceededError')
    })
    const batch = [MESSAGE]
    const original = structuredClone(batch)
    expect(await recover(modules, batch)).toBe(false)
    await settled(modules)
    expect(storage.drafts.size).toBe(0)
    expect(batch).toEqual(original)
    refusal.mockRestore()
    storage.refuseWrites = false
    expect(await recover(modules, batch)).toBe(true)
    await settled(modules)
    expect(text(await reload())).toBe(MESSAGE.text)
  })

  it('preserves receipts when a stale window overwrites ordinary text without seeing the recovery', async () => {
    const stale = await reload()
    const fresh = await reload()
    expect(await recover(fresh, [MESSAGE])).toBe(true)
    await settled(fresh)
    expect(text(stale)).toBe('')
    stale.cache.writeNativeChatDraftCache(SCOPE, 'new text from stale window')
    await settled(stale)
    const restored = await reload()
    expect(text(restored)).toBe('new text from stale window')
    expect(await recover(restored, [MESSAGE])).toBe(true)
    await settled(restored)
    expect(text(restored)).toBe('new text from stale window')
  })

  it('keeps stored recovery receipts when ordinary typing happens before hydration finishes', async () => {
    const initial = await reload()
    expect(await recover(initial, [MESSAGE])).toBe(true)
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
    expect(await recover(restored, [MESSAGE])).toBe(true)
    await settled(restored)
    expect(text(restored)).toBe('typed before hydration finished')
  })

  it('refuses recovery when its stored workspace is deleted before hydration exposes its owner', async () => {
    const owner = { workspaceId: 'synthetic-workspace', executionHostId: 'local' as const }
    storage.drafts.set(SCOPE, {
      text: 'owned draft', images: [], savedAt: 1, owner,
      recoveredMessageIds: ['synthetic-previous-recovery']
    })
    const snapshot = new Map(storage.drafts)
    let release!: (value: ReadonlyMap<string, unknown>) => void
    const pending = new Promise<ReadonlyMap<string, unknown>>((resolve) => { release = resolve })
    const modules = await reload({ ...storage, loadAll: () => pending }, false)
    // No resolver: only the still-loading stored record can establish this draft's owner.
    const recovering = recover(modules, [MESSAGE])
    modules.store.deleteNativeChatComposerDraftsOwnedBy(owner)
    release(snapshot)
    expect(await recovering).toBe(false)
    await settled(modules)
    expect(text(modules)).toBe('')
    expect(storage.drafts.has(SCOPE)).toBe(false)
    expect(text(await reload())).toBe('')
  })

  it('rejects a stale-window recovery when another window filled the final receipt slot', async () => {
    const seed = await reload()
    for (let start = 0; start < CAPACITY - 1; start += 32) {
      const batch = Array.from({ length: Math.min(32, CAPACITY - 1 - start) }, (_, offset) => ({
        clientMessageId: `synthetic-race-${start + offset}`, text: `receipt ${start + offset}`
      }))
      expect(await recover(seed, batch)).toBe(true)
    }
    const stale = await reload()
    const fresh = await reload()
    const last = { clientMessageId: 'synthetic-final-slot', text: 'last committed recovery' }
    expect(await recover(fresh, [last])).toBe(true)
    const before = text(stale)
    const source = [{ clientMessageId: 'synthetic-racing-overflow', text: 'source must remain' }]
    const original = structuredClone(source)
    expect(await recover(stale, source)).toBe(false)
    expect(text(stale)).toBe(before)
    expect(source).toEqual(original)
    const restored = await reload()
    const committed = text(restored)
    expect(await recover(restored, [last])).toBe(true)
    expect(text(restored)).toBe(committed)
    expect(text(restored)).not.toContain('source must remain')
  })

  it('serializes simultaneous overlapping recoveries by message identity', async () => {
    const first = await reload()
    const second = await reload()
    const shared = { clientMessageId: 'synthetic-shared', text: 'shared recovery' }
    const tail = { clientMessageId: 'synthetic-tail', text: 'tail recovery' }
    expect(await Promise.all([
      recover(first, [MESSAGE, shared]), recover(second, [shared, tail])
    ])).toEqual([true, true])
    const restored = await reload()
    for (const message of [MESSAGE, shared, tail]) {
      expect(text(restored).split(message.text)).toHaveLength(2)
    }
    const before = text(restored)
    expect(await recover(restored, [MESSAGE, shared, tail])).toBe(true)
    expect(text(restored)).toBe(before)
  })

  it('keeps user text typed during a deferred recovery commit', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((done) => { release = done })
    const started = new Promise<void>((done) => { entered = done })
    const delayed: NativeChatComposerDraftStorage = {
      ...storage,
      update: async (scopeKey, apply) => {
        entered()
        await gate
        return storage.update(scopeKey, apply)
      }
    }
    const modules = await reload(delayed)
    expect('recoverNativeChatComposerDraftMessages' in modules.store).toBe(true)
    const recovery = recover(modules, [MESSAGE])
    expect(await Promise.race([started.then(() => true), recovery.then(() => false)])).toBe(true)
    modules.cache.writeNativeChatDraftCache(SCOPE, 'typed during recovery')
    release()
    expect(await recovery).toBe(true)
    await settled(modules)
    expect(text(modules)).toContain('typed during recovery')
    expect(text(modules).split(MESSAGE.text)).toHaveLength(2)
    const restored = await reload()
    expect(text(restored)).toContain('typed during recovery')
    expect(text(restored).split(MESSAGE.text)).toHaveLength(2)
  })

  it('preserves typing after the backend committed but before its acknowledgement resumes recovery', async () => {
    let release!: () => void
    let entered!: () => void
    const acknowledgement = new Promise<void>((done) => { release = done })
    const committed = new Promise<void>((done) => { entered = done })
    const delayed: NativeChatComposerDraftStorage = {
      ...storage,
      update: async (scopeKey, apply) => {
        await storage.update(scopeKey, apply)
        entered()
        await acknowledgement
      }
    }
    const modules = await reload(delayed)
    expect('recoverNativeChatComposerDraftMessages' in modules.store).toBe(true)
    const recovery = recover(modules, [MESSAGE])
    expect(await Promise.race([committed.then(() => true), recovery.then(() => false)])).toBe(true)
    expect(storage.drafts.get(SCOPE)?.text).toBe(MESSAGE.text)
    modules.cache.writeNativeChatDraftCache(SCOPE, 'typed while acknowledgement waited')
    release()
    expect(await recovery).toBe(true)
    await settled(modules)
    expect(text(modules)).toContain('typed while acknowledgement waited')
    expect(text(modules).split(MESSAGE.text)).toHaveLength(2)
    const restored = await reload()
    expect(text(restored)).toContain('typed while acknowledgement waited')
    expect(text(restored).split(MESSAGE.text)).toHaveLength(2)
  })

  it('deduplicates a retained source after commit followed by a crash before source clearing', async () => {
    const modules = await reload()
    const durableSource = [MESSAGE]
    expect(await recover(modules, durableSource)).toBe(true)
    modules.store.clearNativeChatComposerDraftsForTests()
    const restored = await reload()
    expect(await recover(restored, durableSource)).toBe(true)
    expect(durableSource).toEqual([MESSAGE])
    expect(text(restored)).toBe(MESSAGE.text)
    expect(text(await reload())).toBe(MESSAGE.text)
  })

})
