import type { Page } from '@stablyai/playwright-test'
import { PNG } from 'pngjs'
import { expect } from './orca-app'

type FrameColor = 'red' | 'cyan' | 'magenta'
type ObservedWebglRenderer = {
  _canvas: HTMLCanvasElement
  _gl: WebGLRenderingContext | WebGL2RenderingContext
  renderRows: (start: number, end: number) => void
}

export function terminalFrame(marker: string, color: FrameColor = 'red'): string {
  const rows = [marker, ...Array.from({ length: 6 }, () => '0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ')]
  const rgb = color === 'cyan' ? '0;255;255' : color === 'magenta' ? '255;0;255' : '255;0;0'
  return `\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[38;2;${rgb}m${rows.join('\r\n')}\x1b[0m`
}

export function foregroundPixelCount(frame: Buffer, color: FrameColor): number {
  const { data } = PNG.sync.read(frame)
  let count = 0
  for (let index = 0; index < data.length; index += 4) {
    const matches =
      color === 'cyan'
        ? data[index] < 64 && data[index + 1] > 128 && data[index + 2] > 128
        : color === 'magenta'
          ? data[index] > 128 && data[index + 1] < 64 && data[index + 2] > 128
          : data[index] > 128 && data[index + 1] < 64 && data[index + 2] < 64
    if (matches && data[index + 3] > 64) {
      count += 1
    }
  }
  return count
}

export async function observeGraphics(page: Page, tabId: string) {
  return page.evaluateHandle((id) => {
    function isWebglRenderer(value: unknown): value is ObservedWebglRenderer {
      if (
        !value ||
        typeof value !== 'object' ||
        !('_canvas' in value) ||
        !('_gl' in value) ||
        !('renderRows' in value)
      ) {
        return false
      }
      return (
        value._canvas instanceof HTMLCanvasElement &&
        (value._gl instanceof WebGLRenderingContext || value._gl instanceof WebGL2RenderingContext) &&
        typeof value.renderRows === 'function'
      )
    }
    const manager = window.__paneManagers?.get(id)
    if (!manager) {
      throw new Error(`No pane manager for ${id}`)
    }
    const internals: unknown = manager
    if (
      !internals ||
      typeof internals !== 'object' ||
      !('panes' in internals) ||
      !(internals.panes instanceof Map) ||
      internals.panes.size !== 1
    ) {
      throw new Error('Expected one internal pane')
    }
    const pane: unknown = internals.panes.values().next().value
    if (!pane || typeof pane !== 'object' || !('webglAddon' in pane)) {
      throw new Error('Internal pane unavailable')
    }
    const addon = pane.webglAddon
    if (!addon || typeof addon !== 'object' || !('_renderer' in addon)) {
      throw new Error('WebGL addon required')
    }
    const renderer = addon._renderer
    if (!isWebglRenderer(renderer)) {
      throw new Error('WebGL canvas, context and renderRows required; use the GPU-enabled E2E lane')
    }
    const canvas = renderer._canvas
    const gl = renderer._gl
    let frame: string | null = null
    let restore = (): void => {}
    const arm = (): void => {
      restore()
      frame = null
      const renderRows = renderer.renderRows
      restore = () => {
        renderer.renderRows = renderRows
      }
      renderer.renderRows = (start, end) => {
        renderRows.call(renderer, start, end)
        if (
          frame === null &&
          window.__store?.getState().activeTabId === id &&
          canvas.getClientRects().length > 0 &&
          canvas.width > 0 &&
          canvas.height > 0
        ) {
          const copy = document.createElement('canvas')
          copy.width = canvas.width
          copy.height = canvas.height
          const context = copy.getContext('2d')
          if (!context) {
            throw new Error('Pixel capture context unavailable')
          }
          // Copy before Chromium discards the WebGL drawing buffer.
          context.drawImage(canvas, 0, 0)
          frame = copy.toDataURL('image/png')
          restore()
        }
      }
    }
    return {
      addon,
      gl,
      arm,
      frame: () => frame,
      restore: () => restore(),
      state: () => ({
        sameAddon: pane.webglAddon === addon,
        lost: gl.isContextLost(),
        width: canvas.width,
        height: canvas.height,
        visible: canvas.getClientRects().length > 0,
        diagnostics: manager.getRenderingDiagnostics()
      })
    }
  }, tabId)
}

export type GraphicsObservation = Awaited<ReturnType<typeof observeGraphics>>

export async function capturedFrame(observation: GraphicsObservation): Promise<Buffer> {
  await expect
    .poll(() => observation.evaluate((value) => value.frame()), {
      timeout: 10_000,
      message: 'Expected a natural WebGL render without a test-forced refresh'
    })
    .not.toBeNull()
  const data = await observation.evaluate((value) => value.frame())
  if (!data) {
    throw new Error('No captured WebGL frame')
  }
  return Buffer.from(data.slice(data.indexOf(',') + 1), 'base64')
}

export async function prepareTerminalGraphics(
  page: Page,
  tabId: string,
  writeFrame: () => Promise<void>
) {
  await page.evaluate((id) => {
    window.__paneManagers?.get(id)?.setTerminalGpuAcceleration('on')
  }, tabId)
  await expect
    .poll(() =>
      page.evaluate((id) => {
        return window.__paneManagers?.get(id)?.getRenderingDiagnostics()
      }, tabId)
    )
    .toEqual([
      expect.objectContaining({
        terminalGpuAcceleration: 'on',
        gpuRenderingEnabled: true,
        hasWebgl: true,
        webglAttachmentDeferred: false
      })
    ])
  const observation = await observeGraphics(page, tabId)
  await observation.evaluate((value) => value.arm())
  await writeFrame()
  await capturedFrame(observation)
  return observation
}
