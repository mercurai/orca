/**
 * After commit: a migration keeps its source rows, so a downgraded build still sees the host and
 * its projects and can reach them over its own relay. New builds hide those rows and serve the host
 * from the server. They are never deleted automatically.
 */
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import {
  updateOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'

/** Marks a committed migration as finished for this build while its source rows stay. */
export async function retainOrcadMigrationSource(
  userDataPath: string,
  migrationId: string,
  now: () => Date = () => new Date()
): Promise<OrcadMigrationSourceCutover> {
  return updateOrcadMigrationSourceCutover(userDataPath, migrationId, (cutover) => {
    if (cutover.phase !== 'destination-committed') {
      throw new Error('orcad_migration_retain_before_commit')
    }
    if (cutover.sourceRetainedAt) {
      return cutover
    }
    // Only the pre-commit fence baseline proves what the server holds after a downgrade.
    return { ...cutover, sourceRetainedAt: now().toISOString() }
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'orcad_migration_cutover_missing') {
      throw new Error('orcad_migration_retain_before_commit')
    }
    throw error
  })
}
