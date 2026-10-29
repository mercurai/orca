/**
 * A stage a reset move may have left on the WSL host. A reset without the host's answer (a restart
 * while the host is down) lifts the desktop's record but cannot abort the host's stage, which then
 * keeps its claims on those projects for the stage's 7-day lifetime and refuses every retry. The
 * reset leaves this record; the next move into the distro aborts that stage by identity first.
 */
import { isRecord } from '../../../shared/orcad-migration/orcad-migration-manifest-fields'
import { serializePathWrite } from '../../../shared/path-write-serializer'
import type { WslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import { createMigrationJournalDirectory } from '../migrating-orcad-catalog/migration-journal-directory'
import type { OrcadMigrationDestinationCatalog } from '../../ssh/orcad-migration-cutover-coordinator'
import { listWslMoveCutovers, wslMoveJournalDirectory } from './wsl-move-cutover-journal'

export type WslMoveOwedHostAbort = {
  migrationId: string
  manifestSha256: string
  journalKey: string
}

const owed = createMigrationJournalDirectory<WslMoveOwedHostAbort>({
  // Its own directory: builds without it never read it, and their stage simply expires.
  directoryName: 'orcad-migration-wsl-owed-aborts',
  maxFileBytes: 4096,
  parse: parseOwedAbort,
  unreadable: (detail) => new Error(`wsl_move_owed_aborts_unreadable: ${detail}`)
})

function parseOwedAbort(value: unknown): WslMoveOwedHostAbort {
  if (
    !isRecord(value) ||
    typeof value.migrationId !== 'string' ||
    typeof value.manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.manifestSha256) ||
    typeof value.journalKey !== 'string'
  ) {
    throw new Error('wsl_move_owed_abort_invalid')
  }
  return {
    migrationId: value.migrationId,
    manifestSha256: value.manifestSha256,
    journalKey: value.journalKey
  }
}

/** Durable before it returns, so it lands before the record it outlives is removed. */
export function recordWslMoveOwedHostAbort(
  userDataPath: string,
  cutover: Pick<WslMoveCutover, 'migrationId' | 'manifestSha256' | 'journalKey'>
): Promise<void> {
  return owed.write(userDataPath, {
    migrationId: cutover.migrationId,
    manifestSha256: cutover.manifestSha256,
    journalKey: cutover.journalKey
  })
}

export function listWslMoveOwedHostAborts(userDataPath: string): WslMoveOwedHostAbort[] {
  return owed.list(userDataPath)
}

/**
 * Aborts each owed stage of this distro on its now-connected host. Only an answer settles one:
 * a failure keeps it for the next move, whose own stage the leftover would refuse anyway.
 */
export async function settleWslMoveOwedHostAborts(
  userDataPath: string,
  journalKey: string,
  destination: Pick<OrcadMigrationDestinationCatalog, 'abortByReference'>,
  warn: (message: string) => void = (message) => console.warn(message)
): Promise<void> {
  let pending: WslMoveOwedHostAbort[]
  try {
    pending = owed.list(userDataPath).filter((entry) => entry.journalKey === journalKey)
  } catch (error) {
    warn(`[wsl-move] Could not read the owed host aborts: ${describe(error)}`)
    return
  }
  for (const entry of pending) {
    try {
      await serializePathWrite(wslMoveJournalDirectory(userDataPath), async () => {
        if (
          listWslMoveCutovers(userDataPath).some(
            (record) => record.migrationId === entry.migrationId
          )
        ) {
          return
        }
        const current = owed
          .list(userDataPath)
          .find((record) => record.migrationId === entry.migrationId)
        if (!sameAbortIdentity(current, entry)) {
          return
        }
        const answer = await destination.abortByReference(entry)
        if (
          answer.migrationId !== entry.migrationId ||
          answer.manifestSha256 !== entry.manifestSha256
        ) {
          warn('[wsl-move] A leftover stage abort answered for another migration')
          return
        }
        if (answer.state === 'committed') {
          warn(`[wsl-move] A reset move ${entry.migrationId} reads as committed on the host`)
        }
        await owed.transact(userDataPath, async ({ remove }) => {
          const latest = owed
            .list(userDataPath)
            .find((record) => record.migrationId === entry.migrationId)
          if (sameAbortIdentity(latest, entry)) {
            await remove(entry.migrationId)
          }
        })
      })
    } catch (error) {
      warn(`[wsl-move] Could not settle a leftover stage on the host: ${describe(error)}`)
    }
  }
}

function sameAbortIdentity(
  current: WslMoveOwedHostAbort | undefined,
  expected: WslMoveOwedHostAbort
): boolean {
  return (
    current?.migrationId === expected.migrationId &&
    current.manifestSha256 === expected.manifestSha256 &&
    current.journalKey === expected.journalKey
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
