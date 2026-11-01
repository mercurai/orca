import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type {
  OrcaProfileCloudSummary,
  OrcaProfileListState,
  OrcaProfileSummary
} from '../../shared/orca-profiles'
import {
  getOrcaProfileDirectory,
  getOrcaProfileIndexPath,
  loadOrCreateProfileIndex,
  writeProfileIndex
} from './profile-index-store'
import {
  artifactCloudCleanupNeedsCommit,
  commitArtifactCloudCleanup,
  completeArtifactCloudCleanupIfCommitted,
  prepareArtifactCloudCleanup
} from './profile-artifact-cloud-cleanup'

export type CreateCloudLinkedOrcaProfileRecordResult = OrcaProfileListState & {
  profile: OrcaProfileSummary
}

function sanitizeProfileName(value: unknown, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return (trimmed || fallback).slice(0, 80)
}

function profileInitial(name: string): string {
  return (name.match(/[A-Za-z0-9]/)?.[0] ?? 'C').toUpperCase()
}

function toCloudLinkedProfile(
  profile: OrcaProfileSummary,
  cloud: OrcaProfileCloudSummary,
  now: number
): OrcaProfileSummary {
  return {
    ...profile,
    kind: 'cloud-linked',
    cloud,
    updatedAt: now,
    lastOpenedAt: now
  }
}

function toLocalProfile(profile: OrcaProfileSummary, now: number): OrcaProfileSummary {
  const { cloud: _cloud, ...localProfile } = profile
  return {
    ...localProfile,
    kind: 'local',
    updatedAt: now,
    lastOpenedAt: now
  }
}

async function reconcileCurrentArtifactCloudCleanup(
  profileId: string,
  userDataPath: string,
  currentCloud: OrcaProfileCloudSummary | undefined
): Promise<void> {
  await completeArtifactCloudCleanupIfCommitted(profileId, userDataPath, currentCloud)
  if (!artifactCloudCleanupNeedsCommit(profileId, userDataPath, currentCloud)) {
    return
  }
  await commitArtifactCloudCleanup(profileId, userDataPath, currentCloud)
  await completeArtifactCloudCleanupIfCommitted(profileId, userDataPath, currentCloud)
}

export function createCloudLinkedOrcaProfileRecord(
  cloud: OrcaProfileCloudSummary,
  args: { name?: string },
  userDataPath: string
): CreateCloudLinkedOrcaProfileRecordResult {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  const fallbackName = cloud.activeOrgName ?? cloud.displayName ?? cloud.email
  const name = sanitizeProfileName(args.name, fallbackName)
  const profile: OrcaProfileSummary = {
    id: `cloud-${randomUUID()}`,
    name,
    avatar: {
      kind: 'initials',
      initials: profileInitial(name),
      color: 'neutral'
    },
    kind: 'cloud-linked',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    cloud
  }
  const nextIndex = {
    ...index,
    profiles: [...index.profiles, profile]
  }
  mkdirSync(getOrcaProfileDirectory(profile.id, userDataPath), { recursive: true })
  writeProfileIndex(getOrcaProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles,
    profile
  }
}

function cloudIdentityDiffers(
  current: OrcaProfileCloudSummary | undefined,
  next: OrcaProfileCloudSummary
): boolean {
  return Boolean(
    current &&
    (current.userId !== next.userId ||
      current.cloudProfileId !== next.cloudProfileId ||
      (current.activeOrgId ?? '') !== (next.activeOrgId ?? ''))
  )
}

function requireProfile(
  index: ReturnType<typeof loadOrCreateProfileIndex>,
  profileId: string
): OrcaProfileSummary {
  const profile = index.profiles.find((candidate) => candidate.id === profileId)
  if (!profile) {
    throw new Error('unknown_orca_profile')
  }
  return profile
}

export async function linkOrcaProfileToCloud(
  profileId: string,
  cloud: OrcaProfileCloudSummary,
  userDataPath: string
): Promise<OrcaProfileListState> {
  const currentProfile = requireProfile(loadOrCreateProfileIndex(userDataPath), profileId)
  await reconcileCurrentArtifactCloudCleanup(profileId, userDataPath, currentProfile.cloud)
  const cleanupNeedsCommit = artifactCloudCleanupNeedsCommit(profileId, userDataPath, cloud)
  const cloudIdentityChanged = cloudIdentityDiffers(
    requireProfile(loadOrCreateProfileIndex(userDataPath), profileId).cloud,
    cloud
  )
  if (cloudIdentityChanged || cleanupNeedsCommit) {
    await prepareArtifactCloudCleanup(profileId, userDataPath, cloud)
  }
  // Why: the awaits above may interleave other index writes, so build the next index from a fresh read.
  const index = loadOrCreateProfileIndex(userDataPath)
  requireProfile(index, profileId)
  const now = Date.now()
  const profiles = index.profiles.map((profile) =>
    profile.id === profileId ? toCloudLinkedProfile(profile, cloud, now) : profile
  )
  const nextIndex = {
    ...index,
    profiles
  }
  writeProfileIndex(getOrcaProfileIndexPath(userDataPath), nextIndex)
  if (cloudIdentityChanged || cleanupNeedsCommit) {
    await commitArtifactCloudCleanup(profileId, userDataPath, cloud)
    await completeArtifactCloudCleanupIfCommitted(profileId, userDataPath, cloud)
  }
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles
  }
}

export async function unlinkOrcaProfileFromCloud(
  profileId: string,
  userDataPath: string
): Promise<OrcaProfileListState> {
  const currentProfile = requireProfile(loadOrCreateProfileIndex(userDataPath), profileId)
  await reconcileCurrentArtifactCloudCleanup(profileId, userDataPath, currentProfile.cloud)
  requireProfile(loadOrCreateProfileIndex(userDataPath), profileId)
  await prepareArtifactCloudCleanup(profileId, userDataPath, undefined)
  // Why: the awaits above may interleave other index writes, so build the next index from a fresh read.
  const index = loadOrCreateProfileIndex(userDataPath)
  requireProfile(index, profileId)
  const now = Date.now()
  const profiles = index.profiles.map((profile) =>
    profile.id === profileId ? toLocalProfile(profile, now) : profile
  )
  const nextIndex = {
    ...index,
    profiles
  }
  writeProfileIndex(getOrcaProfileIndexPath(userDataPath), nextIndex)
  await commitArtifactCloudCleanup(profileId, userDataPath, undefined)
  await completeArtifactCloudCleanupIfCommitted(profileId, userDataPath, undefined)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles
  }
}
