import { expect, it, vi } from 'vitest'
import { loadMainWindowAfterCoreServices } from './main-window-core-services-readiness'

it('waits for core readiness before loading the current window', async () => {
  const ready = Promise.withResolvers<void>()
  const load = vi.fn()
  const failed = vi.fn()
  const loading = loadMainWindowAfterCoreServices({
    ready: ready.promise,
    isCurrent: () => true,
    load,
    failed
  })

  expect(load).not.toHaveBeenCalled()
  ready.resolve()
  await loading
  expect(load).toHaveBeenCalledOnce()
  expect(failed).not.toHaveBeenCalled()
})

it('reports unavailable host preparation without withholding the desktop', async () => {
  const failure = new Error('WSL records unreadable')
  const order: string[] = []
  const failed = vi.fn((error: unknown) => {
    expect(error).toBe(failure)
    order.push('failed')
  })

  await loadMainWindowAfterCoreServices({
    ready: Promise.reject(failure),
    isCurrent: () => true,
    load: () => order.push('load'),
    failed
  })

  expect(order).toEqual(['failed', 'load'])
  expect(failed).toHaveBeenCalledOnce()
})

it('does not load a closed or replaced window after readiness resolves', async () => {
  const ready = Promise.withResolvers<void>()
  let current = true
  const load = vi.fn()
  const loading = loadMainWindowAfterCoreServices({
    ready: ready.promise,
    isCurrent: () => current,
    load,
    failed: vi.fn()
  })

  current = false
  ready.resolve()
  await loading
  expect(load).not.toHaveBeenCalled()
})
