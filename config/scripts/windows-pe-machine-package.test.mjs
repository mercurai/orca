import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageRoot = join(projectRoot, 'src', 'packages', 'process-host')
const manifestPath = join(packageRoot, 'package.json')
const readerPath = join(packageRoot, 'src', 'windows-pe-machine.cjs')
const adapterPath = join(projectRoot, 'config', 'scripts', 'windows-pe-machine.cjs')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const nodeExecutable = process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath
const temporary = []

afterEach(() => {
  for (const root of temporary.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createBootstrapFixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-windows-pe-bootstrap-'))
  temporary.push(root)

  const stagedPackage = join(root, 'node_modules', '@orca', 'process-host')
  mkdirSync(join(stagedPackage, 'src'), { recursive: true })
  mkdirSync(join(root, 'config', 'scripts'), { recursive: true })
  copyFileSync(manifestPath, join(stagedPackage, 'package.json'))
  copyFileSync(readerPath, join(stagedPackage, 'src', 'windows-pe-machine.cjs'))
  copyFileSync(adapterPath, join(root, 'config', 'scripts', 'windows-pe-machine.cjs'))
  writeFileSync(
    join(root, 'probe.cjs'),
    [
      "const assert = require('node:assert/strict')",
      "const path = require('node:path')",
      "const reader = require('@orca/process-host/windows-pe-machine')",
      "const adapter = require('./config/scripts/windows-pe-machine.cjs')",
      'assert.strictEqual(adapter, reader)',
      'assert.equal(',
      "  require.resolve('@orca/process-host/windows-pe-machine'),",
      "  path.join(__dirname, 'node_modules', '@orca', 'process-host', 'src', 'windows-pe-machine.cjs')",
      ')',
      "process.stdout.write('same reader')"
    ].join('\n'),
    'utf8'
  )

  return { root, stagedPackage, probe: join(root, 'probe.cjs') }
}

describe('process-host PE reader package export', () => {
  it('ships one static reader and points both runtime conditions at it', () => {
    expect(manifest.exports?.['./windows-pe-machine']).toEqual({
      'orca-source': './src/windows-pe-machine.cjs',
      types: './dist/windows-pe-machine.d.cts',
      default: './src/windows-pe-machine.cjs'
    })
    expect(manifest.files).toContain('src/windows-pe-machine.cjs')
    expect(existsSync(readerPath)).toBe(true)
  })

  it.each([
    ['default', []],
    ['orca-source', ['--conditions=orca-source']]
  ])('loads the public export and config adapter without dist under %s', (_condition, args) => {
    expect(existsSync(readerPath), 'the canonical package PE reader').toBe(true)
    const fixture = createBootstrapFixture()
    expect(existsSync(join(fixture.stagedPackage, 'dist'))).toBe(false)

    const result = runProcessSync({
      program: nodeExecutable,
      args: [...args, fixture.probe],
      cwd: fixture.root,
      timeoutMs: 10_000,
      env: { ...process.env, NODE_OPTIONS: '' }
    })

    expect(result.code, [result.stdout, result.stderr].filter(Boolean).join('\n')).toBe(0)
    expect(result.stdout).toBe('same reader')
    expect(result.stderr).toBe('')
  })
})
