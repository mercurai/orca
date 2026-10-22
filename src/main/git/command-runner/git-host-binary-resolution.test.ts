import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveHostBinaryOnce } from './git-command-resolution'

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('resolveHostBinaryOnce', () => {
  let root: string

  beforeEach(() => {
    setPlatform('win32')
    root = mkdtempSync(path.join(tmpdir(), 'orca-host-binary-'))
  })
  afterEach(() => {
    setPlatform(realPlatform)
    rmSync(root, { recursive: true, force: true })
  })

  function installBinary(directory: string, name: string): string {
    const dir = path.join(root, directory)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    writeFileSync(file, '')
    return file
  }

  it('returns one absolute path per PATH generation without searching again', () => {
    const later = installBinary('later', 'git.exe')
    const env = { PATH: `${path.join(root, 'earlier')};${path.dirname(later)}` }
    expect(resolveHostBinaryOnce('git', env)).toBe(later)
    // Why: a binary that appears earlier on the same PATH is not seen until the PATH changes.
    installBinary('earlier', 'git.exe')
    expect(resolveHostBinaryOnce('git', env)).toBe(later)
  })

  it('searches again when the cached binary has disappeared', () => {
    const git = installBinary('first', 'git.exe')
    const env = { PATH: path.dirname(git) }
    expect(resolveHostBinaryOnce('git', env)).toBe(git)
    rmSync(git)
    expect(resolveHostBinaryOnce('git', env)).toBe('git')
  })

  it('searches again after the PATH changes', () => {
    const first = installBinary('first', 'gh.exe')
    const second = installBinary('second', 'gh.exe')
    expect(resolveHostBinaryOnce('gh', { PATH: path.dirname(first) })).toBe(first)
    expect(
      resolveHostBinaryOnce('gh', { PATH: `${path.dirname(second)};${path.dirname(first)}` })
    ).toBe(second)
  })

  it('leaves a binary it cannot find, and any other command, to the OS', () => {
    const env = { PATH: path.join(root, 'empty') }
    expect(resolveHostBinaryOnce('git', env)).toBe('git')
    expect(resolveHostBinaryOnce('node', env)).toBe('node')
  })

  it('does not rewrite anything off Windows', () => {
    setPlatform('linux')
    expect(resolveHostBinaryOnce('git', { PATH: root })).toBe('git')
  })

  it('names wsl.exe by its System32 path', () => {
    expect(resolveHostBinaryOnce('wsl.exe', {})).toMatch(/wsl\.exe$/i)
  })
})
