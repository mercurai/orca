import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const SHA40 = /^[0-9a-f]{40}$/

function requireSha(value, label) {
  if (typeof value !== 'string' || !SHA40.test(value)) {
    throw new TypeError(`${label} must be a lowercase 40-character sha`)
  }
}

function conflictPath(line) {
  const content = line.match(/^CONFLICT \(content\): Merge conflict in (.+)$/)
  if (content) return { kind: 'content', path: content[1] }

  const modifyDelete = line.match(
    /^CONFLICT \(modify\/delete\): (.+?) (?:deleted|modified) in .+$/
  )
  if (modifyDelete) return { kind: 'modify/delete', path: modifyDelete[1] }

  return null
}

export function parseMergeTreeOutput(output, exitCode) {
  if (typeof output !== 'string') throw new TypeError('merge-tree output must be text')
  if (!Number.isInteger(exitCode) || exitCode < 0) throw new TypeError('merge-tree exit code is invalid')

  const lines = output.replaceAll('\r\n', '\n').split('\n')
  const tree = lines[0] && /^[0-9a-f]{40}$/.test(lines[0]) ? lines[0] : null
  const conflicts = lines
    .map(conflictPath)
    .filter((entry) => entry !== null)
    .filter(
      (entry, index, all) =>
        all.findIndex(
          (candidate) => candidate.kind === entry.kind && candidate.path === entry.path
        ) === index
    )
    .sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind))

  if (exitCode > 1) {
    throw new Error(`git merge-tree failed with exit code ${exitCode}`)
  }
  if (exitCode === 1 && conflicts.length === 0) {
    throw new Error('git merge-tree exited 1 without reporting conflict paths')
  }

  return {
    status: conflicts.length > 0 ? 'conflict' : 'clean',
    tree,
    conflicts
  }
}

export function buildConflictInventory({ baseSha, upstreamSha, candidateSha, output, exitCode, generatedAt } = {}) {
  requireSha(baseSha, 'baseSha')
  requireSha(upstreamSha, 'upstreamSha')
  requireSha(candidateSha, 'candidateSha')
  const parsed = parseMergeTreeOutput(output, exitCode)
  return {
    schemaVersion: 1,
    baseSha,
    upstreamSha,
    candidateSha,
    generatedAt: generatedAt ?? new Date().toISOString(),
    status: parsed.status,
    mergeTreeExitCode: exitCode,
    mergeTree: parsed.tree,
    conflictCount: parsed.conflicts.length,
    conflicts: parsed.conflicts
  }
}

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) throw new Error(`missing value for --${key}`)
    values.set(key, next)
    index += 1
  }
  const required = ['base', 'upstream', 'candidate']
  for (const key of required) {
    if (!values.has(key)) throw new Error(`missing --${key}`)
  }
  return {
    baseSha: values.get('base'),
    upstreamSha: values.get('upstream'),
    candidateSha: values.get('candidate'),
    outputPath: values.get('out')
  }
}

export function runConflictInventory({ baseSha, upstreamSha, candidateSha } = {}) {
  requireSha(baseSha, 'baseSha')
  requireSha(upstreamSha, 'upstreamSha')
  requireSha(candidateSha, 'candidateSha')
  const result = spawnSync(
    'git',
    ['merge-tree', '--write-tree', '--name-only', '--merge-base', baseSha, upstreamSha, candidateSha],
    { encoding: 'utf8', windowsHide: true }
  )
  if (result.error) throw result.error
  if (result.status === null) throw new Error('git merge-tree did not exit normally')
  return buildConflictInventory({
    baseSha,
    upstreamSha,
    candidateSha,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    exitCode: result.status
  })
}

if (process.argv[1] && process.argv[1].endsWith('release-conflict-inventory.mjs')) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const inventory = runConflictInventory(args)
    const serialized = `${JSON.stringify(inventory, null, 2)}\n`
    if (args.outputPath) writeFileSync(args.outputPath, serialized)
    else process.stdout.write(serialized)
    process.exitCode = inventory.status === 'conflict' ? 10 : 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
