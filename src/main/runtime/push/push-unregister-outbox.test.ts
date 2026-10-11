import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess, runProcessSync } from '../../../shared/child-process/run-process'
import { resetSecureFileWindowsUserSidForTests } from '../../../shared/secure-path-windows-acl'
import { PushUnregisterOutbox } from './push-unregister-outbox'

vi.mock('../../../shared/child-process/run-process', () => ({
  runProcess: vi.fn(),
  runProcessSync: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof fs>()
  return { ...original, readFileSync: vi.fn(original.readFileSync) }
})

const OUTBOX_FILENAME = 'mobile-push-unregister-outbox.json'

function userDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'orca-push-outbox-'))
}

describe('PushUnregisterOutbox', () => {
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

  it('survives a restart with the queued delete intact', async () => {
    const dir = userDataDir()
    const first = new PushUnregisterOutbox(dir)
    const item = await first.enqueue({ registrationId: 'reg-1', deviceId: 'device-1' })

    const reopened = new PushUnregisterOutbox(dir)
    expect(reopened.pending()).toEqual([item])
  })

  it('coalesces repeat enqueues of the same registration', async () => {
    const dir = userDataDir()
    const outbox = new PushUnregisterOutbox(dir)
    const first = await outbox.enqueue({ registrationId: 'reg-1', deviceId: 'device-1' })
    const second = await outbox.enqueue({ registrationId: 'reg-1', deviceId: 'device-1' })

    expect(second.reqId).toBe(first.reqId)
    expect(outbox.pending()).toHaveLength(1)
  })

  it('keeps a removal durable across a restart', async () => {
    const dir = userDataDir()
    const outbox = new PushUnregisterOutbox(dir)
    const kept = await outbox.enqueue({ registrationId: 'reg-keep', deviceId: 'device-1' })
    const dropped = await outbox.enqueue({ registrationId: 'reg-drop', deviceId: 'device-2' })
    await outbox.remove(dropped.reqId)

    expect(new PushUnregisterOutbox(dir).pending()).toEqual([kept])
  })

  it('drops malformed rows instead of failing the whole load', async () => {
    const dir = userDataDir()
    const valid = await new PushUnregisterOutbox(dir).enqueue({
      registrationId: 'reg-1',
      deviceId: 'device-1'
    })
    const path = join(dir, OUTBOX_FILENAME)
    const stored: unknown[] = JSON.parse(readFileSync(path, 'utf-8'))
    writeFileSync(
      path,
      JSON.stringify([...stored, { reqId: 'broken' }, null, 'nope', { registrationId: '' }])
    )

    expect(new PushUnregisterOutbox(dir).pending()).toEqual([valid])
  })

  it('preserves unreadable pending deletes until the outbox can be reloaded', async () => {
    const dir = userDataDir()
    const pending = await new PushUnregisterOutbox(dir).enqueue({
      registrationId: 'reg-1',
      deviceId: 'device-1'
    })
    const path = join(dir, OUTBOX_FILENAME)
    const original = readFileSync(path, 'utf-8')
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('temporarily unavailable'), { code: 'EIO' })
    })
    const unreadable = new PushUnregisterOutbox(dir)

    await expect(
      unreadable.enqueue({ registrationId: 'reg-2', deviceId: 'device-2' })
    ).rejects.toThrow('Cannot overwrite unreadable push unregister outbox')
    expect(readFileSync(path, 'utf-8')).toBe(original)
    const recovered = new PushUnregisterOutbox(dir)
    expect(recovered.pending()).toEqual([pending])
    await recovered.enqueue({ registrationId: 'reg-2', deviceId: 'device-2' })
    expect(new PushUnregisterOutbox(dir).pending()).toHaveLength(2)
  })

  it('starts empty when the file is not JSON at all', async () => {
    const dir = userDataDir()
    writeFileSync(join(dir, OUTBOX_FILENAME), 'not json')
    expect(new PushUnregisterOutbox(dir).pending()).toEqual([])
  })

  it('writes on win32 without a synchronous spawn', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      await new PushUnregisterOutbox(userDataDir()).enqueue({
        registrationId: 'reg-1',
        deviceId: 'device-1'
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
