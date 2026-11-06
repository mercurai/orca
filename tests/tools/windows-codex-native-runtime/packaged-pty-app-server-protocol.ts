import { typeLine } from '../win-update-e2e/app-driver.mjs'
import type { SessionHandle } from './packaged-pty-app-support'

export async function appServerHandshake(
  page: SessionHandle['page'],
  ptyId: string,
  tabId: string,
  requestId: number
): Promise<void> {
  const response = page.evaluate(
    ({ ptyId: expectedPtyId, requestId: expectedRequestId }) =>
      new Promise<boolean>((resolveResponse) => {
        let output = ''
        let stop = (): void => {}
        const timer = setTimeout(() => {
          stop()
          resolveResponse(false)
        }, 15_000)
        stop = window.api.pty.onData((event) => {
          if (event.id !== expectedPtyId) {
            return
          }
          output = (output + event.data).slice(-64_000)
          const frame = new RegExp(`\\{\\s*"id"\\s*:\\s*${expectedRequestId}\\s*,\\s*"result"\\s*:`)
          if (frame.test(output)) {
            clearTimeout(timer)
            stop()
            resolveResponse(true)
          }
        })
      }),
    { ptyId, requestId }
  )
  await typeLine(
    page,
    JSON.stringify({
      id: requestId,
      method: 'initialize',
      params: {
        clientInfo: { name: 'orca_desktop', title: 'Orca', version: '0.0.0' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
          extensions: {}
        }
      }
    }),
    tabId
  )
  if (!(await response)) {
    throw new Error('Codex app-server did not complete its unauthenticated initialize handshake')
  }
  await typeLine(page, JSON.stringify({ method: 'initialized', params: {} }), tabId)
}
