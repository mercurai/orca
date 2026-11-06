import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveCodexShellNativeResolverCommand } from './codex-shell-native-resolver'

const roots: string[] = []

function makeResources(): { resourcesPath: string; launcher: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca codex native resolver-'))
  roots.push(root)
  const resourcesPath = join(root, 'resources')
  const bin = join(resourcesPath, 'bin')
  mkdirSync(bin, { recursive: true })
  const launcher = join(bin, 'orca.exe')
  writeFileSync(launcher, 'fixture')
  return { resourcesPath, launcher }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Codex native resolver path', () => {
  it('returns the readable packaged Windows CLI for local native panes', () => {
    const { resourcesPath, launcher } = makeResources()

    expect(
      resolveCodexShellNativeResolverCommand({
        isPackaged: true,
        resourcesPath,
        platform: 'win32'
      })
    ).toBe(launcher)
  })

  it.each([
    ['development', { isPackaged: false }],
    ['WSL', { isPackaged: true, isWsl: true }],
    ['non-Windows', { isPackaged: true, platform: 'linux' as const }],
    ['missing resources', { resourcesPath: null }]
  ])('does not provide the resolver for %s', (_name, override) => {
    const { resourcesPath } = makeResources()

    expect(
      resolveCodexShellNativeResolverCommand({
        isPackaged: true,
        resourcesPath,
        platform: 'win32',
        ...override
      })
    ).toBeNull()
  })

  it('skips a missing packaged CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca codex missing resolver-'))
    roots.push(root)

    expect(
      resolveCodexShellNativeResolverCommand({
        isPackaged: true,
        resourcesPath: root,
        platform: 'win32'
      })
    ).toBeNull()
  })
})
