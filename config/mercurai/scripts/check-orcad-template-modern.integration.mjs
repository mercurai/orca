// Explicit integration gate: ORCA_TEMPLATE_PRODUCT_REPO names the pinned modern product checkout.
// Run with node --test config/mercurai/scripts/check-orcad-template-modern.integration.mjs.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { checkOrcadTemplate } from './check-orcad-template.mjs'

assert.ok(process.env.ORCA_TEMPLATE_PRODUCT_REPO, 'Set ORCA_TEMPLATE_PRODUCT_REPO to the pinned modern product checkout')
const repoRoot = resolve(process.env.ORCA_TEMPLATE_PRODUCT_REPO)
const artifacts = await import(pathToFileURL(join(repoRoot, 'src/shared/orcad-artifacts.ts')).href)
const { writeOrcadTemplateTestFixture } = await import(
  pathToFileURL(join(repoRoot, 'config/scripts/orcad-template-test-fixture.mjs')).href
)
assert.equal(typeof artifacts.orcadMobileWebAssetFilenames, 'function')
const SHIPPED = 'linux-x64-glibc'
const roots = []
const digest = (value) => createHash('sha256').update(value).digest('hex')
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-modern-template-gate-'))
  roots.push(resourcesDir)
  const templateDir = await writeOrcadTemplateTestFixture(resourcesDir)
  const manifestPath = join(templateDir, artifacts.ORCAD_TEMPLATE_MANIFEST_FILENAME)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const target of Object.keys(manifest.targets)) {
    if (target !== SHIPPED) {
      delete manifest.targets[target]
      await rm(join(templateDir, artifacts.ORCAD_TEMPLATE_TARGETS_DIR, target), { recursive: true })
    }
  }
  const pagePath = join(templateDir, artifacts.ORCAD_MOBILE_WEB_MANIFEST)
  async function writePage(value) {
    await writeFile(pagePath, value)
    manifest.commonSha256[artifacts.ORCAD_MOBILE_WEB_MANIFEST] = digest(value)
    await writeFile(manifestPath, JSON.stringify(manifest))
  }
  const paths = ['index.html', 'assets/app.abc123.js', 'assets/styles.def456.css']
  for (const asset of paths) {
    const filename = `${artifacts.ORCAD_MOBILE_WEB_DIR}/${asset}`
    const contents = `synthetic packaged asset: ${asset}`
    await mkdir(dirname(join(templateDir, filename)), { recursive: true })
    await writeFile(join(templateDir, filename), contents)
    manifest.commonSha256[filename] = digest(contents)
  }
  await writePage(JSON.stringify({ assets: paths.map((path) => ({ path })) }))
  return { resourcesDir, templateDir, manifest, writePage }
}
const check = (f) => checkOrcadTemplate({ repoRoot, resourcesDir: f.resourcesDir, targets: [SHIPPED] })
async function failureText(f) {
  try {
    return (await check(f)).join('\n')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

test('validates every asset from the packaged slot manifest with the modern tag APIs', async () => {
  const f = await fixture()
  assert.deepEqual(await check(f), [])
})

test('rejects a missing modern page manifest instead of assuming an empty asset list', async () => {
  const f = await fixture()
  await rm(join(f.templateDir, artifacts.ORCAD_MOBILE_WEB_MANIFEST))
  assert.match(await failureText(f), /manifest\.json/)
})

test('rejects a missing hashed page asset', async () => {
  const f = await fixture()
  await rm(join(f.templateDir, artifacts.ORCAD_MOBILE_WEB_DIR, 'assets/app.abc123.js'))
  assert.match(await failureText(f), /missing.*assets\/app\.abc123\.js|assets\/app\.abc123\.js.*missing/)
})

test('rejects corrupted page bytes against the template checksum', async () => {
  const f = await fixture()
  await writeFile(join(f.templateDir, artifacts.ORCAD_MOBILE_WEB_DIR, 'assets/styles.def456.css'), 'corrupt')
  assert.match(await failureText(f), /styles\.def456\.css checksum mismatch/)
})

test('rejects malformed page metadata even when its outer checksum is updated', async () => {
  const f = await fixture()
  await f.writePage('{invalid json')
  assert.match(await failureText(f), /JSON|manifest|Unexpected token|property name/i)
})

for (const path of ['../outside.js', '/outside.js', 'C:/outside.js', 'assets/../../outside.js']) {
  test(`rejects unsafe page asset path ${path} with valid outer checksums`, async () => {
    const f = await fixture()
    await f.writePage(JSON.stringify({ assets: [{ path }] }))
    assert.match(await failureText(f), /unsafe asset path/)
  })
}
