// Why: the E2EE auth handshake must never wait on a secure-file write. Every registry write runs on
// the async lane (no synchronous icacls spawn on the main thread), and the deferred lastSeen refresh
// is coalesced. These tests pin spawn counts and ordering, not wall-clock, so they are deterministic.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import { runProcess, runProcessSync } from '../../../shared/child-process/run-process'
import { settlePathWritesForTests } from '../../../shared/path-write-serializer'
import { resetSecureFileWindowsUserSidForTests } from '../../../shared/secure-path-windows-acl'
import { DEVICE_REGISTRY_FILENAME } from '../mobile-pairing-files'
import { DeviceRegistry, type DeviceEntry } from '../device-registry'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from './e2ee-crypto'
import { MobileSocketWiring, type MobileSocketTransport } from './mobile-socket-wiring'

// Why this module and not `node:child_process`: hardening reaches the OS only through
// runProcess/runProcessSync, and a hand-written child_process factory silently omitted the one
// function they call — so every spawn threw, hardening no-opped, and the test double hid it.
vi.mock('../../../shared/child-process/run-process', () => ({
  runProcess: vi.fn(),
  runProcessSync: vi.fn()
}))

const USER_SID = 'S-1-5-21-1000'
const OK: ProcessResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
/**
 * One secure write restricts only the staged temp file, fresh and still on the inherited DACL:
 * a reset and a grant. The published file keeps the protected DACL that came along with the
 * rename, so it costs nothing.
 */
const SPAWNS_PER_WRITE = 2

/** Paths the fake icacls has granted a protected DACL, keyed to the ACE flags the grant used. */
const hardenedByFake = new Map<string, string>()

/**
 * Stands in for icacls. `/save` really writes a UTF-16LE SDDL file, because the code under test
 * reads that file back off disk to decide whether a rewrite is needed at all — which is what makes
 * the spawn count per write a property of the real ACL path rather than of this double.
 */
function fakeIcacls(spec: ProcessSpec): ProcessResult {
  const args = spec.args ?? []
  const path = args[0] ?? ''
  const grantIndex = args.indexOf('/grant:r')
  if (grantIndex !== -1) {
    hardenedByFake.set(path, args[grantIndex + 1]!.includes('(OI)(CI)') ? 'OICI' : '')
    return OK
  }
  const saveIndex = args.indexOf('/save')
  if (saveIndex === -1) {
    return OK // /reset
  }
  writeFileSync(args[saveIndex + 1]!, fakeSddl(path), 'utf16le')
  return OK
}

function fakeSddl(path: string): string {
  const aceFlags = hardenedByFake.get(path)
  if (aceFlags === undefined) {
    // Never hardened: the inherited DACL a fresh file carries, so the first verify must fail.
    return `name\r\nD:(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${USER_SID})\r\n`
  }
  const ace = (sid: string): string => `(A;${aceFlags};FA;;;${sid})`
  return `name\r\nD:PAI${ace('BA')}${ace('SY')}${ace(USER_SID)}\r\n`
}

type TimelineEntry = 'acl-spawn' | 'e2ee_ready' | 'e2ee_authenticated' | 'other-frame'

class FakeSocket {
  readonly OPEN = 1
  readyState = this.OPEN
  bufferedAmount = 0
  readonly sent: (string | Buffer)[] = []
  readonly close = vi.fn()
  send: (data: string | Buffer) => void = (data) => {
    this.sent.push(data)
  }
}

class FakeTransport implements MobileSocketTransport {
  private messageHandler: Parameters<MobileSocketTransport['onMessage']>[0] | null = null
  readonly setClientId = vi.fn()
  readonly terminateClientConnections = vi.fn(() => 0)

  onMessage(handler: Parameters<MobileSocketTransport['onMessage']>[0]): void {
    this.messageHandler = handler
  }

  onConnectionClose(): void {}

  receive(ws: FakeSocket, message: string): void {
    this.messageHandler?.(message, vi.fn(), ws as unknown as WebSocket)
  }
}

