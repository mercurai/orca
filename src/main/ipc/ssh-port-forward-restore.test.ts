import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortForwardEntry, SavedPortForward } from '../../shared/ssh-types'

const h = vi.hoisted(() => {
  const conn = { id: 'conn' }
  const saved: { portForwards?: SavedPortForward[] } = {}
  const active: PortForwardEntry[] = []
  return {
    conn,
    saved,
    active,
    store: {
      getTarget: vi.fn(() => ({ id: 't1', ...saved })),
      updateTarget: vi.fn((_id: string, update: { portForwards?: SavedPortForward[] }) => {
        saved.portForwards = update.portForwards
      })
    },
    connectionManager: { getConnection: vi.fn(() => conn) },
    portForwardManager: {
      closeStaleForwards: vi.fn(async () => {}),
      listForwards: vi.fn(() => [...active]),
      addForward: vi.fn(
        async (
          connectionId: string,
          _conn: unknown,
          localPort: number,
          remoteHost: string,
          remotePort: number,
          label?: string
        ) => {
          const entry = {
            id: `pf-${active.length + 1}`,
            connectionId,
            localPort,
            remoteHost,
            remotePort,
            label
          }
          active.push(entry)
          return entry
        }
      )
    },
    hostServerStatus: vi.fn<() => { kind: 'managed'; environmentId: string } | undefined>(() => ({
      kind: 'managed',
      environmentId: 'env-1'
    })),
    broadcastPortForwards: vi.fn()
  }
})

vi.mock('../ssh/ssh-target-registry', () => ({ getSshTargetRegistryStore: () => h.store }))
vi.mock('./ssh-ipc-context', () => ({
  connectionManager: h.connectionManager,
  portForwardManager: h.portForwardManager,
  getCurrentMainWindow: () => null
}))
vi.mock('./ssh-renderer-broadcast', () => ({ broadcastPortForwards: h.broadcastPortForwards }))
vi.mock('../ssh/ssh-host-server-status', () => ({ getSshHostServerStatus: h.hostServerStatus }))

import { restorePortForwards } from './ssh-port-forward-persistence'
import { restoreManagedHostPortForwards } from './ssh-managed-port-forward-restore'

const FORWARD = { localPort: 4100, remoteHost: '127.0.0.1', remotePort: 7860, label: 'app' }

describe('saved port forward restore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.active.length = 0
    h.saved.portForwards = [{ ...FORWARD }]
  })

  it('closes forwards bound to a replaced transport before re-adding the saved ones', async () => {
    await restorePortForwards('t1', () => null)
    expect(h.portForwardManager.closeStaleForwards).toHaveBeenCalledWith('t1', h.conn)
    expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(1)
    expect(h.portForwardManager.closeStaleForwards.mock.invocationCallOrder[0]).toBeLessThan(
      h.portForwardManager.addForward.mock.invocationCallOrder[0]
    )
  })

  it('leaves a forward that is still live on the current transport alone', async () => {
    await restorePortForwards('t1', () => null)
    await restorePortForwards('t1', () => null)
    expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(1)
    expect(h.saved.portForwards).toEqual([FORWARD])
  })

  it('restores a managed host once even when two connects race', async () => {
    await Promise.all([restoreManagedHostPortForwards('t1'), restoreManagedHostPortForwards('t1')])
    expect(h.portForwardManager.addForward).toHaveBeenCalledTimes(1)
    expect(h.broadcastPortForwards).toHaveBeenCalledWith(expect.any(Function), 't1')
  })

  it('does nothing for a host that is not managed', async () => {
    h.hostServerStatus.mockReturnValueOnce(undefined)
    await restoreManagedHostPortForwards('t1')
    expect(h.portForwardManager.addForward).not.toHaveBeenCalled()
  })
})
