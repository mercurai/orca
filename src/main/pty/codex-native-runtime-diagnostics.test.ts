import { describe, expect, it } from 'vitest'
import {
  runtimeStageCleanupMessage,
  runtimeStageFailureMessage,
  type RuntimeChildFailureSnapshot
} from '../../../tests/tools/windows-codex-native-runtime/runtime-stage-diagnostics'
import { formatRuntimeShellCloseDiagnostic } from '../../../tests/tools/windows-codex-native-runtime/runtime-shell-close-diagnostic-format'
import type { RuntimeShellCloseDiagnostic } from '../../../tests/tools/windows-codex-native-runtime/runtime-shell-close-diagnostic'

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

  it('reports only bounded close state and indexed allowlisted job members', () => {
    const privateValue = 'C:\\Users\\private\\profile'
    const diagnostic: RuntimeShellCloseDiagnostic = {
      shellName: privateValue,
      mode: 'native',
      sessionIndex: 1,
      exitCode: 0,
      signal: null,
      closeObserved: false,
      killed: false,
      stdin: { writable: false, destroyed: false, ended: true, finished: true, closed: false },
      stdout: { readable: true, destroyed: false, ended: false, closed: false },
      stderr: { readable: true, destroyed: false, ended: false, closed: false },
      pendingRequests: 0,
      stdoutBytes: 502,
      stdoutFrames: 2,
      stderrBytes: 0,
      tableState: 'ok',
      jobState: 'ok',
      jobMemberCount: 2,
      missingIdentities: 0,
      changedIdentities: 0,
      truncatedMembers: 0,
      members: [
        { label: 'root', image: 'bash.exe', parent: 'outside' },
        { label: 'm1', image: 'codex.exe', parent: 'root' },
        { label: privateValue, image: privateValue, parent: privateValue }
      ]
    }
    const message = formatRuntimeShellCloseDiagnostic(diagnostic)

    expect(message).toContain(
      'shell=other mode=native session=1 childExit=0 childSignal=none closeObserved=0'
    )
    expect(message).toContain('stdin=0,0,1,1,0 stdout=1,0,0,0 stderr=1,0,0,0')
    expect(message).toContain('outBytes=502 frames=2 errBytes=0 table=ok job=ok jobMembers=2')
    expect(message).toContain(
      'members=[root:bash.exe<-outside;m1:codex.exe<-root;other:other<-other]'
    )
    expect(message).not.toContain(privateValue)
  })

  it('marks unavailable process evidence explicitly', () => {
    const message = formatRuntimeShellCloseDiagnostic({
      shellName: 'Git Bash',
      mode: 'native',
      sessionIndex: null,
      exitCode: null,
      signal: null,
      closeObserved: false,
      killed: false,
      stdin: { writable: false, destroyed: false, ended: true, finished: false, closed: false },
      stdout: { readable: true, destroyed: false, ended: false, closed: false },
      stderr: { readable: true, destroyed: false, ended: false, closed: false },
      pendingRequests: 0,
      stdoutBytes: 0,
      stdoutFrames: 0,
      stderrBytes: 0,
      tableState: 'timeout',
      jobState: 'unavailable',
      jobMemberCount: null,
      missingIdentities: 0,
      changedIdentities: 0,
      truncatedMembers: 0,
      members: []
    })

    expect(message).toContain('table=timeout job=unavailable jobMembers=unknown')
    expect(message).toContain('truncated=0 members=[]')
  })

  it('caps job-member summaries and reports the omitted count', () => {
    const members = Array.from({ length: 9 }, (_unused, index) => ({
      label: index === 0 ? 'root' : `m${index}`,
      image: index === 0 ? 'bash.exe' : 'codex.exe',
      parent: index === 0 ? 'outside' : 'root'
    }))
    const message = formatRuntimeShellCloseDiagnostic({
      shellName: 'Git Bash',
      mode: 'optout',
      sessionIndex: 2,
      exitCode: null,
      signal: null,
      closeObserved: false,
      killed: false,
      stdin: { writable: false, destroyed: false, ended: true, finished: false, closed: false },
      stdout: { readable: true, destroyed: false, ended: false, closed: false },
      stderr: { readable: true, destroyed: false, ended: false, closed: false },
      pendingRequests: 0,
      stdoutBytes: 0,
      stdoutFrames: 0,
      stderrBytes: 0,
      tableState: 'ok',
      jobState: 'ok',
      jobMemberCount: 9,
      missingIdentities: 0,
      changedIdentities: 0,
      truncatedMembers: 1,
      members
    })

    expect(message).toContain('jobMembers=9 missing=0 changed=0 truncated=1')
    expect(message).toContain('m7:codex.exe<-root')
    expect(message).not.toContain('m8:codex.exe')
  })
})
