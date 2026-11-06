import { describe, expect, it } from 'vitest'
import {
  runtimeStageCleanupMessage,
  runtimeStageFailureMessage,
  type RuntimeChildFailureSnapshot
} from '../../../tests/tools/windows-codex-native-runtime/runtime-stage-diagnostics'

describe('Windows Codex runtime stage diagnostics', () => {
  it('reports failure-time child evidence before the separate cleanup verdict', () => {
    const message = runtimeStageFailureMessage({
      shellName: 'Git Bash',
      mode: 'native',
      sessionCount: 1,
      runIndex: 0,
      pairId: 1,
      phase: 'initialize-app-server',
      sessionIndex: 1,
      error: new Error('Codex app-server initialize timed out'),
      childrenAtFailure: [
        {
          closeObserved: true,
          exitCode: 1,
          signal: null,
          stdoutBytes: 1234,
          stdoutFrames: 2,
          stderrBytes: 7
        }
      ]
    })
    const cleanupMessage = runtimeStageCleanupMessage({
      shellName: 'Git Bash',
      mode: 'native',
      sessionCount: 1,
      runIndex: 0,
      pairId: 1,
      phase: 'initialize-app-server',
      sessionIndex: 1,
      cleanupErrorCount: 1,
      unverifiedCleanupCount: 0,
      forcedCleanupCount: 1,
      sessions: [{ cleanupComplete: true, cleanupMode: 'forced' }]
    })

    expect(message).toContain('shell=Git Bash mode=native sessions=1 run=1 pair=2')
    expect(message).toContain('phase=initialize-app-server session=1 cause=initialize-timeout')
    expect(message).toContain(
      'childrenAtFailure=[s1{exit=1,signal=none,outBytes=1234,frames=2,errBytes=7}]'
    )
    expect(cleanupMessage).toContain('errors=1 unverified=0 forced=1 sessions=[s1:forced]')
  })

  it('excludes raw paths and unbounded counter values from diagnostics', () => {
    const secretPath = 'C:\\Users\\private\\Codex'
    const message = runtimeStageFailureMessage({
      shellName: secretPath,
      mode: 'optout',
      sessionCount: 1,
      runIndex: 0,
      pairId: 0,
      phase: `initialize ${secretPath}`,
      sessionIndex: 1,
      error: new Error(secretPath),
      childrenAtFailure: [
        {
          closeObserved: false,
          exitCode: null,
          signal: null,
          stdoutBytes: Number.POSITIVE_INFINITY,
          stdoutFrames: -1,
          stderrBytes: 0
        }
      ]
    })

    expect(message).toContain('shell=other mode=optout')
    expect(message).toContain('phase=other session=1 cause=operation-failed')
    expect(message).toContain('outBytes=0,frames=0,errBytes=0')
    expect(message).not.toContain(secretPath)
  })

  it('caps child summaries', () => {
    const child: RuntimeChildFailureSnapshot = {
      closeObserved: false,
      exitCode: null,
      signal: null,
      stdoutBytes: 0,
      stdoutFrames: 0,
      stderrBytes: 0
    }
    const message = runtimeStageFailureMessage({
      shellName: 'PowerShell 7',
      mode: 'optout',
      sessionCount: 5,
      runIndex: 0,
      pairId: 0,
      phase: 'resource-measurement',
      sessionIndex: null,
      error: new Error('failure'),
      childrenAtFailure: [child, child, child, child, child]
    })

    expect(message.match(/s\d\{/gu)).toHaveLength(3)
    expect(message).toContain(';+2]')
  })
})
