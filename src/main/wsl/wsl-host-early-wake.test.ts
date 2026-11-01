import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeWslHostDeployment } from '../../shared/wsl-host-deployment-store'
import * as boundedWrites from '../../shared/bounded-secure-json-file'
import * as boundedReads from '../../shared/node-bounded-file-reader'
import { drainPendingPathWrites, pendingPathWritePaths } from '../../shared/path-write-serializer'
import {
  forgetWslHostToWake,
  forgetWslHostsToWake,
  rememberWslHostsToWake,
  wakeRememberedWslHosts
} from './wsl-host-early-wake'

describe('WSL host early wake', () => {
  let userDataPath: string
  const additionalPaths: string[] = []

  function wakePath(path = userDataPath): string {
    return join(path, 'orca-wsl-host-wake.json')
  }

  function readWakeFile(path = userDataPath): unknown {
    return JSON.parse(readFileSync(wakePath(path), 'utf8'))
  }

  function holdFirstAsyncWakeRead() {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const read = boundedReads.readNodeFileWithinLimit
    vi.spyOn(boundedReads, 'readNodeFileWithinLimit').mockImplementationOnce(async (...args) => {
      const result = await read(...args)
      entered.resolve()
      await release.promise
      return result
    })
    return { entered: entered.promise, release: () => release.resolve() }
  }

  beforeEach(async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-wake-'))
    await writeWslHostDeployment(userDataPath, 'wsl:ubuntu', {
      kind: 'wsl',
      distro: 'Ubuntu',
      localPort: 41000,
      remotePort: 6768,
      environmentId: 'wsl:ubuntu',
      createdAt: 1
    })
  })
  afterEach(async () => {
    await drainPendingPathWrites()
    vi.restoreAllMocks()
    for (const path of [userDataPath, ...additionalPaths.splice(0)]) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('wakes only the remembered distros that are still WSL hosts', async () => {
    await rememberWslHostsToWake(userDataPath, ['Ubuntu', 'Removed'])
    const spawn = vi.fn()
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual(['Ubuntu'])
    expect(spawn).toHaveBeenCalledExactlyOnceWith('Ubuntu')
  })

  it('wakes nothing once the open work is gone', async () => {
    await rememberWslHostsToWake(userDataPath, ['Ubuntu'])
    await rememberWslHostsToWake(userDataPath, [])
    const spawn = vi.fn()
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('wakes nothing without a list, or from an unreadable one', () => {
    const spawn = vi.fn()
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
    writeFileSync(join(userDataPath, 'orca-wsl-host-wake.json'), '{"version":1,"distros":["a b"]}')
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('deletes the list when WSL hosts are turned off, so the next launch wakes nothing', async () => {
    await rememberWslHostsToWake(userDataPath, ['Ubuntu'])
    await forgetWslHostsToWake(userDataPath)
    expect(existsSync(join(userDataPath, 'orca-wsl-host-wake.json'))).toBe(false)
    const spawn = vi.fn()
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
    // Nothing to delete is fine too.
    await forgetWslHostsToWake(userDataPath)
  })

  it('forgets a removed host even while its record is still on disk', async () => {
    await rememberWslHostsToWake(userDataPath, ['Ubuntu', 'Debian'])
    await forgetWslHostToWake(userDataPath, 'ubuntu')
    expect(readWakeFile()).toEqual({ version: 1, distros: ['Debian'] })
    const spawn = vi.fn()
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
  })

  it('persists focus through the async bounded lane without synchronous reads or writes', async () => {
    const syncRead = vi.spyOn(boundedReads, 'readNodeFileSyncWithinLimit')
    const syncWrite = vi.spyOn(boundedWrites, 'writeSecureJsonFileWithinLimit')
    const saving = rememberWslHostsToWake(userDataPath, ['Ubuntu'])
    expect(syncRead).not.toHaveBeenCalled()
    expect(syncWrite).not.toHaveBeenCalled()
    await saving
    expect(syncRead).not.toHaveBeenCalled()
    expect(syncWrite).not.toHaveBeenCalled()
    expect(readWakeFile()).toEqual({ version: 1, distros: ['Ubuntu'] })
  })

  it('keeps the newest focused host and registers a pending read with the quit drain', async () => {
    writeFileSync(wakePath(), '{"version":1,"distros":[]}')
    const held = holdFirstAsyncWakeRead()
    try {
      const first = rememberWslHostsToWake(userDataPath, ['Ubuntu'])
      expect(first).toBeInstanceOf(Promise)
      await held.entered
      expect(pendingPathWritePaths().some((path) => path.startsWith(wakePath()))).toBe(true)
      const latest = rememberWslHostsToWake(userDataPath, ['Debian'])
      const draining = drainPendingPathWrites()
      held.release()
      await draining
      expect(readWakeFile()).toEqual({ version: 1, distros: ['Debian'] })
      await Promise.all([first, latest])
    } finally {
      held.release()
    }
  })

  it('does not restore a focused host when disable revokes its pending save', async () => {
    writeFileSync(wakePath(), '{"version":1,"distros":[]}')
    const held = holdFirstAsyncWakeRead()
    try {
      const saving = rememberWslHostsToWake(userDataPath, ['Ubuntu'])
      expect(saving).toBeInstanceOf(Promise)
      await held.entered
      const clearing = forgetWslHostsToWake(userDataPath)
      expect(wakeRememberedWslHosts(userDataPath, vi.fn())).toEqual([])
      held.release()
      await Promise.all([saving, clearing])
      await drainPendingPathWrites()
      const spawn = vi.fn()
      expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      held.release()
    }
  })

  it('does not restore a removed host when its focus save was already pending', async () => {
    writeFileSync(wakePath(), '{"version":1,"distros":[]}')
    const held = holdFirstAsyncWakeRead()
    try {
      const saving = rememberWslHostsToWake(userDataPath, ['Ubuntu'])
      expect(saving).toBeInstanceOf(Promise)
      await held.entered
      const clearing = forgetWslHostToWake(userDataPath, 'ubuntu')
      held.release()
      await Promise.all([saving, clearing])
      await drainPendingPathWrites()
      const spawn = vi.fn()
      expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      held.release()
    }
  })

  it('preserves another host’s pending focus when a different host is removed', async () => {
    writeFileSync(wakePath(), '{"version":1,"distros":["Ubuntu"]}')
    const held = holdFirstAsyncWakeRead()
    try {
      const saving = rememberWslHostsToWake(userDataPath, ['Debian'])
      expect(saving).toBeInstanceOf(Promise)
      await held.entered
      const clearing = forgetWslHostToWake(userDataPath, 'ubuntu')
      held.release()
      await Promise.all([saving, clearing])
      await drainPendingPathWrites()
      expect(readWakeFile()).toEqual({ version: 1, distros: ['Debian'] })
    } finally {
      held.release()
    }
  })

  it('persists another profile while the first profile has a pending focus read', async () => {
    const otherPath = mkdtempSync(join(tmpdir(), 'orca-wsl-wake-other-'))
    additionalPaths.push(otherPath)
    writeFileSync(wakePath(), '{"version":1,"distros":[]}')
    const held = holdFirstAsyncWakeRead()
    try {
      const first = rememberWslHostsToWake(userDataPath, ['Ubuntu'])
      expect(first).toBeInstanceOf(Promise)
      await held.entered
      await rememberWslHostsToWake(otherPath, ['Debian'])
      expect(readWakeFile(otherPath)).toEqual({ version: 1, distros: ['Debian'] })
      expect(readWakeFile()).toEqual({ version: 1, distros: [] })
      held.release()
      await first
      expect(readWakeFile()).toEqual({ version: 1, distros: ['Ubuntu'] })
    } finally {
      held.release()
    }
  })

  it('does not rewrite an unchanged normalized focus list', async () => {
    const write = vi.spyOn(boundedWrites, 'writeSecureJsonFileWithinLimitAsync')
    await rememberWslHostsToWake(userDataPath, ['Ubuntu', 'Ubuntu'])
    await rememberWslHostsToWake(userDataPath, ['Ubuntu'])
    expect(readWakeFile()).toEqual({ version: 1, distros: ['Ubuntu'] })
    expect(write).toHaveBeenCalledTimes(1)
  })
})
