// @vitest-environment happy-dom

import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneManager } from './pane-manager'
import type { ManagedPaneInternal, PaneManagerOptions } from './pane-manager-types'
import { isTerminalCursorBlinkSuspended } from './pane-cursor-blink-suspension'
import { disposeWebgl, primeTerminalWebglAddon } from './pane-webgl-renderer'
import { resetTerminalWebglAutoDecision } from './terminal-webgl-auto-policy'
import {
  resetHiddenWebglRetentionForTest,
  retainedHiddenWebglOwnerCountForTest
} from './terminal-webgl-hidden-retention'

type ObservedAddon = {
  lost: boolean
  disposed: ReturnType<typeof vi.fn>
  clearTextureAtlas: ReturnType<typeof vi.fn>
  emitContextLoss: () => void
}

const webgl = vi.hoisted(() => ({ addons: new Map<Terminal, ObservedAddon>() }))

// Only the GPU boundary is replaced; manager, xterm, retention and recovery stay real.
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    lost = false
    readonly disposed = vi.fn()
    readonly clearTextureAtlas = vi.fn()
    private onLoss: (() => void) | null = null
    readonly _renderer = {
      _gl: { isContextLost: () => this.lost, getExtension: () => null },
      _canvas: document.createElement('canvas')
    }

    activate(terminal: Terminal): void {
      webgl.addons.set(terminal, this)
    }

    onContextLoss(callback: () => void): { dispose: () => void } {
      this.onLoss = callback
      return {
        dispose: () => {
          this.onLoss = null
        }
      }
    }

    emitContextLoss(): void {
      this.lost = true
      this.onLoss?.()
    }

    dispose(): void {
      this.disposed()
    }
  }
}))

const managers: PaneManager[] = []

function internalPane(value: unknown, paneId: number): ManagedPaneInternal {
  if (typeof value !== 'object' || value === null || !('panes' in value)) {
    throw new Error('Expected a real pane manager')
  }
  if (!(value.panes instanceof Map)) {
    throw new Error('Expected the manager pane map')
  }
  const pane = value.panes.get(paneId)
  if (!(pane?.terminal instanceof Terminal) || typeof pane.webglAttachmentDeferred !== 'boolean') {
    throw new Error('Expected a mounted manager pane')
  }
  return pane
}

function isManagerSuspended(value: unknown): boolean {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('renderingSuspended' in value) ||
    typeof value.renderingSuspended !== 'boolean'
  ) {
    throw new Error('Expected the manager rendering state')
  }
  return value.renderingSuspended
}

function observedAddon(pane: ManagedPaneInternal): ObservedAddon {
  const addon = webgl.addons.get(pane.terminal)
  if (!addon) {
    throw new Error('Expected a WebGL addon attached by the real manager')
  }
  return addon
}

function createManager(paneCount = 1, options: Partial<PaneManagerOptions> = {}) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const manager = new PaneManager(root, {
    linkOpenHint: () => '',
    terminalGpuAcceleration: 'on',
    terminalOptions: () => ({ cols: 80, rows: 24, cursorBlink: true }),
    ...options
  })
  managers.push(manager)
  const panes = Array.from({ length: paneCount }, () => {
    const pane = manager.createInitialPane({ focus: false })
    return internalPane(manager, pane.id)
  })
  return { manager, panes }
}

function expectSuspended(manager: PaneManager, panes: ManagedPaneInternal[]): void {
  expect(isManagerSuspended(manager)).toBe(true)
  for (const pane of panes) {
    expect(pane.webglAttachmentDeferred).toBe(true)
    expect(pane.terminal.options.cursorBlink).toBe(false)
    expect(isTerminalCursorBlinkSuspended(pane.terminal)).toBe(true)
  }
}

