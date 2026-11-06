import { describe, it } from 'vitest'
import { runPackagedCodexPtyLifecycle } from '../../../tests/tools/windows-codex-native-runtime/packaged-pty-lifecycle'

const requested = process.env.ORCA_CODEX_NATIVE_RUNTIME_TEST
if (requested !== undefined && requested !== '1') {
  throw new Error(
    'Set ORCA_CODEX_NATIVE_RUNTIME_TEST=1 to request the packaged Windows Codex PTY proof'
  )
}

const runtimeTest = requested === '1' ? it : it.skip

describe('packaged Windows Codex PTY lifecycle', () => {
  runtimeTest(
    'proves native launch and PTY reattach, interrupt, and close behavior',
    async () => {
      await runPackagedCodexPtyLifecycle()
    },
    15 * 60 * 1000
  )
})
