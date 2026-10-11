import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectNoSyncSpawnOnWin32 } from '../../shared/windows-spawn-test-harness'
import {
  captureCloudSessionMutation,
  isCloudSessionMutationCurrent,
  recordCloudSessionIdentityMutation,
  recordSuccessfulCloudSessionLogin,
  tombstoneCloudSession,
  type CloudSessionIdentity
} from './profile-cloud-session-mutation'

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: vi.fn(),
  runProcessSync: vi.fn()
}))

describe('cloud session mutation fence', () => {
  let userDataPath: string
  const identity: CloudSessionIdentity = {
    localProfileId: 'local-1',
    cloudUserId: 'user-1',
    cloudProfileId: 'profile-1',
    organizationId: 'org-1'
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-session-mutation-'))
  })

  afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

  it('invalidates a captured refresh before destructive sign-out', async () => {
    const snapshot = await captureCloudSessionMutation(identity, userDataPath)
    expect(isCloudSessionMutationCurrent(identity.localProfileId, userDataPath, snapshot)).toBe(
      true
    )
    await tombstoneCloudSession(identity, userDataPath)
    expect(isCloudSessionMutationCurrent(identity.localProfileId, userDataPath, snapshot)).toBe(
      false
    )
  })

  it('clears only the matching tombstone after explicit successful login', async () => {
    await tombstoneCloudSession(identity, userDataPath)
    const login = await recordSuccessfulCloudSessionLogin(identity, userDataPath)
    expect(isCloudSessionMutationCurrent(identity.localProfileId, userDataPath, login)).toBe(true)
  })

  it('invalidates old work when the expected org changes without tombstoning either identity', async () => {
    const old = await captureCloudSessionMutation(identity, userDataPath)
    const next = await recordCloudSessionIdentityMutation(
      { ...identity, organizationId: 'org-2' },
      userDataPath
    )
    expect(isCloudSessionMutationCurrent(identity.localProfileId, userDataPath, old)).toBe(false)
    expect(isCloudSessionMutationCurrent(identity.localProfileId, userDataPath, next)).toBe(true)
  })

  it('persists the fence across module-independent reads', async () => {
    const snapshot = await recordSuccessfulCloudSessionLogin(identity, userDataPath)
    expect(isCloudSessionMutationCurrent(identity.localProfileId, userDataPath, snapshot)).toBe(
      true
    )
  })

  it('persists the fence on win32 with no synchronous spawn', async () => {
    await expectNoSyncSpawnOnWin32(async () => {
      await captureCloudSessionMutation(identity, userDataPath)
      await tombstoneCloudSession(identity, userDataPath)
    })
  })
})
