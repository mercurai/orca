import { ipcMain } from 'electron'
import {
  clearZcodePlanApiKeyCredential,
  getZcodePlanCredentialsStatus,
  saveZcodePlanApiKeyCredential
} from '../zcode/zcode-plan-credential-commands'
import type { RateLimitService } from '../rate-limits/service'

export function registerZcodePlanCredentialsHandlers(
  rateLimits: Pick<RateLimitService, 'refresh' | 'invalidateZcodeCredentialState'> | null
): void {
  ipcMain.handle('zcodePlanCredentials:getStatus', () => getZcodePlanCredentialsStatus())
  ipcMain.handle('zcodePlanCredentials:saveApiKey', (_event, key: unknown) =>
    saveZcodePlanApiKeyCredential(rateLimits, key)
  )
  ipcMain.handle('zcodePlanCredentials:clearApiKey', () =>
    clearZcodePlanApiKeyCredential(rateLimits)
  )
}
