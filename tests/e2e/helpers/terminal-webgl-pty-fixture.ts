import type { Page } from '@stablyai/playwright-test'
import { parseRemoteRuntimePtyId } from '../../../src/shared/remote-runtime-pty-id'
import { readTerminalSendAcknowledgment } from '../../../src/shared/terminal-send-acknowledgment'
import { quotePosixShell } from '../../../src/shared/wsl-login-shell-command'
import { expect } from './orca-app'
import { readActiveScreen } from './alt-screen-frame'
import { callEnvironment } from './paired-host-terminal'

export function localFrameReaderSource(ready: string): string {
  return [
    'process.stdin.setRawMode(true)',
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (chunk) => {",
    '  pending += chunk',
    '  const lines = pending.split(/\\r\\n|\\r|\\n/)',
    "  pending = lines.pop() ?? ''",
    '  for (const line of lines) {',
    '    if (line) {',
    "      process.stdout.write(Buffer.from(line, 'base64'))",
    '    }',
    '  }',
    '})',
    'process.stdin.resume()',
    `process.stdout.write(${JSON.stringify(`${ready}\r\n`)})`
  ].join('\n')
}

export function remoteFrameReaderCommand(marker: string): string {
  return [
    'stty -echo',
    `printf '%s%s\\n' 'RETENTION_READY_' ${quotePosixShell(marker)}`,
    'while IFS= read -r payload; do printf %s "$payload" | base64 -d; done'
  ].join('; ')
}

export async function writePtyFrame(
  page: Page,
  tabId: string,
  data: string,
  marker: string,
  expectedEnvironmentId?: string
): Promise<void> {
  const ptyId = await page.evaluate((id) => {
    const panes = window.__paneManagers?.get(id)?.getPanes()
    if (panes?.length !== 1 || !panes[0].container.dataset.ptyId) {
      throw new Error(`Expected one bound PTY for ${id}`)
    }
    return panes[0].container.dataset.ptyId
  }, tabId)
  const text = `${Buffer.from(data).toString('base64')}\r`
  const remote = parseRemoteRuntimePtyId(ptyId)
  if (expectedEnvironmentId) {
    expect(remote?.environmentId).toBe(expectedEnvironmentId)
    if (!remote) {
      throw new Error('Managed fixture terminal has no remote PTY handle')
    }
    const result = await callEnvironment(page, expectedEnvironmentId, 'terminal.send', {
      terminal: remote.handle,
      text,
      client: { id: 'orca-desktop', type: 'desktop' },
      requireWriteSettlement: true
    })
    expect(readTerminalSendAcknowledgment(result)).toBe('accepted')
    await expect
      .poll(
        async () => {
          const result = await callEnvironment(page, expectedEnvironmentId, 'terminal.read', {
            terminal: remote.handle,
            screen: true,
            limit: 100
          })
          if (!result || typeof result !== 'object' || !('terminal' in result)) {
            return false
          }
          const terminal = result.terminal
          return (
            terminal &&
            typeof terminal === 'object' &&
            'source' in terminal &&
            terminal.source === 'screen' &&
            'tail' in terminal &&
            Array.isArray(terminal.tail) &&
            terminal.tail.some((line) => typeof line === 'string' && line.trim() === marker)
          )
        },
        { timeout: 30_000, message: `Remote host never parsed ${marker}` }
      )
      .toBe(true)
    return
  }
  expect(remote).toBeNull()
  const accepted = await page.evaluate(
    ({ ptyId, text }) => {
      return window.api.pty.writeAccepted(ptyId, text, 'driving', { requireWriteSettlement: true })
    },
    { ptyId, text }
  )
  expect(accepted).toBe(true)
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ ptyId, marker }) => {
            const snapshot = await window.api.pty.getMainBufferSnapshot(ptyId, { scrollbackRows: 0 })
            return (
              snapshot?.source === 'headless' &&
              snapshot.alternateScreen === true &&
              snapshot.data.includes(marker)
            )
          },
          { ptyId, marker }
        ),
      { timeout: 30_000, message: `Local host never parsed ${marker}` }
    )
    .toBe(true)
}

export async function waitForPtyFrame(page: Page, tabId: string, marker: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const screen = await readActiveScreen(page, tabId)
        return screen?.bufferType === 'alternate' && screen.rows[0]?.trim() === marker
      },
      { timeout: 30_000, message: `PTY output never parsed ${marker}` }
    )
    .toBe(true)
}
