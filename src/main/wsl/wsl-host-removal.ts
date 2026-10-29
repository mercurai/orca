/**
 * Removing a WSL host (E11). Only a proven stop drops its records; anything else keeps the host
 * listed with a pending stop, so the next Remove retries it and Connect or Add can keep the host.
 * Dropping it would strand a still-running server that blocks the next add's activation.
 */
import { errorMessage } from '../../shared/error-message'
import {
  removeWslHostEnvironment,
  setWslHostPendingStop
} from '../../shared/runtime-environment-wsl-host-store'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type { WslHostAddResult, WslHostServerStop } from '../../shared/wsl-host-types'
import { admitWslHostDistro, wslHostRemovalPendingMessage } from './wsl-host-add-admission'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'
import type { WslHostConnector } from './wsl-host-service'
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
  const removal = await removeWslHostServer(userDataPath, connector, record)
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
  record: WslHostDeploymentRecord
): Promise<WslHostRemoval> {
  let serverStop: WslHostServerStop = { stopped: true }
  if (connector) {
    // A distro that is no longer registered (by GUID or name) runs nothing of this host.
    const current = await connector
      .resolveDistroName(record.distro, record.distroId)
      .catch(() => null)
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
    await connector.disconnect(record.distro)
    // Without its holder the distro idles out, pending or not.
    await connector.releaseHolder(record.distro)
  }
  if (serverStop.stopped) {
    const removed = await removeWslHostEnvironment(
      userDataPath,
      record.environmentId,
      record.createdAt
    )
    return { serverStop, removed }
  }
  await setWslHostPendingStop(
    userDataPath,
    record.environmentId,
    {
      since: Date.now(),
      reason: serverStop.reason,
      verdict: serverStop.verdict ?? 'unverifiable'
    },
    record.createdAt
  )
  return { serverStop: { ...serverStop, kept: true }, removed: false }
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
