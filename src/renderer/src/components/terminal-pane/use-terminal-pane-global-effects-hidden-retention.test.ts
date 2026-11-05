// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneManager } from '@/lib/pane-manager/pane-manager'
import * as outputScheduler from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { primeTerminalWebglAddon } from '@/lib/pane-manager/pane-webgl-renderer'
import {
  resetHiddenWebglRetentionForTest,
  retainedHiddenWebglOwnerCountForTest
} from '@/lib/pane-manager/terminal-webgl-hidden-retention'
import { useAppStore } from '@/store'
import type { PtyTransport } from './pty-transport-types'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'

type ObservedWebglAddon = {
  disposed: ReturnType<typeof vi.fn>
  clearTextureAtlas: ReturnType<typeof vi.fn>
}

const webgl = vi.hoisted(() => ({ addons: new Map<Terminal, ObservedWebglAddon>() }))

// happy-dom has no GPU; leave the manager, suspension, retention, and xterm real.
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    readonly disposed = vi.fn()
    readonly clearTextureAtlas = vi.fn()
    readonly _renderer = {
      _gl: { isContextLost: () => false, getExtension: () => null },
      _canvas: document.createElement('canvas')
    }

    activate(terminal: Terminal): void {
      webgl.addons.set(terminal, this)
    }

    onContextLoss(): { dispose: () => void } {
      return { dispose: () => {} }
    }

    dispose(): void {
      this.disposed()
    }
  }
}))

type TabVisibility = {
  isVisible: boolean
  isWorktreeActive: boolean
  isActive: boolean
  isChatViewMode: boolean
}

const managers: PaneManager[] = []

function addonFor(terminal: Terminal): ObservedWebglAddon {
  const addon = webgl.addons.get(terminal)
  if (!addon) {
    throw new Error('Expected the real manager to attach the WebGL test addon')
  }
  return addon
}

function createTab(tabId: string) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const manager = new PaneManager(host, {
    linkOpenHint: () => '',
    terminalGpuAcceleration: 'on',
    terminalLigaturesEnabled: () => false,
    terminalInlineImagesEnabled: () => false,
    terminalOptions: () => ({ cols: 80, rows: 24, cursorBlink: true })
  })
  managers.push(manager)
  const pane = manager.createInitialPane({ focus: false })
  const refs = {
    managerRef: { current: manager },
    containerRef: { current: null },
    paneTransportsRef: { current: new Map<number, PtyTransport>() },
    isActiveRef: { current: false },
    isVisibleRef: { current: true }
  }
  let visibility: TabVisibility = {
    isVisible: true,
    isWorktreeActive: true,
    isActive: false,
    isChatViewMode: false
  }
  const hook = renderHook(
    (props: TabVisibility) =>
      useTerminalPaneGlobalEffects({
        tabId,
        ...refs,
        ...props,
        paneCount: 1,
        isSyncFitEnabled: false,
        toggleExpandPane: () => {}
      }),
    { initialProps: visibility }
  )
  const costs = {
    fit: vi.spyOn(manager, 'fitAllRevealedPanes'),
    repaint: vi.spyOn(manager, 'scheduleRevealRepaint'),
    present: vi.spyOn(manager, 'scheduleRevealPresent'),
    atlasReset: vi.spyOn(manager, 'resetWebglTextureAtlases')
  }
  return {
    manager,
    pane,
    addon: addonFor(pane.terminal),
    costs,
    render(update: Partial<TabVisibility>): void {
      visibility = { ...visibility, ...update }
      host.style.display = visibility.isVisible && visibility.isWorktreeActive ? '' : 'none'
      hook.rerender(visibility)
    }
  }
}

