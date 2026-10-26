import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as SecureFileAsyncWrite from '../../shared/secure-file-async-write'
import type {
  OrcaCloudCapabilities,
  OrcaCloudOrgSummary,
  OrcaProfileCloudSummary
} from '../../shared/orca-profiles'

const {
  beginOrcaCloudPkceFlowMock,
  exchangeOrcaCloudAuthCodeMock,
  revokeOrcaCloudSessionMock,
  safeStorageMock,
  sessionWriteHook
} = vi.hoisted(() => {
  const sessionWriteHook: { once: (() => void) | null } = { once: null }
  return {
    beginOrcaCloudPkceFlowMock: vi.fn(),
    exchangeOrcaCloudAuthCodeMock: vi.fn(),
    revokeOrcaCloudSessionMock: vi.fn(),
    safeStorageMock: {
      decryptString: vi.fn((value: Buffer) => value.toString('utf-8')),
      encryptString: vi.fn((value: string) => Buffer.from(value, 'utf-8')),
      isEncryptionAvailable: vi.fn(() => true)
    },
    // Runs once, right after a session write has been requested and before it lands.
    sessionWriteHook
  }
})

let userDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  },
  safeStorage: safeStorageMock
}))

vi.mock('../../shared/secure-file-async-write', async (importOriginal) => {
  const original = await importOriginal<typeof SecureFileAsyncWrite>()
  return {
    ...original,
    writeSecureJsonFileAsync: (path: string, value: unknown) => {
      const write = original.writeSecureJsonFileAsync(path, value)
      if (path.endsWith('account-session.json.enc') && sessionWriteHook.once) {
        const hook = sessionWriteHook.once
        sessionWriteHook.once = null
        hook()
      }
      return write
    }
  }
})

vi.mock('./profile-cloud-pkce', () => ({
  beginOrcaCloudPkceFlow: beginOrcaCloudPkceFlowMock
}))

vi.mock('./profile-cloud-client', () => ({
  createOrcaCloudProfile: vi.fn(),
  exchangeOrcaCloudAuthCode: exchangeOrcaCloudAuthCodeMock,
  revokeOrcaCloudSession: revokeOrcaCloudSessionMock,
  selectOrcaCloudOrg: vi.fn()
}))

import {
  connectCurrentOrcaProfile,
  getCurrentOrcaProfileAuthStatus,
  signOutCurrentOrcaProfile
} from './profile-cloud-service'
import {
  readCloudSession,
  signInCloudSession,
  signOutCloudSession
} from './profile-cloud-session-owner'

const earlierCloud: OrcaProfileCloudSummary = {
  cloudProfileId: 'cloud-profile-1',
  userId: 'user-1',
  email: 'nina@example.com',
  displayName: 'Nina',
  linkedAt: 10
}

const laterCloud: OrcaProfileCloudSummary = {
  ...earlierCloud,
  cloudProfileId: 'cloud-profile-2',
  userId: 'user-2',
  email: 'ada@example.com'
}

const capabilities: OrcaCloudCapabilities = {
  flags: { share: true },
  refreshedAt: 11
}

const organizations: OrcaCloudOrgSummary[] = [{ orgId: 'org-1', name: 'Acme', role: 'Admin' }]

