import { beforeEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
  installed: true,
  packaged: true,
  launcher: '/opt/orca/bin/orca-ide' as string | null,
  appPath: '/opt/orca/app',
  executable: '/opt/orca/orca-ide',
  files: new Set<string>()
}))

vi.mock('../../shared/app-environment', () => ({
  hasAppEnvironment: () => host.installed,
  getAppEnvironment: () => ({
    isPackaged: () => host.packaged,
    getCliLauncherPath: () => host.launcher,
    getAppPath: () => host.appPath,
    getPath: (name: string) => name === 'exe' ? host.executable : '/private/user-data'
  })
}))
vi.mock('node:fs', () => ({
  existsSync: (path: string) => host.files.has(path),
  statSync: (path: string) => {
    if (!host.files.has(path)) throw new Error('ENOENT')
    return { isFile: () => true }
  }
}))

// Missing implementation fails each behavioral assertion in RED, not test collection.
async function loadBridge() {
  const modulePath = './worker-report-bridge'
  return import(modulePath)
}

beforeEach(() => {
  host.installed = true
  host.packaged = true
  host.launcher = '/opt/orca/bin/orca-ide'
  host.appPath = '/opt/orca/app'
  host.executable = '/opt/orca/orca-ide'
  host.files = new Set(['/opt/orca/bin/orca-ide'])
})

describe('Pi host-owned report CLI descriptor', () => {
  it('returns only the current host native executable and fixed argument prefix', async () => {
    const { resolvePiWorkerReportCli } = await loadBridge()
    expect(resolvePiWorkerReportCli({ platform: 'linux' })).toEqual({
      executable: '/opt/orca/bin/orca-ide', argvPrefix: [], mode: 'native'
    })
  })

  it('uses a packaged Windows native launcher without shell interpretation', async () => {
    const { resolvePiWorkerReportCli } = await loadBridge()
    host.launcher = 'C:\\Program Files\\Orca\\resources\\bin\\orca.exe'
    host.files = new Set([host.launcher])
    expect(resolvePiWorkerReportCli({ platform: 'win32' })).toEqual({
      executable: host.launcher, argvPrefix: [], mode: 'native'
    })
  })

  it('derives Windows development invocation from the host app layout, never a cmd body', async () => {
    const { resolvePiWorkerReportCli } = await loadBridge()
    host.packaged = false
    host.launcher = null
    host.appPath = 'C:\\Orca Source'
    host.executable = 'C:\\Orca Source\\node_modules\\electron\\dist\\electron.exe'
    const entry = 'C:\\Orca Source\\out\\cli\\index.js'
    host.files = new Set([host.executable, entry])
    expect(resolvePiWorkerReportCli({ platform: 'win32' })).toEqual({
      executable: host.executable, argvPrefix: [entry], mode: 'electron-cli'
    })
  })

  it.each(['orca', 'orca --json', 'C:\\Orca\\orca.cmd', 'C:\\Orca\\orca.bat']) (
    'refuses ambiguous or shell-interpreted host launcher %s', async (launcher) => {
      const { resolvePiWorkerReportCli } = await loadBridge()
      host.launcher = launcher
      host.files = new Set([launcher])
      expect(() => resolvePiWorkerReportCli({ platform: 'win32' })).toThrow()
    }
  )

  it('refuses missing host or missing installed CLI instead of ambient PATH fallback', async () => {
    const { resolvePiWorkerReportCli } = await loadBridge()
    host.installed = false
    expect(() => resolvePiWorkerReportCli({ platform: 'linux' })).toThrow()
    host.installed = true
    host.files.clear()
    expect(() => resolvePiWorkerReportCli({ platform: 'linux' })).toThrow()
  })

  it('does not consume ambient command overrides or serialize identity and secrets', async () => {
    const { resolvePiWorkerReportCli } = await loadBridge()
    vi.stubEnv('ORCA_CLI_COMMAND', '/wrong/runtime --arbitrary-rpc')
    vi.stubEnv('ORCA_AGENT_SESSION_SPAWN_TOKEN', 'test-only-seal')
    vi.stubEnv('OPENROUTER_API_KEY', 'test-only-provider-value')
    try {
      const descriptor = resolvePiWorkerReportCli({ platform: 'linux' })
      expect(descriptor).toEqual({
        executable: '/opt/orca/bin/orca-ide', argvPrefix: [], mode: 'native'
      })
      expect(JSON.stringify(descriptor)).not.toMatch(/test-only|wrong\/runtime|env|token|secret/i)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
