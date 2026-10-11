import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess, runProcessSync } from '../../../shared/child-process/run-process'
import type * as SecureFileAsyncModule from '../../../shared/secure-file-async-write'
import { resetSecureFileWindowsUserSidForTests } from '../../../shared/secure-path-windows-acl'
import { RelayRevokeOutbox } from './relay-revoke-outbox'

const secureFileMocks = vi.hoisted(() => ({ failWrites: false }))

vi.mock('../../../shared/secure-file-async-write', async (importOriginal) => {
  const actual = await importOriginal<typeof SecureFileAsyncModule>()
  return {
    ...actual,
    writeSecureJsonFileAsync: async (targetPath: string, value: unknown) => {
      if (secureFileMocks.failWrites) {
        throw new Error('disk full')
      }
      return await actual.writeSecureJsonFileAsync(targetPath, value)
    }
  }
})

vi.mock('../../../shared/child-process/run-process', () => ({
  runProcess: vi.fn(),
  runProcessSync: vi.fn()
}))

describe('RelayRevokeOutbox', () => {
  const paths: string[] = []
  beforeEach(() => {
    // Why: no test here may reach a real icacls/whoami, whatever platform it runs on.
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '"USER","S-1-5-21-1000"',
      stderr: '',
      timedOut: false
    })
    vi.mocked(runProcessSync).mockClear()
    resetSecureFileWindowsUserSidForTests()
  })
  afterEach(() => {
    secureFileMocks.failWrites = false
    for (const path of paths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('durably retains an idempotent account-scoped revoke after local deletion', async () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-relay-revoke-'))
    paths.push(path)
    const binding = {
      relayHostId: 'AbCdEf0123_-xyZ9',
      relayDeviceId: 'device-1',
      ownerIdentityKey: 'user-1\0profile-1\0org-1'
    }
    const first = await new RelayRevokeOutbox(path).enqueue(binding)
    const reloaded = new RelayRevokeOutbox(path)
    expect((await reloaded.enqueue(binding)).reqId).toBe(first.reqId)
    expect(reloaded.pendingFor(binding.ownerIdentityKey, binding.relayHostId)).toEqual([first])
    await reloaded.remove(first.reqId)
    expect(
      new RelayRevokeOutbox(path).pendingFor(binding.ownerIdentityKey, binding.relayHostId)
    ).toEqual([])
  })

  it('does not retain an enqueue that failed to reach disk', async () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-relay-revoke-'))
    paths.push(path)
    const binding = {
      relayHostId: 'AbCdEf0123_-xyZ9',
      relayDeviceId: 'device-1',
      ownerIdentityKey: 'user-1\0profile-1\0org-1'
    }
    const outbox = new RelayRevokeOutbox(path)
    secureFileMocks.failWrites = true
    await expect(outbox.enqueue(binding)).rejects.toThrow('disk full')

    secureFileMocks.failWrites = false
    const persisted = await outbox.enqueue(binding)
    expect(
      new RelayRevokeOutbox(path).pendingFor(binding.ownerIdentityKey, binding.relayHostId)
    ).toEqual([persisted])
  })

  it('does not remove an item in memory when the durable removal fails', async () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-relay-revoke-'))
    paths.push(path)
    const binding = {
      relayHostId: 'AbCdEf0123_-xyZ9',
      relayDeviceId: 'device-1',
      ownerIdentityKey: 'user-1\0profile-1\0org-1'
    }
    const outbox = new RelayRevokeOutbox(path)
    const item = await outbox.enqueue(binding)
    secureFileMocks.failWrites = true
    await expect(outbox.remove(item.reqId)).rejects.toThrow('disk full')

    secureFileMocks.failWrites = false
    expect(outbox.pendingFor(binding.ownerIdentityKey, binding.relayHostId)).toEqual([item])
  })

  it('writes on win32 without a synchronous spawn', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const path = mkdtempSync(join(tmpdir(), 'orca-relay-revoke-'))
      paths.push(path)
      await new RelayRevokeOutbox(path).enqueue({
        relayHostId: 'AbCdEf0123_-xyZ9',
        relayDeviceId: 'device-1',
        ownerIdentityKey: 'owner-1'
      })
      expect(runProcessSync).not.toHaveBeenCalled()
    } finally {
      if (original) {
        Object.defineProperty(process, 'platform', original)
      }
      resetSecureFileWindowsUserSidForTests()
    }
  })
})
