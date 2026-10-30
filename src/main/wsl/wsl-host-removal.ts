/**
 * Removing a WSL host (E11). Only a proven stop drops its records; anything else keeps the host
 * listed with a pending stop, so the next Remove retries it and Connect or Add can keep the host.
 * Dropping it would strand a still-running server that blocks the next add's activation.
 */
import { errorMessage } from '../../shared/error-message'
import { wslHostServerStopReason } from '../../shared/wsl-host-failure-copy'
import {
  findWslHostDeployment,
  removeWslHostEnvironment,
  setWslHostPendingStop
} from '../../shared/runtime-environment-wsl-host-store'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type { WslHostAddResult, WslHostServerStop } from '../../shared/wsl-host-types'
import { admitWslHostDistro, wslHostRemovalPendingMessage } from './wsl-host-add-admission'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'
import type { WslHostConnector } from './wsl-host-service'
import { noteWslHostUserAction } from './wsl-host-user-actions'
import { forgetWslHostKeptForPeers, recordWslHostKeptForPeers } from './wsl-host-kept-for-peers'
import { forgetWslHostToWake } from './wsl-host-early-wake'

export type WslHostRemoval = { serverStop: WslHostServerStop; removed: boolean }

/** A stale stop cannot retire the status or wake intent of a replacement host. */
export async function removeWslHostAndPublish(
  userDataPath: string,
  connector: WslHostConnector | null,
  record: WslHostDeploymentRecord,
  owner: {
    currentRecord: () => WslHostDeploymentRecord | null
    close: (record: WslHostDeploymentRecord) => void
    retire: () => Promise<void>
  }
): Promise<WslHostServerStop> {
  const removal = await removeWslHostServer(userDataPath, connector, record, () => {
    const current = owner.currentRecord()
    return current?.createdAt === record.createdAt && current.distroId === record.distroId
  })
  const stillOwnsRemoval = (): boolean => {
    const current = owner.currentRecord()
    return removal.removed ? current === null : current?.createdAt === record.createdAt
  }
  if (!stillOwnsRemoval()) {
    return removal.serverStop
  }
  await forgetWslHostToWake(userDataPath, record.distro)
  if (!stillOwnsRemoval()) {
    return removal.serverStop
  }
  if (removal.removed) {
    await owner.retire()
  } else {
    owner.close(owner.currentRecord() ?? record)
  }
  return removal.serverStop
}

export async function removeWslHostServer(
  userDataPath: string,
  connector: WslHostConnector | null,
  record: WslHostDeploymentRecord,
  isCurrent: () => boolean = () => {
    const owner = findWslHostDeployment(userDataPath, record.environmentId)
    return owner?.createdAt === record.createdAt && owner.distroId === record.distroId
  }
): Promise<WslHostRemoval> {
  let serverStop: WslHostServerStop = { stopped: true }
  if (connector) {
    // A distro that is no longer registered (by GUID or name) runs nothing of this host.
    const current = await connector
      .resolveDistroName(record.distro, record.distroId)
      .catch(() => null)
    if (!isCurrent()) return { serverStop, removed: false }
    if (current !== false) {
      // Under its current name: a renamed distro never reads as running under the old one.
      // Never boots: a stopped distro is itself a proven stop.
      serverStop = await connector
        .stopServer(current ?? record.distro, record.environmentId)
        .catch((error: unknown): WslHostServerStop => ({
          stopped: false,
          verdict: 'unverifiable',
          reason: errorMessage(error)
        }))
    }
    if (!isCurrent()) return { serverStop, removed: false }
    await connector.disconnect(record.distro)
    // Without its holder the distro idles out, pending or not.
    if (!isCurrent()) return { serverStop, removed: false }
    await connector.releaseHolder(record.distro)
  }
  if (!isCurrent()) return { serverStop, removed: false }
  if (serverStop.stopped) {
    const stopped = serverStop
    let markerFailed = false
    let markerError: unknown
    try {
      const removed = await removeWslHostEnvironment(
        userDataPath,
        record.environmentId,
        record.createdAt,
        async () => {
          try {
            await noteServerKeptForPeers(userDataPath, record.environmentId, stopped)
          } catch (error) {
            markerFailed = true
            markerError = error
            throw error
          }
        }
      )
      if (removed && !findWslHostDeployment(userDataPath, record.environmentId)) {
        noteWslHostUserAction({ kind: 'removed', distro: record.distro })
      }
      return { serverStop, removed }
    } catch (error) {
      if (!markerFailed) throw error
      serverStop = {
        stopped: false,
        verdict: stopped.keptForOtherDesktops ? 'live' : 'unverifiable',
        ...wslHostServerStopReason('removalUnrecorded', { detail: errorMessage(markerError) })
      }
    }
  }

  const { reason, reasonCode, reasonParams } = serverStop
  await setWslHostPendingStop(
    userDataPath,
    record.environmentId,
    {
      since: Date.now(),
      reason,
      ...(reasonCode ? { reasonCode } : {}),
      ...(reasonCode && reasonParams ? { reasonParams } : {}),
      verdict: serverStop.verdict ?? 'unverifiable'
    },
    record.createdAt
  )
  return { serverStop: { ...serverStop, kept: true }, removed: false }
}

/** The marker is written before deletion so a crash cannot hide a peer-owned server. */
async function noteServerKeptForPeers(
  userDataPath: string,
  environmentId: string,
  serverStop: Extract<WslHostServerStop, { stopped: true }>
): Promise<void> {
  if (serverStop.keptForOtherDesktops) {
    await recordWslHostKeptForPeers(userDataPath, environmentId)
  } else {
    await forgetWslHostKeptForPeers(userDataPath, environmentId)
  }
}

/** Adding a pending host again keeps it, under the same stopped-distro rule as any add. */
export async function readdPendingWslHost(
  args: { distro: string; startIfStopped?: boolean },
  host: {
    listDistros: () => Promise<WslHostDistroCandidate[]>
    keep: () => Promise<void>
    environmentId: string
  }
): Promise<WslHostAddResult> {
  try {
    const admission = admitWslHostDistro({
      requested: args.distro,
      candidates: await host.listDistros(),
      alreadyAdded: () => false,
      startIfStopped: args.startIfStopped === true
    })
    if (!('distro' in admission)) {
      return admission
    }
    await host.keep()
    return { ok: true, environmentId: host.environmentId }
  } catch (error) {
    return { ok: false, kind: 'failed', message: errorMessage(error) }
  }
}

/** A pending host connects only for the user's own Connect or Add, which withdraws its Remove. */
export async function admitConnectToPendingHost(
  userDataPath: string,
  record: WslHostDeploymentRecord,
  withdraw: boolean
): Promise<void> {
  if (!record.pendingStop) {
    return
  }
  if (!withdraw) {
    throw new Error(wslHostRemovalPendingMessage(record.distro))
  }
  await setWslHostPendingStop(userDataPath, record.environmentId, null, record.createdAt)
}
