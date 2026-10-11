// The stop records went from synchronous writes to the async secure-file lane. These pin that
// orcad still has each record on disk before it hands a stop on, and before its exit path ends.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OrcadManagedStopRequestSchema } from '../../shared/orcad-stop-request'
import { serializePathWrite } from '../../shared/path-write-serializer'
import { drainPathWritesForQuit } from '../startup/path-write-quit-drain'
import { orcadStopReceiptPath, writeOrcadStopRecordFile } from './orcad-completed-stop-receipt'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { orcadManagedStopRequestPath } from './orcad-managed-stop-request'
import {
  installOrcadStopRequestListeners,
  type OrcadStopRequestListener
} from './orcad-stop-request-listener'

const roots: string[] = []
const listeners: OrcadStopRequestListener[] = []

afterEach(() => {
  for (const listener of listeners.splice(0)) {
    listener.close()
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'orcad-stop-durability-'))
  roots.push(root)
  return root
}

it('has the dispatched decision on disk before it hands the stop on', async () => {
  const lock = acquireOrcadInstanceLock(directory(), { identity: () => 'uid-1000' })
  const { pid, startedAtMs, nonce } = lock.record
  const managedStop = {
    version: '1.0.0',
    runtimeId: 'runtime-1',
    instance: { pid, startedAtMs, nonce, lockPath: lock.path }
  }
  const request = OrcadManagedStopRequestSchema.parse({
    schemaVersion: 1,
    transactionId: '0b9f6a3e-9e2c-4c8e-8f58-4c0f6b1d2e3a',
    ...managedStop
  })
  const decisionPath = orcadStopReceiptPath(request, 'decision')
  let decisionAtHandOff: unknown = null
  const onRequest = vi.fn(() => {
    // Read straight from disk: the stop that follows may end the process at any point after this.
    decisionAtHandOff = existsSync(decisionPath)
      ? JSON.parse(readFileSync(decisionPath, 'utf8')).decision
      : null
  })
  listeners.push(
    installOrcadStopRequestListeners(onRequest, {
      pollIntervalMs: 10,
      installRoot: directory(),
      managedStop
    })
  )
  writeFileSync(orcadManagedStopRequestPath(managedStop.instance), JSON.stringify(request))

  await vi.waitFor(() => expect(onRequest).toHaveBeenCalledOnce())
  expect(decisionAtHandOff).toBe('dispatched')
})

it('ends the exit path only after a stop record queued behind a slow write has landed', async () => {
  const recordPath = join(directory(), 'orcad-idle-stop.json')
  // A slow earlier write on the same path (an ACL spawn on Windows) holds the lane.
  let releaseEarlier!: () => void
  const earlier = serializePathWrite(
    recordPath,
    () =>
      new Promise<void>((resolve) => {
        releaseEarlier = resolve
      })
  )
  const record = writeOrcadStopRecordFile(recordPath, { kind: 'orcad_idle_stop' })
  const exit = vi.fn()
  // The orcad cleanup stack's last step, then the process exit (installOrcadShutdownSignals).
  const exitPath = drainPathWritesForQuit(5_000).then(() => exit(existsSync(recordPath)))

  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(exit).not.toHaveBeenCalled()
  expect(existsSync(recordPath)).toBe(false)

  releaseEarlier()
  await Promise.all([earlier, record, exitPath])
  expect(exit).toHaveBeenCalledWith(true)
  expect(JSON.parse(readFileSync(recordPath, 'utf8')).kind).toBe('orcad_idle_stop')
})