describe('atomic light rendering resume', () => {
  let originalApi: PropertyDescriptor | undefined

  beforeEach(async () => {
    originalApi = Object.getOwnPropertyDescriptor(window, 'api')
    resetHiddenWebglRetentionForTest()
    resetTerminalWebglAutoDecision()
    webgl.addons.clear()
    let nextFrameId = 0
    vi.stubGlobal('requestAnimationFrame', () => ++nextFrameId)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm only measures text using this happy-dom canvas double.
    const context = { measureText: () => ({ width: 10 }) } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    await primeTerminalWebglAddon()
  })

  afterEach(() => {
    for (const manager of managers.splice(0)) {
      manager.destroy()
    }
    resetHiddenWebglRetentionForTest()
    resetTerminalWebglAutoDecision()
    document.body.replaceChildren()
    if (originalApi) {
      Object.defineProperty(window, 'api', originalApi)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps retained addons and restores each cursor while releasing suspension and retention', () => {
    const { manager, panes } = createManager(2)
    panes[1].terminal.options.cursorBlink = false
    const addons = panes.map((pane) => pane.webglAddon)
    manager.suspendRendering()
    const attach = panes.map((pane) => vi.spyOn(pane.terminal, 'loadAddon'))
    expectSuspended(manager, panes)
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(1)

    expect(manager.tryResumeRenderingWithoutRecreation()).toBe(true)

    expect(isManagerSuspended(manager)).toBe(false)
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(0)
    expect(panes.map((pane) => pane.terminal.options.cursorBlink)).toEqual([true, false])
    for (const [index, pane] of panes.entries()) {
      expect(pane.webglAddon).toBe(addons[index])
      expect(pane.webglAttachmentDeferred).toBe(false)
      expect(isTerminalCursorBlinkSuspended(pane.terminal)).toBe(false)
      expect(attach[index]).not.toHaveBeenCalled()
      expect(observedAddon(pane).disposed).not.toHaveBeenCalled()
      expect(observedAddon(pane).clearTextureAtlas).not.toHaveBeenCalled()
    }
  })

  it('refuses a missing later addon atomically and preserves the original retention order', () => {
    const oldest = createManager(2)
    oldest.manager.suspendRendering()
    disposeWebgl(oldest.panes[1])
    const firstAddon = oldest.panes[0].webglAddon
    const newer = createManager(5)
    newer.manager.suspendRendering()
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(2)

    expect(oldest.manager.tryResumeRenderingWithoutRecreation()).toBe(false)

    expectSuspended(oldest.manager, oldest.panes)
    expect(oldest.panes[0].webglAddon).toBe(firstAddon)
    expect(oldest.panes[1].webglAddon).toBeNull()
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(2)
    const newest = createManager()
    newest.manager.suspendRendering()
    expect(oldest.panes[0].webglAddon).toBeNull()
    expect(newer.panes.every((pane) => pane.webglAddon !== null)).toBe(true)
    expect(newest.panes[0].webglAddon).not.toBeNull()
  })

  for (const fallback of ['off', 'auto', 'pane-disabled'] as const) {
    it(`resumes an intentional ${fallback} DOM fallback without creating WebGL`, () => {
      if (fallback === 'auto') {
        vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64')
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)')
        Object.defineProperty(window, 'api', {
          configurable: true,
          value: { platform: { get: () => ({ displayServer: 'wayland' }) } }
        })
      }
      const {
        manager,
        panes: [pane]
      } = createManager(1, {
        terminalGpuAcceleration: fallback === 'pane-disabled' ? 'on' : fallback
      })
      if (fallback === 'pane-disabled') {
        manager.setPaneGpuRendering(pane.id, false)
      }
      expect(pane.webglAddon).toBeNull()
      manager.suspendRendering()
      const attach = vi.spyOn(pane.terminal, 'loadAddon')

      expect(manager.tryResumeRenderingWithoutRecreation()).toBe(true)

      expect(isManagerSuspended(manager)).toBe(false)
      expect(pane.webglAddon).toBeNull()
      expect(pane.webglAttachmentDeferred).toBe(false)
      expect(pane.terminal.options.cursorBlink).toBe(true)
      expect(attach).not.toHaveBeenCalled()
    })
  }

  it('leaves forced-on attach backoff intact until heavy recovery retries the missing addon', () => {
    const {
      manager,
      panes: [pane]
    } = createManager()
    manager.suspendRendering()
    disposeWebgl(pane)
    pane.webglAttachFailedSinceRecovery = true

    expect(manager.tryResumeRenderingWithoutRecreation()).toBe(false)

    expectSuspended(manager, [pane])
    expect(pane.webglAttachFailedSinceRecovery).toBe(true)
    expect(pane.webglAddon).toBeNull()
    manager.resumeRendering()
    expect(pane.webglAttachFailedSinceRecovery).toBe(false)
    expect(pane.webglAddon).not.toBeNull()
  })

  for (const losses of [1, 3]) {
    it(`leaves ${losses} recorded context losses unchanged for bounded heavy recovery`, () => {
      const now = 1_700_000_000_000
      vi.spyOn(Date, 'now').mockReturnValue(now)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const {
        manager,
        panes: [pane]
      } = createManager()
      for (let loss = 0; loss < losses; loss++) {
        observedAddon(pane).emitContextLoss()
        if (loss + 1 < losses) {
          manager.resumeRendering()
        }
      }
      const timestamps = [now - 60_001, ...(pane.webglContextLossTimestamps ?? [])]
      pane.webglContextLossTimestamps = timestamps
      manager.suspendRendering()

      expect(manager.tryResumeRenderingWithoutRecreation()).toBe(false)

      expectSuspended(manager, [pane])
      expect(pane.webglDisabledAfterContextLoss).toBe(true)
      expect(pane.webglAddon).toBeNull()
      expect(pane.webglContextLossTimestamps).toBe(timestamps)
      expect(pane.webglContextLossTimestamps).toEqual([now - 60_001, ...Array(losses).fill(now)])
      manager.resumeRendering()
      expect(pane.webglContextLossTimestamps).toEqual(Array(losses).fill(now))
      expect(pane.webglDisabledAfterContextLoss).toBe(losses === 3)
      expect(pane.webglAddon !== null).toBe(losses < 3)
    })
  }

  it('refuses a retained addon whose rebuild was deferred while hidden', () => {
    const {
      manager,
      panes: [pane]
    } = createManager()
    manager.suspendRendering()
    manager.rebuildPaneWebgl(pane.id)
    const addon = pane.webglAddon

    expect(manager.tryResumeRenderingWithoutRecreation()).toBe(false)

    expectSuspended(manager, [pane])
    expect(pane.webglRebuildDeferred).toBe(true)
    expect(pane.webglAddon).toBe(addon)
    expect(observedAddon(pane).disposed).not.toHaveBeenCalled()
  })

  it('refuses a retained context already lost before its event arrives', () => {
    const {
      manager,
      panes: [pane]
    } = createManager()
    manager.suspendRendering()
    observedAddon(pane).lost = true
    const addon = pane.webglAddon

    expect(manager.tryResumeRenderingWithoutRecreation()).toBe(false)

    expectSuspended(manager, [pane])
    expect(pane.webglAddon).toBe(addon)
    expect(pane.webglDisabledAfterContextLoss).toBe(false)
    expect(observedAddon(pane).disposed).not.toHaveBeenCalled()
  })

  it('requires recovery when GPU mode becomes eligible while the pane is hidden', () => {
    const {
      manager,
      panes: [pane]
    } = createManager(1, { terminalGpuAcceleration: 'off' })
    manager.suspendRendering()
    manager.setTerminalGpuAcceleration('on')

    expect(manager.tryResumeRenderingWithoutRecreation()).toBe(false)

    expectSuspended(manager, [pane])
    expect(pane.webglAddon).toBeNull()
    manager.resumeRendering()
    expect(pane.webglAddon).not.toBeNull()
  })

  it('requires recovery for a WebGL-eligible pane first mounted behind a hidden surface', () => {
    const {
      manager,
      panes: [pane]
    } = createManager(1, { initialRenderingSuspended: true })
    expect(pane.webglAddon).toBeNull()

    expect(manager.tryResumeRenderingWithoutRecreation()).toBe(false)

    expectSuspended(manager, [pane])
    manager.resumeRendering()
    expect(pane.webglAddon).not.toBeNull()
  })

  it('keeps a split created after suspension deferred until heavy recovery', () => {
    const {
      manager,
      panes: [original]
    } = createManager()
    manager.suspendRendering()
    const split = manager.splitPane(original.id, 'vertical')
    if (!split) {
      throw new Error('Expected a split pane')
    }
    const created = internalPane(manager, split.id)

    expectSuspended(manager, [original, created])
    expect(created.webglAddon).toBeNull()
    expect(manager.tryResumeRenderingWithoutRecreation()).toBe(false)
    expectSuspended(manager, [original, created])

    manager.resumeRendering()
    expect(original.webglAddon).not.toBeNull()
    expect(created.webglAddon).not.toBeNull()
    expect(created.terminal.options.cursorBlink).toBe(true)
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(0)
  })

  it('destroying a retained manager releases its owner and disposes its addon', () => {
    const {
      manager,
      panes: [pane]
    } = createManager()
    const addon = observedAddon(pane)
    manager.suspendRendering()
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(1)

    manager.destroy()

    expect(retainedHiddenWebglOwnerCountForTest()).toBe(0)
    expect(addon.disposed).toHaveBeenCalledTimes(1)
    expect(manager.getPaneCount()).toBe(0)
  })
})
