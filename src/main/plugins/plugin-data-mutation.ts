import { resolve } from 'node:path'
import {
  discardPendingPathWrites,
  pathDiscardEpoch,
  serializePathWrite
} from '../../shared/path-write-serializer'

export const PLUGIN_DATA_RETIRED_ERROR = 'plugin data lifetime expired'

export function capturePluginDataLifetime(directory: string): () => boolean {
  const key = resolve(directory)
  const epoch = pathDiscardEpoch(key)
  return () => pathDiscardEpoch(key) === epoch
}

export function createPluginDataMutation(directory: string) {
  const key = resolve(directory)
  const current = capturePluginDataLifetime(key)
  return {
    current,
    run<T>(operation: () => Promise<T>, retired: () => T): Promise<T> {
      return serializePathWrite(key, async () => {
        if (!current()) {
          return retired()
        }
        try {
          const result = await operation()
          return current() ? result : retired()
        } catch (error) {
          if (!current()) {
            return retired()
          }
          throw error
        }
      })
    }
  }
}

/** Retire queued handles, drain admitted writes, then retire handles born during removal. */
export function retirePluginData(directory: string, remove: () => Promise<void>): Promise<void> {
  const key = resolve(directory)
  discardPendingPathWrites(key)
  return serializePathWrite(key, async () => {
    try {
      await remove()
    } finally {
      discardPendingPathWrites(key)
    }
  })
}
