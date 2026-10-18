// mercurai fork: a desktop build may ship the orcad template for some targets only.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assembleOrcadArtifact } from '../../src/main/orcad/orcad-artifact-materializer'
import {
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR
} from '../../src/shared/orcad-artifacts.ts'
import { writeOrcadTemplateTestFixture } from './orcad-template-test-fixture.mjs'

const require = createRequire(import.meta.url)
const {
  finalizePackagedOrcadTemplate,
  resealSignedWindowsApp
} = require('./packaged-orcad-template.cjs')
const {
  ORCAD_TEMPLATE_TARGETS_ENV,
  packagedOrcadTemplateTargets
} = require('./packaged-orcad-template-targets.cjs')

const SHIPPED = 'linux-x64-glibc'
const roots = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A resources dir whose template carries only `kept`, as `build-orcad-template --targets` leaves it. */
async function resourcesWith(kept, { compat = false } = {}) {
  const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-partial-orcad-template-'))
  roots.push(resourcesDir)
  const templateDir = await writeOrcadTemplateTestFixture(resourcesDir, { compat })
  if (kept) {
    const manifestPath = join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    for (const target of Object.keys(manifest.targets)) {
      if (!kept.includes(target)) {
        delete manifest.targets[target]
        await rm(join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target), { recursive: true })
      }
    }
    await writeFile(manifestPath, JSON.stringify(manifest))
  }
  return { resourcesDir, templateDir }
}

const finalize = (resourcesDir, targets) =>
  finalizePackagedOrcadTemplate(resourcesDir, {
    platform: 'win32',
    env: targets === undefined ? {} : { [ORCAD_TEMPLATE_TARGETS_ENV]: targets },
    signMacBinary: async () => {}
  })

describe('the packaged target list', () => {
  it('is every target when the variable is unset', () => {
    expect(packagedOrcadTemplateTargets({})).toBeUndefined()
  })

  it('reads a comma-separated list, ignoring spaces and repeats', () => {
    expect(
      packagedOrcadTemplateTargets({
        [ORCAD_TEMPLATE_TARGETS_ENV]: ` ${SHIPPED} , win32-x64,${SHIPPED}`
      })
    ).toEqual([SHIPPED, 'win32-x64'])
  })

  it.each([
    ['', 'got nothing'],
    [' , ', 'got nothing'],
    [`${SHIPPED},solaris-x64`, 'got solaris-x64']
  ])('refuses %j by name', (value, reason) => {
    const read = () => packagedOrcadTemplateTargets({ [ORCAD_TEMPLATE_TARGETS_ENV]: value })
    expect(read).toThrow(expect.objectContaining({ name: 'OrcadTemplateTargetsError' }))
    expect(read).toThrow(reason)
  })
})

describe('packaging a partial orcad template', () => {
  it('accepts a template that carries exactly the listed targets', async () => {
    const { resourcesDir } = await resourcesWith([SHIPPED])

    await expect(finalize(resourcesDir, SHIPPED)).resolves.toBeUndefined()
  })

  // `--targets linux-x64-glibc` also stages the glibc 2.17 slot when one was built.
  it('accepts the optional compat slot beside its listed base target', async () => {
    const { resourcesDir } = await resourcesWith([SHIPPED, 'linux-x64-glibc217'], { compat: true })

    await expect(finalize(resourcesDir, SHIPPED)).resolves.toBeUndefined()
  })

  it('still demands every target when the variable is unset', async () => {
    const { resourcesDir } = await resourcesWith([SHIPPED])

    await expect(finalize(resourcesDir, undefined)).rejects.toThrow('target manifest inventory')
  })

  it('fails when the list names a target the template lacks', async () => {
    const { resourcesDir } = await resourcesWith([SHIPPED])

    await expect(finalize(resourcesDir, `${SHIPPED},win32-x64`)).rejects.toThrow(
      'target manifest inventory'
    )
  })

  it('fails when the template carries a target the list does not name', async () => {
    const { resourcesDir } = await resourcesWith(null)

    await expect(finalize(resourcesDir, SHIPPED)).rejects.toThrow('target manifest inventory')
  })

  it('fails on a malformed list before it looks for the template', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'orca-partial-orcad-template-'))
    roots.push(empty)

    await expect(finalize(empty, 'solaris-x64')).rejects.toThrow(
      expect.objectContaining({ name: 'OrcadTemplateTargetsError' })
    )
  })

  it('reseals a signed Windows app against the same list', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv(ORCAD_TEMPLATE_TARGETS_ENV, SHIPPED)
    const appDir = await mkdtemp(join(tmpdir(), 'orca-partial-orcad-template-'))
    roots.push(appDir)
    // The fixture writes `<dir>/orcad-template`, so build it in the app's resources dir.
    const resourcesDir = join(appDir, 'resources')
    const templateDir = await writeOrcadTemplateTestFixture(resourcesDir)
    const manifestPath = join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    for (const target of Object.keys(manifest.targets)) {
      if (target !== SHIPPED) {
        delete manifest.targets[target]
        await rm(join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target), { recursive: true })
      }
    }
    await writeFile(manifestPath, JSON.stringify(manifest))
    const list = join(appDir, 'inner-signing-list.txt')
    await writeFile(list, '')

    expect(() => resealSignedWindowsApp(appDir, list)).not.toThrow()
  })
})

describe('a host outside the shipped targets', () => {
  it('is refused as unsupported, not as a missing template', async () => {
    const { templateDir, resourcesDir } = await resourcesWith([SHIPPED])

    await expect(
      assembleOrcadArtifact({
        templateDir,
        cacheRoot: join(resourcesDir, 'cache'),
        target: 'win32-x64'
      })
    ).rejects.toThrow(
      expect.objectContaining({
        name: 'OrcadHostUnsupportedError',
        message: 'Packaged orcad template does not support win32-x64'
      })
    )
  })
})
