import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileCapture } from './exec-file-capture'
import {
  createThreadWorkerFactory,
  restoreGitSpawnMode,
  useGitSpawnMode
} from './git-spawn-worker-test-fixture'

describe('capture stderr observation across the worker boundary', () => {
  let bundle: ReturnType<typeof createThreadWorkerFactory>

  beforeAll(() => {
    bundle = createThreadWorkerFactory()
  })
  afterAll(() => bundle.cleanup())
  afterEach(() => restoreGitSpawnMode())

  it.each(['in-process', 'worker'] as const)(
    'delivers progress before the child can finish in %s mode and retains captured stderr',
    async (mode) => {
      useGitSpawnMode(mode, bundle.factory)
      const directory = mkdtempSync(join(tmpdir(), 'orca-capture-stderr-'))
      const acknowledged = join(directory, 'acknowledged')
      const chunks: string[] = []
      const script = `
        const fs = require('node:fs')
        process.stderr.write('progress\\n')
        const poll = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(acknowledged)})) return
          clearInterval(poll)
          process.stderr.write('finished\\n')
          process.stdout.write('complete')
        }, 5)
      `
      try {
        const result = await execFileCapture(process.execPath, ['-e', script], {
          encoding: 'utf8',
          timeout: 5_000,
          onStderr: (chunk) => {
            chunks.push(chunk)
            if (chunks.join('').includes('progress\n')) {
              writeFileSync(acknowledged, '')
            }
          }
        })
        expect(result.stdout).toBe('complete')
        expect(result.stderr).toBe('progress\nfinished\n')
        expect(chunks.join('')).toBe(result.stderr)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    15_000
  )
})
