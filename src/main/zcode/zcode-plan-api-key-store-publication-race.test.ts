import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSecretStore } from '../../shared/secret-store'
import type * as Fs from 'node:fs'
import type * as SecureFile from '../../shared/secure-file-async-write'
import type * as ZcodePlanApiKeyStore from './zcode-plan-api-key-store'

const restriction = vi.hoisted(() => vi.fn((_path: string, _directory: boolean) => false))

beforeEach(() =>
  setSecretStore({
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('unavailable')
    },
    decryptString: () => {
      throw new Error('unavailable')
    },
    describeProtectionGap: () => 'unavailable'
  })
)
// Stands in for the born-restricted create: a real staged write, then the injected outcome.
vi.mock('../../shared/secure-path-windows-acl', async () => {
  const { writeFileSync: stage } = await vi.importActual<typeof Fs>('node:fs')
  return {
    restrictWindowsPathSync: restriction,
    restrictNewFileAsync: async (path: string, directory = false) => restriction(path, directory),
    writeRestrictedWindowsFile: (path: string, contents: string) => {
      stage(path, contents, { encoding: 'utf-8', mode: 0o600 })
      return restriction(path, false)
    },
    restrictWindowsDirectory: () => Promise.resolve(false)
  }
})

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const envelope = (key: string): string =>
  `orca-zcode-plan-api-key:v1:plaintext:${Buffer.from(key).toString('base64')}`
const previousEnvelope = envelope('previous-key')
const competingEnvelope = envelope('competing-key')
let caseHome: string
let keyPath: string
let store: typeof ZcodePlanApiKeyStore
let writer: typeof SecureFile

beforeEach(async () => {
  caseHome = mkdtempSync(join(tmpdir(), 'orca-rollback-publication-'))
  vi.stubEnv('HOME', caseHome)
  vi.stubEnv('USERPROFILE', caseHome)
  keyPath = join(caseHome, '.orca', 'zcode-plan-api-key.enc')
  mkdirSync(join(caseHome, '.orca'))
  restriction.mockReset().mockReturnValue(false)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  vi.resetModules()
  expect(homedir()).toBe(caseHome)
  store = await import('./zcode-plan-api-key-store')
  writer = await import('../../shared/secure-file-async-write')
  expect(vi.isMockFunction(writer.writeSecureFileAsync)).toBe(false)
  expect(vi.isMockFunction(writeFileSync)).toBe(false)
  expect(vi.isMockFunction(renameSync)).toBe(false)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(caseHome, { recursive: true, force: true })
})

function publishDuringRollbackStaging(outcome: boolean | 'throws'): void {
  let stagedRestrictions = 0
  restriction.mockImplementation((targetPath) => {
    if (targetPath.endsWith('.tmp') && ++stagedRestrictions === 2) {
      const competingPath = join(caseHome, '.orca', 'competing-envelope')
      writeFileSync(competingPath, competingEnvelope)
      renameSync(competingPath, keyPath)
      if (outcome === 'throws') {
        throw new Error('Synthetic rollback staged ACL failure')
      }
      return outcome
    }
    return false
  })
}

async function refuseReplacement(): Promise<void> {
  await expect(store.saveZcodePlanApiKey('attempted-key')).rejects.toThrow(
    'could not be stored securely on this device'
  )
}

describe('rollback publication with real filesystem writes and renames', () => {
  it.each([false, true, 'throws'] as const)(
    'preserves the competing publication when the second staged ACL call returns %s',
    async (outcome) => {
      writeFileSync(keyPath, previousEnvelope)
      publishDuringRollbackStaging(outcome)

      await refuseReplacement()

      expect(readFileSync(keyPath, 'utf8')).toBe(competingEnvelope)
      expect(readFileSync(keyPath, 'utf8')).not.toBe(envelope('attempted-key'))
      expect(store.readZcodePlanApiKey()).toBe('competing-key')
      expect(readdirSync(join(caseHome, '.orca'))).toEqual(['zcode-plan-api-key.enc'])
    }
  )

  it('restores the previous envelope when the attempted publication is still owned', async () => {
    writeFileSync(keyPath, previousEnvelope)

    await refuseReplacement()

    expect(readFileSync(keyPath, 'utf8')).toBe(previousEnvelope)
    expect(store.readZcodePlanApiKey()).toBe('previous-key')
    expect(readdirSync(join(caseHome, '.orca'))).toEqual(['zcode-plan-api-key.enc'])
  })

  it('removes the owned rejected plaintext when no previous envelope exists', async () => {
    await refuseReplacement()

    expect(existsSync(keyPath)).toBe(false)
    expect(store.readZcodePlanApiKey()).toBeNull()
    expect(readdirSync(join(caseHome, '.orca'))).toEqual([])
  })

  it.each([false, true])(
    'retains the prior target state when initial staged hardening throws: previous %s',
    async (previous) => {
      if (previous) {
        writeFileSync(keyPath, previousEnvelope)
      }
      restriction.mockImplementation((targetPath) => {
        if (targetPath.endsWith('.tmp')) {
          throw new Error('Synthetic initial staged ACL failure')
        }
        return false
      })

      await expect(store.saveZcodePlanApiKey('attempted-key')).rejects.toThrow(
        'Synthetic initial staged ACL failure'
      )

      expect(existsSync(keyPath)).toBe(previous)
      expect(store.readZcodePlanApiKey()).toBe(previous ? 'previous-key' : null)
      expect(readdirSync(join(caseHome, '.orca'))).toEqual(
        previous ? ['zcode-plan-api-key.enc'] : []
      )
      if (previous) {
        expect(readFileSync(keyPath, 'utf8')).toBe(previousEnvelope)
      }
    }
  )

  it('keeps the cached prior key after rejecting a replacement during competing publication', async () => {
    writeFileSync(keyPath, previousEnvelope)
    expect(store.readZcodePlanApiKey()).toBe('previous-key')
    publishDuringRollbackStaging(false)

    await refuseReplacement()

    expect(readFileSync(keyPath, 'utf8')).toBe(competingEnvelope)
    expect(store.readZcodePlanApiKey()).toBe('previous-key')
    expect(readdirSync(join(caseHome, '.orca'))).toEqual(['zcode-plan-api-key.enc'])
  })
})
