import { randomUUID } from 'node:crypto'
import { serializePathWrite } from '../../shared/path-write-serializer'
import {
  writeDurableSecureJsonFileAsync,
  writeSecureJsonFileAsync
} from '../../shared/secure-file-async-write'
import {
  loadRecords,
  pruneRecords,
  recordPath,
  type ArtifactShareRecord,
  type ArtifactShareRecordFile,
  type ArtifactShareScope,
  type PreserveExpired
} from './artifact-share-record-file'

export type { ArtifactShareScope }

// Why: each store operation reads, modifies, then awaits a write; that unit must not interleave.
function serializeRecords<T>(
  profileId: string,
  userDataPath: string,
  run: () => Promise<T>
): Promise<T> {
  return serializePathWrite(`${recordPath(profileId, userDataPath)}#read-modify-write`, run)
}

async function readRecords(
  profileId: string,
  userDataPath: string,
  preserveExpired?: PreserveExpired,
  pruneExpired = true
): Promise<ArtifactShareRecordFile> {
  const { records, dirty } = loadRecords(profileId, userDataPath, preserveExpired, pruneExpired)
  if (dirty) {
    await writeSecureJsonFileAsync(recordPath(profileId, userDataPath), records)
  }
  return records
}

function matchesScope(record: ArtifactShareRecord, scope: ArtifactShareScope): boolean {
  return (
    matchesScopeIdentity(record, scope) &&
    (record.cloudOrganizationId === undefined ||
      record.cloudOrganizationId === scope.cloudOrganizationId)
  )
}

function matchesScopeIdentity(record: ArtifactShareRecord, scope: ArtifactShareScope): boolean {
  return (
    record.cloudUserId === scope.cloudUserId &&
    record.cloudProfileId === scope.cloudProfileId &&
    record.apiOrigin === scope.apiOrigin
  )
}

export function getArtifactShareRecord(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope
): Promise<ArtifactShareRecord | null> {
  return serializeRecords(profileId, userDataPath, async () => {
    const record = (await readRecords(profileId, userDataPath)).shares[sourceKey]
    return record && matchesScope(record, scope) ? record : null
  })
}

export function saveArtifactShareRecord(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  record: ArtifactShareRecord
): Promise<void> {
  return serializeRecords(profileId, userDataPath, async () => {
    const records = await readRecords(profileId, userDataPath)
    records.shares[sourceKey] = { ...record, savedAt: Date.now() }
    records.shares = pruneRecords(records.shares, Date.now()).shares
    await writeDurableSecureJsonFileAsync(recordPath(profileId, userDataPath), records)
  })
}

async function refreshExpirationUnserialized(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope,
  expected: { slug: string; editToken: string },
  expiresAt: string
): Promise<void> {
  const records = await readRecords(profileId, userDataPath, { sourceKey, ...expected })
  const current = records.shares[sourceKey]
  if (
    !current ||
    !matchesScope(current, scope) ||
    current.slug !== expected.slug ||
    current.editToken !== expected.editToken
  ) {
    return
  }
  records.shares[sourceKey] = {
    ...current,
    cloudOrganizationId: scope.cloudOrganizationId,
    expiresAt,
    savedAt: Date.now()
  }
  await writeSecureJsonFileAsync(recordPath(profileId, userDataPath), records)
}

export function refreshArtifactShareRecordExpiration(
  profileId: string,
  userDataPath: string,
  sourceKey: string,
  scope: ArtifactShareScope,
  expected: { slug: string; editToken: string },
  expiresAt: string
): Promise<void> {
  return serializeRecords(profileId, userDataPath, () =>
    refreshExpirationUnserialized(profileId, userDataPath, sourceKey, scope, expected, expiresAt)
  )
}

export function removeArtifactShareRecords(
  profileId: string,
  userDataPath: string,
  scope: ArtifactShareScope,
  match: { sourceKey?: string; slug?: string }
): Promise<void> {
  return serializeRecords(profileId, userDataPath, async () => {
    const records = await readRecords(profileId, userDataPath)
    for (const [sourceKey, record] of Object.entries(records.shares)) {
      if (
        matchesScope(record, scope) &&
        (match.slug === record.slug || (match.slug === undefined && match.sourceKey === sourceKey))
      ) {
        delete records.shares[sourceKey]
      }
    }
    await writeDurableSecureJsonFileAsync(recordPath(profileId, userDataPath), records)
  })
}

export function clearArtifactShareRecords(profileId: string, userDataPath: string): Promise<void> {
  return serializeRecords(profileId, userDataPath, async () => {
    let lifecycleGeneration = 0
    try {
      lifecycleGeneration = loadRecords(profileId, userDataPath, undefined, false).records
        .lifecycleGeneration
    } catch {
      // Clearing must recover sign-out from an unreadable token index.
    }
    await writeDurableSecureJsonFileAsync(recordPath(profileId, userDataPath), {
      version: 2,
      lifecycleGeneration: lifecycleGeneration + 1,
      lifecycleNonce: randomUUID(),
      shares: {}
    })
  })
}

// Why: a pure read, so the sync assertCurrent guards can call it; dirty cleanup is left to the next store write.
export function captureArtifactShareLifecycle(profileId: string, userDataPath: string): string {
  const { records } = loadRecords(profileId, userDataPath, undefined, false)
  return `${records.lifecycleGeneration}:${records.lifecycleNonce}`
}

export function isArtifactShareLifecycleCurrent(
  profileId: string,
  userDataPath: string,
  lifecycle: string
): boolean {
  return captureArtifactShareLifecycle(profileId, userDataPath) === lifecycle
}
