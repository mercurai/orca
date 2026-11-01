import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests
} from '../../shared/windows-security-addon'
import { createFakeWindowsSecurity } from '../../shared/windows-security-addon.test-fixture'
import { ensureWindowsUserDataAclGrant, type WindowsAclGrantResult } from './windows-user-data-acl'

let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-acl-no-username-'))
})

afterEach(() => {
  resetWindowsSecurityLoadForTests()
  vi.unstubAllEnvs()
  rmSync(userDataPath, { recursive: true, force: true })
})

it('grants on a host without USERNAME because the identity is the account SID, not a name', async () => {
  vi.stubEnv('USERNAME', '')
  const fake = createFakeWindowsSecurity()
  setWindowsSecurityForTests(fake)

  const result = await new Promise<WindowsAclGrantResult>((resolve) => {
    ensureWindowsUserDataAclGrant(userDataPath, { onDone: resolve })
  })

  expect(result).toEqual({ mode: 'granted' })
  expect(fake.callsFor('grantAsync').map((call) => call.path)).toEqual([userDataPath])
})
