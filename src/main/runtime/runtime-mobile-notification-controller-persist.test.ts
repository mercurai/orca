import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RuntimeMobileNotificationController } from './runtime-mobile-notification-controller'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function dispatchAndFlush(hasPairedMobileDevice: () => boolean): Promise<boolean> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-controller-persist-'))
  directories.push(directory)
  const controller = new RuntimeMobileNotificationController()
  controller.configureDismissalStore(directory, { hasPairedMobileDevice })
  // A push registrar and a listener always exist on a desktop host; only the registry decides.
  controller.setPushRegistrar({
    test: async () => ({ accepted: true }),
    register: async () => ({ registered: true }),
    unregister: async () => ({ unregistered: true })
  })
  controller.onDispatched(() => {})

  controller.dispatch({
    type: 'notification',
    source: 'terminal-bell',
    title: 'QA',
    body: '',
    notificationId: 'n1'
  })
  await controller.flushDismissals()

  return existsSync(join(directory, 'mobile-notification-dismissals.json'))
}

it('writes nothing while no mobile device is paired, even with a push service and a listener', async () => {
  expect(await dispatchAndFlush(() => false)).toBe(false)
})

it('persists the dismissal history once a mobile device is paired', async () => {
  expect(await dispatchAndFlush(() => true)).toBe(true)
})