describe('mobile auth critical path', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalSystemRoot = process.env.SystemRoot
  const timeline: TimelineEntry[] = []
  let userDataPath = ''

  beforeEach(() => {
    timeline.length = 0
    process.env.SystemRoot = 'C:\\Windows'
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-auth-acl-'))
    hardenedByFake.clear()
    vi.mocked(runProcessSync).mockReset()
    vi.mocked(runProcess).mockReset()
    resetSecureFileWindowsUserSidForTests()
    vi.mocked(runProcess).mockImplementation((spec) => {
      // Matched by suffix, not by the whole path: `windowsSystem32Binary` joins with the host
      // separator, so the literal only matches when the tests happen to run on Windows.
      if (spec.program.endsWith('whoami.exe')) {
        return Promise.resolve({ ...OK, stdout: `"USER","${USER_SID}"` })
      }
      // Why: only the staged file's spawns are per-write; the directory harden is a one-time, path-cached cost.
      if (spec.args?.[0]?.endsWith('.tmp')) {
        timeline.push('acl-spawn')
      }
      return Promise.resolve(fakeIcacls(spec))
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    if (originalSystemRoot === undefined) {
      delete process.env.SystemRoot
    } else {
      process.env.SystemRoot = originalSystemRoot
    }
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function authenticate(
    registry: DeviceRegistry,
    device: DeviceEntry
  ): { ws: FakeSocket; sharedKey: Uint8Array } {
    const desktop = generateKeyPair()
    const phone = generateKeyPair()
    const ws = new FakeSocket()
    const sharedKey = deriveSharedKey(phone.secretKey, desktop.publicKey)
    ws.send = vi.fn((data: string | Buffer) => {
      ws.sent.push(data)
      const text = data.toString()
      const plaintext = text.startsWith('{') ? text : (decrypt(text, sharedKey) ?? '')
      const type = (JSON.parse(plaintext || '{}') as { type?: string }).type
      timeline.push(type === 'e2ee_ready' || type === 'e2ee_authenticated' ? type : 'other-frame')
    })
    const transport = new FakeTransport()
    const wiring = new MobileSocketWiring({
      deviceRegistry: registry,
      e2eeKeypair: {
        publicKey: desktop.publicKey,
        secretKey: desktop.secretKey,
        publicKeyB64: Buffer.from(desktop.publicKey).toString('base64')
      },
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wiring.attachTransport(transport)
    transport.receive(
      ws,
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(phone.publicKey).toString('base64')
      })
    )
    transport.receive(
      ws,
      encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: device.token }), sharedKey)
    )
    return { ws, sharedKey }
  }

  function readPersistedDevices(): DeviceEntry[] {
    return JSON.parse(
      readFileSync(join(userDataPath, DEVICE_REGISTRY_FILENAME), 'utf-8')
    ) as DeviceEntry[]
  }

  const aclSpawns = (): number => timeline.filter((entry) => entry === 'acl-spawn').length

  it('emits e2ee_authenticated without a synchronous ACL spawn', async () => {
    const registry = new DeviceRegistry(userDataPath)
    const device = await registry.addDevice('Phone', 'runtime')
    // Why: a re-connecting device is the measured case; the first sighting is covered below.
    await registry.updateLastSeen(device.deviceId)
    timeline.length = 0

    authenticate(registry, device)

    expect(timeline).toEqual(['e2ee_ready', 'e2ee_authenticated'])
    expect(aclSpawns()).toBe(0)

    await registry.flushPendingLastSeen()
    // Hardening is deferred, never dropped: the staged file's reset and grant, as the inline path did.
    expect(aclSpawns()).toBe(SPAWNS_PER_WRITE)
    expect(runProcessSync).not.toHaveBeenCalled()
    expect(readPersistedDevices()[0]?.lastSeenAt).toBe(
      registry.getDevice(device.deviceId)?.lastSeenAt
    )
  })

  it('persists the first sighting without holding e2ee_authenticated', async () => {
    const registry = new DeviceRegistry(userDataPath)
    const device = await registry.addDevice('Phone', 'runtime')
    timeline.length = 0

    authenticate(registry, device)

    // Why: the first sighting still reaches disk (rotatePendingDevice drops never-scanned entries), but the auth callback is synchronous.
    expect(timeline).toEqual(['e2ee_ready', 'e2ee_authenticated'])
    await settlePathWritesForTests()
    expect(aclSpawns()).toBe(SPAWNS_PER_WRITE)
    expect(runProcessSync).not.toHaveBeenCalled()
    expect(readPersistedDevices()[0]?.lastSeenAt).toBeGreaterThan(0)
  })

  it('coalesces a reconnect burst into one deferred write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const registry = new DeviceRegistry(userDataPath)
    const device = await registry.addDevice('Phone', 'runtime')
    await registry.updateLastSeen(device.deviceId)
    timeline.length = 0

    for (let attempt = 0; attempt < 5; attempt += 1) {
      authenticate(registry, device)
    }

    expect(aclSpawns()).toBe(0)
    await vi.advanceTimersByTimeAsync(250)
    await settlePathWritesForTests()
    expect(aclSpawns()).toBe(SPAWNS_PER_WRITE)
  })

  it('cancels the deferred rewrite when another registry save persists the timestamp', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const registry = new DeviceRegistry(userDataPath)
    const device = await registry.addDevice('Phone', 'runtime')
    await registry.updateLastSeen(device.deviceId)
    timeline.length = 0

    registry.updateLastSeenDeferred(device.deviceId)
    await registry.addDevice('Other client', 'runtime')
    expect(aclSpawns()).toBe(SPAWNS_PER_WRITE)

    await vi.advanceTimersByTimeAsync(250)
    await settlePathWritesForTests()
    expect(aclSpawns()).toBe(SPAWNS_PER_WRITE)
  })

  it('keeps a deferred refresh that lands while another save is in flight', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const registry = new DeviceRegistry(userDataPath)
    const device = await registry.addDevice('Phone', 'runtime')
    await registry.updateLastSeen(device.deviceId)
    const refreshedAt = Date.now() + 10_000
    const now = vi.spyOn(Date, 'now')

    const saving = registry.addDevice('Other client', 'runtime')
    now.mockReturnValue(refreshedAt)
    registry.updateLastSeenDeferred(device.deviceId)
    await saving
    now.mockRestore()

    expect(registry.getDevice(device.deviceId)?.lastSeenAt).toBe(refreshedAt)
    await vi.advanceTimersByTimeAsync(250)
    await settlePathWritesForTests()
    expect(
      readPersistedDevices().find((entry) => entry.deviceId === device.deviceId)?.lastSeenAt
    ).toBe(refreshedAt)
  })
})
