import { describe, it } from 'vitest'
import { runNativeCodexRuntimeQualification } from '../../../tests/tools/windows-codex-native-runtime/runtime-qualification'

const requested = process.env.ORCA_CODEX_NATIVE_RUNTIME_TEST
if (requested !== undefined && requested !== '1') {
  throw new Error(
    'Set ORCA_CODEX_NATIVE_RUNTIME_TEST=1 to request the real Windows Codex runtime gate'
  )
}

const runtimeTest = requested === '1' ? it : it.skip

describe('real Windows Codex native runtime qualification', () => {
  runtimeTest(
    'measures the official npm launcher against Orca native resolution',
    async () => {
      await runNativeCodexRuntimeQualification()
    },
    20 * 60 * 1000
  )
})
