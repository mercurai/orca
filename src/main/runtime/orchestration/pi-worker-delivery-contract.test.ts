import { beforeEach, describe, expect, it, vi } from 'vitest'
import { win32 } from 'node:path'

const host = vi.hoisted(() => ({
  installed: true,
  packaged: true,
  launcher: '/opt/orca/bin/orca-ide' as string | null,
  appPath: '/opt/orca/app',
  executable: '/opt/orca/orca-ide',
  files: new Set<string>()
}))

vi.mock('../../../shared/app-environment', () => ({
  hasAppEnvironment: () => host.installed,
  getAppEnvironment: () => ({
    isPackaged: () => host.packaged,
    getCliLauncherPath: () => host.launcher,
    getAppPath: () => host.appPath,
    getPath: (name: string) => name === 'exe' ? host.executable : '/private/user-data'
  })
}))

vi.mock('node:fs', () => ({
  statSync: (path: string) => {
    if (!host.files.has(path)) throw new Error('ENOENT')
    return { isFile: () => true }
  }
}))

describe('Pi delivery contracts at host and prompt boundaries', () => {
  beforeEach(() => {
    host.installed = true
    host.packaged = true
    host.launcher = '/opt/orca/bin/orca-ide'
    host.appPath = '/opt/orca/app'
    host.executable = '/opt/orca/orca-ide'
    host.files = new Set(['/opt/orca/bin/orca-ide'])
  })

  it('binds acquisition reporting to the trusted native host resolver shape', async () => {
    const { resolvePiWorkerReportCli } = await import('../../pi/worker-report-bridge')
    const descriptor = resolvePiWorkerReportCli({ platform: 'linux' })
    expect(descriptor).toEqual({ executable: '/opt/orca/bin/orca-ide', argvPrefix: [], mode: 'native' })
    expect(Object.keys(descriptor)).not.toEqual(expect.arrayContaining([
      'OPENROUTER_API_KEY', 'ORCA_AGENT_SESSION_SPAWN_TOKEN', 'credential', 'secret', 'identity'
    ]))
    expect(JSON.stringify(descriptor)).not.toContain('test-only-provider-value')
    expect(JSON.stringify(descriptor)).not.toContain('test-only-seal')
  })

  it('keeps development electron-cli invocation host-owned and rejects caller shell overrides', async () => {
    const { resolvePiWorkerReportCli } = await import('../../pi/worker-report-bridge')
    host.packaged = false
    host.launcher = null
    host.appPath = win32.normalize(String.raw`C:\Orca Source`)
    host.executable = win32.join(host.appPath, 'node_modules', 'electron', 'dist', 'electron.exe')
    const entry = win32.join(host.appPath, 'out', 'cli', 'index.js')
    host.files = new Set([host.executable, entry])
    expect(resolvePiWorkerReportCli({ platform: 'win32' })).toEqual({
      executable: host.executable, argvPrefix: [entry], mode: 'electron-cli'
    })
    host.launcher = win32.join(String.raw`C:\Orca`, 'orca.cmd')
    host.files = new Set([host.launcher])
    expect(() => resolvePiWorkerReportCli({ platform: 'win32' })).toThrow()
  })

  it('ignores caller and environment overrides while excluding their credential values', async () => {
    const { resolvePiWorkerReportCli } = await import('../../pi/worker-report-bridge')
    vi.stubEnv('ORCA_CLI_COMMAND', '/wrong/runtime --arbitrary-rpc')
    vi.stubEnv('ORCA_AGENT_SESSION_SPAWN_TOKEN', 'test-only-seal')
    vi.stubEnv('OPENROUTER_API_KEY', 'test-only-provider-value')
    try {
      const descriptor = resolvePiWorkerReportCli({ platform: 'linux' })
      expect(descriptor).toEqual({ executable: '/opt/orca/bin/orca-ide', argvPrefix: [], mode: 'native' })
      expect(JSON.stringify(descriptor)).not.toContain('/wrong/runtime')
      expect(JSON.stringify(descriptor)).not.toContain('test-only-seal')
      expect(JSON.stringify(descriptor)).not.toContain('test-only-provider-value')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
