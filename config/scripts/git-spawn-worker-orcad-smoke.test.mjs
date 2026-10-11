// A built orcad must start git on the spawn worker; a slot without the entry falls back silently.
import { build } from 'esbuild'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SHARE_ENV, Worker } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { gitExecFileAsync } from '../../src/main/git/command-runner/git-exec-file'
import { setGitSpawnWorkerFactoryForTests } from '../../src/main/git/command-runner/git-spawn-worker-access'
import { resolveWorkerThreadEntryPath } from '../../src/main/worker-thread-entry-path'
import { ORCAD_ARTIFACTS, ORCAD_GIT_SPAWN_WORKER_ENTRY } from '../../src/shared/orcad-artifacts.ts'
import {
  externalNativeAddons,
  ORCAD_CHILD_ENTRY_POINTS,
  ORCAD_EXTERNAL_MODULES,
  orcadChildOutputFilename
} from './orcad-entry-build.mjs'

const directories = []
let slot

function directory() {
  const created = mkdtempSync(join(tmpdir(), 'orca-git-spawn-worker-orcad-'))
  directories.push(created)
  return created
}

// orcad is packaged but has no Electron resources tree, so entries resolve beside orcad.js.
function entryPathIn(moduleDir) {
  return resolveWorkerThreadEntryPath(
    { isPackaged: true, resourcesPath: undefined, moduleDir },
    ORCAD_GIT_SPAWN_WORKER_ENTRY
  )
}

/** The production factory's contract, pointed at one slot directory. */
function useSlot(moduleDir) {
  const seen = { started: 0, log: [], workerMessages: [] }
  setGitSpawnWorkerFactoryForTests(
    () => {
      const workerPath = entryPathIn(moduleDir)
      if (!existsSync(workerPath)) {
        throw new Error(`Git spawn worker entry not found: ${workerPath}`)
      }
      seen.started += 1
      const worker = new Worker(workerPath, { env: SHARE_ENV })
      // Why: a worker that dies at load is retried in-process without a log line, so only
      // the worker's own replies prove the child was started on its thread.
      worker.on('message', (message) => seen.workerMessages.push(message.type))
      return worker
    },
    (message) => seen.log.push(message)
  )
  return seen
}

beforeAll(async () => {
  slot = directory()
  await build({
    entryPoints: [resolve(ORCAD_CHILD_ENTRY_POINTS.gitSpawnWorker)],
    outfile: join(slot, orcadChildOutputFilename(ORCAD_CHILD_ENTRY_POINTS.gitSpawnWorker)),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ORCAD_EXTERNAL_MODULES,
    plugins: [externalNativeAddons],
    // Same output shape as build-orcad.mjs's child build, so the minified artifact is what loads.
    minify: true,
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent'
  })
}, 60_000)

afterEach(() => setGitSpawnWorkerFactoryForTests(null))

afterAll(() => {
  for (const created of directories) {
    rmSync(created, { recursive: true, force: true })
  }
})

it('ships the entry under the name orcad resolves beside orcad.js', () => {
  expect(ORCAD_ARTIFACTS.map((artifact) => artifact.filename)).toContain(
    ORCAD_GIT_SPAWN_WORKER_ENTRY
  )
  expect(existsSync(entryPathIn(slot))).toBe(true)
})

it('runs git on the worker thread from an orcad slot', async () => {
  const seen = useSlot(slot)

  const { stdout } = await gitExecFileAsync(['--version'], { cwd: slot })

  expect(stdout).toMatch(/^git version /)
  expect(seen.started).toBe(1)
  expect(seen.log).toEqual([])
  expect(seen.workerMessages).toEqual(expect.arrayContaining(['spawned', 'result']))
}, 60_000)

it('does not count a slot whose entry cannot load as running git on the worker', async () => {
  const broken = directory()
  writeFileSync(entryPathIn(broken), "throw new Error('entry failed to load')")
  const seen = useSlot(broken)

  const { stdout } = await gitExecFileAsync(['--version'], { cwd: slot })

  // The client retries in-process, so git still answers; no reply came from the worker.
  expect(stdout).toMatch(/^git version /)
  expect(seen.workerMessages).not.toContain('spawned')
}, 60_000)

it('falls back in-process, and says so, when a slot lacks the entry', async () => {
  const seen = useSlot(directory())

  const { stdout } = await gitExecFileAsync(['--version'], { cwd: slot })

  expect(stdout).toMatch(/^git version /)
  expect(seen.started).toBe(0)
  expect(seen.log.join('\n')).toContain('[git-spawn-worker] unavailable, spawning in-process')
}, 60_000)
