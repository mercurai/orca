import { describe, expect, it } from 'vitest'

import { serializeCodexNativeResolution } from './agent-codex-native-protocol'

const nativeExecutable = String.raw`C:\Program Files\Codex\codex.exe`
const managedPackageRoot = String.raw`C:\Users\test-user\AppData\Roaming\npm\node_modules\@openai\codex`
const nativeResolution = {
  outcome: 'native',
  nativeExecutable,
  environmentDelta: { managedPackageRoot, manager: 'npm' }
}

describe('native Codex version-one protocol', () => {
  it('serializes the exact native JSON envelope', () => {
    expect(serializeCodexNativeResolution(nativeResolution, 'json')).toBe(
      `${JSON.stringify({
        schemaVersion: 1,
        outcome: 'native',
        nativeExecutable,
        environmentDelta: { managedPackageRoot, manager: 'npm' }
      })}\n`
    )
  })

  it('serializes native records in fixed order with a final newline', () => {
    expect(serializeCodexNativeResolution(nativeResolution, 'records')).toBe(
      [
        'ORCA_CODEX_NATIVE_V1',
        'native',
        nativeExecutable,
        managedPackageRoot,
        'npm',
        'END_ORCA_CODEX_NATIVE_V1',
        ''
      ].join('\n')
    )
  })

  it('serializes only the fixed fallback reason', () => {
    expect(
      serializeCodexNativeResolution(
        { outcome: 'fallback', reason: 'unrecognized_launcher' },
        'records'
      )
    ).toBe(
      'ORCA_CODEX_NATIVE_V1\nfallback\nunrecognized_launcher\nEND_ORCA_CODEX_NATIVE_V1\n'
    )
  })

  it.each([
    null,
    { outcome: 'fallback', reason: 'untrusted-value' },
    { outcome: 'fallback', reason: 'native_unavailable', extra: 'ignored data' },
    {
      outcome: 'native',
      nativeExecutable: 'codex.exe',
      environmentDelta: { managedPackageRoot, manager: 'npm' }
    },
    {
      outcome: 'native',
      nativeExecutable: String.raw`\foo\codex.exe`,
      environmentDelta: { managedPackageRoot, manager: 'npm' }
    },
    {
      outcome: 'native',
      nativeExecutable,
      environmentDelta: { managedPackageRoot: String.raw`\foo`, manager: 'npm' }
    },
    {
      outcome: 'native',
      nativeExecutable,
      environmentDelta: { managedPackageRoot, manager: 'pnpm' }
    },
    {
      outcome: 'native',
      nativeExecutable,
      environmentDelta: { managedPackageRoot: `${managedPackageRoot}\nmalicious`, manager: 'npm' }
    }
  ])('rejects malformed resolver results', (resolution) => {
    expect(() => serializeCodexNativeResolution(resolution, 'json')).toThrow(
      'invalid protocol data'
    )
  })

  it('rejects native paths that make the encoded response exceed 16 KiB', () => {
    const oversized = {
      outcome: 'native',
      nativeExecutable: `C:\\${'x'.repeat(16 * 1024)}`,
      environmentDelta: { managedPackageRoot, manager: 'npm' }
    }

    expect(() => serializeCodexNativeResolution(oversized, 'json')).toThrow(
      'output exceeds 16 KiB'
    )
  })
})
