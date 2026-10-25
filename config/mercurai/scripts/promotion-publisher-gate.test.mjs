import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..', '..', '..')
const read = (...parts) => readFileSync(resolve(root, ...parts), 'utf8').replaceAll('\r\n', '\n')
const release = read('.github', 'workflows', 'fork-release-win-build.yml')
const assemble = read('.github', 'workflows', 'fork-assemble-release.yml')

test('published builds require a qualification run and trusted promotion receipt', () => {
  assert.match(release, /^      qualification_run_id:\n/m)
  assert.match(release, /name: Download the promotion receipt/)
  assert.match(release, /run-id: \$\{\{ inputs\.qualification_run_id \}\}/)
  assert.match(release, /name: Verify promotion receipt/)
  assert.match(release, /node \.controller\/config\/mercurai\/scripts\/verify-promotion\.mjs/)
  assert.match(release, /gh api .*actions\/runs/)
  assert.match(release, /run_attempt/)
  assert.match(release, /build controller changed after qualification/)
  assert.match(release, /qualified=true/)
  assert.match(release, /publish=true.*qualified|qualified.*publish=true/s)
  const preflight = release.slice(release.indexOf('\n  preflight:'), release.indexOf('\n  orcad-template:'))
  assert.doesNotMatch(preflight, /\bsecrets\b/)
})

test('assembly hands the exact candidate to qualification before packaging', () => {
  assert.match(assemble, /name: Qualify the assembled candidate/)
  assert.match(assemble, /fork-qualify-release\.yml/)
  assert.match(assemble, /candidate_sha/)
  assert.match(assemble, /Freeze the ordered patch series/)
  assert.match(assemble, /-f "series=\$SERIES"/)
  assert.match(assemble, /createdAt/)
  assert.match(assemble, /started_at=/)
  assert.match(assemble, /gh run watch/)
  assert.match(assemble, /qualification_run_id=/)
  assert.match(assemble, /qualification_run_id.*fork-release-win-build\.yml/s)
})
