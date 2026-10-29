import type { OrcadMigrationCatalogPayload } from '../../shared/orcad-migration/orcad-migration-manifest'
import {
  MAX_ORCAD_MIGRATION_FOLDER_WORKSPACES,
  MAX_ORCAD_MIGRATION_REPOSITORIES
} from '../../shared/orcad-migration/orcad-migration-manifest-validation'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration/orcad-migration-source-cutover'
import { orcadMigrationCatalogIds } from './orcad-migration-manifest-export'

export type UnmovedOrcadSourceRows = { repositoryIds: string[]; folderWorkspaceIds: string[] }

/**
 * The source's projects and folder workspaces that no move in the chain took or linked, and that
 * keeping the server's version didn't leave behind: all a delta move can add. Groups never count,
 * since deleting or creating one on this desktop is organization, not work the server lacks.
 */
export function unmovedOrcadSourceRows(
  current: OrcadMigrationCatalogPayload,
  chain: readonly OrcadMigrationSourceCutover[]
): UnmovedOrcadSourceRows {
  const moved = orcadMigrationCatalogIds(chain.map((cutover) => cutover.manifest.payload))
  const repositories = new Set([
    ...moved.repositoryIds,
    ...chain.flatMap((cutover) => [
      ...(cutover.linkedRepositoryIds ?? []),
      ...(cutover.keptRepositoryIds ?? [])
    ])
  ])
  const folders = new Set([
    ...moved.folderWorkspaceIds,
    ...chain.flatMap((cutover) => [
      ...(cutover.linkedFolderWorkspaceIds ?? []),
      ...(cutover.keptFolderWorkspaceIds ?? [])
    ])
  ])
  return {
    repositoryIds: current.repositories.map((row) => row.id).filter((id) => !repositories.has(id)),
    folderWorkspaceIds: current.folderWorkspaces
      .map((row) => row.id)
      .filter((id) => !folders.has(id))
  }
}

export function withKeptOrcadSourceRows(
  head: OrcadMigrationSourceCutover,
  unmoved: UnmovedOrcadSourceRows
): OrcadMigrationSourceCutover {
  const keptRepositoryIds = [...(head.keptRepositoryIds ?? []), ...unmoved.repositoryIds]
  const keptFolderWorkspaceIds = [
    ...(head.keptFolderWorkspaceIds ?? []),
    ...unmoved.folderWorkspaceIds
  ]
  // Why: past the bounds, the baseline fingerprint alone records what was kept.
  return keptRepositoryIds.length <= MAX_ORCAD_MIGRATION_REPOSITORIES &&
    keptFolderWorkspaceIds.length <= MAX_ORCAD_MIGRATION_FOLDER_WORKSPACES
    ? { ...head, keptRepositoryIds, keptFolderWorkspaceIds }
    : head
}
