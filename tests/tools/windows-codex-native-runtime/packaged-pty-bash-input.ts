import { existsSync, readFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { typeLine } from '../win-update-e2e/app-driver.mjs'
import { delay } from './packaged-pty-app-support'
import {
  bashInputSentinelCommand,
  bashProbeSourceCommand,
  type BashInputFiles,
  writeBashProbeScript
} from './packaged-pty-bash-probe'

const KEYBOARD_SENTINEL = 'keyboard-input-ok'
const PROVIDER_SENTINEL = 'provider-write-observed'

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

function markerMatches(path: string, expected: string): boolean {
  return existsSync(path) && readFileSync(path, 'utf8').replace(/\r\n/gu, '\n') === `${expected}\n`
}

async function waitForMarker(path: string, expected: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (markerMatches(path, expected)) {
      return true
    }
    await delay(100)
  }
  return markerMatches(path, expected)
}

async function rendererInputState(page: Page, tabId: string) {
  return page.evaluate((targetTabId) => {
    const visible = (element: HTMLElement): boolean =>
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden' &&
      getComputedStyle(element).display !== 'none'
    const inputs = Array.from(document.querySelectorAll<HTMLElement>('[data-terminal-tab-id]'))
      .filter(
        (surface) =>
          surface.dataset.terminalTabId === targetTabId &&
          !surface.hasAttribute('data-pane-prevent-terminal-focus') &&
          visible(surface)
      )
      .flatMap((surface) =>
        Array.from(surface.querySelectorAll<HTMLTextAreaElement>('.xterm-helper-textarea')).filter(
          visible
        )
      )
    return {
      documentFocused: document.hasFocus(),
      activeIsXterm: inputs.some((input) => input === document.activeElement),
      visibleInputs: inputs.length,
      disabledInputs: inputs.filter((input) => input.disabled).length,
      ariaDisabledInputs: inputs.filter((input) => input.getAttribute('aria-disabled') === 'true')
        .length
    }
  }, tabId)
}

function executableCategory(value: string | null): string {
  const name = value
    ?.trim()
    .split(/[\\/]/u)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.exe$/u, '')
  return name
    ? ['bash', 'pwsh', 'powershell', 'cmd', 'codex'].includes(name)
      ? name
      : 'other'
    : 'none'
}

async function hostInputState(page: Page, ptyId: string) {
  const inspection = await withTimeout(
    page.evaluate((id) => window.api.pty.inspectProcess(id, { scanChildProcesses: true }), ptyId),
    1_500
  )
  if (!inspection) {
    return null
  }
  if ('verdict' in inspection) {
    return { host: inspection.verdict }
  }
  return {
    host: 'observed',
    foreground: executableCategory(inspection.foregroundProcess),
    verdict: inspection.foregroundProcessEvidence?.verdict ?? 'absent',
    children: inspection.childProcessEvidence ?? 'unavailable'
  }
}

async function acceptedWriteDiagnostic(page: Page, ptyId: string, markerPath: string) {
  const data = `${bashInputSentinelCommand(markerPath, PROVIDER_SENTINEL)}\r`
  const accepted = await withTimeout(
    page.evaluate(
      ({ id, input }) =>
        window.api.pty.writeAccepted(id, input, 'driving', { requireWriteSettlement: true }),
      { id: ptyId, input: data }
    ),
    1_500
  )
  return {
    accepted: accepted === null ? 'unavailable' : accepted ? 'accepted' : 'rejected',
    executed: await waitForMarker(markerPath, PROVIDER_SENTINEL, 2_000)
  }
}

export async function typeBashProbe(
  page: Page,
  ptyId: string,
  tabId: string,
  files: BashInputFiles
): Promise<void> {
  writeBashProbeScript(files.script, files)
  await typeLine(page, bashInputSentinelCommand(files.keyboardSentinel, KEYBOARD_SENTINEL), tabId)
  if (!(await waitForMarker(files.keyboardSentinel, KEYBOARD_SENTINEL, 10_000))) {
    const [renderer, host] = await Promise.all([
      withTimeout(rendererInputState(page, tabId), 1_500),
      withTimeout(hostInputState(page, ptyId), 3_000)
    ])
    const provider = await acceptedWriteDiagnostic(page, ptyId, files.writeAcceptedSentinel)
    throw new Error(
      `The typed Bash input sentinel was not executed (${JSON.stringify({ renderer, host, provider })})`
    )
  }
  await typeLine(page, bashProbeSourceCommand(files.script), tabId)
}
