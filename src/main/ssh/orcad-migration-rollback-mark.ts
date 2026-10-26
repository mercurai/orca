import type { OrcadManagedRollbackResult } from '../../shared/orcad-managed-runtime'
import { findIncompleteManagedOrcadMigration } from '../managed-server/lifecycle/orcad-managed-migration-status'
/** When a managed server last took in migrated state; a rollback to an older snapshot loses it. */
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { listOrcadMigrationSourceCutovers } from './orcad-migration-cutover-journal'

/**
 * The latest migration into this server: its durable mark, or a journal's start for a delta
 * moved before deltas wrote that mark. An unreadable journal fails closed as "now".
 */
export function latestOrcadMigrationInto(
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): string | undefined {
  let started: string[]
  try {
    started = listOrcadMigrationSourceCutovers(userDataPath)
      .filter((cutover) => cutover.destinationEnvironmentId === environment.id)
      .map((cutover) => cutover.startedAt)
  } catch {
    return new Date().toISOString()
  }
  return [environment.orcadMigratedAt, ...started]
    .filter((at): at is string => at !== undefined)
    .reduce<string | undefined>(
      (latest, at) => (latest === undefined || Date.parse(at) > Date.parse(latest) ? at : latest),
      undefined
    )
}

export function migrationRollbackRefusal(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  activatedAt: string | null
): OrcadManagedRollbackResult | null {
  if (findIncompleteManagedOrcadMigration(userDataPath, environment.id)) {
    return {
      outcome: 'refused',
      code: 'orcad_rollback_migration_in_progress',
      reason: 'A migration into this server is still running. Finish it before rolling back.'
    }
  }
  const migratedAt = latestOrcadMigrationInto(userDataPath, environment)
  if (migratedAt && (activatedAt === null || Date.parse(activatedAt) < Date.parse(migratedAt))) {
    return {
      outcome: 'refused',
      code: 'orcad_rollback_crosses_migration',
      reason:
        "The previous version's state predates the projects migrated onto this server; " +
        'rolling back would lose them. Deploy forward instead.'
    }
  }
  return null
}
