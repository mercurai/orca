// Run with `node --test "config/mercurai/scripts/*.test.mjs"` from the repo root.
// Uses the repo's own template fixture and verifier, so it follows whatever tag it runs in.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { writeOrcadTemplateTestFixture } from '../../scripts/orcad-template-test-fixture.mjs'
import { ORCAD_TEMPLATE_TARGETS } from '../../../src/shared/node-runtime-pin.ts'
import {
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR
} from '../../../src/shared/orcad-artifacts.ts'
import { checkOrcadTemplate, parseArguments } from './check-orcad-template.mjs'

const repoRoot = resolve(import.meta.dirname, '..', '..', '..')
const SHIPPED = 'linux-x64-glibc'
const roots = []

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

/** A resources dir whose template carries only `kept` (all targets when omitted). */
async function resourcesWith(kept) {
  const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-check-orcad-template-'))
  roots.push(resourcesDir)
  const templateDir = await writeOrcadTemplateTestFixture(resourcesDir)
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

const check = (resourcesDir, targets, required) =>
  checkOrcadTemplate({ repoRoot, resourcesDir, targets, required })

test('passes the full template for every target', async () => {
  const { resourcesDir } = await resourcesWith()
  assert.deepEqual(await check(resourcesDir, [...ORCAD_TEMPLATE_TARGETS]), [])
})

test('passes a template that carries exactly the shipped target', async () => {
  const { resourcesDir } = await resourcesWith([SHIPPED])
  assert.deepEqual(await check(resourcesDir, [SHIPPED]), [])
})

test('fails when the template lacks a target the build claims to ship', async () => {
  const { resourcesDir } = await resourcesWith([SHIPPED])
  const problems = await check(resourcesDir, [SHIPPED, 'win32-x64'])
  assert.ok(problems.some((problem) => problem.includes('target manifest inventory')), problems.join('\n'))
  assert.ok(problems.some((problem) => problem.startsWith('win32-x64: missing or empty ')))
})

test('fails when the template carries a target the build does not claim', async () => {
  const { resourcesDir } = await resourcesWith()
  const problems = await check(resourcesDir, [SHIPPED])
  assert.ok(problems.some((problem) => problem.includes('target manifest inventory')), problems.join('\n'))
})

test('names a server file that is missing from the template', async () => {
  const { resourcesDir, templateDir } = await resourcesWith([SHIPPED])
  await rm(join(templateDir, 'daemon-entry.js'))
  const problems = await check(resourcesDir, [SHIPPED])
  assert.ok(problems.includes(`${SHIPPED}: missing or empty daemon-entry.js`), problems.join('\n'))
})

test('names a per-target file that is empty', async () => {
  const { resourcesDir, templateDir } = await resourcesWith([SHIPPED])
  await writeFile(join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, SHIPPED, ORCAD_SERVER_TARGET_FILENAME), '')
  const problems = await check(resourcesDir, [SHIPPED])
  assert.ok(problems.includes(`${SHIPPED}: missing or empty ${ORCAD_SERVER_TARGET_FILENAME}`), problems.join('\n'))
})

test('fails when the tag does not list a file the release requires', async () => {
  const { resourcesDir } = await resourcesWith([SHIPPED])
  const problems = await check(resourcesDir, [SHIPPED], ['no-such-worker-entry.js'])
  assert.deepEqual(problems, [
    'ORCAD_ARTIFACTS does not list no-such-worker-entry.js; the tag lacks the patch that ships it'
  ])
})

test('accepts a required file the tag lists', async () => {
  const { resourcesDir } = await resourcesWith([SHIPPED])
  assert.deepEqual(await check(resourcesDir, [SHIPPED], ['daemon-entry.js']), [])
})

test('parses its arguments and refuses an incomplete or unknown set', () => {
  const parsed = parseArguments([
    '--repo', '.', '--resources', 'out', '--targets', `${SHIPPED},win32-x64`,
    '--require', 'a.js', '--require', 'b.js'
  ])
  assert.deepEqual(parsed.targets, [SHIPPED, 'win32-x64'])
  assert.deepEqual(parsed.required, ['a.js', 'b.js'])
  assert.equal(parsed.repoRoot, resolve('.'))
  assert.throws(() => parseArguments(['--repo', '.']), /usage:/)
  assert.throws(() => parseArguments(['--repo', '.', '--resources', 'out', '--targets', '']), /usage:/)
  assert.throws(() => parseArguments(['--bogus', 'x']), /unexpected argument --bogus/)
})

