import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { guardedSafeStorage as safeStorage } from '../host/safe-storage-availability'
import { isUnreadableError } from '../../shared/secure-file'
import { writeSecureFileAsync } from '../../shared/secure-file-async-write'
import {
  PLUGIN_STORAGE_KEY_LIMIT,
  PLUGIN_STORAGE_TOTAL_MAX_BYTES
} from '../../shared/plugins/workers/plugin-host-api'
import { pluginDataDir } from './plugin-storage-store'
import { createPluginDataMutation, PLUGIN_DATA_RETIRED_ERROR } from './plugin-data-mutation'

// SafeStorage vault writes fail without OS encryption; never fall back to plaintext.

type PersistedSecretsFile = {
  version: 1
  format: 'electron-safe-storage-v1'
  ciphertexts: Record<string, string>
}

export type PluginSecretsResult<T> = { ok: true; value: T } | { ok: false; error: string }

const UNREADABLE_VAULT_ERROR = 'secret vault exists but could not be read; refusing to overwrite it'

export class PluginSecretsStore {
  private readonly filePath: string
  private readonly mutation: ReturnType<typeof createPluginDataMutation>

  constructor(pluginsDataDir: string, qualifiedKey: string) {
    const directory = pluginDataDir(pluginsDataDir, qualifiedKey)
    this.filePath = join(directory, 'secrets.json.enc')
    this.mutation = createPluginDataMutation(directory)
  }

  /** Null means unreadable, never empty. */
  private read(): PersistedSecretsFile | null {
    const empty: PersistedSecretsFile = {
      version: 1,
      format: 'electron-safe-storage-v1',
      ciphertexts: {}
    }
    try {
      if (!existsSync(this.filePath)) {
        return empty
      }
      if (statSync(this.filePath).size > PLUGIN_STORAGE_TOTAL_MAX_BYTES) {
        return empty
      }
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedSecretsFile
      if (
        parsed &&
        parsed.version === 1 &&
        parsed.format === 'electron-safe-storage-v1' &&
        parsed.ciphertexts &&
        typeof parsed.ciphertexts === 'object' &&
        !Array.isArray(parsed.ciphertexts)
      ) {
        return parsed
      }
    } catch (error) {
      // Read denial cannot prove emptiness; replacing the vault would silently drop every other secret.
      if (isUnreadableError(error)) {
        return null
      }
      // Corrupt vaults read as empty; set() rewrites a valid file.
    }
    return empty
  }

  get(key: string): PluginSecretsResult<string | null> {
    if (!this.mutation.current()) {
      return { ok: false, error: PLUGIN_DATA_RETIRED_ERROR }
    }
    const file = this.read()
    if (!file) {
      return { ok: false, error: UNREADABLE_VAULT_ERROR }
    }
    const ciphertext = file.ciphertexts[key]
    if (typeof ciphertext !== 'string') {
      return { ok: true, value: null }
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS-backed encryption is unavailable' }
    }
    try {
      return { ok: true, value: safeStorage.decryptString(Buffer.from(ciphertext, 'base64')) }
    } catch {
      return { ok: false, error: 'failed to decrypt stored secret' }
    }
  }

  set(key: string, value: string): Promise<PluginSecretsResult<true>> {
    return this.mutation.run(
      () => this.setUnserialized(key, value),
      () => ({ ok: false, error: PLUGIN_DATA_RETIRED_ERROR })
    )
  }

  delete(key: string): Promise<void> {
    return this.mutation.run(
      () => this.deleteUnserialized(key),
      () => undefined
    )
  }

  private async setUnserialized(key: string, value: string): Promise<PluginSecretsResult<true>> {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS-backed encryption is unavailable; secret not stored' }
    }
    const file = this.read()
    if (!file) {
      return { ok: false, error: UNREADABLE_VAULT_ERROR }
    }
    if (
      !Object.hasOwn(file.ciphertexts, key) &&
      Object.keys(file.ciphertexts).length >= PLUGIN_STORAGE_KEY_LIMIT
    ) {
      return { ok: false, error: `secret vault exceeds the ${PLUGIN_STORAGE_KEY_LIMIT}-key limit` }
    }
    file.ciphertexts[key] = safeStorage.encryptString(value).toString('base64')
    const nextFile = JSON.stringify(file, null, 2)
    if (Buffer.byteLength(nextFile, 'utf8') > PLUGIN_STORAGE_TOTAL_MAX_BYTES) {
      return { ok: false, error: `secret vault exceeds ${PLUGIN_STORAGE_TOTAL_MAX_BYTES} bytes` }
    }
    await writeSecureFileAsync(this.filePath, nextFile, { shouldPublish: this.mutation.current })
    return { ok: true, value: true }
  }

  private async deleteUnserialized(key: string): Promise<void> {
    const file = this.read()
    if (!file) {
      // Rewriting what we could not read would drop every other secret in the vault.
      return
    }
    if (Object.hasOwn(file.ciphertexts, key)) {
      delete file.ciphertexts[key]
      await writeSecureFileAsync(this.filePath, JSON.stringify(file, null, 2), {
        shouldPublish: this.mutation.current
      })
    }
  }
}
