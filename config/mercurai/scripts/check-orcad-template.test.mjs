// Run with `node --test "config/mercurai/scripts/*.test.mjs"` from the repo root.
// Uses the repo's own template fixture and verifier, so it follows whatever tag it runs in.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
