#!/usr/bin/env node
// mercurai fork: gate an orcad deployment template, as built or as packaged in the desktop app.
// It runs the release tag's own verifier for the shipped targets, then checks that every file
// the tag lists for a deployed orcad is really there, so a build cannot ship a template that a
// host would fail to start from (claude-code-config#1125).
//
//   node check-orcad-template.mjs --repo <checkout of the release tag> \
//     --resources <dir holding orcad-template> --targets linux-x64-glibc [--require <filename>]...
import { existsSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Problems found, one line each; empty when the template can be shipped. */
export async function checkOrcadTemplate({ repoRoot, resourcesDir, targets, required = [] }) {
  const artifacts = await import(
    pathToFileURL(join(repoRoot, 'src', 'shared', 'orcad-artifacts.ts')).href
  )
  const { verifyPackagedOrcadTemplate } = createRequire(import.meta.url)(
    join(repoRoot, 'config', 'scripts', 'verify-packaged-orcad-template.cjs')
  )
  const problems = []
  const listed = new Set(artifacts.ORCAD_ARTIFACTS.map((artifact) => artifact.filename))
  for (const filename of required) {
    if (!listed.has(filename)) {
      problems.push(`ORCAD_ARTIFACTS does not list ${filename}; the tag lacks the patch that ships it`)
    }
  }
  try {
    verifyPackagedOrcadTemplate(resourcesDir, targets)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  const templateDir = join(resourcesDir, 'orcad-template')
  const common = new Set(artifacts.orcadTemplateCommonFilenames())
  for (const target of targets) {
    for (const filename of artifacts.orcadArtifactFilenames(target)) {
      const path = common.has(filename)
        ? join(templateDir, ...filename.split('/'))
        : join(templateDir, artifacts.ORCAD_TEMPLATE_TARGETS_DIR, target, ...filename.split('/'))
      if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
        problems.push(`${target}: missing or empty ${filename}`)
      }
    }
  }
  return problems
}

/** `--name value` pairs; `--require` may repeat. */
export function parseArguments(argv) {
  const options = { required: [] }
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index], argv[index + 1]]
    if (value === undefined || !['--repo', '--resources', '--targets', '--require'].includes(name)) {
      throw new Error(`unexpected argument ${name}`)
    }
    if (name === '--require') {
      options.required.push(value)
    } else if (name === '--targets') {
      options.targets = value.split(',').filter(Boolean)
    } else {
      options[name === '--repo' ? 'repoRoot' : 'resourcesDir'] = resolve(value)
    }
  }
  if (!options.repoRoot || !options.resourcesDir || !options.targets?.length) {
    throw new Error(
      'usage: check-orcad-template.mjs --repo <dir> --resources <dir> --targets <a,b> [--require <file>]...'
    )
  }
  return options
}

/** Compared as real paths: a drive-letter case or symlink difference must not skip the check. */
function runsAsScript() {
  try {
    return (
      realpathSync.native(import.meta.filename) === realpathSync.native(process.argv[1])
    )
  } catch {
    return false
  }
}

if (runsAsScript()) {
  try {
    const options = parseArguments(process.argv.slice(2))
    const problems = await checkOrcadTemplate(options)
    if (problems.length > 0) {
      for (const problem of problems) {
        console.error(`::error::orcad template: ${problem}`)
      }
      process.exit(1)
    }
    const requires = options.required.length ? `; requires ${options.required.join(',')}` : ''
    console.log(`orcad template ok: ${options.targets.join(',')} under ${options.resourcesDir}${requires}`)
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}
