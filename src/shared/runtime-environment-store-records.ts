import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import {
  PersistedRuntimeEnvironmentSchema,
  type PersistedRuntimeEnvironment
} from './runtime-environments'
import { hardenExistingSecureFile } from './secure-file'

const ENVIRONMENTS_FILE = 'orca-environments.json'
export const MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES = 1024 * 1024

export type RuntimeEnvironmentStoreErrorCode = 'invalid_argument' | 'runtime_error'

export class RuntimeEnvironmentStoreError extends Error {
  readonly code: RuntimeEnvironmentStoreErrorCode

  constructor(code: RuntimeEnvironmentStoreErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeEnvironmentStoreError'
    this.code = code
  }
}

export function getEnvironmentStorePath(userDataPath: string): string {
  return join(userDataPath, ENVIRONMENTS_FILE)
}

// Records stay opaque so one bad or newer-format entry cannot hide the rest.
const StoreEnvelopeSchema = z.object({
  version: z.literal(1),
  environments: z.array(z.unknown())
})

/** A record this build cannot read; it is rewritten verbatim so a newer build still finds it. */
export type UnreadableEnvironmentRecord = { id: string | undefined; raw: unknown }

export type EnvironmentStoreRecords = {
  environments: PersistedRuntimeEnvironment[]
  unreadable: UnreadableEnvironmentRecord[]
}

function recordId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || !('id' in raw)) {
    return undefined
  }
  return typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : undefined
}

function parseRecord(raw: unknown): PersistedRuntimeEnvironment | undefined {
  // Why: a `kind` marks a record type this build predates; reading it as a plain pairing would
  // strip the kind and rewrite it as one.
  if (typeof raw === 'object' && raw !== null && 'kind' in raw) {
    return undefined
  }
  const parsed = PersistedRuntimeEnvironmentSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

/** The envelope must be valid; individual records that are not are set aside, not rejected. */
export function readEnvironmentStoreRecords(
  userDataPath: string,
  options: { requireStoreFile?: boolean } = {}
): EnvironmentStoreRecords {
  const path = getEnvironmentStorePath(userDataPath)
  if (!options.requireStoreFile && !existsSync(path)) {
    return { environments: [], unreadable: [] }
  }
  let records: unknown[]
  try {
    hardenExistingSecureFile(path)
    records = StoreEnvelopeSchema.parse(
      JSON.parse(
        readNodeFileSyncWithinLimit(path, MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES).buffer.toString(
          'utf8'
        )
      )
    ).environments
  } catch {
    throw new RuntimeEnvironmentStoreError(
      'runtime_error',
      `Could not read Orca environments at ${path}; the file is invalid.`
    )
  }
  const result: EnvironmentStoreRecords = { environments: [], unreadable: [] }
  for (const raw of records) {
    const environment = parseRecord(raw)
    if (environment) {
      result.environments.push(environment)
    } else {
      result.unreadable.push({ id: recordId(raw), raw })
    }
  }
  return result
}

const warned = new Set<string>()

/** Logs once per distinct message so per-round-trip reads do not flood the log. */
export function warnUnreadableEnvironmentState(message: string): void {
  if (warned.has(message)) {
    return
  }
  warned.add(message)
  console.warn(`[runtime-environments] ${message}`)
}

export function resolveEnvironmentFromStore<T extends PersistedRuntimeEnvironment>(
  store: { environments: T[] },
  selector: string
): T {
  const byId = store.environments.find((entry) => entry.id === selector)
  if (byId) {
    return byId
  }
  const matches = store.environments.filter((entry) => entry.name === selector)
  if (matches.length === 1) {
    return matches[0]!
  }
  if (matches.length > 1) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `Environment name "${selector}" is ambiguous; use the environment id.`
    )
  }
  throw new RuntimeEnvironmentStoreError('invalid_argument', `Unknown environment: ${selector}`)
}
