// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryNativeChatComposerDraftStorage } from './native-chat-composer-draft-storage'

// Imperative image verification must not import or call the application store hook.
vi.mock('@/store', () => ({
  useAppStore: () => {
    throw new Error('Draft verification must not call the application store hook')
  }
}))

let storage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>
const loaded: { clearNativeChatComposerDraftsForTests: () => void }[] = []
const originalPreloadApi = window.api
const IMAGES = [{ id: 'a-1', path: '/repo/shot.png' }]

async function reload() {
  vi.resetModules()
  const storageModule = await import('./native-chat-composer-draft-storage')
  storageModule.setNativeChatComposerDraftStorageForTests(storage)
  const drafts = await import('./native-chat-draft-cache')
  const store = await import('./native-chat-composer-draft-store')
  loaded.push(store)
  await store.hydrateNativeChatComposerDrafts()
  return { drafts, attachments: drafts, store }
}

beforeEach(() => {
  localStorage.clear()
  storage = createMemoryNativeChatComposerDraftStorage()
})

afterEach(() => {
  Object.assign(window, { api: originalPreloadApi })
  for (const store of loaded.splice(0)) {
    store.clearNativeChatComposerDraftsForTests()
  }
})

it('gives a foreign replacement its own check and keeps completed unchanged images settled', async () => {
  const other = await reload()
  const modules = await reload()
  const checks = await import('./native-chat-composer-draft-image-check')
  const memory = await import('./native-chat-composer-draft-memory')
  const scope = 'tab-1:pane'
  const restored = () => modules.store.readNativeChatComposerDraft(scope)
  const old = Promise.withResolvers<boolean>()
  const next = Promise.withResolvers<boolean>()
  const pathExists = vi.fn(({ filePath }: { filePath: string }) => {
    if (filePath === IMAGES[0].path) {
      return old.promise
    }
    if (filePath === '/repo/new.png') {
      return next.promise
    }
    throw new Error(`Unexpected image check: ${filePath}`)
  })
  Object.assign(window, { api: { fs: { pathExists } } })
  other.attachments.appendNativeChatAttachmentCache('tab-1:pane', [IMAGES[0]])
  await vi.waitFor(() => expect(restored().images).toEqual([IMAGES[0]]))
  const first = checks.verifyRestoredNativeChatComposerDraftImages('tab-1:pane')
  expect(pathExists.mock.calls).toEqual([[{ filePath: IMAGES[0].path }]])
  const replacement = { ...IMAGES[0], path: '/repo/new.png' }
  other.store.updateNativeChatComposerDraft(scope, { images: [replacement] }, 'immediate')
  await vi.waitFor(() => expect(restored().images).toEqual([replacement]))
  const second = checks.verifyRestoredNativeChatComposerDraftImages('tab-1:pane')
  expect(pathExists.mock.calls).toEqual([
    [{ filePath: IMAGES[0].path }],
    [{ filePath: replacement.path }]
  ])
  old.resolve(false)
  await first
  expect(memory.restoredImageChecks.get('tab-1:pane')).toHaveLength(1)
  next.reject(new Error('temporarily unavailable'))
  await second
  other.drafts.appendNativeChatDraftCache('tab-1:pane', 'caption')
  await vi.waitFor(() => expect(restored().text).toBe('caption'))
  expect(memory.restoredImageChecks.has('tab-1:pane')).toBe(false)
})
