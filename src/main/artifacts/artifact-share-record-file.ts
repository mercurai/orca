import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getOrcaProfileDirectory } from '../orca-profiles/profile-storage-paths'

export type ArtifactShareScope = {
  cloudUserId: string
  cloudProfileId: string
  cloudOrganizationId: string
  apiOrigin: string
}

export type ArtifactShareRecord = Omit<ArtifactShareScope, 'cloudOrganizationId'> & {
  cloudOrganizationId?: string
  slug: string
  editToken: string
  shareUrl: string
  expiresAt?: string
  savedAt?: number
}

export type ArtifactShareRecordFile = {
  version: 2
  lifecycleGeneration: number
  lifecycleNonce: string
  shares: Record<string, ArtifactShareRecord>
}

type ParsedArtifactShareRecordFile = {
  version?: unknown
  lifecycleGeneration?: unknown
  lifecycleNonce?: unknown
  shares?: unknown
}

const MAX_ARTIFACT_SHARE_RECORDS = 10_000

export function recordPath(profileId: string, userDataPath: string): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), 'artifact-shares.json')
}

function isRecord(value: unknown): value is ArtifactShareRecord {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Partial<ArtifactShareRecord>
  const requiredFieldsValid = [
    record.slug,
    record.editToken,
    record.shareUrl,
    record.cloudUserId,
    record.cloudProfileId,
    record.apiOrigin
  ].every((field) => typeof field === 'string' && field.length > 0)
  const expiresAtValid =
    record.expiresAt === undefined ||
    (typeof record.expiresAt === 'string' && Number.isFinite(Date.parse(record.expiresAt)))
  const savedAtValid =
    record.savedAt === undefined ||
    (typeof record.savedAt === 'number' &&
      Number.isSafeInteger(record.savedAt) &&
      record.savedAt >= 0)
  return requiredFieldsValid && expiresAtValid && savedAtValid
}

function compareRecordsNewestFirst(
  [sourceKeyA, recordA]: [string, ArtifactShareRecord],
  [sourceKeyB, recordB]: [string, ArtifactShareRecord]
): number {
  const savedAtDifference = (recordB.savedAt ?? -1) - (recordA.savedAt ?? -1)
  if (savedAtDifference !== 0) {
    return savedAtDifference
  }
  return sourceKeyA < sourceKeyB ? -1 : sourceKeyA > sourceKeyB ? 1 : 0
}

export function pruneRecords(
  shares: Record<string, ArtifactShareRecord>,
  now: number,
  preserveExpired?: PreserveExpired
): { shares: Record<string, ArtifactShareRecord>; changed: boolean } {
  const currentEntries = Object.entries(shares)
  const unexpired = currentEntries.filter(
    ([sourceKey, record]) =>
      (preserveExpired?.sourceKey === sourceKey &&
        preserveExpired.slug === record.slug &&
        preserveExpired.editToken === record.editToken) ||
      record.expiresAt === undefined ||
      Date.parse(record.expiresAt) > now
  )
  const retained =
    unexpired.length > MAX_ARTIFACT_SHARE_RECORDS
      ? unexpired.sort(compareRecordsNewestFirst).slice(0, MAX_ARTIFACT_SHARE_RECORDS)
      : unexpired
  return {
    shares: retained.length === currentEntries.length ? shares : Object.fromEntries(retained),
    changed: retained.length !== currentEntries.length
  }
}

export type PreserveExpired = { sourceKey: string; slug: string; editToken: string }

/** Reads and normalizes the record file; `dirty` means the cleaned form should be persisted. */
export function loadRecords(
  profileId: string,
  userDataPath: string,
  preserveExpired?: PreserveExpired,
  pruneExpired = true
): { records: ArtifactShareRecordFile; dirty: boolean } {
  const path = recordPath(profileId, userDataPath)
  if (!existsSync(path)) {
    return {
      records: { version: 2, lifecycleGeneration: 0, lifecycleNonce: '', shares: {} },
      dirty: false
    }
  }
  let parsed: ParsedArtifactShareRecordFile
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as ParsedArtifactShareRecordFile
  } catch (error) {
    throw new Error('Artifact share records could not be read safely.', { cause: error })
  }
  if (parsed.version === 1) {
    return {
      records: { version: 2, lifecycleGeneration: 0, lifecycleNonce: '', shares: {} },
      dirty: false
    }
  }
  if (
    parsed.version !== 2 ||
    !parsed.shares ||
    typeof parsed.shares !== 'object' ||
    Array.isArray(parsed.shares)
  ) {
    throw new Error('Artifact share records have an unsupported format.')
  }
  const shareEntries = Object.entries(parsed.shares as Record<string, unknown>)
  const validShares = Object.fromEntries(
    shareEntries.filter((entry): entry is [string, ArtifactShareRecord] => isRecord(entry[1]))
  )
  const pruned = pruneExpired
    ? pruneRecords(validShares, Date.now(), preserveExpired)
    : { shares: validShares, changed: false }
  const records: ArtifactShareRecordFile = {
    version: 2,
    lifecycleGeneration:
      Number.isSafeInteger(parsed.lifecycleGeneration) && Number(parsed.lifecycleGeneration) >= 0
        ? Number(parsed.lifecycleGeneration)
        : 0,
    lifecycleNonce: typeof parsed.lifecycleNonce === 'string' ? parsed.lifecycleNonce : '',
    shares: pruned.shares
  }
  return {
    records,
    dirty: pruned.changed || shareEntries.length !== Object.keys(validShares).length
  }
}
