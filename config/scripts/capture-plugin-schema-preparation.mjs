import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PLUGIN_SCHEMA_PREPARATION_PATHS = Object.freeze([
  'docs/schemas/plugins/orca-plugin.v2.schema.json',
  'examples/plugins/orca-gleam-syntax/orca-plugin.v2.schema.json',
  'docs/schemas/plugins/orca-catalog.v2.schema.json',
  'docs/reference/plugin-manifest.md',
  'docs/reference/plugin-catalog.md',
  'docs/reference/plugin-host-api.md',
  'docs/reference/plugin-theme-tokens.md'
])

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function git(checkout, args) {
  return execFileSync('git', args, {
    cwd: checkout,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore']
  })
}

function inventoryFile(checkout, path) {
  let beforeSha256 = null
  let afterSha256 = null
  try {
    beforeSha256 = sha256(git(checkout, ['show', `HEAD:${path}`]))
  } catch {
    // Missing baseline files cannot be represented by the tracked-file patch below.
  }
  try {
    const file = join(checkout, path)
    if (lstatSync(file).isFile()) {
      afterSha256 = sha256(readFileSync(file))
    }
  } catch {
    // Missing or nonregular outputs remain explicit inventory failures.
  }
  return { path, beforeSha256, afterSha256 }
}

export function capturePluginSchemaPreparation({
  checkout = process.cwd(),
  outputDir,
  env = process.env
}) {
  if (!outputDir) {
    throw new Error('source preparation requires an artifact directory')
  }
  checkout = resolve(checkout)
  outputDir = resolve(outputDir)
  const outputRelative = relative(checkout, outputDir)
  if (
    outputRelative === '' ||
    (!isAbsolute(outputRelative) &&
      outputRelative !== '..' &&
      !outputRelative.startsWith(`..${sep}`))
  ) {
    throw new Error('source preparation artifacts must be outside the checkout')
  }
  const validationErrors = []
  const report = {
    schemaVersion: 1,
    diagnosticOnly: true,
    qualifiedCandidate: false,
    expectedSha: env.GITHUB_SHA ?? null,
    checkoutSha: null,
    runId: env.GITHUB_RUN_ID ?? null,
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
    typecheckOutcome: env.TYPECHECK_OUTCOME ?? 'unknown',
    generationOutcome: env.GENERATION_OUTCOME ?? 'unknown',
    proposalStatus: env.GENERATION_OUTCOME === 'success' ? 'complete' : 'partial',
    files: PLUGIN_SCHEMA_PREPARATION_PATHS.map((path) => inventoryFile(checkout, path)),
    unexpectedPaths: [],
    validationErrors
  }
  let patch = Buffer.alloc(0)
  try {
    report.checkoutSha = git(checkout, ['rev-parse', 'HEAD']).toString('utf8').trim()
    const changed = [
      ...git(checkout, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-only',
        '--no-renames',
        '-z',
        'HEAD'
      ])
        .toString('utf8')
        .split('\0'),
      ...git(checkout, ['ls-files', '--others', '--exclude-standard', '-z'])
        .toString('utf8')
        .split('\0')
    ].filter(Boolean)
    const allowed = new Set(PLUGIN_SCHEMA_PREPARATION_PATHS)
    report.unexpectedPaths = [...new Set(changed.filter((path) => !allowed.has(path)))].sort()
    patch = git(checkout, [
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      'HEAD',
      '--',
      ...PLUGIN_SCHEMA_PREPARATION_PATHS
    ])
  } catch {
    validationErrors.push('capture_failed')
  }
  if (
    !/^[0-9a-f]{40}$/.test(report.expectedSha ?? '') ||
    report.checkoutSha !== report.expectedSha
  ) {
    validationErrors.push('source_identity_mismatch')
  }
  if (!/^\d+$/.test(report.runId ?? '') || !/^[1-9]\d*$/.test(report.runAttempt ?? '')) {
    validationErrors.push('invalid_run_identity')
  }
  if (report.files.some((file) => !file.beforeSha256)) {
    validationErrors.push('missing_baseline_files')
  }
  if (report.files.some((file) => !file.afterSha256)) {
    validationErrors.push('missing_or_nonregular_outputs')
  }
  if (report.unexpectedPaths.length) {
    validationErrors.push('unexpected_paths')
  }
  if (validationErrors.length) {
    report.proposalStatus = 'rejected'
  }
  report.patchSha256 = sha256(patch)
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, 'proposed.patch'), patch)
  writeFileSync(join(outputDir, 'preparation.json'), `${JSON.stringify(report, null, 2)}\n`)
  if (validationErrors.length) {
    throw new Error('source preparation was rejected; inspect preparation.json')
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  capturePluginSchemaPreparation({ outputDir: process.argv[2] })
}
