import type {
  CreateCloudLinkedOrcaProfileArgs,
  OrcaProfileListState
} from '../../shared/orca-profiles'
import type { ActiveOrcaProfileState } from './profile-index-store'
import { createCloudLinkedOrcaProfileRecord, linkOrcaProfileToCloud } from './profile-cloud-index'
import { readCloudSession, signInCloudSession } from './profile-cloud-session-owner'
import { createDevOrcaCloudSession } from './profile-cloud-dev-auth'

type DevProfileListResult = OrcaProfileListState

type DevCreateProfileResult =
  | {
      status: 'created'
      list: ReturnType<typeof createCloudLinkedOrcaProfileRecord>
    }
  | { status: 'reconnect-required' }

type DevMutationResult =
  | {
      status: 'updated'
      list: DevProfileListResult
    }
  | { status: 'reconnect-required' }

export async function connectDevOrcaCloudProfile(
  active: ActiveOrcaProfileState,
  userDataPath: string
): Promise<DevProfileListResult> {
  const session = createDevOrcaCloudSession({ localProfileId: active.profile.id })
  await signInCloudSession(active.profile.id, userDataPath, session)
  return await linkOrcaProfileToCloud(active.profile.id, session.cloud, userDataPath)
}

export async function createDevCloudLinkedOrcaProfile(
  active: ActiveOrcaProfileState,
  userDataPath: string,
  args: CreateCloudLinkedOrcaProfileArgs
): Promise<DevCreateProfileResult> {
  if (readCloudSession(active.profile.id, userDataPath).status !== 'found') {
    return { status: 'reconnect-required' }
  }
  const session = createDevOrcaCloudSession({ orgId: args.orgId })
  const list = createCloudLinkedOrcaProfileRecord(session.cloud, { name: args.name }, userDataPath)
  await signInCloudSession(list.profile.id, userDataPath, session)
  return { status: 'created', list }
}

export async function refreshDevOrcaCloudProfile(
  active: ActiveOrcaProfileState,
  userDataPath: string
): Promise<DevMutationResult> {
  if (
    !active.profile.cloud ||
    readCloudSession(active.profile.id, userDataPath).status !== 'found'
  ) {
    return { status: 'reconnect-required' }
  }
  const session = createDevOrcaCloudSession({
    localProfileId: active.profile.id,
    cloudProfileId: active.profile.cloud.cloudProfileId,
    orgId: active.profile.cloud.activeOrgId
  })
  await signInCloudSession(active.profile.id, userDataPath, session)
  return {
    status: 'updated',
    list: await linkOrcaProfileToCloud(active.profile.id, session.cloud, userDataPath)
  }
}

export async function selectDevOrcaCloudOrg(
  active: ActiveOrcaProfileState,
  userDataPath: string,
  orgId: string
): Promise<DevMutationResult> {
  if (
    !active.profile.cloud ||
    readCloudSession(active.profile.id, userDataPath).status !== 'found'
  ) {
    return { status: 'reconnect-required' }
  }
  const session = createDevOrcaCloudSession({
    localProfileId: active.profile.id,
    cloudProfileId: active.profile.cloud.cloudProfileId,
    orgId
  })
  await signInCloudSession(active.profile.id, userDataPath, session)
  return {
    status: 'updated',
    list: await linkOrcaProfileToCloud(active.profile.id, session.cloud, userDataPath)
  }
}
