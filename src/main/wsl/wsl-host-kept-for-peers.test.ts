import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type { WslHostServerStop } from '../../shared/wsl-host-types'

const store = vi.hoisted(() => ({ removed: new Array<string>(), pending: new Array<string>(), current: true, actions: 0, supersedeOnRemove: false }))
vi.mock('../../shared/runtime-environment-wsl-host-store', () => ({
  findWslHostDeployment: () => store.current ? { createdAt: 1, distroId: '00000000-0000-4000-8000-000000000001' } : null,
  removeWslHostEnvironment: async (_userData: string, environmentId: string, _expected: number, beforeRemove: () => void) => {
    if (store.supersedeOnRemove) store.current = false
    if (!store.current) return false
    beforeRemove()
    store.removed.push(environmentId)
    return true
  },
  setWslHostPendingStop: (_userData: string, environmentId: string) => {
    store.pending.push(environmentId)
  }
}))
vi.mock('./wsl-host-user-actions', () => ({ noteWslHostUserAction: () => { store.actions += 1 } }))

import {
  forgetWslHostKeptForPeers,
  recordWslHostKeptForPeers,
  wasWslHostKeptForPeers
} from './wsl-host-kept-for-peers'
import { removeWslHostServer } from './wsl-host-removal'
import type { WslHostConnector } from './wsl-host-service'

const RECORD: WslHostDeploymentRecord = {
  kind: 'wsl',
  environmentId: 'wsl:ubuntu',
  distro: 'Ubuntu',
  distroId: '00000000-0000-4000-8000-000000000001',
  localPort: 42000,
  remotePort: 6768,
  createdAt: 1
}

function connector(serverStop: WslHostServerStop): WslHostConnector {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: removeWslHostServer calls only these four members.
  return {
    resolveDistroName: async () => 'Ubuntu',
    stopServer: async () => serverStop,
    disconnect: async () => {},
    releaseHolder: async () => {}
  } as Partial<WslHostConnector> as WslHostConnector
}

describe('a WSL host kept for another Orca', () => {
  let userData: string
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-wsl-kept-'))
    store.removed = []
    store.pending = []
    store.current = true
    store.actions = 0
    store.supersedeOnRemove = false
  })
  afterEach(() => rmSync(userData, { recursive: true, force: true }))

  it('is remembered until a later Remove proves its server stopped', () => {
    expect(wasWslHostKeptForPeers(userData, 'wsl:ubuntu')).toBe(false)
    recordWslHostKeptForPeers(userData, 'wsl:ubuntu')
    recordWslHostKeptForPeers(userData, 'wsl:ubuntu')
    expect(wasWslHostKeptForPeers(userData, 'wsl:ubuntu')).toBe(true)
    forgetWslHostKeptForPeers(userData, 'wsl:ubuntu')
    expect(wasWslHostKeptForPeers(userData, 'wsl:ubuntu')).toBe(false)
  })

  it('is recorded by a Remove that kept the server, and cleared by one that stopped it', async () => {
    await removeWslHostServer(
      userData,
      connector({ stopped: true, keptForOtherDesktops: ['Orca Dev'] }),
      RECORD
    )
    expect(store.removed).toEqual(['wsl:ubuntu'])
    expect(wasWslHostKeptForPeers(userData, 'wsl:ubuntu')).toBe(true)

    await removeWslHostServer(userData, connector({ stopped: true }), RECORD)
    expect(wasWslHostKeptForPeers(userData, 'wsl:ubuntu')).toBe(false)
  })

  it('does not publish a peer marker or user action for a superseded removal', async () => {
    const stopped = Promise.withResolvers<WslHostServerStop>()
    const entered = Promise.withResolvers<void>()
    const old = connector({ stopped: true })
    old.stopServer = () => {
      entered.resolve()
      return stopped.promise
    }
    const removal = removeWslHostServer(userData, old, RECORD)
    await entered.promise
    store.current = false
    stopped.resolve({ stopped: true, keptForOtherDesktops: ['Orca Dev'] })
    await expect(removal).resolves.toMatchObject({ removed: false })
    expect(wasWslHostKeptForPeers(userData, RECORD.environmentId)).toBe(false)
    expect(store.removed).toEqual([])
    expect(store.actions).toBe(0)
  })

  it('does not publish a peer marker when ownership changes before the serialized removal', async () => {
    store.supersedeOnRemove = true
    const removal = await removeWslHostServer(
      userData,
      connector({ stopped: true, keptForOtherDesktops: ['Orca Dev'] }),
      RECORD
    )
    expect(removal.removed).toBe(false)
    expect(wasWslHostKeptForPeers(userData, RECORD.environmentId)).toBe(false)
    expect(store.removed).toEqual([])
    expect(store.actions).toBe(0)
  })

  it('keeps the host listed when the record cannot be saved', async () => {
    // A directory where the file should be: the write fails.
    const blocked = join(userData, 'blocked')
    rmSync(blocked, { force: true })
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(blocked, 'orca-wsl-hosts-kept-for-peers.json'), { recursive: true })
    const removal = await removeWslHostServer(
      blocked,
      connector({ stopped: true, keptForOtherDesktops: ['Orca Dev'] }),
      RECORD
    )
    expect(removal).toMatchObject({
      removed: false,
      serverStop: { stopped: false, verdict: 'live' }
    })
    expect(store.pending).toEqual(['wsl:ubuntu'])
    expect(store.removed).toEqual([])
    expect(store.actions).toBe(0)
  })
})
