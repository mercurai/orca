// fork-orcad-template ships a template exactly when the ref carries patch/orca-partial-orcad-template,
// and fails closed from v1.4.224, where every SSH host needs one. The gate needed fix 590fcad with no
// repro; these run the workflow step's own script against throwaway checkouts of each line
// (claude-code-config#1125).
// Run with `node --test "config/mercurai/scripts/*.test.mjs"` from the repo root.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'

const workflow = readFileSync(
  resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'fork-orcad-template.yml'),
  'utf8'
).replaceAll('\r\n', '\n')

/** The gate step's text: from its name line to the next step. */
function gateStep() {
  const start = workflow.indexOf('      - name: Detect whether the ref ships the orcad template\n')
  assert.ok(start !== -1, 'the gate step exists')
  const rest = workflow.slice(start + 1)
  const end = rest.search(/^ {6}(?:- |#)/m)
  return end < 0 ? rest : rest.slice(0, end)
}

/** The step's `run: |` body with its indentation removed. */
function gateScript(step) {
  const lines = step.split('\n')
  const at = lines.findIndex((line) => /^ {8}run: \|$/.test(line))
  assert.ok(at !== -1, 'the gate step runs a block')
  const body = []
  for (const line of lines.slice(at + 1)) {
    if (line !== '' && !line.startsWith(' '.repeat(10))) {
      break
    }
    body.push(line.slice(10))
  }
  return body.join('\n')
}

const step = gateStep()
const script = gateScript(step)
const firstWithOrcadHosts = /^ {10}FIRST_WITH_ORCAD_HOSTS: (\S+)$/m.exec(step)?.[1]
const roots = []

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Run the gate in a checkout whose package.json says `version` (null: no package.json). */
function runGate({ version, template = false, packageJson }) {
  const root = mkdtempSync(join(tmpdir(), 'orca-ships-gate-'))
  roots.push(root)
  if (packageJson !== undefined) {
    writeFileSync(join(root, 'package.json'), packageJson)
  } else if (version !== null) {
    writeFileSync(join(root, 'package.json'), `{\n  "name": "orca",\n  "version": "${version}",\n  "dependencies": {\n    "version": "9.9.9"\n  }\n}\n`)
  }
  if (template) {
    mkdirSync(join(root, 'config', 'scripts'), { recursive: true })
    writeFileSync(join(root, 'config', 'scripts', 'packaged-orcad-template-targets.cjs'), '')
  }
  const output = join(root, 'github-output')
  writeFileSync(output, '')
  const result = spawnSync('bash', ['-c', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      TEMPLATE_REF: 'a'.repeat(40),
      FIRST_WITH_ORCAD_HOSTS: firstWithOrcadHosts,
      GITHUB_OUTPUT: output
    }
  })
  return { ...result, outputs: readFileSync(output, 'utf8'), log: `${result.stdout}${result.stderr}` }
}

test('the gate step names the first version whose SSH hosts need a template', () => {
  assert.equal(firstWithOrcadHosts, '1.4.224')
})

test('v1.4.223 without the patch ships no template and still builds', () => {
  const run = runGate({ version: '1.4.223' })
  assert.equal(run.status, 0, run.log)
  assert.equal(run.outputs, 'ships=false\n')
  assert.match(run.log, /::notice::.*1\.4\.223.*no orcad template/)
})

test('v1.4.224 without the patch fails and says which patch is missing', () => {
  const run = runGate({ version: '1.4.224' })
  assert.equal(run.status, 1, run.log)
  assert.equal(run.outputs, '')
  assert.match(run.log, /::error::.*1\.4\.224.*lacks patch\/orca-partial-orcad-template/)
})

test('a ref with the patch ships the template on either line', () => {
  for (const version of ['1.4.223', '1.4.224']) {
    const run = runGate({ version, template: true })
    assert.equal(run.status, 0, run.log)
    assert.equal(run.outputs, 'ships=true\n', version)
  }
})

test('every later version without the patch fails; earlier ones build without a template', () => {
  for (const version of ['1.4.225', '1.5.0', '1.10.0', '2.0.0']) {
    const run = runGate({ version })
    assert.equal(run.status, 1, `${version}: ${run.log}`)
    assert.equal(run.outputs, '', version)
  }
  for (const version of ['1.4.9', '1.4.100', '1.3.999']) {
    const run = runGate({ version })
    assert.equal(run.status, 0, `${version}: ${run.log}`)
    assert.equal(run.outputs, 'ships=false\n', version)
  }
})

test('fails closed when the version cannot be read', () => {
  for (const options of [
    { version: null },
    { packageJson: '{}\n' },
    { packageJson: '{\n  "version": "next"\n}\n' },
    { packageJson: '{\n    "nested": {\n      "version": "1.4.224"\n    }\n}\n' }
  ]) {
    const run = runGate(options)
    assert.equal(run.status, 1, run.log)
    assert.equal(run.outputs, '', JSON.stringify(options))
  }
})

test('mobile dependencies are installed and checked before building the template page', () => {
  const installAt = workflow.indexOf('      - name: Install mobile dependencies\n')
  const pageAt = workflow.indexOf('      - name: Build the mobile web bundle\n')
  assert.ok(installAt !== -1 && pageAt > installAt)
  const install = workflow.slice(installAt, pageAt)
  assert.match(install, /if: steps\.support\.outputs\.ships == 'true'/)
  assert.match(install, /working-directory: mobile\n/)
  assert.match(install, /pnpm install --frozen-lockfile\n/)
  assert.doesNotMatch(install, /--ignore-scripts/)
  assert.match(install, /git diff --exit-code -- package\.json pnpm-lock\.yaml pnpm-workspace\.yaml/)
})

test('the verified mobile page is built before orcad stages it', () => {
  const pageAt = workflow.indexOf('      - name: Build the mobile web bundle\n')
  const serverAt = workflow.indexOf(
    '      - name: Build orcad and run the headless server tests against the artifact\n'
  )
  assert.ok(pageAt !== -1 && serverAt > pageAt)
  const page = workflow.slice(pageAt, serverAt)
  assert.match(page, /if: steps\.support\.outputs\.ships == 'true'/)
  assert.match(page, /run: pnpm run build:mobile-web\n/)
})