describe('ordinary tab WebGL retention through the visibility hook', () => {
  let originalApi: PropertyDescriptor | undefined

  beforeEach(async () => {
    originalApi = Object.getOwnPropertyDescriptor(window, 'api')
    Object.defineProperty(window, 'api', { configurable: true, value: { ui: {}, pty: {} } })
    useAppStore.setState({ terminalLayoutsByTabId: {} })
    resetHiddenWebglRetentionForTest()
    webgl.addons.clear()
    let nextFrameId = 0
    // Keep initial fit and settled paint pending so only the reveal's own work is counted.
    vi.stubGlobal('requestAnimationFrame', () => ++nextFrameId)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm only needs text measurement from this happy-dom canvas double.
    const context = { measureText: () => ({ width: 10 }) } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    await primeTerminalWebglAddon()
  })

  afterEach(() => {
    cleanup()
    for (const manager of managers.splice(0)) {
      manager.destroy()
    }
    resetHiddenWebglRetentionForTest()
    document.body.replaceChildren()
    if (originalApi) {
      Object.defineProperty(window, 'api', originalApi)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('bounds seven ordinary hidden tabs and chooses retained or evicted reveal behavior', () => {
    const flush = vi.spyOn(outputScheduler, 'flushTerminalOutput')
    const tabs = [createTab('tab-0')]
    for (let index = 1; index < 8; index++) {
      tabs[index - 1].render({ isVisible: false })
      tabs.push(createTab(`tab-${index}`))
    }
    const oldest = tabs[0]
    const recent = tabs[6]
    const visible = tabs[7]
    const hiddenContexts = tabs.slice(0, 7).flatMap((tab) => tab.manager.getRenderingDiagnostics())

    expect(hiddenContexts.filter((pane) => pane.hasWebgl)).toHaveLength(6)
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(6)
    expect(oldest.addon.disposed).toHaveBeenCalledOnce()
    expect(oldest.manager.getRenderingDiagnostics()[0].hasWebgl).toBe(false)
    expect(recent.addon.disposed).not.toHaveBeenCalled()
    expect(recent.manager.getRenderingDiagnostics()[0].webglAttachmentDeferred).toBe(true)

    visible.render({ isVisible: false })
    flush.mockClear()
    recent.render({ isVisible: true })

    expect(addonFor(recent.pane.terminal)).toBe(recent.addon)
    expect(recent.addon.disposed).not.toHaveBeenCalled()
    expect(recent.manager.getRenderingDiagnostics()[0].webglAttachmentDeferred).toBe(false)
    expect(recent.pane.terminal.options.cursorBlink).toBe(true)
    expect(flush).not.toHaveBeenCalled()
    expect(recent.costs.fit).not.toHaveBeenCalled()
    expect(recent.costs.repaint).not.toHaveBeenCalled()
    expect(recent.costs.atlasReset).not.toHaveBeenCalled()
    expect(recent.addon.clearTextureAtlas).not.toHaveBeenCalled()
    expect(recent.costs.present).toHaveBeenCalledOnce()

    recent.render({ isVisible: false })
    flush.mockClear()
    oldest.render({ isVisible: true })

    expect(addonFor(oldest.pane.terminal)).not.toBe(oldest.addon)
    expect(oldest.manager.getRenderingDiagnostics()[0].hasWebgl).toBe(true)
    expect(oldest.manager.getRenderingDiagnostics()[0].webglAttachmentDeferred).toBe(false)
    expect(oldest.pane.terminal.options.cursorBlink).toBe(true)
    expect(flush).toHaveBeenCalled()
    expect(oldest.costs.fit).toHaveBeenCalledOnce()
    expect(oldest.costs.repaint).toHaveBeenCalledOnce()
    expect(oldest.costs.present).not.toHaveBeenCalled()
  })

  it('keeps an ordinary hide eligible for light reveal across hidden activity and chat rerenders', () => {
    const tab = createTab('rerendered-tab')
    const flush = vi.spyOn(outputScheduler, 'flushTerminalOutput')
    tab.render({ isVisible: false })
    tab.render({ isActive: true })
    tab.render({ isChatViewMode: true })
    tab.render({ isActive: false, isChatViewMode: false })
    flush.mockClear()

    tab.render({ isVisible: true })

    expect(addonFor(tab.pane.terminal)).toBe(tab.addon)
    expect(tab.addon.disposed).not.toHaveBeenCalled()
    expect(tab.manager.getRenderingDiagnostics()[0].webglAttachmentDeferred).toBe(false)
    expect(tab.pane.terminal.options.cursorBlink).toBe(true)
    expect(flush).not.toHaveBeenCalled()
    expect(tab.costs.fit).not.toHaveBeenCalled()
    expect(tab.costs.repaint).not.toHaveBeenCalled()
    expect(tab.costs.atlasReset).not.toHaveBeenCalled()
    expect(tab.addon.clearTextureAtlas).not.toHaveBeenCalled()
    expect(tab.costs.present).toHaveBeenCalledOnce()
  })

  it('preserves a surface-hide upgrade across later hidden rerenders', () => {
    const tab = createTab('surface-upgrade-tab')
    const flush = vi.spyOn(outputScheduler, 'flushTerminalOutput')
    tab.render({ isVisible: false })
    tab.render({ isWorktreeActive: false })
    tab.render({ isWorktreeActive: true, isChatViewMode: true })
    tab.render({ isChatViewMode: false })
    flush.mockClear()

    tab.render({ isVisible: true })

    expect(flush).toHaveBeenCalled()
    expect(tab.costs.fit).toHaveBeenCalledOnce()
    expect(tab.costs.repaint).toHaveBeenCalledOnce()
    expect(tab.costs.present).not.toHaveBeenCalled()
    expect(tab.pane.terminal.options.cursorBlink).toBe(true)
  })
})
