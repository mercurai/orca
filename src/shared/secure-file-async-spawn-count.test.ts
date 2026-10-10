// A Windows secure write must never block the thread that answers IPC: zero synchronous spawns,
// and at most the two icacls runs (reset, then inheritance plus grants) the new file needs.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcess, runProcessSync } from './child-process/run-process'
import { settlePathWritesForTests } from './path-write-serializer'
import { writeSecureFileAsync } from './secure-file-async-write'
import { resetSecureFileWindowsUserSidForTests } from './secure-path-windows-acl'

vi.mock('./child-process/run-process', () => ({
  runProcess: vi.fn(),
  runProcessSync: vi.fn()
}))

const OK = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const directories: string[] = []

beforeEach(() => {
  vi.mocked(runProcess).mockReset()
  vi.mocked(runProcessSync).mockReset()
  vi.mocked(runProcess).mockImplementation(async (spec) =>
    spec.program.endsWith('whoami.exe') ? { ...OK, stdout: '"USER","S-1-5-21-1000"' } : OK
  )
  resetSecureFileWindowsUserSidForTests()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  resetSecureFileWindowsUserSidForTests()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('writes a secure file with no synchronous spawn and two icacls runs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-secure-async-spawns-'))
  directories.push(directory)
  const target = join(directory, 'secret.json')

  // The bound is the steady state: a process's first write also pays one whoami and the directory's one-time harden.
  await writeSecureFileAsync(target, 'first')
  await settlePathWritesForTests()
  await new Promise((resolve) => setTimeout(resolve, 50))
  vi.mocked(runProcess).mockClear()

  await writeSecureFileAsync(target, 'second')

  expect(readFileSync(target, 'utf-8')).toBe('second')
  expect(runProcessSync).not.toHaveBeenCalled()
  const spawned = vi.mocked(runProcess).mock.calls.map(([spec]) => spec.args ?? [])
  expect(spawned).toHaveLength(2)
  expect(spawned[0]![1]).toBe('/reset')
  expect(spawned[1]![1]).toBe('/inheritance:r')
  expect(spawned.every((args) => args[0]?.endsWith('.tmp'))).toBe(true)
})
