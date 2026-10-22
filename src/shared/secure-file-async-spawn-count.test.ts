// A Windows secure write must never block the thread that answers IPC: zero spawns of any kind,
// and the staged file is created restricted by the in-process addon, so no DACL rewrite follows.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcess, runProcessSync } from '@orca/process-host'
import { drainPendingPathWrites } from './path-write-serializer'
import { __resetSecureFileHardenedPathsForTests } from './secure-file'
import { writeSecureFileAsync } from './secure-file-async-write'
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

vi.mock('@orca/process-host', () => ({
  runProcess: vi.fn(),
  runProcessSync: vi.fn()
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const directories: string[] = []
let fake: FakeWindowsSecurity

beforeEach(() => {
  vi.mocked(runProcess).mockReset()
  vi.mocked(runProcessSync).mockReset()
  fake = createFakeWindowsSecurity()
  __resetSecureFileHardenedPathsForTests()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  setWindowsSecurityForTests(fake)
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  resetWindowsSecurityLoadForTests()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('writes a secure file with no spawn and creates the staged file already restricted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-secure-async-spawns-'))
  directories.push(directory)
  const target = join(directory, 'secret.json')

  await writeSecureFileAsync(target, 'first')
  await drainPendingPathWrites()
  // The directory's one-time harden settles on the thread pool, after the write returns.
  await new Promise((resolve) => setTimeout(resolve, 50))
  fake.calls.length = 0

  await writeSecureFileAsync(target, 'second')

  expect(readFileSync(target, 'utf-8')).toBe('second')
  expect(runProcess).not.toHaveBeenCalled()
  expect(runProcessSync).not.toHaveBeenCalled()
  const created = fake.callsFor('create')
  expect(created).toHaveLength(1)
  expect(created[0]).toMatchObject({
    path: expect.stringMatching(/\.tmp$/),
    sddl: hardenedDaclSddl(FAKE_USER_SID, false)
  })
  expect(fake.callsFor('set')).toHaveLength(0)
  expect(fake.callsFor('setAsync')).toHaveLength(0)
})