describe('Orca cloud overlapping connect', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-connect-overlap-'))
    sessionWriteHook.once = null
    beginOrcaCloudPkceFlowMock.mockReset()
    exchangeOrcaCloudAuthCodeMock.mockReset()
    revokeOrcaCloudSessionMock.mockReset()
    revokeOrcaCloudSessionMock.mockResolvedValue(undefined)
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf-8'))
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf-8'))
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    vi.stubEnv('ORCA_CLOUD_API_URL', 'https://orca-cloud.example')
    vi.stubEnv('ORCA_CLOUD_CLIENT_ID', 'desktop-client')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('does not let an earlier sign-in overwrite a later successful connect', async () => {
    let finishFirst!: (value: {
      code: string
      codeVerifier: string
      nonce: string
      redirectUri: string
      state: string
    }) => void
    beginOrcaCloudPkceFlowMock
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishFirst = resolve
        })
      )
      .mockResolvedValueOnce({
        code: 'later-code',
        codeVerifier: 'later-verifier',
        nonce: 'later-nonce',
        redirectUri: 'http://127.0.0.1:4101/auth/callback',
        state: 'later-state'
      })
    exchangeOrcaCloudAuthCodeMock.mockImplementation(async (_config, args) => ({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
      cloud: args.code === 'later-code' ? laterCloud : earlierCloud,
      organizations,
      capabilities
    }))

    const first = connectCurrentOrcaProfile(userDataPath)
    const later = connectCurrentOrcaProfile(userDataPath)
    await expect(later).resolves.toMatchObject({ status: 'connected' })
    expect(getCurrentOrcaProfileAuthStatus(userDataPath).cloud?.email).toBe('ada@example.com')

    finishFirst({
      code: 'earlier-code',
      codeVerifier: 'earlier-verifier',
      nonce: 'earlier-nonce',
      redirectUri: 'http://127.0.0.1:4100/auth/callback',
      state: 'earlier-state'
    })
    await expect(first).resolves.toMatchObject({ status: 'cancelled' })
    expect(exchangeOrcaCloudAuthCodeMock).toHaveBeenCalledTimes(1)
    expect(exchangeOrcaCloudAuthCodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ code: 'later-code' })
    )
    expect(getCurrentOrcaProfileAuthStatus(userDataPath).cloud?.email).toBe('ada@example.com')
  })

  it('discards an earlier token exchange that finishes after a later wait has linked', async () => {
    type PkceCode = {
      code: string
      codeVerifier: string
      nonce: string
      redirectUri: string
      state: string
    }
    let finishEarlierPkce!: (value: PkceCode) => void
    let finishLaterPkce!: (value: PkceCode) => void
    let finishEarlierExchange!: (value: {
      accessToken: string
      refreshToken: string
      expiresAt: number
      cloud: OrcaProfileCloudSummary
      organizations: OrcaCloudOrgSummary[]
      capabilities: OrcaCloudCapabilities
    }) => void
    let finishLaterExchange!: (value: {
      accessToken: string
      refreshToken: string
      expiresAt: number
      cloud: OrcaProfileCloudSummary
      organizations: OrcaCloudOrgSummary[]
      capabilities: OrcaCloudCapabilities
    }) => void
    beginOrcaCloudPkceFlowMock
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishEarlierPkce = resolve
        })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishLaterPkce = resolve
        })
      )
    exchangeOrcaCloudAuthCodeMock.mockImplementation(
      (_config, args) =>
        new Promise((resolve) => {
          if (args.code === 'later-code') {
            finishLaterExchange = resolve
          } else {
            finishEarlierExchange = resolve
          }
        })
    )

    const earlier = connectCurrentOrcaProfile(userDataPath)
    const later = connectCurrentOrcaProfile(userDataPath)
    finishEarlierPkce({
      code: 'earlier-code',
      codeVerifier: 'earlier-verifier',
      nonce: 'earlier-nonce',
      redirectUri: 'http://127.0.0.1:4100/auth/callback',
      state: 'earlier-state'
    })
    finishLaterPkce({
      code: 'later-code',
      codeVerifier: 'later-verifier',
      nonce: 'later-nonce',
      redirectUri: 'http://127.0.0.1:4101/auth/callback',
      state: 'later-state'
    })
    await vi.waitFor(() => expect(exchangeOrcaCloudAuthCodeMock).toHaveBeenCalledTimes(2))

    finishLaterExchange({
      accessToken: 'later-access',
      refreshToken: 'later-refresh',
      expiresAt: Date.now() + 3_600_000,
      cloud: laterCloud,
      organizations,
      capabilities
    })
    await expect(later).resolves.toMatchObject({ status: 'connected' })
    expect(getCurrentOrcaProfileAuthStatus(userDataPath).cloud?.email).toBe('ada@example.com')

    finishEarlierExchange({
      accessToken: 'earlier-access',
      refreshToken: 'earlier-refresh',
      expiresAt: Date.now() + 3_600_000,
      cloud: earlierCloud,
      organizations,
      capabilities
    })
    await expect(earlier).resolves.toMatchObject({ status: 'cancelled' })
    expect(getCurrentOrcaProfileAuthStatus(userDataPath).cloud?.email).toBe('ada@example.com')
  })

  it('does not relink an in-flight later wait after sign-out', async () => {
    type PkceCode = {
      code: string
      codeVerifier: string
      nonce: string
      redirectUri: string
      state: string
    }
    let finishEarlierPkce!: (value: PkceCode) => void
    let finishLaterPkce!: (value: PkceCode) => void
    beginOrcaCloudPkceFlowMock
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishEarlierPkce = resolve
        })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishLaterPkce = resolve
        })
      )
    exchangeOrcaCloudAuthCodeMock.mockImplementation(async (_config, args) => ({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
      cloud: args.code === 'later-code' ? laterCloud : earlierCloud,
      organizations,
      capabilities
    }))

    const earlier = connectCurrentOrcaProfile(userDataPath)
    const later = connectCurrentOrcaProfile(userDataPath)
    finishEarlierPkce({
      code: 'earlier-code',
      codeVerifier: 'earlier-verifier',
      nonce: 'earlier-nonce',
      redirectUri: 'http://127.0.0.1:4100/auth/callback',
      state: 'earlier-state'
    })
    await expect(earlier).resolves.toMatchObject({ status: 'connected' })
    await expect(signOutCurrentOrcaProfile(userDataPath)).resolves.toMatchObject({
      status: 'signed-out'
    })
    finishLaterPkce({
      code: 'later-code',
      codeVerifier: 'later-verifier',
      nonce: 'later-nonce',
      redirectUri: 'http://127.0.0.1:4101/auth/callback',
      state: 'later-state'
    })
    await expect(later).resolves.toMatchObject({ status: 'cancelled' })
    expect(exchangeOrcaCloudAuthCodeMock).toHaveBeenCalledTimes(1)
    expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({ state: 'local' })
  })

  it('cancels a connect whose session write is overtaken by a sign-out, and leaves no session file', async () => {
    beginOrcaCloudPkceFlowMock.mockResolvedValue({
      code: 'earlier-code',
      codeVerifier: 'earlier-verifier',
      nonce: 'earlier-nonce',
      redirectUri: 'http://127.0.0.1:4100/auth/callback',
      state: 'earlier-state'
    })
    exchangeOrcaCloudAuthCodeMock.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
      cloud: earlierCloud,
      organizations,
      capabilities
    })
    let signingOut: ReturnType<typeof signOutCurrentOrcaProfile> | null = null
    sessionWriteHook.once = () => {
      signingOut = signOutCurrentOrcaProfile(userDataPath)
    }

    await expect(connectCurrentOrcaProfile(userDataPath)).resolves.toMatchObject({
      status: 'cancelled'
    })
    await expect(signingOut).resolves.toMatchObject({ status: 'signed-out' })

    expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'local',
      persistence: 'none'
    })
    expect(
      existsSync(join(userDataPath, 'profiles', 'local-default', 'account-session.json.enc'))
    ).toBe(false)
  })

  it('refuses a sign-in that was requested before a sign-out, even while it is still queued', async () => {
    const signingIn = signInCloudSession('local-default', userDataPath, {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
      cloud: earlierCloud,
      organizations,
      capabilities
    })
    signOutCloudSession('local-default', userDataPath)

    await expect(signingIn).rejects.toThrow('Signed out while signing in.')
    expect(readCloudSession('local-default', userDataPath).status).toBe('missing')
    expect(
      existsSync(join(userDataPath, 'profiles', 'local-default', 'account-session.json.enc'))
    ).toBe(false)
  })
})
