import type { Page } from '@stablyai/playwright-test'
import { PNG } from 'pngjs'
import { expect, test } from './orca-app'
import { compareTerminalScreenshots } from '../terminal-screenshot-diff'
import { foregroundPixelCount } from './terminal-webgl-retention-graphics'

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

export async function captureCompositorFrames(page: Page, recording: CompositorRecording) {
  const cdp = await page.context().newCDPSession(page)
  cdp.on('Page.screencastFrame', (frame) => {
    if (recording.enabled) {
      const timestamp = frame.metadata.timestamp
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
        recording.error = 'Compositor frame lacks a callback timestamp'
      } else if (timestamp >= recording.startedAt) {
        if (recording.frames.length < 64) {
          recording.frames.push({
            data: frame.data,
            width: frame.metadata.deviceWidth,
            height: frame.metadata.deviceHeight,
            timestamp
          })
        }
        if (recording.frames.length === 64) {
          recording.error = 'Compositor recording reached its 64-frame limit'
        }
      }
    }
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
  })
  await cdp.send('Page.enable')
  // CDP keeps the isolated hidden renderer painting without activating its window.
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  return cdp
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
  const selectedIndex =
    rows
      .filter((row) => row.indicatorDiff !== null && row.indicatorDiff < 4)
      .sort((left, right) => left.timestamp - right.timestamp)[0]?.index ?? -1
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

export async function startCompositorRecording(
  page: Page,
  recording: CompositorRecording
): Promise<void> {
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

export function firstRecordedCompositorFrames(
  recording: CompositorRecording,
  region: TerminalRegion,
  accepts: (source: CompositorFrame) => boolean
): Buffer[] {
  expect(recording.enabled).toBe(false)
  if (recording.error) {
    throw new Error(recording.error)
  }
  // PNG encoding can reorder delivery; equal callback timestamps remain ambiguous.
  const selected = recording.frames
    .filter(accepts)
    .sort((left, right) => left.timestamp - right.timestamp)
  const first = selected[0]
  if (!first) {
    throw new Error('No selected-tab frame in the bounded compositor recording')
  }
  return selected
    .filter((frame) => frame.timestamp === first.timestamp)
    .map((frame) => cropCompositorFrame(frame, region))
}
