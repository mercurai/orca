import type { Page } from '@stablyai/playwright-test'
import { PNG } from 'pngjs'
import { expect, test } from './orca-app'
import { writeToPaneTerminal } from './alt-screen-frame'
import { compareTerminalScreenshots } from '../terminal-screenshot-diff'

type FrameColor = 'red' | 'cyan' | 'magenta'
type TerminalRegion = { x: number; y: number; width: number; height: number }
type CompositorFrame = { data: string; width: number; height: number; timestamp: number }
export type CompositorRecording = {
  enabled: boolean
  startedAt: number
  error: string | null
  frames: CompositorFrame[]
}
export type CompositorDiagnostics = {
  terminalRegion?: TerminalRegion
  indicatorRegion?: TerminalRegion
  selectedIndicator?: Buffer
  baselines: { name: string; body: Buffer }[]
}
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

export function cropCompositorFrame(frame: CompositorFrame, region: TerminalRegion): Buffer {
  const source = PNG.sync.read(Buffer.from(frame.data, 'base64'))
  const scaleX = source.width / frame.width
  const scaleY = source.height / frame.height
  const width = Math.round(region.width * scaleX)
  const height = Math.round(region.height * scaleY)
  const crop = new PNG({ width, height })
  PNG.bitblt(
    source,
    crop,
    Math.round(region.x * scaleX),
    Math.round(region.y * scaleY),
    width,
    height,
    0,
    0
  )
  return PNG.sync.write(crop)
}

export async function attachCompositorDiagnostics(
  recording: CompositorRecording,
  diagnostic: CompositorDiagnostics
): Promise<void> {
  const frames = recording.frames.slice(0, 64)
  const rows = frames.map((frame, index) => {
    const terminal = diagnostic.terminalRegion
      ? cropCompositorFrame(frame, diagnostic.terminalRegion)
      : null
    const indicator = diagnostic.indicatorRegion
      ? cropCompositorFrame(frame, diagnostic.indicatorRegion)
      : null
    return {
      index,
      timestamp: frame.timestamp,
      width: frame.width,
      height: frame.height,
      indicatorDiff:
        indicator && diagnostic.selectedIndicator
          ? compareTerminalScreenshots(diagnostic.selectedIndicator, indicator).diffPixels
          : null,
      red: terminal ? foregroundPixelCount(terminal, 'red') : null,
      cyan: terminal ? foregroundPixelCount(terminal, 'cyan') : null,
      magenta: terminal ? foregroundPixelCount(terminal, 'magenta') : null
    }
  })
  const metadata = {
    startedAt: recording.startedAt,
    error: recording.error,
    terminalRegion: diagnostic.terminalRegion,
    indicatorRegion: diagnostic.indicatorRegion,
    rows
  }
  await test.info().attach('retention-compositor-diagnostics', {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(metadata, null, 2))
  })
  const selectedIndex = rows.findIndex((row) => row.indicatorDiff !== null && row.indicatorDiff < 4)
  const indices = new Set([0, 1, selectedIndex !== -1 ? selectedIndex : 2])
  for (const index of indices) {
    const frame = frames[index]
    if (!frame) {
      continue
    }
    await test.info().attach(`retention-compositor-frame-${index}`, {
      body: Buffer.from(frame.data, 'base64'),
      contentType: 'image/png'
    })
    if (diagnostic.terminalRegion) {
      await test.info().attach(`retention-compositor-terminal-${index}`, {
        body: cropCompositorFrame(frame, diagnostic.terminalRegion),
        contentType: 'image/png'
      })
    }
  }
  for (const { name, body } of diagnostic.baselines.slice(0, 4)) {
    await test.info().attach(`retention-${name}`, { body, contentType: 'image/png' })
  }
}

export async function startCompositorRecording(page: Page, recording: CompositorRecording): Promise<void> {
  recording.enabled = false
  recording.frames = []
  recording.error = null
  recording.startedAt = await page.evaluate(() => (performance.timeOrigin + performance.now()) / 1000)
  recording.enabled = true
}

export async function firstCompositorFrame(
  recording: CompositorRecording,
  region: TerminalRegion,
  accepts: (pixels: Buffer, source: CompositorFrame) => boolean
): Promise<{ pixels: Buffer; source: CompositorFrame }> {
  let frame: { pixels: Buffer; source: CompositorFrame } | undefined
  let next = 0
  await expect
    .poll(
      () => {
        if (recording.error) {
          throw new Error(recording.error)
        }
        while (next < recording.frames.length) {
          const source = recording.frames[next++]
          const pixels = cropCompositorFrame(source, region)
          if (accepts(pixels, source)) {
            frame = { pixels, source }
            return true
          }
        }
        return false
      },
      { timeout: 10_000, message: 'Expected a matching frame in the bounded compositor recording' }
    )
    .toBe(true)
  recording.enabled = false
  if (!frame) {
    throw new Error('Compositor frame unavailable')
  }
  return frame
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

export async function prepareTerminalGraphics(page: Page, tabId: string, marker: string) {
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
  await writeToPaneTerminal(page, tabId, terminalFrame(marker))
  await capturedFrame(observation)
  return observation
}