/** Synthetic newer release API: the real legacy fixture above covers the older tag contract. */
async function compactedReleaseFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-compacted-release-check-'))
  roots.push(root)
  const releaseRepo = join(root, 'repo')
  const resourcesDir = join(root, 'resources')
  const templateDir = join(resourcesDir, 'orcad-template')
  await mkdir(join(releaseRepo, 'src/shared'), { recursive: true })
  await mkdir(join(releaseRepo, 'config/scripts'), { recursive: true })
  await mkdir(join(templateDir, 'targets', SHIPPED), { recursive: true })
  await mkdir(join(resourcesDir, 'ripgrep/linux-x64'), { recursive: true })
  const worker = 'git-spawn-worker-entry.js'
  const binary = 'ripgrep/linux-x64/rg'
  await writeFile(join(templateDir, 'targets', SHIPPED, worker), 'worker')
  await writeFile(join(resourcesDir, binary), 'synthetic-ripgrep')
  await writeFile(
    join(templateDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 4,
      targets: {
        [SHIPPED]: {
          packagedRipgrep: true,
          files: { [binary]: createHash('sha256').update('synthetic-ripgrep').digest('hex') }
        }
      }
    })
  )
  await writeFile(join(releaseRepo, 'src/shared/orcad-artifacts.ts'), `
export const ORCAD_TEMPLATE_TARGETS_DIR = 'targets'
export const ORCAD_TEMPLATE_MANIFEST_FILENAME = 'manifest.json'
export const ORCAD_ARTIFACTS = [{filename: '${worker}'}, {filename: '${binary}'}]
export const orcadTemplateCommonFilenames = () => []
export const orcadArtifactFilenames = () => ['${worker}', '${binary}']
export function orcadTemplatePackagedRipgrep(schema, target, value) {
  if (schema !== 4 || target !== '${SHIPPED}' || value !== true) {
    throw new Error('Invalid packaged ripgrep reference')
  }
  return '${binary}'
}
`)
  await writeFile(join(releaseRepo, 'config/scripts/verify-packaged-orcad-template.cjs'), `
const { readFileSync, lstatSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { join } = require('node:path')
exports.verifyPackagedOrcadTemplate = (resources) => {
  const binary = join(resources, '${binary}')
  const manifest = JSON.parse(readFileSync(join(resources, 'orcad-template/manifest.json'), 'utf8'))
  const metadata = lstatSync(binary)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('ripgrep is not a regular file')
  const digest = createHash('sha256').update(readFileSync(binary)).digest('hex')
  if (digest !== manifest.targets['${SHIPPED}'].files['${binary}']) {
    throw new Error('shared ripgrep checksum mismatch')
  }
}
`)
  return { root, repoRoot: releaseRepo, resourcesDir, templateDir, worker, binary }
}

test('uses the release resolver for a compacted shared ripgrep and retains required worker checks', async () => {
  const fixture = await compactedReleaseFixture()
  const input = { ...fixture, targets: [SHIPPED], required: [fixture.worker] }
  assert.deepEqual(await checkOrcadTemplate(input), [])
  await rm(join(fixture.templateDir, 'targets', SHIPPED, fixture.worker))
  assert.ok((await checkOrcadTemplate(input)).includes(`${SHIPPED}: missing or empty ${fixture.worker}`))
})

for (const damage of ['missing', 'tampered']) {
  test(`refuses ${damage} compacted shared ripgrep`, async () => {
    const fixture = await compactedReleaseFixture()
    const binary = join(fixture.resourcesDir, fixture.binary)
    if (damage === 'missing') {
      await rm(binary)
    } else {
      await writeFile(binary, 'changed')
    }
    const problems = await checkOrcadTemplate({ ...fixture, targets: [SHIPPED] })
    assert.ok(problems.length > 0)
    assert.ok(
      problems.some((problem) =>
        damage === 'tampered'
          ? problem.includes('shared ripgrep checksum mismatch')
          : problem.includes('ENOENT')
      )
    )
  })
}
