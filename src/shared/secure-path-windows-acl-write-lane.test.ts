import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restrictNewFileAsync } from './secure-path-windows-acl'
import { hardenedDaclSddl } from './windows-secure-dacl'
import {
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests
} from './windows-security-addon'
import {
  createFakeWindowsSecurity,
  FAKE_USER_SID,
  type FakeWindowsSecurity
} from './windows-security-addon.test-fixture'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
let fake: FakeWindowsSecurity

beforeEach(() => {
  fake = createFakeWindowsSecurity()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  setWindowsSecurityForTests(fake)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  resetWindowsSecurityLoadForTests()
  vi.restoreAllMocks()
})

describe('restrictNewFileAsync', () => {
  it('rewrites an inherited DACL off the event loop and trusts the read-back', async () => {
    await expect(restrictNewFileAsync('C:\\a.json')).resolves.toBe(true)

    expect(fake.callsFor('setAsync', 'C:\\a.json')).toMatchObject([
      { sddl: hardenedDaclSddl(FAKE_USER_SID, false) }
    ])
    expect(fake.callsFor('set')).toHaveLength(0)
  })

  it('does not rewrite a DACL that already verifies', async () => {
    fake.dacls.set('C:\\a.json', hardenedDaclSddl(FAKE_USER_SID, false))

    await expect(restrictNewFileAsync('C:\\a.json')).resolves.toBe(true)

    expect(fake.callsFor('setAsync')).toHaveLength(0)
  })

  it('applies a directory DACL that is inheritable', async () => {
    await expect(restrictNewFileAsync('C:\\dir', true)).resolves.toBe(true)

    expect(fake.callsFor('setAsync', 'C:\\dir')).toMatchObject([
      { sddl: hardenedDaclSddl(FAKE_USER_SID, true) }
    ])
  })

  it('resolves false instead of rejecting when the addon refuses the write', async () => {
    fake.failing.add('C:\\a.json')

    await expect(restrictNewFileAsync('C:\\a.json')).resolves.toBe(false)

    expect(console.warn).toHaveBeenCalledWith(
      '[secure-path.windows-acl] failed to restrict path',
      expect.objectContaining({ stage: 'apply' })
    )
  })

  it('resolves false when the addon cannot load', async () => {
    setWindowsSecurityForTests(null)

    await expect(restrictNewFileAsync('C:\\a.json')).resolves.toBe(false)
  })
})
